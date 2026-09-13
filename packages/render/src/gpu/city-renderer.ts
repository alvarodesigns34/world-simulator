/**
 * City and infrastructure geometry pass (M13, T-0101).
 *
 * WHAT THIS FIXES. M9 generated city state and layouts, and the only way to
 * look at a city in the application was a separate 320x320 2D canvas toggled
 * with `y`. The main renderer drew planet patches and nothing else. So M9's
 * acceptance — "renders at 60 FPS from street level and orbit", "seamless
 * city -> terrain transition" — and several M13 shots were nominal: there was no
 * 3D scene in which to evaluate them. Astra would have arrived to find the
 * system missing rather than unpolished.
 *
 * WHAT IT IS NOT. This is functional completeness, not art. Boxes, one
 * pipeline, flat tints, no windows, no roofs, no materials. Astra tunes what
 * exists; she should not have to build it first.
 *
 * SIMULATION STATE != RENDERING STATE. This module owns no world state and
 * imports nothing from `sim`. It consumes flat arrays produced by an adapter,
 * exactly as `FieldOverlay` consumes a field, and it decides nothing about
 * topology — where a road goes is M10's answer, not the renderer's.
 *
 * PRECISION. Instance centres are camera-relative f32, computed in f64 by the
 * adapter. At Earth radius an f32 ulp is 0.5 m — larger than a building — so a
 * planet-centred position must never reach the GPU (DEC-005, DEC-033).
 */

import { CITY_WGSL } from '../shaders/city.wgsl.js';
import type { GpuContext } from './device.js';
import { BINDINGS } from './layout.js';

/** Instance kinds. Shading only; the renderer draws them identically. */
export const CITY_KIND = {
  BUILDING: 0,
  STREET: 1,
  ARTERIAL: 2,
  ROAD: 3,
  RAIL: 4,
  BRIDGE: 5,
  PORT: 6,
  /** One block standing in for a whole city, used from orbit. */
  AGGREGATE: 7,
} as const;
export type CityKind = (typeof CITY_KIND)[keyof typeof CITY_KIND];

/** Five vec4s: centre, three axes with half-extents, tint. */
export const CITY_INSTANCE_FLOATS = 20;
export const CITY_INSTANCE_BYTES = CITY_INSTANCE_FLOATS * 4;

export const CITY_INSTANCE_OFFSET = {
  centre: 0,
  axisX: 4,
  axisY: 8,
  axisZ: 12,
  tint: 16,
} as const;

/**
 * A batch of boxes to draw, already camera-relative.
 *
 * `count` rather than `data.length / CITY_INSTANCE_FLOATS` so an adapter can
 * keep one oversized buffer and refill it, which is what avoids allocating per
 * frame at street level.
 */
export interface CityInstanceBatch {
  readonly data: Float32Array;
  readonly count: number;
}

/* Unit cube: 6 faces x 4 corners, with per-face normals so the lighting reads
   as boxes rather than as a smoothed blob. 24 vertices, 36 indices. */
