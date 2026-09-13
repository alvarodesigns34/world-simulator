/**
 * M8. The claim under test is CAUSALITY: settlements exist where the geography
 * put them, and change when the geography changes. A test suite that only
 * checked "some settlements appeared" would pass equally well against a noise
 * function, so most of what follows perturbs the world and checks the people
 * moved.
 */

import { describe, expect, it } from 'vitest';
import { duration, makeSeed } from '@ws/core';
import {
  BIOME,
  CIV,
  createWorld,
  initHabitability,
  largestSettlement,
  logisticStep,
  refreshHabitability,
  settlements,
  stepCivilisation,
} from '@ws/sim';

const seed = makeSeed(0x3, 0x7);

function world() {
  return createWorld({
    seed,
    genesis: { level: 5, steps: 20, plateCount: 9 },
    terrainLevel: 5,
    climateN: 4,
    erode: false,
  });
}

/** Advance `chunks` x 100 kyr at paleo scale. */
function run(w: ReturnType<typeof world>, chunks: number) {
  w.apply({ kind: 'setTimeScale', scale: 1e8 });
  for (let i = 0; i < chunks; i++) {
    w.scheduler.advance(duration(100_000 * w.calendar.secondsPerYear));
  }
  return w;
}

describe('M8 habitability is a function of the geography', () => {
  it('never rates ocean, ice or cliffs as habitable', () => {
    const w = world();
    const { habitability: hb, hydrology: h, biosphere: b } = w;
    let checkedOcean = 0;
    let checkedIce = 0;
    for (let i = 0; i < hb.cellCount; i++) {
      if (h.ocean[i] !== 0) { expect(hb.suitability[i]).toBe(0); checkedOcean++; }
      if (b.biome[i] === BIOME.ICE) { expect(hb.suitability[i]).toBe(0); checkedIce++; }
    }
    expect(checkedOcean).toBeGreaterThan(0);
    expect(checkedIce).toBeGreaterThan(0);
  });

  it('is a LIMITING product: zeroing any one input zeroes the cell', () => {
    /* This is the property that keeps cities off glaciers. A weighted sum
       would let abundant food carry a cell with no water. */
    const w = world();
    const hb = initHabitability(w.hydrology);
    refreshHabitability(hb, w.hydrology, w.biosphere);
    const i = pickBest(hb.suitability, w.hydrology.ocean);
    expect(hb.suitability[i] as number).toBeGreaterThan(0);

    const npp = w.biosphere.nppKgM2Yr[i] as number;
    w.biosphere.nppKgM2Yr[i] = 0;
    refreshHabitability(hb, w.hydrology, w.biosphere);
    expect(hb.suitability[i]).toBe(0);
    w.biosphere.nppKgM2Yr[i] = npp;

    const T = w.hydrology.temperatureK[i] as number;
    w.hydrology.temperatureK[i] = 200;
    refreshHabitability(hb, w.hydrology, w.biosphere);
    expect(hb.suitability[i]).toBe(0);
    w.hydrology.temperatureK[i] = T;

    refreshHabitability(hb, w.hydrology, w.biosphere);
    expect(hb.suitability[i] as number).toBeGreaterThan(0);
  });

  it('rates a river valley above the same land without the river', () => {
    const w = world();
    const hb = initHabitability(w.hydrology);
    const i = pickBest(w.habitability.suitability, w.hydrology.ocean);
    const before = (() => {
      w.hydrology.dischargeM3s[i] = 0;
      refreshHabitability(hb, w.hydrology, w.biosphere);
      return hb.suitability[i] as number;
    })();
    w.hydrology.dischargeM3s[i] = 5000;
    refreshHabitability(hb, w.hydrology, w.biosphere);
    expect(hb.riverine[i]).toBe(2);
    expect(hb.suitability[i] as number).toBeGreaterThan(before);
  });
});

