/**
 * T-0107. What "path-independent soil moisture" actually means.
 *
 * The source comment on the soil solver said: "One 100 kyr step and 10^5
 * one-year steps now agree, which is the path-independence DEC-030 requires of
 * slow state." The repository's own diagnostic then asserted the same thing
 * across three cadences — and every one of those cadences used chunks of a
 * thousand years or more, so all three took the same branch and all three
 * relaxed fully to equilibrium. Three paths that cannot disagree are not
 * evidence of path-independence; they are evidence that the test was not
 * sharp enough to find a disagreement.
 *
 * These tests are sharp. They establish, separately:
 *
 *   1. The closed form IS exactly path-independent under constant forcing,
 *      at chunk sizes comparable to the relaxation time, where a mistake
 *      would actually show. This is the real content of the claim.
 *
 *   2. There is ONE cadence dependence in the module, and it is not in the
 *      closed form: `stepHydrology` substitutes a reduced-column rainfall
 *      closure when it is handed a window of a thousand years or more with no
 *      live atmosphere behind it. Crossing that threshold changes the answer
 *      by orders of magnitude. It is a real discontinuity, it is confined to
 *      a diagnostic path, and it is measured here rather than left to be
 *      discovered.
 *
 *   3. The production path does not take it. A world advanced through the
 *      scheduler has a live atmosphere, so no cell falls back, and the soil
 *      settles somewhere habitable.
 */

import { describe, expect, it } from 'vitest';
import { EARTH_CALENDAR, makeSeed } from '@ws/core';
import { createWorld, duration, stepClimate, stepHydrology } from '../src/index.js';

const YEAR = EARTH_CALENDAR.secondsPerYear;

function world() {
  const w = createWorld({ seed: makeSeed(3, 7), terrainLevel: 3, hydrologyLevel: 3,
    climateN: 2, genesis: { level: 3, plateCount: 7, steps: 12 }, erode: false });
  /* A short atmospheric spin-up, matching the existing diagnostic, so the
     forcing is whatever it is — the point is that it is the SAME forcing for
     every chunking compared below. */
  for (let i = 0; i < 20; i++) stepClimate(w.climate, 3600, 0.1);
  return w;
}

function meanLandSoil(w: ReturnType<typeof world>): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < w.hydrology.cellCount; i++) {
    if (w.hydrology.ocean[i] !== 0) continue;
    sum += w.hydrology.soilMoistureM[i] as number;
    n++;
  }
  return sum / Math.max(1, n);
}

/** Run `count` hydrology steps of `years` each and report the land mean. */
function run(count: number, years: number): number {
  const w = world();
  for (let i = 0; i < count; i++) stepHydrology(w.hydrology, w.climate, years * YEAR);
  return meanLandSoil(w);
}

describe('M5 soil moisture: path independence, precisely', () => {
  /**
   * The relaxation time is capacity / lossRate, about 7 years. Chunks of 1, 8
   * and 32 years therefore span it: a solver that got the composition wrong —
   * an Euler step, or a recharge-then-evaporate sequence — diverges visibly
   * here, while at the thousand-year chunks the old diagnostic used, every
   * path saturates and the error is invisible.
   */
  it('agrees exactly across chunkings that span the relaxation time', () => {
    const one = run(1, 32);
    const four = run(4, 8);
    const many = run(32, 1);
    expect(four).toBeCloseTo(one, 12);
    expect(many).toBeCloseTo(one, 12);
    /* Relative, not absolute: the value is small, and an absolute tolerance
       would pass even if everything collapsed to zero. */
    expect(Math.abs(many - one) / Math.max(1e-12, one)).toBeLessThan(1e-9);
    expect(one).toBeGreaterThan(0);
  }, 60_000);

  it('agrees at every chunking below the reduced-column threshold', () => {
    const chunkings: readonly (readonly [number, number])[] = [
      [1, 999], [3, 333], [9, 111], [999, 1],
    ];
    const results = chunkings.map(([count, years]) => run(count, years));
    const lo = Math.min(...results);
    const hi = Math.max(...results);
    expect((hi - lo) / Math.max(1e-12, hi)).toBeLessThan(1e-9);
  }, 120_000);

  /**
   * THE ONE PLACE IT IS NOT PATH-INDEPENDENT, MEASURED.
   *
   * `stepHydrology` swaps in a reduced-column rainfall closure when the window
   * is >= 1000 years AND the atmosphere it was handed is effectively dry. That
   * is a deliberate fallback — a millennial water-budget window driven by no
   * atmosphere at all would otherwise integrate zero rain — but it is a HARD
   * threshold on the window length, so 1000 x 1 year and 1 x 1000 years are
   * driven by different rainfall and reach different answers.
   *
   * This test pins the discontinuity so it cannot be reintroduced silently and
   * cannot be described as absent. It is not asserted to be small: it is
   * asserted to be LARGE, because that is what it is.
   */
  it('changes regime at the 1000-year reduced-column threshold, and says so', () => {
    const below = run(999, 1);
    const above = run(1, 1000);
    expect(below).toBeGreaterThan(0);
    expect(above).toBeGreaterThan(0);
    /* Orders of magnitude apart. Naming the size is the honesty. */
    expect(above / below).toBeGreaterThan(100);
  }, 60_000);

  /**
   * And the production path does not take that branch, which is why this is a
   * declared limitation of a diagnostic entry point rather than a defect in
   * the simulation. A world advanced through the scheduler runs the atmosphere
   * first, so every cell has real precipitation.
   */
  it('never falls back in a world advanced through the scheduler', () => {
    const w = createWorld({ seed: makeSeed(3, 7), terrainLevel: 3, hydrologyLevel: 3,
      climateN: 2, genesis: { level: 3, plateCount: 7, steps: 12 }, erode: false });
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    for (let i = 0; i < 4; i++) w.scheduler.advance(duration(100_000 * YEAR));
    expect(w.climate.regime).toBe('paleo');

    let dry = 0;
    for (let i = 0; i < w.hydrology.cellCount; i++) {
      if ((w.hydrology.precipitationRate[i] as number) < 1e-8) dry++;
    }
    expect(dry, 'a cell with no rain would take the reduced-column fallback').toBe(0);

    /* And the planet it produces is not the dried-out one the closed form was
       introduced to prevent. */
    const soil = meanLandSoil(w);
    expect(soil).toBeGreaterThan(1e-3);
    expect(soil).toBeLessThan(0.35);
  }, 120_000);
});
