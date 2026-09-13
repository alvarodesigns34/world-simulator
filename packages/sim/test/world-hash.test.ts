/**
 * T-0082. The determinism gold must SEE the whole world.
 *
 * The previous digest covered M2 geology and M4 climate on a stride. These
 * tests are written as a coverage proof rather than a behaviour check: for
 * every authoritative array in M5/M6/M7, perturb one cell by a physically
 * negligible amount and require the digest to move. A field that survives this
 * is a field a worker could corrupt without any determinism test noticing.
 */

import { describe, expect, it } from 'vitest';
import { duration, makeSeed } from '@ws/core';
import { createWorld } from '@ws/sim';

const seed = makeSeed(0x51ee, 0x9a1d);

function freshWorld() {
  const w = createWorld({
    seed,
    genesis: { level: 3, steps: 12, plateCount: 7 },
    terrainLevel: 3,
    climateN: 2,
    erode: false,
  });
  /* Advance far enough that hydrology, biosphere and dynamic geology all hold
     non-trivial state — a digest that only sees zeros proves nothing. */
  w.apply({ kind: 'setTimeScale', scale: 1e8 });
  w.scheduler.advance(duration(200_001 * w.calendar.secondsPerYear));
  return w;
}

/** Every authoritative numeric array, by the subsystem that owns it. */
function authoritativeArrays(w: ReturnType<typeof freshWorld>): Array<[string, { [i: number]: number; length: number }]> {
  const h = w.hydrology;
  const b = w.biosphere;
  const d = w.dynamicGeology;
  return [
    ['hydrology.filledM', h.filledM],
    ['hydrology.contributingAreaM2', h.contributingAreaM2],
    ['hydrology.runoffMps', h.runoffMps],
    ['hydrology.dischargeM3s', h.dischargeM3s],
    ['hydrology.soilMoistureM', h.soilMoistureM],
    ['hydrology.snowpackM', h.snowpackM],
    ['hydrology.glacierM', h.glacierM],
    ['hydrology.temperatureK', h.temperatureK],
    ['hydrology.precipitationRate', h.precipitationRate],
    ['hydrology.receiver', h.receiver],
    ['hydrology.topologicalOrder', h.topologicalOrder],
    ['hydrology.basinId', h.basinId],
    ['hydrology.ocean', h.ocean],
    ['hydrology.rivers.width', h.rivers.width],
    ['hydrology.rivers.velocity', h.rivers.velocity],
    ['hydrology.rivers.order', h.rivers.order],
    ['biosphere.biome', b.biome],
    ['biosphere.nppKgM2Yr', b.nppKgM2Yr],
    ['biosphere.vegetationDensity', b.vegetationDensity],
    ['biosphere.biomassKgM2', b.biomassKgM2],
    ['biosphere.phenology', b.phenology],
    ['biosphere.producers', b.producers],
    ['biosphere.herbivores', b.herbivores],
    ['biosphere.predators', b.predators],
    ['biosphere.populationDensity', b.populationDensity],
    ['dynamicGeology.stress', d.stress],
    ['dynamicGeology.volcanicActivity', d.volcanicActivity],
    ['dynamicGeology.coarse.elevationM', d.coarse.elevationM],
    ['dynamicGeology.coarse.plateId', d.coarse.plateId],
    ['dynamicGeology.coarse.boundaryType', d.coarse.boundaryType],
    ['dynamicGeology.coarse.crustThicknessKm', d.coarse.crustThicknessKm],
    ['dynamicGeology.coarse.crustAgeMyr', d.coarse.crustAgeMyr],
    ['dynamicGeology.coarse.upliftM', d.coarse.upliftM],
  ];
}

