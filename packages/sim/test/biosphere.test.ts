import { describe, expect, it } from 'vitest';
import { makeSeed } from '@ws/core';
import {
  BIOME,
  DEFAULT_GENESIS,
  deriveOcean,
  diagnoseBiomes,
  initBiosphere,
  initClimate,
  initHydrology,
  runGenesis,
  stepBiosphere,
} from '@ws/sim';

const seed = makeSeed(0x51a5, 0x1a51);

function fixture() {
  const geology = runGenesis({ seed, ...DEFAULT_GENESIS, level: 3, steps: 20, plateCount: 7 });
  const ocean = deriveOcean(geology);
  const climate = initClimate({ n: 2, geology, seaLevel: ocean.seaLevel, seed });
  const hydrology = initHydrology({ geology, ocean, climate, level: 3 });
  return hydrology;
}

describe('M6 biosphere', () => {
  it('classifies biomes from temperature and water, not random paint', () => {
    const h = fixture();
    const land: number[] = [];
    for (let i = 0; i < h.cellCount && land.length < 2; i++) if (h.ocean[i] === 0) land.push(i);
    expect(land).toHaveLength(2);
    const wet = land[0] as number;
    const dry = land[1] as number;
    h.temperatureK[wet] = 300; h.soilMoistureM[wet] = 0.25; h.glacierM[wet] = 0;
    h.temperatureK[dry] = 300; h.soilMoistureM[dry] = 0.005; h.glacierM[dry] = 0;
    const s = initBiosphere(h);
    diagnoseBiomes(s, h);
    expect(s.biome[wet]).toBe(BIOME.TROPICAL_FOREST);
    expect(s.biome[dry]).toBe(BIOME.DESERT);
  });

  it('vegetation and trophic pools are deterministic and bounded', () => {
    const ha = fixture();
    const hb = fixture();
    const a = initBiosphere(ha);
    const b = initBiosphere(hb);
    for (let k = 0; k < 80; k++) {
      stepBiosphere(a, ha, 0.25, (k % 4) / 4);
      stepBiosphere(b, hb, 0.25, (k % 4) / 4);
    }
    expect(Array.from(a.biome)).toEqual(Array.from(b.biome));
    expect(Array.from(a.populationDensity)).toEqual(Array.from(b.populationDensity));
    for (let i = 0; i < a.cellCount; i++) {
      expect(Number.isFinite(a.biomassKgM2[i] as number)).toBe(true);
      expect(a.populationDensity[i] as number).toBeGreaterThanOrEqual(0);
      expect(a.populationDensity[i] as number).toBeLessThan(100);
      if (ha.ocean[i] !== 0 || a.biome[i] === BIOME.ICE) expect(a.populationDensity[i]).toBe(0);
    }
  });

  it('phenology responds to snow/drought and populations can go extinct', () => {
    const h = fixture();
    const s = initBiosphere(h);
    let land = -1;
    for (let i = 0; i < h.cellCount; i++) if (h.ocean[i] === 0) { land = i; break; }
    h.snowpackM[land] = 2; h.temperatureK[land] = 250; h.glacierM[land] = 2;
    stepBiosphere(s, h, 1, 0);
    expect(s.phenology[land]).toBeLessThan(0.1);
    expect(s.populationDensity[land]).toBe(0);
  });
});
