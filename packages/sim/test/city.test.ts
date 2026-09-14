/**
 * M9. Two claims are under test and they matter in different ways.
 *
 * 1. GEOMETRY IS DERIVED. Every street, plot and building is a function of a
 *    small authoritative state plus the terrain. The blunt test of that is to
 *    destroy every layout in the world and check nothing about the simulation
 *    changed — asserted below, and it is the M9 form of the founding
 *    principle.
 *
 * 2. THE CITY ANSWERS TO THE GROUND. Rivers get bridged or stop the city,
 *    slopes turn streets away, water suppresses buildings. These are tested
 *    against a SYNTHETIC landscape as well as the real planet, because a real
 *    planet may not happen to put a river where the test needs one, and
 *    "no bridges were built" is not evidence that bridge-building works.
 */

import { describe, expect, it } from 'vitest';
import { duration, makeSeed } from '@ws/core';
import {
  CITY_LOD,
  DISTRICT,
  MAX_LAYOUT_BUILDINGS,
  ROAD,
  builtRadiusM,
  cityDigest,
  cityLayout,
  cityPopulationOf,
  createWorld,
  dropAllLayouts,
  generateCityLayout,
  initCity,
  largestCity,
  lodForDistance,
  maxBridgeSpanM,
  stepCity,
  urbanFraction,
  type TerrainSampler,
} from '@ws/sim';

const seed = makeSeed(0x9, 0x11);

/** Flat, dry ground. The control. */
const FLAT: TerrainSampler = { elevationAt: () => 100, waterAt: () => false };

/** A river of `width` metres running north-south through the centre. */
function riverAt(width: number): TerrainSampler {
  return {
    elevationAt: (x) => 100 + Math.abs(x) * 0.001,
    waterAt: (x) => Math.abs(x) < width / 2,
  };
}

/** A ridge: ground climbing steeply east. */
const RIDGE: TerrainSampler = {
  elevationAt: (x) => 100 + Math.max(0, x) * 0.5,
  waterAt: () => false,
};

function testCity(population: number, technology: number) {
  return initCity({
    id: 1, settlementIndex: 0, cell: 0, seed,
    population, technology, foundedYear: 0,
  });
}

describe('M9 authoritative city state', () => {
  it('separates a polity from a city', () => {
    /* An M8 settlement holds a territory of continental cells. Treating its
       population as a city's produced a 553-million-person "city"; that is a
       category error, not a scale error. */
    expect(urbanFraction(0)).toBeLessThan(0.06);
    expect(urbanFraction(1)).toBeGreaterThan(0.7);
    const polity = 10_000_000;
    expect(cityPopulationOf(polity, 0.05)).toBeLessThan(cityPopulationOf(polity, 0.9));
    expect(cityPopulationOf(polity, 0.9)).toBeLessThan(polity);
  });

  it('sizes a city by population and density, not by fiat', () => {
    /* Same people, denser city, smaller footprint. */
    const preIndustrial = builtRadiusM(100_000, 0.1);
    const modern = builtRadiusM(100_000, 0.9);
    expect(preIndustrial).toBeLessThan(modern);
    /* Area scales with population. */
    expect(builtRadiusM(400_000, 0.5) / builtRadiusM(100_000, 0.5)).toBeCloseTo(2, 1);
  });

  it('does not un-build streets when a city shrinks', () => {
    const c = testCity(200_000, 0.5);
    for (let i = 0; i < 40; i++) stepCity(c, 200_000, 0.5, 100);
    const grown = c.radiusM;
    for (let i = 0; i < 40; i++) stepCity(c, 20_000, 0.5, 100);
    expect(c.population).toBe(20_000);
    expect(c.radiusM).toBe(grown);
  });

  it('keeps the authoritative state bounded however long it runs', () => {
    /* Without a cap, each growth era appended districts forever: a long-lived
       city accumulated thousands, the layout's nearest-district search became
       its dominant cost, and the "small authoritative state" that makes M9
       affordable stopped being small. */
    const c = testCity(5000, 0.1);
    for (let i = 0; i < 4000; i++) {
      stepCity(c, 5000 * (1 + i * 0.02), Math.min(1, 0.1 + i * 0.001), 100);
    }
    expect(c.districts.length).toBeLessThanOrEqual(40);
    expect(c.era).toBeLessThanOrEqual(12);
    /* Capped eras must not cap growth: the city still spreads. */
    expect(c.radiusM).toBeGreaterThan(builtRadiusM(5000, 0.1) * 5);
  });

  it('digests authoritative state only, never geometry', () => {
    const c = testCity(50_000, 0.4);
    const before = cityDigest(c);
    const a = generateCityLayout(c, FLAT, CITY_LOD.PLOTS);
    const b = generateCityLayout(c, RIDGE, CITY_LOD.PLOTS);
    /* Wildly different geometry from the same state. */
    expect(a.edgeCount).not.toBe(b.edgeCount);
    expect(cityDigest(c)).toBe(before);
  });
});

