/**
 * Planet renderer (T-0010, DEC-003, DEC-005, DEC-033, DEC-034).
 *
 * M1 scope, deliberately small: a stable sphere, camera-relative, reversed-Z,
 * driven by the real LOD selector. No terrain generation, no 8.2 M triangles.
 *
 * RESOURCE LIFECYCLE. Every GPU object this creates is owned here and released
 * in `destroy()`. The instance buffer grows geometrically and never shrinks per
 * frame, so a steady state allocates nothing. The depth view is cached across
 * frames of the same size. The pipeline is created once.
 */

import { budgets, vnorm, vscale, v3, vcross, type Vec3 } from '@ws/core';
import { type PlanetGeometry, type QuadKey } from '@ws/data';
import type { CameraState } from '../camera/state.js';
import { derive, nearPlane } from '../camera/state.js';
import {
  multiply,
  perspectiveReversedZInfinite,
  viewRotationOnly,
} from '../camera/matrices.js';
import {
  createSelectWorkspace,
  selectPatches,
  sortVisibleInPlace,
  type SelectStats,
} from '../lod/select.js';
import { NodePool, type PatchNode } from '../lod/quadtree.js';
import { PLANET_WGSL } from '../shaders/planet.wgsl.js';
import type { GpuContext } from './device.js';
import { FLOATS_PER_INSTANCE, packPatchInstance, patchCorners, patchIndices, type PackedCorners } from './instance.js';
import {
  BINDINGS,
  ENTRY_POINTS,
  UNIFORM_FLOATS,
  UNIFORM_OFFSET,
  VERTEX_ATTR,
} from './layout.js';
import { WINDING_UNKNOWN, type WindingProbeOutcome } from './winding.js';

/** Reversed-Z (DEC-033 rule 3): near maps to 1.0, far to 0.0, clear to 0.0. */
export const DEPTH_CLEAR_VALUE = 0.0;
export const DEPTH_COMPARE: GPUCompareFunction = 'greater-equal';
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

export interface RendererOptions {
  readonly planet: PlanetGeometry;
  /**
   * Result of `probeWindingConvention` (T-0062). WebGPU's NDC is y-up and its
   * framebuffer y-down, so whether `frontFace: 'ccw'` refers to the winding
   * before or after that flip decides whether an outward-wound sphere draws or
   * is culled entirely. Omit it and culling is disabled, which renders
   * correctly for a convex body at the cost of overdraw — never a black screen.
   */
  readonly winding?: WindingProbeOutcome;
  readonly patchVerticesPerSide?: number;
  readonly maxLevel?: number;
}

export type DebugMode = 'shaded' | 'lod' | 'patches' | 'height';

export type ElevationSampler = (key: QuadKey) => { h00: number; h10: number; h01: number; h11: number };

export interface FrameStats extends SelectStats {
  readonly cpuSelectMs: number;
  readonly cpuEncodeMs: number;
  readonly drawnPatches: number;
  readonly altitude: number;
  readonly cameraNear: number;
  readonly cameraSpeed: number;
  /** GPU pass time in ms if timestamp-query is available; otherwise -1. */
  readonly gpuFrameMs: number;
  readonly patchVerticesPerSide: number;
  readonly pixelCount: number;
}

export class PlanetRenderer {
  private readonly gpu: GpuContext;
  private readonly planet: PlanetGeometry;
  private readonly n: number;
  private readonly maxLevel: number;
  private readonly pool = new NodePool();
  private readonly workspace = createSelectWorkspace();

  private pipeline!: GPURenderPipeline;
  private uniformBuffer!: GPUBuffer;
  private gridBuffer!: GPUBuffer;
  private indexBuffer!: GPUBuffer;
  private indexCount = 0;
  private instanceBuffer: GPUBuffer | null = null;
  private instanceCapacity = 0;
  private bindGroup: GPUBindGroup | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private depthSize = { w: 0, h: 0 };

  private instanceData = new Float32Array(0);
  private readonly uniformData = new Float32Array(UNIFORM_FLOATS);
  private previouslySplit: ReadonlySet<number> = new Set();
  private destroyed = false;

