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
  // The original M0 finding, kept as the regression it is: the constants that
  // Architecture v0 shipped describe a design nobody wanted.
  it('the v0 constants (1000 patches of 65x65 at 1440p) were 0.45 px/triangle', () => {
    const v0PatchTris = budgets.patchTriangles(65);
    expect(v0PatchTris).toBe(8192);
    const px = 2560 * 1440;
    expect(px / (v0PatchTris * 1000)).toBeLessThan(0.5);
  });

  // DEC-032: the budget is now a function, and it cannot produce that result.
  it('resolvePatchBudget never returns a sub-2px/triangle budget', () => {
    for (const tier of ['discrete', 'integrated', 'floor'] as const) {
      for (const n of [17, 33, 65]) {
        for (const px of [1920 * 1080, 2560 * 1440, 3840 * 2160]) {
          const b = budgets.resolvePatchBudget({
            pixelCount: px,
            gpuTier: tier,
            patchVerticesPerSide: n,
          });
          expect(b.pxPerTriangle).toBeGreaterThanOrEqual(budgets.QUALITY.minPxPerTriangle);
          expect(b.maxVisiblePatches).toBeGreaterThan(0);
          expect(b.maxVisiblePatches).toBeLessThanOrEqual(
            budgets.QUALITY.absoluteMaxVisiblePatches,
          );
        }
      }
    }
  });

  it('a bigger patch buys fewer patches, at constant triangle budget', () => {
    const req = { pixelCount: 2560 * 1440, gpuTier: 'discrete' as const };
    const a = budgets.resolvePatchBudget({ ...req, patchVerticesPerSide: 33 });
    const b = budgets.resolvePatchBudget({ ...req, patchVerticesPerSide: 65 });
    expect(b.maxVisiblePatches).toBeLessThan(a.maxVisiblePatches);
    // 65x65 is 4x the triangles of 33x33, so the patch counts differ ~4x and the
    // triangle totals land within rounding of each other.
    expect(a.maxTriangles).toBeCloseTo(b.maxTriangles, -3);
  });

  it('the floor tier gets a smaller budget than discrete at the same pixels', () => {
    const req = { pixelCount: 1920 * 1080, patchVerticesPerSide: 33 };
    const d = budgets.resolvePatchBudget({ ...req, gpuTier: 'discrete' });
    const f = budgets.resolvePatchBudget({ ...req, gpuTier: 'floor' });
    expect(f.maxVisiblePatches).toBeLessThan(d.maxVisiblePatches);
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
