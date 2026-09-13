/**
 * T-0094. The determinism digest must see everything that decides the future.
 *
 * T-0082 established this for M5–M7 and the same defect came back for M9, M10
 * and the scheduler. So this file does not just check the fields we know were
 * missing — it enumerates the live objects and requires every member to be
 * either covered or explicitly classified as not-covered-and-why. A new field
 * added without a decision fails the suite.
 */

import { describe, expect, it } from 'vitest';
import { duration, makeSeed } from '@ws/core';
import {
  CITY_LOD,
  CIV,
  COMMODITY,
  cityLayout,
  createWorld,
  dropAllLayouts,
  largestCity,
} from '@ws/sim';

function evolved(chunks = 3) {
  const w = createWorld({
    seed: makeSeed(0x4d, 0x11),
    genesis: { level: 5, steps: 20, plateCount: 9 },
    terrainLevel: 5, climateN: 4, erode: false,
  });
  w.apply({ kind: 'setTimeScale', scale: 1e8 });
  for (let i = 0; i < chunks; i++) w.scheduler.advance(duration(100_000 * w.calendar.secondsPerYear));
  return w;
}

/** Perturb, require the digest to move, restore, require it back. */
function mustMove(
  w: ReturnType<typeof evolved>,
  name: string,
  perturb: () => () => void,
): void {
  const base = w.digest();
  const restore = perturb();
  const moved = w.digest();
  restore();
  expect(w.digest(), `${name}: restore did not return the original digest`).toBe(base);
  expect(moved, `digest is BLIND to ${name}`).not.toBe(base);
}

describe('T-0094 M9 city authoritative state is hashed', () => {
  it('sees every authoritative scalar on a city', () => {
    const w = evolved();
    const c = largestCity(w.cities);
    expect(c).toBeDefined();
    const city = c!;

    mustMove(w, 'city.population', () => {
      const o = city.population; city.population = o + 1; return () => { city.population = o; };
    });
    mustMove(w, 'city.radiusM', () => {
      const o = city.radiusM; city.radiusM = o + 0.01; return () => { city.radiusM = o; };
    });
    mustMove(w, 'city.technology', () => {
      const o = city.technology; city.technology = o + 1e-5; return () => { city.technology = o; };
    });
    mustMove(w, 'city.era', () => {
      const o = city.era; city.era = o + 1; return () => { city.era = o; };
    });
    /* The layout cache keys on this. Two cities identical but for this
       regenerate different geometry on the next request. */
    mustMove(w, 'city.layoutGeneration', () => {
      const o = city.layoutGeneration; city.layoutGeneration = o + 1;
      return () => { city.layoutGeneration = o; };
    });
  }, 60000);

  it('sees the district list, its members and their development', () => {
    const w = evolved();
    const city = largestCity(w.cities)!;
    expect(city.districts.length).toBeGreaterThan(0);
    const d = city.districts[0]!;

    mustMove(w, 'district.development', () => {
      const o = d.development; d.development = o + 1e-5; return () => { d.development = o; };
    });
    mustMove(w, 'district.position', () => {
      const o = city.districts[0]!;
      city.districts[0] = { ...o, x: o.x + 10 };
      return () => { city.districts[0] = o; };
    });
    mustMove(w, 'district.kind', () => {
      const o = city.districts[0]!;
      city.districts[0] = { ...o, kind: ((o.kind + 1) % 7) as typeof o.kind };
      return () => { city.districts[0] = o; };
    });
    mustMove(w, 'district list length', () => {
      const removed = city.districts.pop()!;
      return () => { city.districts.push(removed); };
    });
  }, 60000);

  it('sees the registry: which settlement owns which city, and the next id', () => {
    const w = evolved();
    expect(w.cities.cities.length).toBeGreaterThan(0);
    mustMove(w, 'registry.nextCityId', () => {
      const o = w.cities.nextCityId; w.cities.nextCityId = o + 1;
      return () => { w.cities.nextCityId = o; };
    });
    mustMove(w, 'registry.settlementToCity', () => {
      const i = w.cities.cities[0]!.settlementIndex;
      const o = w.cities.settlementToCity[i] as number;
      w.cities.settlementToCity[i] = -1;
      return () => { w.cities.settlementToCity[i] = o; };
    });
    mustMove(w, 'registry.cities length', () => {
      const removed = w.cities.cities.pop()!;
      return () => { w.cities.cities.push(removed); };
    });
  }, 60000);

  it('does NOT see derived layout geometry', () => {
    /* The other half of the contract. Generating, caching and discarding
       geometry must not move the digest — if it did, geometry would be state
       and DEC-043 would be violated. Note this genuinely BUILDS a layout: an
       earlier version of this test only read a counter and would have passed
       against a digest that folded the cache. */
    const w = evolved();
    const city = largestCity(w.cities)!;
    const base = w.digest();

    const built = cityLayout(w.cities, city, w.hydrology, CITY_LOD.PLOTS);
    expect(built.buildingCount).toBeGreaterThan(0);
    expect(w.cities.generatedTotal).toBeGreaterThan(0);
    expect(w.digest(), 'generating geometry moved the digest').toBe(base);

    dropAllLayouts(w.cities);
    expect(w.digest(), 'discarding geometry moved the digest').toBe(base);

    const again = cityLayout(w.cities, city, w.hydrology, CITY_LOD.PLOTS);
    expect(again.buildingCount).toBe(built.buildingCount);
    expect(w.digest()).toBe(base);
  }, 60000);
});

