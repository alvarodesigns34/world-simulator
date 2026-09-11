/**
 * Independent Architecture v0 checks (Grok) against core claims.
 */
import { describe, expect, it } from 'vitest';
import { budgets, DOMAIN, EARTH_CALENDAR, hashU32, makeSeed } from '@ws/core';

const SPY = EARTH_CALENDAR.secondsPerYear;

function ulp(x: number): number {
  const ax = Math.abs(x);
  const exp = Math.floor(Math.log2(ax));
  return 2 ** (exp - 52);
}

describe('audit: DEC-014 ulp figure in the docs is wrong', () => {
  it('f64 ulp at 1e6 years is 3.90625 ms, not 7.8 ms', () => {
    const t = 1e6 * SPY;
    expect(ulp(t)).toBe(0.00390625);
    // x * EPSILON is the formula that produces the ~7 ms figure. It is not ulp.
    expect(t * Number.EPSILON).toBeGreaterThan(0.006);
    expect(t * Number.EPSILON).toBeLessThan(0.008);
    expect(t * Number.EPSILON).not.toBe(ulp(t));
  });

  it('1/60 s rounds to 1/64 s at year 1e6, which is what kills the flat counter', () => {
    const t = 1e6 * SPY;
    const rounded = Math.round(1 / 60 / ulp(t)) * ulp(t);
    expect(rounded).toBe(1 / 64);
  });
});

describe('audit: hash width vs DEC-017', () => {
  it('hashU32 output is 32-bit; L11-scale birthday collisions are tens of thousands', () => {
    const n = 25_165_824;
    const expected = (n * (n - 1)) / 2 / 2 ** 32;
    expect(expected).toBeGreaterThan(50_000);
    const h = hashU32(makeSeed(1, 2), DOMAIN.TERRAIN_BASE, 0, 0, 0);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('audit: budgets.ts triangle arithmetic', () => {
  it('1000 patches of 65×65 at 1440p is 0.45 pixels per triangle', () => {
    expect(budgets.PATCH_TRIANGLES).toBe(8192);
    expect(budgets.MAX_TRIANGLES).toBe(8192 * budgets.QUALITY.maxVisiblePatches);
    const px = 2560 * 1440;
    const pxPerTri = px / (budgets.PATCH_TRIANGLES * 1000);
    expect(pxPerTri).toBeLessThan(0.5);
  });

  it('main-thread zones still sum to the stated total', () => {
    const sum = Object.values(budgets.MAIN_THREAD.zones).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(budgets.MAIN_THREAD.total, 6);
  });

  it('GPU zones still sum to the stated total', () => {
    const sum = Object.values(budgets.GPU.zones).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(budgets.GPU.total, 6);
  });

  it('CPU sim + tile cache already consume the 1.0 GB that is not GPU', () => {
    expect(budgets.MEMORY_BYTES.simState + budgets.MEMORY_BYTES.tileCacheCpu).toBe(
      1000 * 1024 * 1024,
    );
  });
});