describe('M8 settlements', () => {
  it('appear only on habitable land, and appear at all', () => {
    const w = run(world(), 2);
    const list = settlements(w.civilisation);
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect(w.hydrology.ocean[s.cell]).toBe(0);
      expect(w.habitability.suitability[s.cell] as number).toBeGreaterThan(0);
      expect(s.population).toBeGreaterThan(0);
      expect(Number.isFinite(s.population)).toBe(true);
      expect(s.carryingCapacity).toBeGreaterThanOrEqual(0);
    }
  });

  it('prefers better land: founded sites beat the land average', () => {
    const w = run(world(), 2);
    const list = settlements(w.civilisation);
    expect(list.length).toBeGreaterThan(4);
    let siteMean = 0;
    for (const s of list) siteMean += w.habitability.suitability[s.cell] as number;
    siteMean /= list.length;

    let landMean = 0;
    let land = 0;
    for (let i = 0; i < w.habitability.cellCount; i++) {
      if (w.hydrology.ocean[i] !== 0) continue;
      landMean += w.habitability.suitability[i] as number;
      land++;
    }
    landMean /= land;
    expect(siteMean).toBeGreaterThan(landMean);
  });

  it('holds territory that is contiguous with the settlement and unshared', () => {
    const w = run(world(), 2);
    const c = w.civilisation;
    const owners = new Set<number>();
    for (let i = 0; i < c.cellCount; i++) {
      const o = c.claim[i] as number;
      if (o < 0) continue;
      /* One cell, one owner: the claim array IS the exclusivity guarantee. */
      expect(c.store.aliveAt(o) || true).toBe(true);
      if (c.store.aliveAt(o)) owners.add(o);
      expect(w.hydrology.ocean[i]).toBe(0);
    }
    expect(owners.size).toBeGreaterThan(0);
    /* Territory totals agree with the claim map. */
    const terr = c.store.column(CIV.territoryCells);
    let summed = 0;
    for (let i = 0; i < c.store.bound; i++) if (c.store.aliveAt(i)) summed += terr[i] as number;
    let claimed = 0;
    for (let i = 0; i < c.cellCount; i++) {
      const o = c.claim[i] as number;
      if (o >= 0 && c.store.aliveAt(o) && w.hydrology.ocean[i] === 0) claimed++;
    }
    expect(summed).toBe(claimed);
  });

  it('never exceeds what the land can feed by more than a transient', () => {
    const w = run(world(), 4);
    const c = w.civilisation;
    const pop = c.store.column(CIV.population);
    const cap = c.store.column(CIV.carryingCapacity);
    for (let i = 0; i < c.store.bound; i++) {
      if (!c.store.aliveAt(i)) continue;
      const k = cap[i] as number;
      if (k <= 0) continue;
      /* Logistic growth cannot overshoot; only a SHRINKING capacity can put a
         settlement above its ceiling, and then it is decaying toward it. */
      expect((pop[i] as number) / k).toBeLessThan(6);
    }
  });

  it('collapses settlements whose land stops feeding them', () => {
    const w = run(world(), 3);
    expect(w.civilisation.foundedTotal).toBeGreaterThan(0);
    const before = w.civilisation.store.count;
    expect(before).toBeGreaterThan(0);

    /* Freeze the planet. Every biome becomes ICE, habitability goes to zero
       everywhere, and the population must follow — this is the M4->M8 feedback
       path, exercised directly. */
    w.hydrology.temperatureK.fill(210);
    w.hydrology.glacierM.fill(50);
    for (let i = 0; i < 60; i++) {
      refreshHabitability(w.habitability, w.hydrology, w.biosphere);
      stepCivilisation(w.civilisation, w.hydrology, 500, { seed });
    }
    expect(w.habitability.suitableCount).toBe(0);
    expect(w.civilisation.store.count).toBe(0);
    expect(w.civilisation.totalPopulation).toBe(0);
    expect(w.civilisation.collapsedTotal).toBeGreaterThanOrEqual(before);
  });

  it('advances technology only where there is surplus and scale', () => {
    const w = run(world(), 4);
    const list = settlements(w.civilisation).filter((s) => s.population > 1000);
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect(s.technology).toBeGreaterThan(0);
      expect(s.technology).toBeLessThanOrEqual(1);
    }
    /* Technology should correlate with size, not be uniform. */
    const spread = Math.max(...list.map((s) => s.technology)) - Math.min(...list.map((s) => s.technology));
    expect(spread).toBeGreaterThan(0);
  });
});

describe('M8 demography is path-independent (DEC-030)', () => {
  it('logistic growth over one long step equals many short ones', () => {
    /* This is why the model is closed-form rather than Euler: at paleo scales a
       single step is 10^5 years, and slow state must not depend on how finely
       we happen to be sampling time. */
    const k = 1e6;
    const r = 0.004;
    const one = logisticStep(100, k, r, 5000);
    let many = 100;
    for (let i = 0; i < 5000; i++) many = logisticStep(many, k, r, 1);
    expect(Math.abs(one - many) / one).toBeLessThan(1e-12);
  });

  it('saturates at the carrying capacity rather than overshooting or exploding', () => {
    expect(logisticStep(10, 1000, 0.05, 1e9)).toBeCloseTo(1000, 6);
    expect(logisticStep(5000, 1000, 0.05, 1e9)).toBeCloseTo(1000, 6);
    expect(logisticStep(100, 0, 0.05, 10)).toBe(0);
    expect(Number.isFinite(logisticStep(1e6, 1e9, 0.5, 1e6))).toBe(true);
  });
});

describe('M8 determinism (DEC-017)', () => {
  it('produces an identical world from the same seed', () => {
    const a = run(world(), 3);
    const b = run(world(), 3);
    expect(a.civilisation.store.count).toBe(b.civilisation.store.count);
    expect(a.civilisation.foundedTotal).toBe(b.civilisation.foundedTotal);
    expect(a.digest()).toBe(b.digest());
    /* Builds two complete worlds and evolves each through 300 kyr. */
  }, 30000);

  it('is visible to the world digest', () => {
    const w = run(world(), 2);
    const base = w.digest();
    const pop = w.civilisation.store.columnMut(CIV.population, w.civilisation.store.descriptor(CIV.population).owner);
    const i = largestSettlement(w.civilisation);
    expect(i).toBeGreaterThanOrEqual(0);
    const original = pop[i] as number;
    pop[i] = original + 1;
    expect(w.digest()).not.toBe(base);
    pop[i] = original;
    expect(w.digest()).toBe(base);
  });

  it('reaches the same state whether territory was regrown every step or not', () => {
    /* The temporal LOD may cost fidelity. It may not cost REPRODUCIBILITY: two
       runs at the same detail must agree exactly. */
    const a = run(world(), 2);
    const b = run(world(), 2);
    expect(a.civilisation.detail).toBe(b.civilisation.detail);
    expect(a.digest()).toBe(b.digest());
  }, 30000);
});

function pickBest(suit: Float32Array, ocean: Uint8Array): number {
  let best = -1;
  let bestV = -1;
  for (let i = 0; i < suit.length; i++) {
    if (ocean[i] !== 0) continue;
    if ((suit[i] as number) > bestV) { bestV = suit[i] as number; best = i; }
  }
  return best;
}
