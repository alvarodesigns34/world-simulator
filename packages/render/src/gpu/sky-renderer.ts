/**
 * Background pass: stars and sky (T-0160).
 *
 * Drawn first, with no depth attachment write, so the planet occludes it by
 * simply being drawn afterwards. It owns one small uniform buffer of its own
 * rather than borrowing the planet's: the planet's lanes are full, and
 * overloading them would make two passes depend on each other's packing.
 */

import { SKY_WGSL } from '../shaders/sky.wgsl.js';
import type { GpuContext } from './device.js';

/** vec4 forward, right, up, sun, radial. */
export const SKY_UNIFORM_FLOATS = 20;

export interface SkyFrame {
  /** Unit camera basis. */
  readonly forward: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly tanHalfFovY: number;
  readonly aspect: number;
  readonly altitudeM: number;
  readonly sun: readonly [number, number, number];
  readonly exposure: number;
  /** Outward radial at the camera. */
  readonly radial: readonly [number, number, number];
  /** True in scientific mode: skip the filmic curve so colour stays faithful. */
  readonly scientific: boolean;
}

export class SkyRenderer {
  private readonly gpu: GpuContext;
  private readonly pipeline: GPURenderPipeline;
  private readonly uniform: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly staging = new Float32Array(SKY_UNIFORM_FLOATS);
  private destroyed = false;

  constructor(gpu: GpuContext, colorFormat?: GPUTextureFormat, depthFormat: GPUTextureFormat = 'depth32float') {
    this.gpu = gpu;
    const { device } = gpu;
    const module = device.createShaderModule({ label: 'sky', code: SKY_WGSL });
    this.pipeline = device.createRenderPipeline({
      label: 'sky',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: colorFormat ?? gpu.format }] },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
      primitive: { topology: 'triangle-list' },
      /*
       * The background writes colour only — but it must still DECLARE depth
       * state, because a pipeline with no depthStencil is incompatible with a
       * render pass that has a depth attachment, and WebGPU rejects the whole
       * pass rather than just this draw. That rejection is silent to the eye:
       * the planet stops being drawn too, and the screen goes black.
       */
    });
    this.uniform = device.createBuffer({
      label: 'sky-uniforms',
      size: SKY_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      label: 'sky-bindgroup',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniform } }],
    });
  }

  update(frame: SkyFrame): void {
    const d = this.staging;
    d[0] = frame.forward[0]; d[1] = frame.forward[1]; d[2] = frame.forward[2]; d[3] = frame.tanHalfFovY;
    d[4] = frame.right[0]; d[5] = frame.right[1]; d[6] = frame.right[2]; d[7] = frame.aspect;
    d[8] = frame.up[0]; d[9] = frame.up[1]; d[10] = frame.up[2]; d[11] = frame.altitudeM;
    d[12] = frame.sun[0]; d[13] = frame.sun[1]; d[14] = frame.sun[2]; d[15] = frame.exposure;
    d[16] = frame.radial[0]; d[17] = frame.radial[1]; d[18] = frame.radial[2];
    d[19] = frame.scientific ? 1 : 0;
    this.gpu.device.queue.writeBuffer(this.uniform, 0, d);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.destroyed) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.uniform.destroy();
  }
}
