import { describe, expect, it } from 'vitest';
import { EARTH_CALENDAR, makeSeed } from '@ws/core';
import {
  COMMODITY,
  createWorld,
  endowmentAt,
  stepClimate,
  stepCivilisation,
  stepEconomy,
  stepHydrology,
} from '../src/index.js';

const log = (label: string, value: unknown): void =>
  (globalThis as unknown as { console: { log(message: string): void } }).console.log(`${label} ${JSON.stringify(value)}`);

function meanLand(values: ArrayLike<number>, ocean: Uint8Array): number {
  let sum = 0; let n = 0;
  for (let i = 0; i < values.length; i++) if (ocean[i] === 0) { sum += values[i] as number; n++; }
  return sum / Math.max(1, n);
}

describe('M1-M10 directed consolidation diagnostics', () => {
  it('classifies long-run soil moisture as path-independent equilibration', () => {
    const make = () => createWorld({ seed: makeSeed(3, 7), terrainLevel: 3, hydrologyLevel: 3,
      climateN: 2, genesis: { level: 3, plateCount: 7, steps: 12 }, erode: false });
    const paths = [
      { name: 'climatology', count: 800, years: 1_000 },
      { name: 'paleo', count: 8, years: 100_000 },
      { name: 'single', count: 1, years: 800_000 },
    ];
    const result = paths.map((path) => {
      const world = make();
      for (let i = 0; i < 20; i++) stepClimate(world.climate, 3600, 0.1);
      const initial = meanLand(world.hydrology.soilMoistureM, world.hydrology.ocean);
      for (let i = 0; i < path.count; i++) stepHydrology(world.hydrology, world.climate,
        path.years * EARTH_CALENDAR.secondsPerYear);
      return { path: path.name, initial, final: meanLand(world.hydrology.soilMoistureM, world.hydrology.ocean),
        precipitationM3: world.hydrology.budget.precipitationM3,
        evaporationM3: world.hydrology.budget.evaporationM3,
        oceanOutflowM3: world.hydrology.budget.oceanOutflowM3,
        storageChangeM3: world.hydrology.budget.storageChangeM3,
        residualFraction: Math.abs(world.hydrology.budget.residualM3) /
          Math.max(1, world.hydrology.budget.precipitationM3) };
    });
    const finals = result.map((r) => r.final);
    log('SOIL_DIAGNOSTIC', result);
    expect(Math.max(...finals) - Math.min(...finals)).toBeLessThan(2e-3);
    /* The reduced column closure should settle to a live, non-zero land
       bucket; an all-zero result would still be a cadence-independent bug. */
    expect(finals.every((v) => v > 0.01 && v < 0.1)).toBe(true);
    expect(result.every((r) => r.residualFraction < 1e-6)).toBe(true);
  }, 30_000);

  it('measures ore anti-correlation and economy outcomes across ten seeds', () => {
    const rows = [];
    for (let seedIndex = 0; seedIndex < 10; seedIndex++) {
      const seed = makeSeed(0x100 + seedIndex, 0x700 + seedIndex * 17);
      const world = createWorld({ seed, terrainLevel: 3, hydrologyLevel: 3, climateN: 2,
        genesis: { level: 3, plateCount: 7, steps: 12 }, erode: false });
      world.civilisation.detail = 'aggregate';
      for (let i = 0; i < 96; i++) stepCivilisation(world.civilisation, world.hydrology, 500, { seed });
      for (let i = 0; i < 4; i++) stepEconomy(world.economy, world.civilisation, world.hydrology, 100);
      let planet = 0; let settled = 0; let settledCells = 0;
      for (let cell = 0; cell < world.economy.cellCount; cell++) {
        const ore = endowmentAt(world.economy.resources, cell, COMMODITY.ORE);
        planet += ore;
        const owner = world.civilisation.claim[cell] as number;
        if (owner >= 0 && world.civilisation.store.aliveAt(owner)) { settled += ore; settledCells++; }
      }
      const prices = world.economy.price;
      let priceMean = 0;
      for (let i = 0; i < prices.length; i++) priceMean += prices[i] as number;
      const extracted = world.economy.extracted.reduce((a, b) => a + b, 0);
      const planetaryMean = planet / world.economy.cellCount;
      const settledMean = settled / Math.max(1, settledCells);
      rows.push({ seed: seedIndex, planetaryMean, settledMean, ratio: planetaryMean / Math.max(1e-12, settledMean),
        priceMean: priceMean / prices.length, trade: world.economy.totalTrade,
        depletion: extracted, shortage: world.economy.worstShortage,
        settlements: world.civilisation.store.count });
    }
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => Object.values(row).every(Number.isFinite))).toBe(true);
    expect(rows.filter((row) => row.settlements > 0).length).toBeGreaterThanOrEqual(8);
    log('ABUNDANCE_DIAGNOSTIC', rows);
  }, 60_000);
});
