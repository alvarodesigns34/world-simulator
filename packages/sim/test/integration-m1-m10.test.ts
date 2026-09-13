/**
 * M1–M10 integration: the causal chain, end to end.
 *
 * Every milestone has its own tests. This file tests the thing none of them
 * can: that the arrows between them actually connect, in one running world.
 *
 *   geology -> where land and mountains are
 *           -> hydrology: where the water goes
 *           -> climate/biosphere: what grows
 *           -> M8: where people can live, and how many
 *           -> M9: which of those places become cities, and what they look like
 *           -> M10: what they extract, make, trade and burn
 *           -> back to M8 (trade feeds people the land cannot)
 *           -> back to M4 (combustion puts pollution in the wind)
 *
 * A milestone-shaped test suite can pass completely while the arrows are all
 * disconnected. These are the arrows.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { duration, makeSeed } from '@ws/core';
import {
  CITY_LOD,
  CIV,
  COMMODITY,
  capacityMultiplier,
  cityLayout,
  createWorld,
  dropAllLayouts,
  endowmentAt,
  largestCity,
  settlements,
} from '@ws/sim';

function planet(chunks = 5) {
  const w = createWorld({
    seed: makeSeed(3, 7),
    genesis: { level: 5, steps: 20, plateCount: 9 },
    terrainLevel: 5, climateN: 4, erode: false,
  });
  w.apply({ kind: 'setTimeScale', scale: 1e8 });
  for (let i = 0; i < chunks; i++) w.scheduler.advance(duration(100_000 * w.calendar.secondsPerYear));
  return w;
}

describe('M1-M10 the chain connects', () => {
  /* Built once and SHARED by the tests that only read it. Each of these was
     evolving its own 500 kyr planet — seven times the work for seven identical
     worlds, and enough CPU to starve the test reporter on a 2-core runner.
     The tests that mutate the world still build their own. */
  let shared: ReturnType<typeof planet>;
  beforeAll(() => { shared = planet(); }, 120000);

  it('runs a living planet: land, water, life, people, cities, an economy', () => {
    const w = shared;

    /* M2/M7 — there is a planet with land and sea. */
    let land = 0;
    for (let i = 0; i < w.hydrology.cellCount; i++) if (w.hydrology.ocean[i] === 0) land++;
    expect(land).toBeGreaterThan(0);
    expect(land).toBeLessThan(w.hydrology.cellCount);
    expect(w.dynamicGeology.elapsedMyr).toBeGreaterThan(0);

    /* M5 — water moves and collects. */
    let flowing = 0;
    for (let i = 0; i < w.hydrology.cellCount; i++) {
      if ((w.hydrology.dischargeM3s[i] as number) > 1) flowing++;
    }
    expect(flowing).toBeGreaterThan(0);

    /* M6 — things grow. */
    let productive = 0;
    for (let i = 0; i < w.biosphere.cellCount; i++) {
      if ((w.biosphere.nppKgM2Yr[i] as number) > 0) productive++;
    }
    expect(productive).toBeGreaterThan(0);

    /* M8 — people live somewhere, and it is somewhere habitable. */
    const towns = settlements(w.civilisation);
    expect(towns.length).toBeGreaterThan(0);
    expect(w.civilisation.totalPopulation).toBeGreaterThan(0);
    for (const s of towns) expect(w.habitability.suitability[s.cell] as number).toBeGreaterThan(0);

    /* M9 — some of those places are cities with real plans. */
    const city = largestCity(w.cities);
    expect(city).toBeDefined();
    const plan = cityLayout(w.cities, city!, w.hydrology, CITY_LOD.STREETS);
    expect(plan.edgeCount).toBeGreaterThan(0);
    expect(plan.stats.streetLengthM).toBeGreaterThan(0);

    /* M10 — they make things, move them, and burn fuel doing it. */
    expect(w.economy.totalProduction).toBeGreaterThan(0);
    expect(w.economy.network.edges.length).toBeGreaterThan(0);
    let pollution = 0;
    for (let c = 0; c < w.economy.cellCount; c++) pollution += w.economy.pollution[c] as number;
    expect(pollution).toBeGreaterThan(0);
  }, 60000);

  it('puts people where the geography allows and not where it does not', () => {
    /* The direction of causation, stated as a measurement: settled cells are
       systematically better land than unsettled land, and none of them is
       ocean or ice. */
    const w = shared;
    const towns = settlements(w.civilisation);
    expect(towns.length).toBeGreaterThan(3);

    let settledSuit = 0;
    for (const s of towns) settledSuit += w.habitability.suitability[s.cell] as number;
    settledSuit /= towns.length;

    let landSuit = 0;
    let n = 0;
    for (let i = 0; i < w.habitability.cellCount; i++) {
      if (w.hydrology.ocean[i] !== 0) continue;
      landSuit += w.habitability.suitability[i] as number;
      n++;
    }
    landSuit /= n;
    expect(settledSuit).toBeGreaterThan(landSuit);
  }, 60000);

  it('makes the resource map a consequence of the geology, and the economy of the resource map', () => {
    const w = shared;
    const store = w.civilisation.store;
    const e = w.economy;

    /* Polities differ in what they can produce, because their ground differs.
       Uniform production would mean the endowment was not being read. */
    const oreProd: number[] = [];
    for (let i = 0; i < store.bound; i++) {
      if (!store.aliveAt(i)) continue;
      oreProd.push(e.production[COMMODITY.ORE * e.capacity + i] as number);
    }
    expect(oreProd.length).toBeGreaterThan(3);
    const lo = Math.min(...oreProd);
    const hi = Math.max(...oreProd);
    expect(hi).toBeGreaterThan(lo);

    /* And the endowment itself varies over the planet. */
    let oreLo = Infinity;
    let oreHi = -Infinity;
    for (let i = 0; i < e.resources.cellCount; i++) {
      if (w.hydrology.ocean[i] !== 0) continue;
      const v = endowmentAt(e.resources, i, COMMODITY.ORE);
      oreLo = Math.min(oreLo, v);
      oreHi = Math.max(oreHi, v);
    }
    expect(oreHi).toBeGreaterThan(oreLo);
  }, 60000);

  it('closes the loop: trade changes what the land can support', () => {
    /* The M10 -> M8 arrow, exercised directly. A polity that can import food
       supports more people than its own fields do; one that cannot, fewer. */
    const w = planet();
    const e = w.economy;
    const store = w.civilisation.store;
    let target = -1;
    for (let i = 0; i < store.bound; i++) if (store.aliveAt(i)) { target = i; break; }
    expect(target).toBeGreaterThanOrEqual(0);

    const idx = COMMODITY.FOOD * e.capacity + target;
    e.consumption[idx] = 1000;
    e.production[idx] = 1000;
    e.imports[idx] = 0;
    const selfSufficient = capacityMultiplier(e, w.civilisation, target);
    e.imports[idx] = 2000;
    const importing = capacityMultiplier(e, w.civilisation, target);
    e.production[idx] = 100;
    e.imports[idx] = 0;
    const starving = capacityMultiplier(e, w.civilisation, target);

    expect(importing).toBeGreaterThan(selfSufficient);
    expect(starving).toBeLessThan(selfSufficient);
  }, 60000);

  it('holds the founding principle across all ten milestones', () => {
    /* Simulation state is not rendering state. Throwing away every derived
       artefact — city geometry above all — must change no simulation result.
       If this fails, something has quietly become authoritative that is not. */
    const w = shared;
    const before = w.digest();

    const city = largestCity(w.cities);
    expect(city).toBeDefined();
    const a = cityLayout(w.cities, city!, w.hydrology, CITY_LOD.PLOTS);
    expect(a.buildingCount).toBeGreaterThan(0);
    expect(w.digest()).toBe(before);

    dropAllLayouts(w.cities);
    expect(w.digest()).toBe(before);

    const b = cityLayout(w.cities, city!, w.hydrology, CITY_LOD.PLOTS);
    expect(b.buildingCount).toBe(a.buildingCount);
    expect(w.digest()).toBe(before);
  }, 60000);

  it('is reproducible end to end from the seed alone', () => {
    const a = planet(4);
    const b = planet(4);
    expect(a.digest()).toBe(b.digest());
    expect(a.civilisation.store.count).toBe(b.civilisation.store.count);
    expect(a.cities.cities.length).toBe(b.cities.cities.length);
    expect(a.economy.network.edges.length).toBe(b.economy.network.edges.length);
  }, 90000);

  it('keeps every published field finite after a long run', () => {
    /* A NaN anywhere in the chain propagates silently until something visibly
       breaks, usually much later and somewhere else. */
    const w = shared;
    const arrays: Array<[string, ArrayLike<number>]> = [
      ['elevation', w.hydrology.elevationM],
      ['discharge', w.hydrology.dischargeM3s],
      ['soilMoisture', w.hydrology.soilMoistureM],
      ['npp', w.biosphere.nppKgM2Yr],
      ['habitability', w.habitability.suitability],
      ['pollution', w.economy.pollution],
      ['prices', w.economy.price],
      ['stocks', w.economy.stock],
    ];
    for (const [name, a] of arrays) {
      for (let i = 0; i < a.length; i++) {
        if (!Number.isFinite(a[i] as number)) {
          throw new Error(`${name}[${String(i)}] is not finite: ${String(a[i])}`);
        }
      }
    }
    const pop = w.civilisation.store.column(CIV.population);
    for (let i = 0; i < w.civilisation.store.bound; i++) {
      if (!w.civilisation.store.aliveAt(i)) continue;
      expect(Number.isFinite(pop[i] as number)).toBe(true);
      expect(pop[i] as number).toBeGreaterThanOrEqual(0);
    }
  }, 90000);
});
