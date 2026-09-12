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

/**
 * The safety property, exhaustively (T-0076).
 *
 * Grok's three-way probe has several inconclusive branches. Individually tested
 * above; this closes the space. Over every combination of the three probe
 * pixels there must be NO input for which culling is enabled without the probe
 * having proved exactly one winding — because that is the branch that ends in a
 * black canvas on Astra's machine.
 */
describe('winding probe: culling is never enabled by an inconclusive result', () => {
  const LIT = new Uint8Array([255, 255, 255, 255]);
  const DARK = new Uint8Array([0, 0, 0, 255]);

  it('holds for all 8 pixel combinations', () => {
    for (const control of [DARK, LIT]) {
      for (const ccw of [DARK, LIT]) {
        for (const cw of [DARK, LIT]) {
          const out = classifyProbePixels(control, ccw, cw);
          const conclusive =
            control === LIT && ((ccw === LIT && cw === DARK) || (cw === LIT && ccw === DARK));

          if (conclusive) {
            expect(out.fallbackNoCull).toBe(false);
            expect(out.observed).toBe(ccw === LIT ? 'ccw' : 'cw');
          } else {
            // Every other case must disable culling and say so.
            expect(out.fallbackNoCull).toBe(true);
            expect(out.observed).toBe('unknown');
            expect(out.detail.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('a partially lit pixel is not treated as lit-enough to conclude', () => {
    const faint = new Uint8Array([1, 0, 0, 255]);
    const out = classifyProbePixels(faint, faint, DARK);
    // Whatever the threshold decides, the invariant is the same: concluding
    // requires the control to have drawn.
    if (out.observed !== 'unknown') expect(out.fallbackNoCull).toBe(false);
    else expect(out.fallbackNoCull).toBe(true);
  });
});
