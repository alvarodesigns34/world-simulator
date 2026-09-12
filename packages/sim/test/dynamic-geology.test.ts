import { describe, expect, it } from 'vitest';
import { duration, makeSeed } from '@ws/core';
import {
  BND_CONVERGENT,
  BND_DIVERGENT,
  CRUST_CONTINENT,
  DEFAULT_GENESIS,
  createWorld,
  geologyDigest,
  initDynamicGeology,
  runGenesis,
  stepDynamicGeology,
} from '@ws/sim';

const seed = makeSeed(0x7721, 0x3377);
const cfg = { seed, ...DEFAULT_GENESIS, level: 3, steps: 25, plateCount: 8 };

describe('M7 dynamic geology', () => {
  it('moves persistent Euler-pole plates and changes authoritative geometry', () => {
    const g = runGenesis(cfg);
    const before = g.plateId.slice();
    const s = initDynamicGeology(cfg, g);
    stepDynamicGeology(s, 20);
    let moved = 0;
    for (let i = 0; i < g.cellCount; i++) if (g.plateId[i] !== before[i]) moved++;
    expect(moved).toBeGreaterThan(0);
    expect(s.elapsedMyr).toBe(20);
  });

  it('creates mountain belts, rifts/new crust and closes crust area accounting', () => {
    const g = runGenesis(cfg);
    const s = initDynamicGeology(cfg, g);
    stepDynamicGeology(s, 10);
    let convergentLand = 0;
    let divergent = 0;
    for (let i = 0; i < g.cellCount; i++) {
      if (g.boundaryType[i] === BND_CONVERGENT && g.crustType[i] === CRUST_CONTINENT) {
        convergentLand++;
        expect(g.crustThicknessKm[i] as number).toBeGreaterThan(35);
      }
      if (g.boundaryType[i] === BND_DIVERGENT) divergent++;
    }
    expect(convergentLand).toBeGreaterThan(0);
    expect(divergent).toBeGreaterThan(0);
    expect(s.crustMassRelativeError).toBeLessThanOrEqual(1e-12);
  });

  it('is deterministic and finite across a 100 Myr coarsened run', () => {
    const ga = runGenesis(cfg); const gb = runGenesis(cfg);
    const a = initDynamicGeology(cfg, ga); const b = initDynamicGeology(cfg, gb);
    for (let k = 0; k < 100; k++) { stepDynamicGeology(a, 1); stepDynamicGeology(b, 1); }
    expect(geologyDigest(ga)).toBe(geologyDigest(gb));
    for (let i = 0; i < ga.cellCount; i++) {
      expect(Number.isFinite(ga.elevationM[i] as number)).toBe(true);
      expect(ga.elevationM[i] as number).toBeGreaterThanOrEqual(-10800);
      expect(ga.elevationM[i] as number).toBeLessThanOrEqual(8900);
    }
  });

  it('invalidates hydrology and survives T0→T4→T0 without step explosion', () => {
    const w = createWorld({ seed, genesis: { level: 3, steps: 20, plateCount: 7 }, terrainLevel: 3, climateN: 2, erode: false });
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    w.scheduler.advance(duration(100_001 * w.calendar.secondsPerYear));
    expect(w.dynamicGeology.generation).toBeGreaterThan(0);
    expect(w.hydrology.routingGeneration).toBeGreaterThan(0);
    w.apply({ kind: 'setTimeScale', scale: 1 });
    w.scheduler.advance(duration(3600));
    expect(w.climate.regime).toBe('explicit');
    expect(Number.isFinite(w.climate.T[0] as number)).toBe(true);
    expect(Number.isFinite(w.biosphere.populationDensity[0] as number)).toBe(true);
  });
});