  private querySet: GPUQuerySet | null = null;
  private queryResolve: GPUBuffer | null = null;
  private queryRead: GPUBuffer | null = null;
  private gpuReadPending = false;
  private lastGpuMs = -1;
  private lastCamX = 0;
  private lastCamY = 0;
  private lastCamZ = 0;
  private lastCamT = 0;
  private haveLastCam = false;

  readonly winding: WindingProbeOutcome;

  debugMode: DebugMode = 'shaded';
  sunDirection: Vec3 = vnorm(v3(1, 0.35, 0.25));
  seaLevel = 0;
  elevationAt: ElevationSampler | null = null;

  constructor(gpu: GpuContext, opts: RendererOptions) {
    this.gpu = gpu;
    this.planet = opts.planet;
    this.n = opts.patchVerticesPerSide ?? budgets.QUALITY.patchVerticesPerSide;
    this.maxLevel = opts.maxLevel ?? 12;
    this.winding = opts.winding ?? WINDING_UNKNOWN;
    this.createStaticResources();
  }

  get nodePool(): NodePool {
    return this.pool;
  }

  private createStaticResources(): void {
    const { device, format } = this.gpu;

    const module = device.createShaderModule({ code: PLANET_WGSL, label: 'planet' });

    this.pipeline = device.createRenderPipeline({
      label: 'planet-surface',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: ENTRY_POINTS.vertex,
        buffers: [
          {
            arrayStride: VERTEX_ATTR.arrayStride,
            attributes: [
              {
                shaderLocation: VERTEX_ATTR.shaderLocation,
                offset: VERTEX_ATTR.offset,
                format: VERTEX_ATTR.format,
              },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: ENTRY_POINTS.fragment, targets: [{ format }] },
      primitive: {
        topology: 'triangle-list',
        // Measured, not assumed (T-0062). Until the probe has run, draw both
        // faces: a convex closed body is identical with culling off, and a
        // wrong guess here is the black screen Astra spent a session on.
        cullMode: this.winding.fallbackNoCull ? 'none' : 'back',
        frontFace: this.winding.frontFace,
      },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: DEPTH_COMPARE,
      },
    });

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

    const indices = patchIndices(n);
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

    if (this.gpu.hasTimestampQuery) {
      this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
      this.queryResolve = device.createBuffer({
        label: 'gpu-time-resolve',
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      this.queryRead = device.createBuffer({
        label: 'gpu-time-read',
        size: 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    }
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
        { binding: BINDINGS.uniforms, resource: { buffer: this.uniformBuffer } },
        { binding: BINDINGS.instances, resource: { buffer: this.instanceBuffer } },
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
      this.depthView = this.depthTexture.createView();
    }
    return this.depthView as GPUTextureView;
  }

  /**
   * Pack one patch into the instance buffer, CAMERA-RELATIVE.
   *
   * Four sphere-surface corners, subtracted in f64. The shader bilinearly
   * interpolates them — it does not reconstruct a planet-centred position.
   */
  private writeInstance(out: Float32Array, at: number, node: PatchNode, cam: CameraState): void {
    const packed = patchCorners(node.key, this.planet.radius, cam.position);
    const h = this.elevationAt ? this.elevationAt(node.key) : { h00: 0, h10: 0, h01: 0, h11: 0 };
    const withH: PackedCorners = {
      c00: packed.c00,
      c10: packed.c10,
      c01: packed.c01,
      c11: packed.c11,
      level: packed.level,
      face: packed.face,
      h00: h.h00,
      h10: h.h10,
      h01: h.h01,
      h11: h.h11,
    };
    packPatchInstance(out, at, withH);
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
      pool: this.pool,
      workspace: this.workspace,
    });
    this.previouslySplit = result.split;
    const visible = sortVisibleInPlace(this.workspace.visible);
    const t1 = nowMs();

    this.ensureInstanceCapacity(Math.max(1, visible.length));
    for (let i = 0; i < visible.length; i++) {
      this.writeInstance(this.instanceData, i, visible[i] as PatchNode, cam);
    }
    if (visible.length > 0 && this.instanceBuffer !== null) {
      device.queue.writeBuffer(
        this.instanceBuffer,
        0,
        this.instanceData.buffer as ArrayBuffer,
        0,
        visible.length * FLOATS_PER_INSTANCE * 4,
      );
    }

    const d = derive(cam, this.planet);
    const proj = perspectiveReversedZInfinite(cam.fovY, width / height, nearPlane(d.altitude));
    const view = viewRotationOnly(cam);
    const viewProj = multiply(proj, view);
    // Offsets come from layout.ts, which gpu-contract.test.ts asserts against
    // the struct the shader actually declares.
    this.uniformData.set(viewProj, UNIFORM_OFFSET.viewProj);
    this.uniformData.set(
      [this.sunDirection.x, this.sunDirection.y, this.sunDirection.z, 0],
      UNIFORM_OFFSET.sunDirection,
    );
    this.uniformData.set(
      [
        this.planet.radius,
        d.altitude,
        this.debugMode === 'shaded' ? 0 : this.debugMode === 'lod' ? 1 : this.debugMode === 'patches' ? 2 : 3,
        this.seaLevel,
      ],
      UNIFORM_OFFSET.params,
    );
    this.uniformData.set(
      [cam.position.x, cam.position.y, cam.position.z, 0],
      UNIFORM_OFFSET.camK,
    );
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const encoder = device.createCommandEncoder({ label: 'frame' });
    const stamp =
      this.querySet !== null
        ? { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }
        : undefined;
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
      ...(stamp ? { timestampWrites: stamp } : {}),
    });

    if (visible.length > 0 && this.bindGroup !== null) {
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.gridBuffer);
      pass.setIndexBuffer(this.indexBuffer, 'uint32');
      pass.drawIndexed(this.indexCount, visible.length);
    }
    pass.end();