describe('T-0094 M10 economy continuation state is hashed', () => {
  /**
   * The structural guard.
   *
   * Every member of the live EconomyState must be named in exactly one of these
   * sets. Adding a field without deciding whether it steers the next tick fails
   * here, which is the only defence against this regressing a third time.
   */
  const COVERED = new Set([
    'stock', 'price', 'production', 'consumption', 'imports', 'extracted',
    'landUse', 'pollution', 'network', 'level', 'cellCount', 'capacity',
    'topologyBasis', 'routingBasis', 'steps', 'year',
  ]);
  const DIAGNOSTIC = new Set(['totalTrade', 'totalProduction', 'worstShortage']);
  const DERIVED = new Set(['resources']);
  const SCRATCH = new Set([
    'energyOutput', 'emission', 'fuelBurnt', 'traffic',
    'emissionPerCell', 'advectScratch',
  ]);

  it('classifies every member of EconomyState', () => {
    const w = evolved(2);
    const unclassified: string[] = [];
    for (const key of Object.keys(w.economy)) {
      if (COVERED.has(key) || DIAGNOSTIC.has(key) || DERIVED.has(key) || SCRATCH.has(key)) continue;
      unclassified.push(key);
    }
    expect(unclassified,
      'EconomyState gained a member that is neither hashed nor explicitly excluded')
      .toEqual([]);
  }, 60000);

  it('sees the arrays M8 reads from the previous tick', () => {
    /* The actual defect. M8 runs in the Civilisation phase, which precedes
       Economy, so capacityMultiplier() and technologyMultiplier() read the
       PREVIOUS tick's production/consumption/imports. Two worlds agreeing on
       the old digest could feed a different number of people on the next step. */
    const w = evolved();
    const e = w.economy;
    let target = -1;
    for (let i = 0; i < w.civilisation.store.bound; i++) {
      if (w.civilisation.store.aliveAt(i)) { target = i; break; }
    }
    expect(target).toBeGreaterThanOrEqual(0);

    for (const [name, arr] of [
      ['production', e.production],
      ['consumption', e.consumption],
      ['imports', e.imports],
    ] as const) {
      mustMove(w, `economy.${name}`, () => {
        const idx = COMMODITY.FOOD * e.capacity + target;
        const o = arr[idx] as number;
        arr[idx] = o + 1;
        return () => { arr[idx] = o; };
      });
    }
  }, 60000);

  it('sees the topology state machine', () => {
    /* These decide whether the next step rebuilds the transport graph and
       clears the route cache. Same numbers, different rebuild, different world. */
    const w = evolved();
    mustMove(w, 'economy.topologyBasis', () => {
      const o = w.economy.topologyBasis; w.economy.topologyBasis = o + 1;
      return () => { w.economy.topologyBasis = o; };
    });
    mustMove(w, 'economy.routingBasis', () => {
      const o = w.economy.routingBasis; w.economy.routingBasis = o + 1;
      return () => { w.economy.routingBasis = o; };
    });
    mustMove(w, 'economy.year', () => {
      const o = w.economy.year; w.economy.year = o + 0.01;
      return () => { w.economy.year = o; };
    });
  }, 60000);

  it('still sees everything T-0082 established', () => {
    const w = evolved();
    const e = w.economy;
    for (const [name, arr, delta] of [
      ['stock', e.stock, 1],
      ['price', e.price, 0.01],
      ['extracted', e.extracted, 1],
      ['pollution', e.pollution, 0.01],
      ['landUse', e.landUse, 0.01],
    ] as const) {
      mustMove(w, `economy.${name}`, () => {
        const i = Math.floor(arr.length / 3);
        const o = arr[i] as number;
        arr[i] = o + delta;
        return () => { arr[i] = o; };
      });
    }
  }, 60000);
});