describe('M9 geometry answers to the ground', () => {
  it('bridges a river it can span, and is stopped by one it cannot', () => {
    const c = testCity(120_000, 0.5);
    expect(maxBridgeSpanM(0.5)).toBeGreaterThan(300);
    const spannable = generateCityLayout(c, riverAt(120), CITY_LOD.STREETS);
    expect(spannable.bridgeCount).toBeGreaterThan(0);
    expect(spannable.stats.blockedByWater).toBe(0);

    /* A river wider than the technology can span stops the roads instead. */
    const tooWide = generateCityLayout(c, riverAt(6000), CITY_LOD.STREETS);
    expect(tooWide.bridgeCount).toBe(0);
    expect(tooWide.stats.blockedByWater).toBeGreaterThan(0);
  });

  it('makes bridging a consequence of technology', () => {
    /* The same river: a bronze-age town stops at it, an industrial one crosses.
       This is the whole reason `maxBridgeSpanM` is a function and not a
       constant. */
    const river = riverAt(400);
    const primitive = generateCityLayout(testCity(120_000, 0.05), river, CITY_LOD.ARTERIALS);
    const advanced = generateCityLayout(testCity(120_000, 0.95), river, CITY_LOD.ARTERIALS);
    expect(maxBridgeSpanM(0.05)).toBeLessThan(400);
    expect(maxBridgeSpanM(0.95)).toBeGreaterThan(400);
    expect(primitive.stats.blockedByWater).toBeGreaterThan(0);
    expect(advanced.bridgeCount).toBeGreaterThan(0);
  });

  it('refuses to build streets steeper than the era can climb', () => {
    const c = testCity(120_000, 0.9);
    const flat = generateCityLayout(c, FLAT, CITY_LOD.ARTERIALS);
    const ridge = generateCityLayout(c, RIDGE, CITY_LOD.ARTERIALS);
    /* The ridge is a 50% grade; nothing may be built up it. */
    expect(ridge.stats.maxGrade).toBeLessThanOrEqual(0.09);
    expect(ridge.edgeCount).toBeLessThan(flat.edgeCount);
  });

  it('never puts a building in the water', () => {
    const c = testCity(80_000, 0.5);
    const river = riverAt(500);
    const l = generateCityLayout(c, river, CITY_LOD.PLOTS);
    expect(l.buildingCount).toBeGreaterThan(0);
    for (let i = 0; i < l.buildingCount; i++) {
      expect(river.waterAt(l.buildings[i * 4] as number, l.buildings[i * 4 + 1] as number)).toBe(false);
    }
    expect(l.stats.suppressedByTerrain).toBeGreaterThan(0);
  });

  it('caps height on technology, not on taste', () => {
    /* No lifts and no steel frame means nothing taller than a church, and that
       must be a hard ceiling rather than an unlikely draw. */
    const old = generateCityLayout(testCity(200_000, 0.3), FLAT, CITY_LOD.PLOTS);
    const modern = generateCityLayout(testCity(200_000, 0.95), FLAT, CITY_LOD.PLOTS);
    let oldMax = 0;
    for (let i = 0; i < old.buildingCount; i++) oldMax = Math.max(oldMax, old.buildings[i * 4 + 3] as number);
    let newMax = 0;
    for (let i = 0; i < modern.buildingCount; i++) newMax = Math.max(newMax, modern.buildings[i * 4 + 3] as number);
    expect(oldMax).toBeLessThanOrEqual(19);
    expect(newMax).toBeGreaterThan(60);
  });
});