    if (this.querySet !== null && this.queryResolve !== null && this.queryRead !== null && !this.gpuReadPending) {
      encoder.resolveQuerySet(this.querySet, 0, 2, this.queryResolve, 0);
      encoder.copyBufferToBuffer(this.queryResolve, 0, this.queryRead, 0, 16);
    }

    device.queue.submit([encoder.finish()]);
    this.scheduleGpuRead();
    const t2 = nowMs();

    const now = t2;
    let speed = 0;
    if (this.haveLastCam) {
      const dt = Math.max(1e-4, (now - this.lastCamT) / 1000);
      const dx = cam.position.x - this.lastCamX;
      const dy = cam.position.y - this.lastCamY;
      const dz = cam.position.z - this.lastCamZ;
      speed = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
    }
    this.lastCamX = cam.position.x;
    this.lastCamY = cam.position.y;
    this.lastCamZ = cam.position.z;
    this.lastCamT = now;
    this.haveLastCam = true;

    return {
      ...result.stats,
      cpuSelectMs: t1 - t0,
      cpuEncodeMs: t2 - t1,
      drawnPatches: visible.length,
      altitude: d.altitude,
      cameraNear: d.cameraNear,
      cameraSpeed: speed,
      gpuFrameMs: this.lastGpuMs,
      patchVerticesPerSide: this.n,
      pixelCount: width * height,
    };
  }

  private scheduleGpuRead(): void {
    const buf = this.queryRead;
    if (buf === null || this.gpuReadPending) return;
    this.gpuReadPending = true;
    void buf.mapAsync(GPUMapMode.READ).then(
      () => {
        const times = new BigInt64Array(buf.getMappedRange().slice(0));
        const a = times[0] ?? 0n;
        const b = times[1] ?? 0n;
        this.lastGpuMs = Number(b - a) / 1e6;
        buf.unmap();
        this.gpuReadPending = false;
      },
      () => {
        this.gpuReadPending = false;
      },
    );
  }

  destroy(): void {
    this.instanceBuffer?.destroy();
    this.depthTexture?.destroy();
    this.uniformBuffer.destroy();
    this.gridBuffer.destroy();
    this.indexBuffer.destroy();
    this.querySet?.destroy();
    this.queryResolve?.destroy();
    if (!this.gpuReadPending) this.queryRead?.destroy();
    this.depthView = null;
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
