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

describe('M11 deep-time stress', () => {
  it('advances 4.5 Gyr through temporal LOD without divergence', () => {
    const world = createWorld({ seed: makeSeed(0x45, 0x13), terrainLevel: 3,
      hydrologyLevel: 3, climateN: 2,
      genesis: { level: 3, plateCount: 7, steps: 12 }, erode: false });
    const started = Date.now();
    world.advanceDeepTime(4.5e9);
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
});