describe('M9 level of detail', () => {
  it('nests: each level is a superset of the one below', () => {
    const c = testCity(300_000, 0.6);
    const l0 = generateCityLayout(c, FLAT, CITY_LOD.DISTRICTS);
    const l1 = generateCityLayout(c, FLAT, CITY_LOD.ARTERIALS);
    const l2 = generateCityLayout(c, FLAT, CITY_LOD.STREETS);
    const l3 = generateCityLayout(c, FLAT, CITY_LOD.PLOTS);
    expect(l0.edgeCount).toBe(0);
    expect(l1.edgeCount).toBeGreaterThan(0);
    expect(l2.edgeCount).toBeGreaterThan(l1.edgeCount);
    expect(l3.edgeCount).toBe(l2.edgeCount);
    expect(l2.buildingCount).toBe(0);
    expect(l3.buildingCount).toBeGreaterThan(0);
    /* Districts exist at every level: they are state, not geometry. */
    for (const l of [l0, l1, l2, l3]) expect(l.districtCount).toBe(c.districts.length);
    /* Arterials at L1 are still arterials at L2. */
    let arterials1 = 0;
    for (let e = 0; e < l1.edgeCount; e++) if (l1.edgeClass[e] === ROAD.ARTERIAL) arterials1++;
    let arterials2 = 0;
    for (let e = 0; e < l2.edgeCount; e++) if (l2.edgeClass[e] === ROAD.ARTERIAL) arterials2++;
    expect(arterials2).toBe(arterials1);
  });

  it('picks a level from viewing distance', () => {
    expect(lodForDistance(1e7, 5000)).toBe(CITY_LOD.DISTRICTS);
    expect(lodForDistance(1e5, 5000)).toBe(CITY_LOD.ARTERIALS);
    expect(lodForDistance(2e4, 5000)).toBe(CITY_LOD.STREETS);
    expect(lodForDistance(3e3, 5000)).toBe(CITY_LOD.PLOTS);
  });

  it('bounds allocation and says when it is sampling', () => {
    /* A layout is allocated up front from the state. That is only predictable
       if the state cannot ask for an unbounded array — and when it would, the
       layout must SAY it is a sample rather than quietly truncating. */
    const small = generateCityLayout(testCity(50_000, 0.5), FLAT, CITY_LOD.PLOTS);
    expect(small.stats.buildingScale).toBe(1);
    const huge = generateCityLayout(testCity(40_000_000, 0.8), FLAT, CITY_LOD.PLOTS);
    expect(huge.buildingCount).toBeLessThanOrEqual(MAX_LAYOUT_BUILDINGS);
    expect(huge.stats.buildingScale).toBeGreaterThan(1);
  });

  it('is byte-identical when regenerated', () => {
    const c = testCity(150_000, 0.55);
    const a = generateCityLayout(c, FLAT, CITY_LOD.PLOTS);
    const b = generateCityLayout(c, FLAT, CITY_LOD.PLOTS);
    expect(a.nodeCount).toBe(b.nodeCount);
    expect(a.buildingCount).toBe(b.buildingCount);
    expect(Array.from(a.buildings.slice(0, 4000))).toEqual(Array.from(b.buildings.slice(0, 4000)));
    expect(Array.from(a.edges.slice(0, 4000))).toEqual(Array.from(b.edges.slice(0, 4000)));
  });
});

