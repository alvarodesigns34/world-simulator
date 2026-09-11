/**
 * Planet renderer (T-0010, DEC-003, DEC-005, DEC-033, DEC-034).
 *
 * M1 scope, deliberately small: a stable sphere, camera-relative, reversed-Z,
 * driven by the real LOD selector. No terrain generation, no 8.2 M triangles.
 * The point is to prove the selector, the precision path and the frame loop —
 * DEC-032's arithmetic says the triangle budget was fiction, so nothing here
 * chases it.
 *
 * RESOURCE LIFECYCLE. Every GPU object this creates is owned here and released
 * in `destroy()`. The instance buffer grows geometrically and never shrinks per
 * frame, so a steady state allocates nothing.
 */

import { budgets, vlen, vnorm, vscale, v3, vcross, type Vec3 } from '@ws/core';
import { cubeFaceToUnit, quadkey, type PlanetGeometry } from '@ws/data';
import type { CameraState } from '../camera/state.js';
import { derive, nearPlane } from '../camera/state.js';
import {
  multiply,
  perspectiveReversedZInfinite,
  viewRotationOnly,
} from '../camera/matrices.js';
import { selectPatches, sortVisible, type SelectStats } from '../lod/select.js';
import type { PatchNode } from '../lod/quadtree.js';
import { PLANET_WGSL } from '../shaders/planet.wgsl.js';
import type { GpuContext } from './device.js';

/** Reversed-Z (DEC-033 rule 3): near maps to 1.0, far to 0.0, clear to 0.0. */
export const DEPTH_CLEAR_VALUE = 0.0;
export const DEPTH_COMPARE: GPUCompareFunction = 'greater-equal';
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

const FLOATS_PER_INSTANCE = 16; // 4 x vec4

export interface RendererOptions {
  readonly planet: PlanetGeometry;
  readonly patchVerticesPerSide?: number;
  readonly maxLevel?: number;
}

export type DebugMode = 'shaded' | 'lod' | 'patches';

export interface FrameStats extends SelectStats {
  readonly cpuSelectMs: number;
  readonly cpuEncodeMs: number;
  readonly drawnPatches: number;
  readonly altitude: number;
  readonly cameraNear: number;
}

export class PlanetRenderer {
  private readonly gpu: GpuContext;
  private readonly planet: PlanetGeometry;
  private readonly n: number;
  private readonly maxLevel: number;

  private pipeline!: GPURenderPipeline;
  private uniformBuffer!: GPUBuffer;
  private gridBuffer!: GPUBuffer;
  private indexBuffer!: GPUBuffer;
  private indexCount = 0;
  private instanceBuffer: GPUBuffer | null = null;
  private instanceCapacity = 0;
  private bindGroup: GPUBindGroup | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthSize = { w: 0, h: 0 };

  private instanceData = new Float32Array(0);
  private readonly uniformData = new Float32Array(24); // mat4 + vec4 + vec4
  private previouslySplit: ReadonlySet<number> = new Set();
  private destroyed = false;

  debugMode: DebugMode = 'shaded';
  sunDirection: Vec3 = vnorm(v3(1, 0.35, 0.25));

  constructor(gpu: GpuContext, opts: RendererOptions) {
    this.gpu = gpu;
    this.planet = opts.planet;
    this.n = opts.patchVerticesPerSide ?? budgets.QUALITY.patchVerticesPerSide;
    this.maxLevel = opts.maxLevel ?? 10;
    this.createStaticResources();
  }

  private createStaticResources(): void {
    const { device, format } = this.gpu;

    const module = device.createShaderModule({ code: PLANET_WGSL, label: 'planet' });

    this.pipeline = device.createRenderPipeline({
      label: 'planet-surface',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        // Reversed-Z.
        depthCompare: DEPTH_COMPARE,
      },
    });

