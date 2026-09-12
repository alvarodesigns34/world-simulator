import { describe, expect, it } from 'vitest';
import { WINDING_UNKNOWN, probeWindingConvention } from '@ws/render';

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
