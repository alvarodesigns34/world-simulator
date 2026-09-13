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
 * HOW. Three draws of one triangle whose vertices are written directly in clip
 * space in known counter-clockwise order as seen in NDC, into a 1×1 texture:
 *
 *   1. control — `cullMode: 'none'`. If this pixel is black, the probe did not
 *      draw at all (format, shader, copy) and we MUST NOT guess a winding.
 *   2. ccw     — `frontFace: 'ccw', cullMode: 'back'`
 *   3. cw      — `frontFace: 'cw',  cullMode: 'back'`
 *
 * A single-draw probe that treats "black" as "must be CW" is how a failed
 * probe culls the planet to a black screen. Ambiguous results (both lit, both
 * dark, control dark) disable culling.
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

function pixelLit(p: Uint8Array): boolean {
  return ((p[0] ?? 0) > 127) || ((p[1] ?? 0) > 127) || ((p[2] ?? 0) > 127);
}

/**
 * Pure classifier. Three 1×1 RGBA pixels: control (no cull), ccw, cw.
 * Black control → UNKNOWN. Exactly one of ccw/cw lit → that winding.
 * Anything else (both, neither) → UNKNOWN, cull off.
 */
export function classifyProbePixels(
  control: Uint8Array,
  ccw: Uint8Array,
  cw: Uint8Array,
): WindingProbeOutcome {
  if (!pixelLit(control)) {
    return {
      ...WINDING_UNKNOWN,
      detail: 'control triangle (cull none) did not write; probe inconclusive, culling disabled',
    };
  }
  const ccwOn = pixelLit(ccw);
  const cwOn = pixelLit(cw);
  if (ccwOn && !cwOn) {
    return {
      frontFace: 'ccw',
      observed: 'ccw',
      fallbackNoCull: false,
      detail: "'ccw' matches CCW-in-NDC; outward geometry is front-facing",
    };
  }
  if (cwOn && !ccwOn) {
    return {
      frontFace: 'cw',
      observed: 'cw',
      fallbackNoCull: false,
      detail: "'ccw' is evaluated after the framebuffer Y flip; using 'cw' for outward geometry",
    };
  }
  return {
    ...WINDING_UNKNOWN,
    detail:
      `ambiguous probe (ccw ${ccwOn ? 'lit' : 'dark'}, cw ${cwOn ? 'lit' : 'dark'}); culling disabled`,
  };
}

async function drawProbe(
  device: GPUDevice,
  module: GPUShaderModule,
  format: GPUTextureFormat,
  texture: GPUTexture,
  readback: GPUBuffer,
  primitive: GPUPrimitiveState,
): Promise<Uint8Array> {
  const pipeline = device.createRenderPipeline({
    label: 'winding-probe',
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', ...primitive },
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
  return pixel;
}

/**
 * Run the probe. Never throws: a probe that cannot run yields
 * `fallbackNoCull`, which renders correctly (a convex closed body draws the
 * same with culling off, at the cost of some overdraw) rather than risking a
 * black screen.
 */
export async function probeWindingConvention(device: GPUDevice): Promise<WindingProbeOutcome> {
  let texture: GPUTexture | undefined;
  let readback: GPUBuffer | undefined;
  let pushed = 0;
  try {
    if (typeof device.pushErrorScope === 'function') {
      device.pushErrorScope('out-of-memory');
      device.pushErrorScope('validation');
      pushed = 2;
    }

    const format: GPUTextureFormat = 'rgba8unorm';
    texture = device.createTexture({
      label: 'winding-probe',
      size: { width: 1, height: 1 },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    const module = device.createShaderModule({ code: PROBE_WGSL, label: 'winding-probe' });

    // 256-byte row alignment is required by copyTextureToBuffer.
    readback = device.createBuffer({
      label: 'winding-probe-readback',
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const control = await drawProbe(device, module, format, texture, readback, { cullMode: 'none' });
    const ccw = await drawProbe(device, module, format, texture, readback, {
      cullMode: 'back',
      frontFace: 'ccw',
    });
    const cw = await drawProbe(device, module, format, texture, readback, {
      cullMode: 'back',
      frontFace: 'cw',
    });

    while (pushed > 0) {
      const err = await device.popErrorScope();
      pushed--;
      if (err !== null) {
        return {
          ...WINDING_UNKNOWN,
          detail: `probe GPU error (${err.message}); culling disabled`,
        };
      }
    }

    return classifyProbePixels(control, ccw, cw);
  } catch (err) {
    while (pushed > 0) {
      try {
        await device.popErrorScope();
      } catch {
        /* the device itself is hostile */
      }
      pushed--;
    }
    return {
      ...WINDING_UNKNOWN,
      detail: `probe failed (${err instanceof Error ? err.message : String(err)}); culling disabled`,
    };
  } finally {
    readback?.destroy();
    texture?.destroy();
  }
}
