/**
 * Front-face convention probe (T-0062).
 *
 * THE PROBLEM THIS SOLVES.
 *
 * WebGPU's NDC is y-UP (bottom-left is (-1,-1)); its framebuffer is y-DOWN
 * (top-left is (0,0)). There is therefore a Y flip in the viewport transform,
 * and whether `frontFace: 'ccw'` refers to the winding BEFORE or AFTER that
 * flip decides whether an outward-wound sphere is drawn or entirely culled.
 * Get it wrong and the canvas is black — which is exactly the failure Astra
 * spent an Ampere session diagnosing.
 *
 * This cannot be settled from the CPU. Reading the specification does not
 * settle it either, because the answer that matters is what the driver in front
 * of us actually does. So: ask the GPU.
 *
 * HOW. Draw one triangle whose vertices are written directly in clip space in
 * known counter-clockwise order as seen in NDC, with `frontFace: 'ccw'` and
 * `cullMode: 'back'`, into a 1x1 texture. If the pixel is written, 'ccw' means
 * CCW-in-NDC and our geometry (which is CCW in NDC by construction — see
 * `patchIndices` and the cube-face orientation contract) is front-facing. If it
 * is not written, the convention is inverted and the renderer must use 'cw'.
 *
 * The result is reported in the HUD, so a future driver that disagrees shows up
 * as a line of text rather than as a black screen and a lost session.
 */

const PROBE_WGSL = /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  // Counter-clockwise in NDC with y up: (0, 0.8) -> (-0.8, -0.8) -> (0.8, -0.8).
  var pts = array<vec2<f32>, 3>(
    vec2<f32>( 0.0,  0.8),
    vec2<f32>(-0.8, -0.8),
    vec2<f32>( 0.8, -0.8),
  );
  return vec4<f32>(pts[vi], 0.5, 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}
`;

export type WindingResult = 'ccw' | 'cw' | 'unknown';

export interface WindingProbeOutcome {
  /** The `frontFace` value that makes our outward CCW-in-NDC geometry visible. */
  readonly frontFace: GPUFrontFace;
  /** What the probe actually observed. 'unknown' means the probe could not run. */
  readonly observed: WindingResult;
  /** True when the probe failed and the renderer should disable culling. */
  readonly fallbackNoCull: boolean;
  readonly detail: string;
}

export const WINDING_UNKNOWN: WindingProbeOutcome = {
  frontFace: 'ccw',
  observed: 'unknown',
  fallbackNoCull: true,
  detail: 'probe did not run; back-face culling disabled so geometry cannot vanish',
};

/**
 * Run the probe. Never throws: a probe that cannot run yields
 * `fallbackNoCull`, which renders correctly (a convex closed body draws the
 * same with culling off, at the cost of some overdraw) rather than risking a
 * black screen.
 */
export async function probeWindingConvention(device: GPUDevice): Promise<WindingProbeOutcome> {
  let texture: GPUTexture | undefined;
  let readback: GPUBuffer | undefined;
  try {
    const format: GPUTextureFormat = 'rgba8unorm';
    texture = device.createTexture({
      label: 'winding-probe',
      size: { width: 1, height: 1 },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    const module = device.createShaderModule({ code: PROBE_WGSL, label: 'winding-probe' });
    const pipeline = device.createRenderPipeline({
      label: 'winding-probe',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
    });

    // 256-byte row alignment is required by copyTextureToBuffer.
    readback = device.createBuffer({
      label: 'winding-probe-readback',
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = device.createCommandEncoder({ label: 'winding-probe' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 256 }, {
      width: 1,
      height: 1,
    });
    device.queue.submit([encoder.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    const pixel = new Uint8Array(readback.getMappedRange().slice(0, 4));
    readback.unmap();

    const drawn = pixel[0] !== 0;
    return drawn
      ? {
          frontFace: 'ccw',
          observed: 'ccw',
          fallbackNoCull: false,
          detail: "'ccw' matches CCW-in-NDC; outward geometry is front-facing",
        }
      : {
          frontFace: 'cw',
          observed: 'cw',
          fallbackNoCull: false,
          detail: "'ccw' is evaluated after the framebuffer Y flip; using 'cw' for outward geometry",
        };
  } catch (err) {
    return {
      ...WINDING_UNKNOWN,
      detail: `probe failed (${err instanceof Error ? err.message : String(err)}); culling disabled`,
    };
  } finally {
    readback?.destroy();
    texture?.destroy();
  }
}
