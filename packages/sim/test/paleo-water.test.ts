/**
 * T-0131 / T-0136 / T-0138. Paleo water and carbon must integrate the
 * interval they were handed, not a 1-year / 20-year cap on it.
 *
 * Same class as the soil bug (T-0083): an Euler (or a representative-window
 * cap) that is harmless at an hourly cadence drops 99.99 % of a 100 kyr
 * paleo step. Soil was repaired with a closed form; snow, ice, sea-level and
 * biomass were not. These tests are the ones that cannot pass against the cap.
 */

import { describe, expect, it } from 'vitest';
import { EARTH_CALENDAR, makeSeed } from '@ws/core';
import {
  createWorld,
  initBiosphere,
  stepBiosphere,
  stepClimate,
  stepHydrology,
  syncHydrologyCoast,
} from '../src/index.js';

const YEAR = EARTH_CALENDAR.secondsPerYear;

function hydroWorld() {
  const w = createWorld({
    seed: makeSeed(3, 7), terrainLevel: 3, hydrologyLevel: 3,
    climateN: 2, genesis: { level: 3, plateCount: 7, steps: 12 }, erode: false,
  });
  for (let i = 0; i < 20; i++) stepClimate(w.climate, 3600, 0.1);
  return w;
}

function meanLand(
  w: ReturnType<typeof hydroWorld>,
  pick: 'snow' | 'ice',
): number {
  const arr = pick === 'snow' ? w.hydrology.snowpackM : w.hydrology.glacierM;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < w.hydrology.cellCount; i++) {
    if (w.hydrology.ocean[i] !== 0) continue;
    sum += arr[i] as number;
    n++;
  }
  return sum / Math.max(1, n);
}

function runHydro(count: number, years: number): { snow: number; ice: number; sl: number } {
  const w = hydroWorld();
  for (let i = 0; i < count; i++) stepHydrology(w.hydrology, w.climate, years * YEAR);
  return { snow: meanLand(w, 'snow'), ice: meanLand(w, 'ice'), sl: w.hydrology.seaLevelM };
}

describe('T-0131 paleo snow/ice/sea-level is path-independent under constant forcing', () => {
  it('agrees between 1 × 100 kyr and 100 × 1 kyr', () => {
    const one = runHydro(1, 100_000);
    const many = runHydro(100, 1_000);
    expect(many.snow).toBeCloseTo(one.snow, 6);
    expect(many.ice).toBeCloseTo(one.ice, 6);
    expect(many.sl).toBeCloseTo(one.sl, 5);
    /* And it is not the 1-year-capped answer: a single year of snow is a
       different planet from a hundred millennia of it. */
    const year = runHydro(1, 1);
    expect(Math.abs(one.snow - year.snow) + Math.abs(one.ice - year.ice)).toBeGreaterThan(1e-4);
  }, 120_000);
});

describe('T-0138 sea-level reclassifies hydrology.ocean in the same step', () => {
  it('cells with elevation in (oldSL, newSL) become ocean within a hydrology step', () => {
    const w = hydroWorld();
    const h = w.hydrology;
    let land = -1;
    for (let i = 0; i < h.cellCount; i++) if (h.ocean[i] === 0) { land = i; break; }
    expect(land).toBeGreaterThanOrEqual(0);
    /* Drop sea level with a pile of ice, then raise it by removing the ice. */
    h.glacierM[land] = 50_000;
    stepHydrology(h, w.climate, 0);
    syncHydrologyCoast(h);
    const low = h.seaLevelM;
    h.glacierM.fill(0);
    h.snowpackM.fill(0);
    stepHydrology(h, w.climate, 0);
    syncHydrologyCoast(h);
    const high = h.seaLevelM;
    expect(high).toBeGreaterThan(low);

    let inBand = 0;
    for (let i = 0; i < h.cellCount; i++) {
      const elev = h.elevationM[i] as number;
      if (elev > low && elev < high) {
        expect(h.ocean[i], `cell ${String(i)} at ${String(elev)} m should be ocean`).toBe(1);
        inBand++;
      }
    }
    expect(inBand).toBeGreaterThan(0);
  }, 60_000);
});

describe('T-0136 paleo biosphere integrates the interval, not 20 years of it', () => {
  it('biomass agrees between 1 × 100 kyr and 100 × 1 kyr', () => {
    const h = hydroWorld().hydrology;
    const run = (count: number, years: number): number => {
      const s = initBiosphere(h);
      for (let i = 0; i < count; i++) stepBiosphere(s, h, years, 0.25);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < s.cellCount; i++) {
        if (s.biome[i] === 0 || s.biome[i] === 1) continue;
        sum += s.biomassKgM2[i] as number;
        n++;
      }
      return sum / Math.max(1, n);
    };
    const one = run(1, 100_000);
    const many = run(100, 1_000);
    expect(many).toBeCloseTo(one, 4);
    expect(one).toBeGreaterThan(0);
  }, 60_000);
});
