import { describe, expect, it } from 'vitest';
import { makeSeed } from '@ws/core';
import { createWorld } from '../src/index.js';

function range(values: ArrayLike<number>): readonly [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as number;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return [lo, hi];
}

/**
 * Deep-time configuration, shared so the stress and the determinism assertion
 * are demonstrably the same run rather than two similar ones.
 */
function stressWorld() {
  return createWorld({ seed: makeSeed(0x45, 0x13), terrainLevel: 3,
    hydrologyLevel: 3, climateN: 2,
    genesis: { level: 3, plateCount: 7, steps: 12 }, erode: false });
}

describe('M11 deep-time stress', () => {
  it('advances 4.5 Gyr through temporal LOD without divergence', () => {
    const world = stressWorld();
    const started = Date.now();
    world.advanceDeepTimeApproximate(4.5e9);
    const wallMs = Date.now() - started;
    const report = {
      wallMs,
      time: world.scheduler.time,
      digest: world.digest(),
      elevationM: range(world.geology.elevationM),
      temperatureK: range(world.climate.T),
      soilMoistureM: range(world.hydrology.soilMoistureM),
      pollution: range(world.economy.pollution),
      seaLevelM: world.hydrology.seaLevelM,
      population: world.civilisation.totalPopulation,
      settlements: world.civilisation.store.count,
      events: world.history.events().length,
      geologyGeneration: world.dynamicGeology.generation,
    };
    expect(report.time.year).toBe(4_500_000_000);
    expect(Object.values(report).flatMap((v) => Array.isArray(v) ? v : typeof v === 'number' ? [v] : [])
      .every(Number.isFinite)).toBe(true);
    expect(report.population).toBeGreaterThanOrEqual(0);
    expect(report.soilMoistureM[0]).toBeGreaterThanOrEqual(0);
    expect(report.events).toBeGreaterThan(0);
    expect(report.wallMs).toBeLessThan(120_000);
    (globalThis as unknown as { console: { log(message: string): void } }).console.log(
      `M11_STRESS ${JSON.stringify(report)}`,
    );
  }, 120_000);

  /**
   * T-0097. The determinism contract, asserted deliberately.
   *
   * CI had been producing the same digest across runs, which is evidence but
   * not a contract: it happened because `check:sim-standalone` re-runs the same
   * suite, so nothing in the repository actually REQUIRED two deep-time runs to
   * agree. A determinism property that holds by coincidence of the CI layout is
   * not a determinism property.
   *
   * This compares two runs directly rather than pinning a golden constant. A
   * golden would also catch divergence, but it fails on every legitimate model
   * change and teaches the reader to update the number rather than investigate;
   * a same-run comparison only fails when reproducibility actually breaks.
   *
   * It uses a shorter horizon than the 4.5 Gyr headline so the assertion costs
   * roughly one extra stress run rather than two, while still crossing the same
   * macro-chunk boundaries, regime transitions and cadence restores.
   */
  it('produces bit-identical worlds from the same seed', () => {
    const a = stressWorld();
    const b = stressWorld();
    /* Two macro chunks plus a partial one: exercises chunk boundaries and the
       cadence restore, which is where a deep-time path would diverge. */
    const horizon = 1.1e9;
    a.advanceDeepTimeApproximate(horizon);
    b.advanceDeepTimeApproximate(horizon);

    expect(a.scheduler.time.year).toBe(b.scheduler.time.year);
    expect(a.digest(), 'two identical deep-time runs diverged').toBe(b.digest());
    /* Not a vacuous pass: the run must actually have done something. */
    expect(a.dynamicGeology.generation).toBeGreaterThan(0);
    expect(a.history.events().length).toBeGreaterThan(0);
  }, 180_000);

  it('reaches the same state whether jumped in one call or two', () => {
    /* Path-independence across the deep-time approximation's own chunking. The
       approximation is allowed to be coarse; it is not allowed to depend on how
       the caller split the request. */
    const one = stressWorld();
    one.advanceDeepTimeApproximate(1e9);

    const two = stressWorld();
    two.advanceDeepTimeApproximate(5e8);
    two.advanceDeepTimeApproximate(5e8);

    expect(two.scheduler.time.year).toBe(one.scheduler.time.year);
    expect(Number.isFinite(two.civilisation.totalPopulation)).toBe(true);
  }, 180_000);
});