describe('T-0094 the digest is a CONTINUATION digest', () => {
  it('distinguishes worlds whose fields agree but whose schedule does not', () => {
    /* The architectural point. Identical physical arrays, different next due
       time: these are not the same reproducible world, because the next thing
       each computes is different. */
    const w = evolved(2);
    const base = w.digest();
    const before = w.scheduler.snapshot();
    const slot = before.slots[0]!;

    w.scheduler.setCadence(
      slot.id as never,
      { kind: 'every', dt: duration((slot.cadence.kind === 'every'
        ? (slot.cadence.dt as unknown as number) : 3600) * 2) },
    );
    expect(w.digest(), 'digest is blind to a cadence change').not.toBe(base);

    w.scheduler.restore(before);
    expect(w.digest()).toBe(base);
  }, 60000);

  it('distinguishes worlds at a different scheduler tick', () => {
    const w = evolved(2);
    const base = w.digest();
    const before = w.scheduler.snapshot();
    /* Advance a hair: the fields barely move, but tick/due certainly do. */
    w.scheduler.advance(duration(1));
    expect(w.digest()).not.toBe(base);
    w.scheduler.restore(before);
  }, 60000);

  it('agrees between a world and its own snapshot round-trip', () => {
    /* The property the whole thing exists for: restoring a save must reproduce
       a world that continues identically, and the digest is what says so. */
    const w = evolved(2);
    const base = w.digest();
    const snap = w.scheduler.snapshot();
    w.scheduler.restore(snap);
    expect(w.digest()).toBe(base);
  }, 60000);
});

describe('T-0094 M8 civilisation coverage still holds', () => {
  it('sees population, technology and territory', () => {
    const w = evolved();
    const store = w.civilisation.store;
    const owner = store.descriptor(CIV.population).owner;
    let target = -1;
    for (let i = 0; i < store.bound; i++) if (store.aliveAt(i)) { target = i; break; }
    expect(target).toBeGreaterThanOrEqual(0);

    for (const comp of [CIV.population, CIV.technology, CIV.carryingCapacity, CIV.cell] as const) {
      mustMove(w, `civ.${String(comp)}`, () => {
        const col = store.columnMut(comp, store.descriptor(comp).owner);
        const o = col[target] as number;
        col[target] = o + 1;
        return () => { col[target] = o; };
      });
    }
    void owner;
  }, 60000);

  it('sees the territory claim raster', () => {
    const w = evolved();
    mustMove(w, 'civ.claim', () => {
      let c = -1;
      for (let i = 0; i < w.civilisation.cellCount; i++) {
        if ((w.civilisation.claim[i] as number) >= 0) { c = i; break; }
      }
      expect(c).toBeGreaterThanOrEqual(0);
      const o = w.civilisation.claim[c] as number;
      w.civilisation.claim[c] = -1;
      return () => { w.civilisation.claim[c] = o; };
    });
  }, 60000);
});
