/**
 * @tier A
 *
 * M9 registry: which settlements have become cities, and the layout cache.
 *
 * The cache is the point of the module. A planet may hold thousands of cities
 * and a single large layout is tens of megabytes, so layouts are BUILT ON
 * DEMAND at the requested detail and evicted under pressure. That is only safe
 * because a layout is derived (see `state.ts`): eviction can never lose
 * information, because the layout was never information — it was a function of
 * information.
 */

import { CIV, type CivilisationState } from '../civilisation/system.js';
import type { HydrologyState } from '../hydrology/system.js';
import {
  builtRadiusM,
  cityDigest,
  cityPopulationOf,
  initCity,
  stepCity,
  type CityState,
} from './state.js';
import {
  CITY_LOD,
  estimateLayoutCost,
  generateCityLayout,
  type CityLayout,
  type CityLod,
} from './layout.js';
import { cityTerrainSampler, waterBearings } from './terrain.js';
import type { Seed } from '@ws/core';

/** A settlement becomes a city at this population. Below it, it is a village. */
export const CITY_THRESHOLD = 8000;

export interface CityRegistry {
  readonly seed: Seed;
  /** Cities by id, ascending. Iteration order is index order (DEC-017). */
  readonly cities: CityState[];
  /** settlement index -> city id, or -1. */
  settlementToCity: Int32Array;
  nextCityId: number;
  /** Total bytes of layout currently cached. */
  cacheBytes: number;
  readonly cacheBudgetBytes: number;
  promotedTotal: number;
  demotedTotal: number;
  /** Layouts generated since construction; a cache-miss counter. */
  generatedTotal: number;
}

interface CacheEntry {
  layout: CityLayout;
  lod: CityLod;
  generation: number;
  bytes: number;
  lastUsed: number;
}

const CACHE = new WeakMap<CityRegistry, Map<number, CacheEntry>>();
let clock = 0;

export function initCityRegistry(seed: Seed, capacity: number, cacheBudgetBytes = 256 * 1024 * 1024): CityRegistry {
  const r: CityRegistry = {
    seed,
    cities: [],
    settlementToCity: new Int32Array(capacity).fill(-1),
    nextCityId: 1,
    cacheBytes: 0,
    cacheBudgetBytes,
    promotedTotal: 0,
    demotedTotal: 0,
    generatedTotal: 0,
  };
  CACHE.set(r, new Map());
  return r;
}

/**
 * Promote settlements that crossed the city threshold, retire those whose
 * settlement is gone, and advance every city's authoritative state.
 *
 * O(cities + settlements). No geometry is touched: growth changes numbers, and
 * the layout cache notices via `layoutGeneration`.
 */
export function stepCities(
  r: CityRegistry,
  civ: CivilisationState,
  h: HydrologyState,
  dtYears: number,
): void {
  const store = civ.store;
  const cellCol = store.column(CIV.cell);
  const popCol = store.column(CIV.population);
  const techCol = store.column(CIV.technology);
  const foundedCol = store.column(CIV.foundedYear);

  /* Retire cities whose settlement died. The city is removed, not left as a
     ruin holding a stale settlement index — a reused entity slot would
     otherwise hand the old city a new settlement's population. */
  for (let i = r.cities.length - 1; i >= 0; i--) {
    const c = r.cities[i]!;
    const alive = store.aliveAt(c.settlementIndex)
      && (cellCol[c.settlementIndex] as number) >= 0
      && cityPopulationOf(popCol[c.settlementIndex] as number, techCol[c.settlementIndex] as number)
        >= CITY_THRESHOLD * 0.4;
    if (alive) continue;
    r.settlementToCity[c.settlementIndex] = -1;
    dropLayout(r, c.id);
    r.cities.splice(i, 1);
    r.demotedTotal++;
  }

  /* Promote. Ascending settlement index, so city ids are assigned in a
     reproducible order. */
  for (let i = 0; i < store.bound; i++) {
    if (!store.aliveAt(i)) continue;
    if ((r.settlementToCity[i] as number) >= 0) continue;
    const pop = cityPopulationOf(popCol[i] as number, techCol[i] as number);
    if (pop < CITY_THRESHOLD) continue;
    const cell = cellCol[i] as number;
    if (cell < 0) continue;
    const sampler = cityTerrainSampler(h, cell);
    const city = initCity({
      id: r.nextCityId,
      settlementIndex: i,
      cell,
      seed: r.seed,
      population: pop,
      technology: techCol[i] as number,
      foundedYear: foundedCol[i] as number,
      waterBearings: waterBearings(sampler, Math.max(500, pop / 40)),
    });
    r.nextCityId++;
    r.cities.push(city);
    r.settlementToCity[i] = city.id;
    r.promotedTotal++;
  }

  /* Advance. A city follows its settlement: M8 owns the population, M9 owns
     what the population does to the ground. */
  for (const c of r.cities) {
    const i = c.settlementIndex;
    const cell = cellCol[i] as number;
    const before = c.layoutGeneration;
    /* Water bearings drive PORT districts and are only read when an era change
       reseeds them. Probing every step cost 16 terrain samples per city per
       tick for a result that is almost always discarded. */
    const nextPop = cityPopulationOf(popCol[i] as number, techCol[i] as number);
    const eraDue = builtRadiusM(nextPop, techCol[i] as number) > c.radiusM * 1.15;
    const bearings = eraDue && cell >= 0 && c.radiusM > 0
      ? waterBearings(cityTerrainSampler(h, cell), c.radiusM)
      : [];
    stepCity(c, cityPopulationOf(popCol[i] as number, techCol[i] as number),
      techCol[i] as number, dtYears, bearings);
    if (c.layoutGeneration !== before) dropLayout(r, c.id);
  }
}

