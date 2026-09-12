import { describe, expect, it } from 'vitest';
import { classifyProbePixels, WINDING_UNKNOWN, probeWindingConvention } from '@ws/render';

/**
 * FRONT-FACE CONVENTION (T-0062).
 *
 * WebGPU's NDC is y-up; its framebuffer is y-down. Whether `frontFace: 'ccw'`
 * is evaluated before or after that flip decides whether an outward-wound
 * sphere draws or is culled to a black screen — the exact failure mode Astra
 * spent an Ampere session on.
 *
 * No CPU test can answer it. What a CPU test CAN guarantee is that a failure to
 * answer it never produces a black screen: the fallback must disable culling.
 * A one-draw probe that treats a black pixel as "must be CW" is the guess that
 * blacks the canvas when the probe itself failed to draw.
 */
describe('winding probe: failure can never black the canvas', () => {
  it('the unknown outcome disables culling rather than guessing', () => {
    expect(WINDING_UNKNOWN.observed).toBe('unknown');
    expect(WINDING_UNKNOWN.fallbackNoCull).toBe(true);
  });

  it('never throws, whatever the device does', async () => {
    // Under Node there is no WebGPU at all — not even the GPUTextureUsage
    // globals — so this exercises the earliest possible failure. The contract
    // is the same at every later one: return, do not throw, disable culling.
    const hostile = {
      createTexture() {
        throw new Error('no adapter here');
      },
    } as unknown as GPUDevice;
    const outcome = await probeWindingConvention(hostile);
    expect(outcome.observed).toBe('unknown');
    expect(outcome.fallbackNoCull).toBe(true);
    expect(outcome.detail).toMatch(/probe failed/);
  });

  it('reports a frontFace even when it could not measure one', async () => {
    const outcome = await probeWindingConvention(undefined as unknown as GPUDevice);
    expect(['ccw', 'cw']).toContain(outcome.frontFace);
    expect(outcome.fallbackNoCull).toBe(true);
  });
});

describe('winding probe: classifyProbePixels (pure)', () => {
  const white = new Uint8Array([255, 255, 255, 255]);
  const black = new Uint8Array([0, 0, 0, 255]);

  it('control black → UNKNOWN, never a CW guess', () => {
    const r = classifyProbePixels(black, black, black);
    expect(r.observed).toBe('unknown');
    expect(r.fallbackNoCull).toBe(true);
    const guessed = classifyProbePixels(black, black, white);
    expect(guessed.observed).toBe('unknown');
    expect(guessed.fallbackNoCull).toBe(true);
  });

  it('control white + only ccw lit → ccw, culling on', () => {
    const r = classifyProbePixels(white, white, black);
    expect(r.observed).toBe('ccw');
    expect(r.frontFace).toBe('ccw');
    expect(r.fallbackNoCull).toBe(false);
  });

  it('control white + only cw lit → cw, culling on', () => {
    const r = classifyProbePixels(white, black, white);
    expect(r.observed).toBe('cw');
    expect(r.frontFace).toBe('cw');
    expect(r.fallbackNoCull).toBe(false);
  });

  it('ambiguous (both or neither) → UNKNOWN, culling off', () => {
    expect(classifyProbePixels(white, white, white).fallbackNoCull).toBe(true);
    expect(classifyProbePixels(white, black, black).fallbackNoCull).toBe(true);
  });
});