    // The shared patch mesh: ONE grid, reused by every patch as an instance
    // (DEC-010 rule 2). This is what keeps CPU draw cost flat.
    const n = this.n;
    const verts = new Float32Array(n * n * 2);
    for (let j = 0, k = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        verts[k++] = i / (n - 1);
        verts[k++] = j / (n - 1);
      }
    }
    this.gridBuffer = device.createBuffer({
      label: 'patch-grid',
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.gridBuffer, 0, verts);

    const quads = (n - 1) * (n - 1);
    const indices = new Uint32Array(quads * 6);
    for (let j = 0, k = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        indices[k++] = a; indices[k++] = c; indices[k++] = b;
        indices[k++] = b; indices[k++] = c; indices[k++] = d;
      }
    }
    this.indexCount = indices.length;
    this.indexBuffer = device.createBuffer({
      label: 'patch-indices',
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, indices);

    this.uniformBuffer = device.createBuffer({
      label: 'planet-uniforms',
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private ensureInstanceCapacity(count: number): void {
    if (count <= this.instanceCapacity) return;
    const cap = Math.max(256, 1 << Math.ceil(Math.log2(count)));
    this.instanceBuffer?.destroy();
    this.instanceBuffer = this.gpu.device.createBuffer({
      label: 'patch-instances',
      size: cap * FLOATS_PER_INSTANCE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.instanceCapacity = cap;
    this.instanceData = new Float32Array(cap * FLOATS_PER_INSTANCE);
    this.bindGroup = this.gpu.device.createBindGroup({
      label: 'planet-bindgroup',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.instanceBuffer } },
      ],
    });
  }

  private ensureDepth(w: number, h: number): GPUTextureView {
    if (this.depthTexture === null || this.depthSize.w !== w || this.depthSize.h !== h) {
      this.depthTexture?.destroy();
      this.depthTexture = this.gpu.device.createTexture({
        label: 'depth',
        size: { width: w, height: h },
        format: DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.depthSize = { w, h };
    }
    return this.depthTexture.createView();
  }

  /**
   * Pack one patch into the instance buffer, CAMERA-RELATIVE.
   *
   * This is the f64 -> f32 boundary in practice: `corner - camera` is computed
   * in f64 here, and only the small difference is written as f32. Within 100 km
   * of the camera one f32 ulp is 7.8 mm.
   */
  private writeInstance(out: Float32Array, at: number, node: PatchNode, cam: CameraState): void {
    const [u0, v0, u1, v1] = quadkey.bounds(node.key);
    const R = this.planet.radius;

    const corner = cubeFaceToUnit({ face: node.key.face, u: u0, v: v0 });
    const cu = cubeFaceToUnit({ face: node.key.face, u: u1, v: v0 });
    const cv = cubeFaceToUnit({ face: node.key.face, u: u0, v: v1 });

    // f64 differences, then f32 store.
    const ox = corner.x * R - cam.position.x;
    const oy = corner.y * R - cam.position.y;
    const oz = corner.z * R - cam.position.z;

    const tux = (cu.x - corner.x) * R;
    const tuy = (cu.y - corner.y) * R;
    const tuz = (cu.z - corner.z) * R;
    const tvx = (cv.x - corner.x) * R;
    const tvy = (cv.y - corner.y) * R;
    const tvz = (cv.z - corner.z) * R;

    // The planet centre, in camera-relative space. The shader re-projects onto
    // the sphere from this, so it never needs a world position.
    const centreRel = v3(-cam.position.x, -cam.position.y, -cam.position.z);

    let k = at * FLOATS_PER_INSTANCE;
    out[k++] = ox; out[k++] = oy; out[k++] = oz; out[k++] = centreRel.z;
    out[k++] = tux; out[k++] = tuy; out[k++] = tuz; out[k++] = centreRel.x;
    out[k++] = tvx; out[k++] = tvy; out[k++] = tvz; out[k++] = centreRel.y;
    out[k++] = node.key.level; out[k++] = 0; out[k++] = node.key.face; out[k++] = 0;
  }

  render(cam: CameraState, target: GPUTextureView, width: number, height: number): FrameStats {
    if (this.destroyed) throw new Error('renderer destroyed');
    const { device } = this.gpu;

    const t0 = nowMs();
    const result = selectPatches(cam, {
      planet: this.planet,
      viewportWidth: width,
      viewportHeight: height,
      gpuTier: this.gpu.tier,
      patchVerticesPerSide: this.n,
      maxLevel: this.maxLevel,
      previouslySplit: this.previouslySplit,
    });
    this.previouslySplit = result.split;
    const visible = sortVisible(result.visible);
    const t1 = nowMs();

    this.ensureInstanceCapacity(Math.max(1, visible.length));
    for (let i = 0; i < visible.length; i++) {
      this.writeInstance(this.instanceData, i, visible[i] as PatchNode, cam);
    }
    if (visible.length > 0 && this.instanceBuffer !== null) {
      device.queue.writeBuffer(
        this.instanceBuffer,
        0,
        this.instanceData.buffer,
        0,
        visible.length * FLOATS_PER_INSTANCE * 4,
      );
    }

    const d = derive(cam, this.planet);
    const proj = perspectiveReversedZInfinite(cam.fovY, width / height, nearPlane(d.altitude));
    const view = viewRotationOnly(cam);
    const viewProj = multiply(proj, view);
    this.uniformData.set(viewProj, 0);
    this.uniformData.set(
      [this.sunDirection.x, this.sunDirection.y, this.sunDirection.z, 0],
      16,
    );
    this.uniformData.set(
      [
        this.planet.radius,
        d.altitude,
        this.debugMode === 'shaded' ? 0 : this.debugMode === 'lod' ? 1 : 2,
        0,
      ],
      20,
    );
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const encoder = device.createCommandEncoder({ label: 'frame' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          clearValue: { r: 0.004, g: 0.006, b: 0.012, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.ensureDepth(width, height),
        depthClearValue: DEPTH_CLEAR_VALUE,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    if (visible.length > 0 && this.bindGroup !== null) {
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.gridBuffer);
      pass.setIndexBuffer(this.indexBuffer, 'uint32');
      pass.drawIndexed(this.indexCount, visible.length);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    const t2 = nowMs();

    return {
      ...result.stats,
      cpuSelectMs: t1 - t0,
      cpuEncodeMs: t2 - t1,
      drawnPatches: visible.length,
      altitude: d.altitude,
      cameraNear: d.cameraNear,
    };
  }

  destroy(): void {
    this.instanceBuffer?.destroy();
    this.depthTexture?.destroy();
    this.uniformBuffer.destroy();
    this.gridBuffer.destroy();
    this.indexBuffer.destroy();
    this.destroyed = true;
  }
}

/** Wall-clock only; never reaches simulation state (DEC-017). */
function nowMs(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p === undefined ? 0 : p.now();
}

export function sunDirectionFor(cam: CameraState): Vec3 {
  const up = vnorm(v3(cam.position.x, cam.position.y, cam.position.z));
  const east = vnorm(vcross(v3(0, 0, 1), up));
  return vnorm(vscale(east, 1));
}

export { vlen };