/**
 * Get a city's geometry at `lod`, building it if the cache does not hold it at
 * that detail or newer state.
 *
 * A cached layout at a HIGHER lod satisfies a request for a lower one, because
 * the levels nest — asking for arterials when streets are already built should
 * not throw the streets away.
 */
export function cityLayout(
  r: CityRegistry,
  c: CityState,
  h: HydrologyState,
  lod: CityLod,
): CityLayout {
  const cache = CACHE.get(r);
  if (cache === undefined) throw new Error('city registry was not initialised through initCityRegistry');
  clock++;
  const hit = cache.get(c.id);
  if (hit !== undefined && hit.generation === c.layoutGeneration && hit.lod >= lod) {
    hit.lastUsed = clock;
    return hit.layout;
  }
  const sampler = cityTerrainSampler(h, c.cell);
  const layout = generateCityLayout(c, sampler, lod);
  r.generatedTotal++;
  const bytes = estimateLayoutCost(c, lod).bytes;
  if (hit !== undefined) r.cacheBytes -= hit.bytes;
  cache.set(c.id, { layout, lod, generation: c.layoutGeneration, bytes, lastUsed: clock });
  r.cacheBytes += bytes;
  evict(r, cache);
  return layout;
}

/** Drop a city's cached geometry. Always safe: it is derived. */
export function dropLayout(r: CityRegistry, cityId: number): void {
  const cache = CACHE.get(r);
  if (cache === undefined) return;
  const hit = cache.get(cityId);
  if (hit === undefined) return;
  r.cacheBytes -= hit.bytes;
  cache.delete(cityId);
}

/** Drop every cached layout. Used by the test that proves geometry is derived. */
export function dropAllLayouts(r: CityRegistry): void {
  const cache = CACHE.get(r);
  if (cache === undefined) return;
  cache.clear();
  r.cacheBytes = 0;
}

export function cachedLayoutCount(r: CityRegistry): number {
  return CACHE.get(r)?.size ?? 0;
}

function evict(r: CityRegistry, cache: Map<number, CacheEntry>): void {
  if (r.cacheBytes <= r.cacheBudgetBytes) return;
  /* Least-recently-used, with the city id as a tie-break so eviction is
     deterministic when two entries share a timestamp. */
  const order = [...cache.entries()].sort((a, b) => {
    const d = a[1].lastUsed - b[1].lastUsed;
    return d !== 0 ? d : a[0] - b[0];
  });
  for (const [id, entry] of order) {
    if (r.cacheBytes <= r.cacheBudgetBytes) break;
    r.cacheBytes -= entry.bytes;
    cache.delete(id);
  }
}

/** LOD a viewer at `distanceM` should ask for. */
export function lodForDistance(distanceM: number, radiusM: number): CityLod {
  const relative = distanceM / Math.max(1, radiusM);
  if (relative > 40) return CITY_LOD.DISTRICTS;
  if (relative > 8) return CITY_LOD.ARTERIALS;
  if (relative > 2) return CITY_LOD.STREETS;
  return CITY_LOD.PLOTS;
}

export function cityById(r: CityRegistry, id: number): CityState | undefined {
  return r.cities.find((c) => c.id === id);
}

export function largestCity(r: CityRegistry): CityState | undefined {
  let best: CityState | undefined;
  for (const c of r.cities) {
    if (best === undefined || c.population > best.population) best = c;
  }
  return best;
}

/** Digest of every city's AUTHORITATIVE state, in id order. */
export function citiesDigest(r: CityRegistry): number {
  let h = 0x9e3779b1 >>> 0;
  const mix = (x: number, v: number): number => {
    let y = (x ^ Math.imul(v | 0, 0x9e3779b1)) >>> 0;
    y = Math.imul(y ^ (y >>> 16), 0x7feb352d) >>> 0;
    return (y ^ (y >>> 15)) >>> 0;
  };
  h = mix(h, r.cities.length);
  h = mix(h, r.promotedTotal);
  h = mix(h, r.demotedTotal);
  /* Which settlement id the NEXT promotion gets, and the settlement->city map
     that decides whether a settlement is promoted at all. Both steer the next
     tick; neither was covered. `cacheBytes` and `generatedTotal` are cache
     bookkeeping and deliberately are not. */
  h = mix(h, r.nextCityId);
  for (let i = 0; i < r.settlementToCity.length; i++) {
    const v = r.settlementToCity[i] as number;
    if (v >= 0) { h = mix(h, i); h = mix(h, v); }
  }
  for (const c of r.cities) h = mix(h, cityDigest(c));
  return h >>> 0;
}