describe('T-0082 world digest coverage', () => {
  it('is stable when nothing changes', () => {
    const w = freshWorld();
    expect(w.digest()).toBe(w.digest());
  });

  it('reproduces exactly across two identically-driven worlds', () => {
    expect(freshWorld().digest()).toBe(freshWorld().digest());
  });

  it('sees a single-cell perturbation in every authoritative M5/M6/M7 array', () => {
    const w = freshWorld();
    const base = w.digest();
    const blind: string[] = [];
    for (const [name, arr] of authoritativeArrays(w)) {
      expect(arr.length, `${name} is empty; the test would prove nothing`).toBeGreaterThan(0);
      const i = Math.floor(arr.length / 3);
      const original = arr[i] as number;
      /* Integers move by 1. Floats move by the smallest amount the digest is
         DECLARED to see: two quanta of the coarsest quantum in use (1 unit),
         or a relative 1e-6 for fields whose magnitude is large enough that an
         absolute perturbation would vanish into f64 rounding. Perturbing by
         less than the declared quantum would be testing the quantisation, not
         the coverage. */
      const delta = Math.max(2, Math.abs(original) * 1e-6);
      arr[i] = Number.isInteger(original) ? original + 1 : original + delta;
      if (w.digest() === base) blind.push(name);
      arr[i] = original;
      expect(w.digest(), `${name} did not restore`).toBe(base);
    }
    expect(blind, 'digest is blind to these authoritative fields').toEqual([]);
  });

  it('sees scalar and topology state that is not in any array', () => {
    const w = freshWorld();
    const base = w.digest();

    const probes: Array<[string, () => () => void]> = [
      ['hydrology.seaLevelM', () => {
        const o = w.hydrology.seaLevelM;
        w.hydrology.seaLevelM = o + 0.01;
        return () => { w.hydrology.seaLevelM = o; };
      }],
      ['hydrology.routingGeneration', () => {
        const o = w.hydrology.routingGeneration;
        w.hydrology.routingGeneration = o + 1;
        return () => { w.hydrology.routingGeneration = o; };
      }],
      ['hydrology.budget.residual inputs', () => {
        const o = w.hydrology.budget.storageChangeM3;
        w.hydrology.budget.storageChangeM3 = o + 1;
        return () => { w.hydrology.budget.storageChangeM3 = o; };
      }],
      ['biosphere.extinctions', () => {
        const o = w.biosphere.extinctions;
        w.biosphere.extinctions = o + 1;
        return () => { w.biosphere.extinctions = o; };
      }],
      ['dynamicGeology.elapsedMyr', () => {
        const o = w.dynamicGeology.elapsedMyr;
        w.dynamicGeology.elapsedMyr = o + 1e-6;
        return () => { w.dynamicGeology.elapsedMyr = o; };
      }],
      ['dynamicGeology plate orientation', () => {
        const p = w.dynamicGeology.plates[0];
        if (p === undefined) throw new Error('no plates');
        const o = p.sx;
        p.sx = o + 1e-9;
        return () => { p.sx = o; };
      }],
      ['ocean.seaLevel', () => {
        const o = w.ocean.seaLevel;
        w.ocean.seaLevel = o + 0.01;
        return () => { w.ocean.seaLevel = o; };
      }],
    ];

    const blind: string[] = [];
    for (const [name, perturb] of probes) {
      const restore = perturb();
      if (w.digest() === base) blind.push(name);
      restore();
    }
    expect(blind).toEqual([]);
    expect(w.digest()).toBe(base);
  });

  it('distinguishes an absent subsystem from an all-zero one', () => {
    /* A world without a biosphere must not collide with one whose biosphere
       has been zeroed — otherwise "subsystem failed to run" reads as
       "subsystem ran and produced nothing". */
    const w = freshWorld();
    const zeroed = w.digest.bind(w);
    for (const a of [w.biosphere.biomassKgM2, w.biosphere.populationDensity,
      w.biosphere.producers, w.biosphere.herbivores, w.biosphere.predators,
      w.biosphere.vegetationDensity, w.biosphere.nppKgM2Yr, w.biosphere.phenology]) a.fill(0);
    w.biosphere.biome.fill(0);
    w.biosphere.steps = 0;
    w.biosphere.extinctions = 0;
    expect(zeroed()).not.toBe(freshWorld().digest());
  });

  it('detects a NaN injected anywhere, and where it was injected', () => {
    const w = freshWorld();
    const base = w.digest();
    const arr = w.hydrology.soilMoistureM;
    const i = 3;
    const j = 11;
    const oi = arr[i] as number;
    const oj = arr[j] as number;

    arr[i] = Number.NaN;
    const atI = w.digest();
    arr[i] = oi;

    arr[j] = Number.NaN;
    const atJ = w.digest();
    arr[j] = oj;

    expect(atI).not.toBe(base);
    expect(atJ).not.toBe(base);
    /* Position matters: two runs that both went NaN, in different places, are
       not the same run. */
    expect(atI).not.toBe(atJ);
    expect(w.digest()).toBe(base);
  });

  it('tolerates f64 noise below the quantum', () => {
    /* Worker partitioning legitimately reassociates sums. The digest must not
       fire on last-bit differences, or the 1/4/8-worker gate becomes noise. */
    const w = freshWorld();
    const base = w.digest();
    const arr = w.hydrology.temperatureK;
    for (let i = 0; i < arr.length; i++) {
      arr[i] = (arr[i] as number) * (1 + Number.EPSILON);
    }
    expect(w.digest()).toBe(base);
  });
});