const FACES: readonly (readonly [readonly [number, number, number], readonly number[][]])[] = [
  [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
  [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
  [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
  [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
  [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
  [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
];

export function buildUnitBox(): { vertices: Float32Array; indices: Uint32Array } {
  const vertices = new Float32Array(24 * 6);
  const indices = new Uint32Array(36);
  let v = 0;
  let i = 0;
  let base = 0;
  for (const [normal, corners] of FACES) {
    for (const c of corners) {
      vertices[v++] = c[0] as number;
      vertices[v++] = c[1] as number;
      vertices[v++] = c[2] as number;
      vertices[v++] = normal[0];
      vertices[v++] = normal[1];
      vertices[v++] = normal[2];
    }
    /* Two triangles per face, in the winding the planet pass already uses. */
    indices[i++] = base; indices[i++] = base + 1; indices[i++] = base + 2;
    indices[i++] = base; indices[i++] = base + 2; indices[i++] = base + 3;
    base += 4;
  }
  return { vertices, indices };
}

export interface CityRendererOptions {
  /** Instances the buffer is sized for. Growth reallocates, so size for peak. */
  readonly capacity?: number;
  readonly colorFormat?: GPUTextureFormat;
  readonly depthFormat?: GPUTextureFormat;
}

/**
 * Draws city and infrastructure boxes into an existing render pass.
 *
 * It does NOT own the pass, the depth buffer or the camera uniforms: it is a
 * second pipeline inside the planet's pass, so cities and terrain share one
 * depth buffer and occlude each other correctly. That sharing is what makes the
 * city -> terrain transition seamless rather than a composited overlay.
 */
export class CityRenderer {
  private readonly gpu: GpuContext;
  private readonly pipeline: GPURenderPipeline;
  private readonly vertexBuffer: GPUBuffer;
  private readonly indexBuffer: GPUBuffer;
  private readonly indexCount: number;
  private readonly uniformBuffer: GPUBuffer;
  private instanceBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private capacity: number;
  private destroyed = false;

  /** Instances drawn on the last frame. Diagnostic. */
  lastDrawn = 0;

  constructor(gpu: GpuContext, uniformBuffer: GPUBuffer, options: CityRendererOptions = {}) {
    this.gpu = gpu;
    this.uniformBuffer = uniformBuffer;
    this.capacity = options.capacity ?? 1 << 16;
    const { device } = gpu;
    const box = buildUnitBox();

    this.vertexBuffer = device.createBuffer({
      label: 'city-box-vertices',
      size: box.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, box.vertices.buffer as ArrayBuffer, 0, box.vertices.byteLength);

    this.indexBuffer = device.createBuffer({
      label: 'city-box-indices',
      size: box.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, box.indices.buffer as ArrayBuffer, 0, box.indices.byteLength);
    this.indexCount = box.indices.length;

    const shader = device.createShaderModule({ label: 'city', code: CITY_WGSL });
    this.pipeline = device.createRenderPipeline({
      label: 'city',
      /* `auto`, like the planet pipeline: the shader declares the layout and
         the driver derives it, so there is one authority rather than two. */
      layout: 'auto',
      vertex: {
        module: shader,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
          ],
        }],
      },
      fragment: {
        module: shader,
        entryPoint: 'fs',
        targets: [{ format: options.colorFormat ?? gpu.format }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: {
        format: options.depthFormat ?? 'depth32float',
        depthWriteEnabled: true,
        /* Reversed-Z, matching the planet pass. */
        depthCompare: 'greater',
      },
    });
  }

  /** Grow the instance buffer if needed and upload a batch. */
  upload(batch: CityInstanceBatch): void {
    if (this.destroyed) throw new Error('city renderer destroyed');
    if (batch.count === 0) { this.lastDrawn = 0; return; }
    const { device } = this.gpu;
    if (this.instanceBuffer === null || batch.count > this.capacity) {
      this.instanceBuffer?.destroy();
      this.capacity = Math.max(this.capacity, nextPowerOfTwo(batch.count));
      this.instanceBuffer = device.createBuffer({
        label: 'city-instances',
        size: this.capacity * CITY_INSTANCE_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bindGroup = device.createBindGroup({
        label: 'city-bindgroup',
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: BINDINGS.uniforms, resource: { buffer: this.uniformBuffer } },
          { binding: BINDINGS.instances, resource: { buffer: this.instanceBuffer } },
        ],
      });
    }
    device.queue.writeBuffer(
      this.instanceBuffer, 0, batch.data.buffer as ArrayBuffer,
      batch.data.byteOffset, batch.count * CITY_INSTANCE_BYTES,
    );
    this.lastDrawn = batch.count;
  }

  /** The storage buffer to bind at slot 1. Null before the first upload. */
  get instances(): GPUBuffer | null { return this.instanceBuffer; }

  /**
   * Record the draw into a pass the caller already opened.
   *
   * The caller's pass must be the planet's, with the same depth attachment:
   * that shared depth buffer is what makes buildings occlude and be occluded by
   * terrain instead of floating over it.
   */
  draw(pass: GPURenderPassEncoder): void {
    if (this.lastDrawn === 0 || this.instanceBuffer === null || this.bindGroup === null) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    pass.drawIndexed(this.indexCount, this.lastDrawn);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
    this.instanceBuffer?.destroy();
    this.instanceBuffer = null;
    this.bindGroup = null;
  }
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