describe('M9 in the world', () => {
  function evolved() {
    const w = createWorld({
      seed: makeSeed(3, 7),
      genesis: { level: 5, steps: 20, plateCount: 9 },
      terrainLevel: 5, climateN: 4, erode: false,
    });
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    for (let i = 0; i < 4; i++) w.scheduler.advance(duration(100_000 * w.calendar.secondsPerYear));
    return w;
  }

  it('promotes settlements into cities and retires them with their settlement', () => {
    const w = evolved();
    expect(w.cities.cities.length).toBeGreaterThan(0);
    /* Promoted ≥ live: demotions retire a city when its settlement dies.
       A wetter paleo (T-0131) just does less of that; the live set is still
       a subset of everything ever promoted. */
    expect(w.cities.promotedTotal).toBeGreaterThanOrEqual(w.cities.cities.length);
    for (const c of w.cities.cities) {
      expect(w.civilisation.store.aliveAt(c.settlementIndex)).toBe(true);
      expect(w.hydrology.ocean[c.cell]).toBe(0);
    }
  });

  it('DERIVED: discarding every layout changes no simulation result', () => {
    /* The founding principle at city scale. If this fails, geometry has become
       state and M9 is wrong at the architectural level, not the detail level. */
    const w = evolved();
    const c = largestCity(w.cities);
    expect(c).toBeDefined();
    const before = w.digest();
    const l1 = cityLayout(w.cities, c!, w.hydrology, CITY_LOD.PLOTS);
    const built = l1.buildingCount;
    expect(built).toBeGreaterThan(0);
    expect(w.digest()).toBe(before);

    dropAllLayouts(w.cities);
    expect(w.digest()).toBe(before);
    const l2 = cityLayout(w.cities, c!, w.hydrology, CITY_LOD.PLOTS);
    expect(l2.buildingCount).toBe(built);
    expect(w.digest()).toBe(before);
    /* Builds a world through 400 kyr and lays out a large city twice. */
  }, 30000);

  it('serves a cached layout and rebuilds only when the state moves', () => {
    const w = evolved();
    const c = largestCity(w.cities)!;
    dropAllLayouts(w.cities);
    const n0 = w.cities.generatedTotal;
    cityLayout(w.cities, c, w.hydrology, CITY_LOD.STREETS);
    expect(w.cities.generatedTotal).toBe(n0 + 1);
    cityLayout(w.cities, c, w.hydrology, CITY_LOD.STREETS);
    expect(w.cities.generatedTotal).toBe(n0 + 1);
    /* A lower level of detail is satisfied by a higher cached one. */
    cityLayout(w.cities, c, w.hydrology, CITY_LOD.ARTERIALS);
    expect(w.cities.generatedTotal).toBe(n0 + 1);
    /* A higher one is not. */
    cityLayout(w.cities, c, w.hydrology, CITY_LOD.PLOTS);
    expect(w.cities.generatedTotal).toBe(n0 + 2);
    /* State moves -> the cache must miss, or it would serve a wrong city. */
    c.layoutGeneration++;
    cityLayout(w.cities, c, w.hydrology, CITY_LOD.PLOTS);
    expect(w.cities.generatedTotal).toBe(n0 + 3);
    /* Builds a world through 400 kyr and lays out a large city twice. */
  }, 30000);

  it('places cities on real terrain with real elevation variation', () => {
    const w = evolved();
    const c = largestCity(w.cities)!;
    const l = cityLayout(w.cities, c, w.hydrology, CITY_LOD.STREETS);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < l.nodeCount; i++) {
      const z = l.nodeZ[i] as number;
      expect(Number.isFinite(z)).toBe(true);
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
    /* Bilinear sampling, not nearest-cell: a city spanning tens of kilometres
       must not be perfectly flat. */
    expect(hi - lo).toBeGreaterThan(0);
    expect(l.stats.streetLengthM).toBeGreaterThan(0);
  });

  it('is deterministic across two identical worlds', () => {
    const a = evolved();
    const b = evolved();
    expect(a.cities.cities.length).toBe(b.cities.cities.length);
    const ca = largestCity(a.cities)!;
    const cb = largestCity(b.cities)!;
    expect(cityDigest(ca)).toBe(cityDigest(cb));
    const la = cityLayout(a.cities, ca, a.hydrology, CITY_LOD.STREETS);
    const lb = cityLayout(b.cities, cb, b.hydrology, CITY_LOD.STREETS);
    expect(la.nodeCount).toBe(lb.nodeCount);
    expect(la.edgeCount).toBe(lb.edgeCount);
    expect(Array.from(la.nodeXY.slice(0, 2000))).toEqual(Array.from(lb.nodeXY.slice(0, 2000)));
    /* Builds two complete worlds and evolves each through 400 kyr. */
  }, 30000);
});

