import { describe, expect, it } from 'vitest';
import { makeSeed } from '@ws/core';
import {
  DEFAULT_GENESIS,
  deriveOcean,
  initClimate,
  initHydrology,
  priorityFlood,
  runGenesis,
  stepClimate,
  stepHydrology,
} from '@ws/sim';

const seed = makeSeed(0x51a5, 0x1a51);

function fixture() {
  const geology = runGenesis({ seed, ...DEFAULT_GENESIS, level: 4, steps: 30, plateCount: 8 });
  const ocean = deriveOcean(geology);
  const climate = initClimate({ n: 3, geology, seaLevel: ocean.seaLevel, seed });
  for (let i = 0; i < 20; i++) stepClimate(climate, 3600, 0.1);
  return { geology, ocean, climate };
}

describe('M5 hydrology', () => {
  it('Priority-Flood resolves every land sink into an acyclic ocean path', () => {
    const { geology, ocean } = fixture();
    const elev = Float64Array.from(geology.elevationM);
    const flood = priorityFlood(elev, ocean.mask, geology.level);
    for (let i = 0; i < elev.length; i++) {
      expect(flood.filled[i] as number).toBeGreaterThanOrEqual(elev[i] as number);
      let p = i;
      let guard = 0;
      while ((flood.receiver[p] as number) >= 0 && guard <= elev.length) {
        p = flood.receiver[p] as number;
        guard++;
      }
      expect(guard).toBeLessThan(elev.length);
      expect(ocean.mask[p]).toBe(1);
    }
  });

  it('routes accumulation in O(N) topological order and labels every basin', () => {
    const f = fixture();
    const h = initHydrology({ ...f, level: 4 });
    expect(h.topologicalOrder.length).toBe(h.cellCount);
    for (let i = 0; i < h.cellCount; i++) {
      expect(h.basinId[i]).toBeGreaterThan(0);
      expect(h.contributingAreaM2[i] as number).toBeGreaterThanOrEqual(h.areaM2[i] as number);
      const r = h.receiver[i] as number;
      if (r >= 0) expect(h.filledM[r] as number).toBeLessThanOrEqual((h.filledM[i] as number) + 1e-9);
    }
  });

  it('closes the explicit water account and keeps storage non-negative', () => {
    const f = fixture();
    const h = initHydrology({ ...f, level: 4 });
    for (let i = 0; i < h.precipitationRate.length; i++) h.precipitationRate[i] = h.ocean[i] === 0 ? 1e-5 : 0;
    const b = stepHydrology(h, f.climate, 86400);
    const scale = Math.max(1, b.precipitationM3);
    expect(Math.abs(b.residualM3) / scale).toBeLessThan(1e-6);
    for (let i = 0; i < h.cellCount; i++) {
      expect(h.soilMoistureM[i] as number).toBeGreaterThanOrEqual(0);
      expect(h.snowpackM[i] as number).toBeGreaterThanOrEqual(0);
      expect(h.glacierM[i] as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps filled lakes at a stable spill level under constant forcing', () => {
    const f = fixture();
    const h = initHydrology({ ...f, level: 4 });
    expect(h.lakes.length).toBeGreaterThan(0);
    const initial = h.lakes.map((lake) => lake.volumeM3);
    for (let year = 0; year < 100; year++) stepHydrology(h, f.climate, 365.25 * 86400);
    for (let i = 0; i < h.lakes.length; i++) {
      expect(Math.abs((h.lakes[i]?.volumeM3 ?? 0) - (initial[i] ?? 0)) / Math.max(1, initial[i] ?? 1)).toBeLessThan(1e-12);
    }
    const scale = Math.max(1, h.budget.precipitationM3);
    expect(Math.abs(h.budget.residualM3) / scale).toBeLessThan(1e-6);
  });

  it('sea level rises when land ice is removed', () => {
    const f = fixture();
    const h = initHydrology({ ...f, level: 4 });
    let land = -1;
    for (let i = 0; i < h.cellCount; i++) if (h.ocean[i] === 0) { land = i; break; }
    expect(land).toBeGreaterThanOrEqual(0);
    h.glacierM[land] = 1000;
    stepHydrology(h, f.climate, 0);
    const glacial = h.seaLevelM;
    h.glacierM.fill(0);
    stepHydrology(h, f.climate, 0);
    expect(h.seaLevelM).toBeGreaterThan(glacial);
    expect(Math.abs(h.seaLevelM - h.referenceSeaLevelM)).toBeLessThan(1e-8);
  });

  it('global L6 routing stays within the 500 ms worker-job budget', () => {
    const f = fixture();
    const t0 = Date.now();
    const h = initHydrology({ ...f, level: 6 });
    const elapsed = Date.now() - t0;
    expect(h.cellCount).toBe(24576);
    expect(elapsed).toBeLessThan(500);
  });
});
