/**
 * Offscreen frame capture (T-0150).
 *
 * WHY THIS EXISTS. Two reasons, and both matter.
 *
 * As a PRODUCT feature it is "save an image of what I am looking at", which a
 * world simulator should obviously be able to do.
 *
 * As an ENGINEERING instrument it is the only way to see the renderer's output
 * in an environment whose browser cannot present a WebGPU canvas to the
 * compositor. Headless Chromium with SwiftShader renders correctly — a
 * read-back render target comes out pixel-correct — but the canvas presents
 * nothing, so a page screenshot of the live application is blank while the
 * simulation and the pipelines are running perfectly. Rendering into a texture
 * and copying it back sidesteps the swapchain entirely, which turns "the tests
 * pass so it probably looks right" into looking at it.
 *
 * It is the SAME renderer, the same pipelines, the same shaders and the same
 * world: only the presentation surface differs.
 */

import type { CameraState, PlanetRenderer } from '@ws/render';

/** 256-byte row alignment, required by `copyTextureToBuffer`. */
const ROW_ALIGN = 256;

export interface CaptureResult {
  readonly width: number;
  readonly height: number;
  /** RGBA8, tightly packed, row-major from the top. */
  readonly pixels: Uint8Array;
}

export class FrameCapture {
  private texture: GPUTexture | null = null;
  private buffer: GPUBuffer | null = null;
  private size = { w: 0, h: 0 };

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
  ) {}

  private ensure(w: number, h: number): void {
    if (this.texture !== null && this.size.w === w && this.size.h === h) return;
    this.texture?.destroy();
    this.buffer?.destroy();
    this.texture = this.device.createTexture({
      label: 'capture-colour',
      size: { width: w, height: h },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const bytesPerRow = Math.ceil((w * 4) / ROW_ALIGN) * ROW_ALIGN;
    this.buffer = this.device.createBuffer({
      label: 'capture-readback',
      size: bytesPerRow * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.size = { w, h };
  }

  /**
   * Render one frame through `renderer` into an offscreen target and read it
   * back. The renderer is not told this is a capture: it draws exactly what it
   * would draw to the canvas.
   */
  async capture(
    renderer: PlanetRenderer, cam: CameraState, w: number, h: number,
  ): Promise<CaptureResult> {
    this.ensure(w, h);
    const texture = this.texture as GPUTexture;
    const buffer = this.buffer as GPUBuffer;
    renderer.render(cam, texture.createView(), w, h);

    const bytesPerRow = Math.ceil((w * 4) / ROW_ALIGN) * ROW_ALIGN;
    const encoder = this.device.createCommandEncoder({ label: 'capture-copy' });
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width: w, height: h });
    this.device.queue.submit([encoder.finish()]);

    await buffer.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8Array(w * h * 4);
    const bgra = this.format.startsWith('bgra');
    for (let y = 0; y < h; y++) {
      const src = y * bytesPerRow;
      const dst = y * w * 4;
      for (let x = 0; x < w; x++) {
        const s = src + x * 4;
        const d = dst + x * 4;
        /* The preferred canvas format is often BGRA; an image is RGBA. */
        pixels[d] = (bgra ? padded[s + 2] : padded[s]) as number;
        pixels[d + 1] = padded[s + 1] as number;
        pixels[d + 2] = (bgra ? padded[s] : padded[s + 2]) as number;
        pixels[d + 3] = 255;
      }
    }
    buffer.unmap();
    return { width: w, height: h, pixels };
  }

  destroy(): void {
    this.texture?.destroy();
    this.buffer?.destroy();
    this.texture = null;
    this.buffer = null;
  }
}

/**
 * Summary statistics of a captured frame.
 *
 * Looking at a thumbnail tells you something is wrong; it does not tell you
 * whether the frame is dark because the sun is down, because the exposure is
 * off, or because a pipeline silently failed. These numbers separate those.
 */
export interface CaptureStats {
  readonly meanLuminance: number;
  readonly p01: number;
  readonly p50: number;
  readonly p99: number;
  /** Fraction of pixels below 2/255 — a black screen scores near 1. */
  readonly blackFraction: number;
  /** Fraction above 250/255: blown highlights. */
  readonly clippedFraction: number;
  readonly meanRgb: readonly [number, number, number];
}

export function captureStats(result: CaptureResult): CaptureStats {
  const n = result.width * result.height;
  const hist = new Int32Array(256);
  let sum = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    const R = result.pixels[i * 4] as number;
    const G = result.pixels[i * 4 + 1] as number;
    const B = result.pixels[i * 4 + 2] as number;
    r += R; g += G; b += B;
    const y = Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B);
    hist[y] = (hist[y] as number) + 1;
    sum += y;
  }
  const quantile = (q: number): number => {
    let acc = 0;
    const want = q * n;
    for (let v = 0; v < 256; v++) {
      acc += hist[v] as number;
      if (acc >= want) return v;
    }
    return 255;
  };
  let black = 0;
  for (let v = 0; v < 2; v++) black += hist[v] as number;
  let clipped = 0;
  for (let v = 250; v < 256; v++) clipped += hist[v] as number;
  return {
    meanLuminance: sum / n,
    p01: quantile(0.01), p50: quantile(0.5), p99: quantile(0.99),
    blackFraction: black / n, clippedFraction: clipped / n,
    meanRgb: [r / n, g / n, b / n],
  };
}

/** Encode a capture as a PNG data URL through a 2D canvas. */
export function captureToDataUrl(result: CaptureResult): string {
  const canvas = document.createElement('canvas');
  canvas.width = result.width;
  canvas.height = result.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2D context for capture encoding');
  const image = ctx.createImageData(result.width, result.height);
  image.data.set(result.pixels);
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}