describe('M9 district composition reflects the society', () => {
  it('gives an industrial city industry and a farming town farmland', () => {
    /* Both must GROW: districts are seeded per growth era, so a city with a
       fixed population is laid out once and never diversifies. */
    const primitive = testCity(30_000, 0.08);
    const industrial = testCity(30_000, 0.8);
    for (let i = 0; i < 60; i++) {
      const pop = 30_000 * (1 + i * 0.35);
      stepCity(primitive, pop, 0.08, 200);
      stepCity(industrial, pop, 0.8, 200);
    }

    const farm = primitive.districts.filter((d) => d.kind === DISTRICT.AGRICULTURAL).length;
    const works = industrial.districts.filter((d) => d.kind === DISTRICT.INDUSTRIAL).length;
    expect(farm).toBeGreaterThan(0);
    expect(works).toBeGreaterThan(0);
    expect(industrial.districts.filter((d) => d.kind === DISTRICT.AGRICULTURAL).length)
      .toBeLessThan(farm + works);
  });

  it('gives a landlocked city no port', () => {
    const c = initCity({
      id: 2, settlementIndex: 0, cell: 0, seed,
      population: 90_000, technology: 0.5, foundedYear: 0, waterBearings: [],
    });
    expect(c.districts.some((d) => d.kind === DISTRICT.PORT)).toBe(false);
    const coastal = initCity({
      id: 3, settlementIndex: 0, cell: 0, seed,
      population: 90_000, technology: 0.5, foundedYear: 0, waterBearings: [1.2],
    });
    expect(coastal.districts.some((d) => d.kind === DISTRICT.PORT)).toBe(true);
  });
});

describe('M9 a city sits beside its river, not in it', () => {
  it('sets the plan origin back onto dry ground', () => {
    /* A river reconstructed from M5 runs through its cell centre, so a
       settlement founded on a river is centred in the water. Before the plan
       origin was set back, a small town on a river generated an EMPTY layout:
       every spoke started blocked, and the result looked like a modelling
       choice rather than the bug it was. */
    const c = testCity(20_000, 0.2);
    const river = riverAt(180);
    expect(maxBridgeSpanM(0.2)).toBeLessThan(180);
    const l = generateCityLayout(c, river, CITY_LOD.PLOTS);
    expect(river.waterAt(l.originXY[0] as number, l.originXY[1] as number)).toBe(false);
    expect(l.nodeCount).toBeGreaterThan(1);
    expect(l.edgeCount).toBeGreaterThan(0);
    expect(l.buildingCount).toBeGreaterThan(0);
  });

  it('leaves the origin alone on dry ground', () => {
    const l = generateCityLayout(testCity(20_000, 0.2), FLAT, CITY_LOD.ARTERIALS);
    expect(l.originXY[0]).toBe(0);
    expect(l.originXY[1]).toBe(0);
  });
});
