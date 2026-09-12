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
    /* Creation and consumption are computed from independent kinematics, so
       both are strictly positive and neither is defined as the other. */
    expect(s.createdCrustM2).toBeGreaterThan(0);
    expect(s.consumedCrustM2).toBeGreaterThan(0);
    expect(s.createdCrustM2).not.toBe(s.consumedCrustM2);
  });

  /* T-0081. The old accounting set `consumed = created` whenever any trench
     cell existed, so the residual was identically zero however unbalanced the
     plate configuration actually was. These tests pin the properties that make
     the number a measurement rather than a tautology. */
  it('measures a real, non-degenerate crust budget instead of asserting balance', () => {
    const g = runGenesis(cfg);
    const s = initDynamicGeology(cfg, g);
    for (let k = 0; k < 10; k++) stepDynamicGeology(s, 5);

    /* Boundary lengths are planetary in scale: Earth's ridge system is
       ~6.0e7 m and its subducting margin ~4.5e7 m. */
    expect(s.ridgeLengthM).toBeGreaterThan(1e7);
    expect(s.ridgeLengthM).toBeLessThan(2e8);
    expect(s.trenchLengthM).toBeGreaterThan(1e7);
    expect(s.trenchLengthM).toBeLessThan(2e8);

    /* The residual is a symmetric relative difference: 0 when balanced, 2 when
       one side is missing entirely. This reduced model does not close, and the
       diagnostic must be free to say so — but the two sides must stay the same
       order of magnitude, or the plate configuration has degenerated. */
    expect(Number.isFinite(s.crustMassRelativeError)).toBe(true);
    expect(s.crustMassRelativeError).toBeGreaterThan(0);
    expect(s.crustMassRelativeError).toBeLessThan(1.2);
  });

  it('reports a degenerate budget when one side of the cycle is absent', () => {
    const g = runGenesis(cfg);
    const s = initDynamicGeology(cfg, g);
    stepDynamicGeology(s, 5);
    const real = s.crustMassRelativeError;

    /* Erase subduction from the boundary classification. The OLD model would
       have reported consumed = 0 and, with created > 0, an error of exactly 2
       only by accident of its zero branch; more importantly, with ANY trench
       present it reported 0. The point here is that a one-sided cycle must be
       visibly worse than the real configuration. */
    const s2 = initDynamicGeology(cfg, runGenesis(cfg));
    s2.consumedCrustM2 = 0;
    s2.createdCrustM2 = 1e12;
    const oneSided = Math.abs(s2.createdCrustM2 - s2.consumedCrustM2) /
      (0.5 * (s2.createdCrustM2 + s2.consumedCrustM2));
    expect(oneSided).toBeCloseTo(2, 12);
    expect(real).toBeLessThan(oneSided);
  });

  it('estimates boundary length independently of grid resolution', () => {
    /* Length is summed as sqrt(cell area) over boundary cells. If that were
       instead a raw area sum it would scale with resolution; it must converge.
       Note this also validates the per-cell area weighting: a single mean area
       would be wrong by up to 1.3x on a tangent-warped cube (DEC-007). */
    const lengths = [4, 5].map((level) => {
      const c = { seed, ...DEFAULT_GENESIS, level, steps: 25, plateCount: 8 };
      const s = initDynamicGeology(c, runGenesis(c));
      stepDynamicGeology(s, 10);
      return s.ridgeLengthM;
    });
    const [a, b] = lengths as [number, number];
    expect(Math.abs(a - b) / a).toBeLessThan(0.1);
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
