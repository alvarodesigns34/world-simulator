/**
 * @tier A
 *
 * M10 resource endowment: what the ground is worth.
 *
 * Every deposit here is DIAGNOSED from M2/M6/M7 state, never scattered. Ore
 * follows convergent margins and old shields because that is where orogeny and
 * cratonic crust put it; coal follows warm wet lowlands because that is what a
 * coal measure is; oil follows shallow marine basins on continental shelf.
 * Timber follows the biosphere and fish follow productive shelf water.
 *
 * That matters beyond flavour: it is what makes M10's trade network a map of
 * the planet's geology rather than an arbitrary graph. Move a plate boundary
 * and the mining towns move with it.
 *
 * Endowment is a DIAGNOSIS (DEC-030): pure in the fields it reads, recomputed
 * when they change, never integrated. Depletion is separate authoritative
 * state and lives in `system.ts` — the ground's richness and how much of it has
 * been dug out are different facts.
 */

import { DOMAIN, hashFloat01x64, type Seed } from '@ws/core';
import { BND_CONVERGENT, BND_DIVERGENT, type GeologyState } from '../geology/plates.js';
import { BIOME, type BiosphereState } from '../biosphere/system.js';
import type { HydrologyState } from '../hydrology/system.js';
import { mapCubeToCube, couplingScratch } from '../coupling.js';

/**
 * Commodities. Deliberately few: each one must have a distinct production
 * function, a distinct consumer, and a reason to be traded. A longer list would
 * be a longer list, not a better economy.
 */
export const COMMODITY = {
  FOOD: 0,
  TIMBER: 1,
  STONE: 2,
  ORE: 3,
  FUEL: 4,
  ENERGY: 5,
  GOODS: 6,
} as const;

export const COMMODITY_COUNT = 7;
export type CommodityId = (typeof COMMODITY)[keyof typeof COMMODITY];

export const COMMODITY_NAMES: readonly string[] = [
  'food', 'timber', 'stone', 'ore', 'fuel', 'energy', 'goods',
];

/**
 * Which commodities come out of the ground and can therefore be exhausted.
 * Energy and goods are made, not mined; food and timber regrow.
 */
export const EXTRACTIVE: readonly CommodityId[] = [COMMODITY.STONE, COMMODITY.ORE, COMMODITY.FUEL];

export interface ResourceState {
  readonly level: number;
  readonly cellCount: number;
  /** Per cell, per commodity: relative richness 0..1. Row-major by commodity. */
  readonly endowment: Float32Array;
  /** 1 where the cell is productive shelf water (fishery). */
  readonly fishery: Uint8Array;
  /**
   * Planetary mean endowment per commodity, over LAND cells.
   *
   * Production is expressed relative to this rather than in absolute units, so
   * what drives the economy is COMPARATIVE advantage: a territory twice as
   * ore-rich as the planetary average exports ore, whatever the absolute
   * abundance the geology happens to produce. Without it, every production
   * constant has to be re-tuned whenever the endowment model changes — and the
   * first version was out by ~50x for exactly that reason.
   */
  readonly planetaryMean: Float64Array;
}

export function initResources(h: HydrologyState): ResourceState {
  return {
    level: h.level,
    cellCount: h.cellCount,
    endowment: new Float32Array(h.cellCount * COMMODITY_COUNT),
    fishery: new Uint8Array(h.cellCount),
    planetaryMean: new Float64Array(COMMODITY_COUNT),
  };
}

export function endowmentAt(r: ResourceState, cell: number, c: CommodityId): number {
  return r.endowment[c * r.cellCount + cell] as number;
}

/**
 * Recompute endowment from current geology, hydrology and biosphere.
 *
 * O(cells). Called when the geology changes, not per tick.
 *
 * The world seed enters only as a small multiplicative texture: WHERE the
 * deposits are is decided by the geology, and the hash only decides whether a
 * particular convergent margin happens to be rich or poor. A hash-dominated
 * endowment would make the geology decorative.
 */
export function refreshResources(
  r: ResourceState,
  geology: GeologyState,
  h: HydrologyState,
  b: BiosphereState,
  seed: Seed,
): void {
  const N = r.cellCount;
  /* Geology runs on its own (coarser or finer) cube level; resources live on
     the civilisation grid. Coordinate-aware, per T-0080 — never proportional. */
  const boundary = couplingScratch(N);
  mapCubeToCube(geology.boundaryType, geology.level, r.level, boundary);
  const crust = new Float64Array(N);
  mapCubeToCube(geology.crustType, geology.level, r.level, crust);
  const age = new Float64Array(N);
  mapCubeToCube(geology.crustAgeMyr, geology.level, r.level, age);
  const thickness = new Float64Array(N);
  mapCubeToCube(geology.crustThicknessKm, geology.level, r.level, thickness);

  r.endowment.fill(0);
  r.fishery.fill(0);

  for (let i = 0; i < N; i++) {
    const ocean = h.ocean[i] !== 0;
    const elev = h.elevationM[i] as number;
    const texture = (c: number): number =>
      0.35 + 0.65 * hashFloat01x64(seed, DOMAIN.ECONOMY, i, c);

    if (ocean) {
      /* Fisheries are shallow, productive shelf: deep ocean is a desert. */
      const depth = -elev;
      if (depth > 0 && depth < 400) {
        const productivity = 1 - Math.min(1, depth / 400);
        r.fishery[i] = 1;
        r.endowment[COMMODITY.FOOD * N + i] = productivity * 0.55 * texture(11);
      }
      /* Offshore oil: shallow marine basins over continental crust. */
      if (depth > 0 && depth < 2500 && (crust[i] as number) > 0.5) {
        r.endowment[COMMODITY.FUEL * N + i] = Math.min(1, depth / 2500) * 0.5 * texture(12);
      }
      continue;
    }

    const bnd = boundary[i] as number;
    const continental = (crust[i] as number) > 0.5 ? 1 : 0;
    const crustAge = age[i] as number;
    const thick = thickness[i] as number;

    /* ORE. Two settings, both real: active convergent margins (arc magmatism,
       porphyry copper) and old thick continental shield (cratonic iron). */
    const arc = bnd > BND_CONVERGENT - 0.5 && bnd < BND_CONVERGENT + 0.5 ? 1 : 0;
    const nearDivergent = Math.abs(bnd - BND_DIVERGENT) < 0.5 ? 1 : 0;
    const shield = continental === 1 ? Math.min(1, crustAge / 320) * Math.min(1, thick / 45) : 0;
    const ore = Math.min(1, arc * 0.85 + shield * 0.6 + nearDivergent * 0.15);
    if (ore > 0) r.endowment[COMMODITY.ORE * N + i] = ore * texture(1);

    /* STONE. Everywhere on land, but quarryable rock needs relief or thin
       soil — a deep alluvial plain has none. */
    const relief = Math.min(1, Math.max(0, elev) / 2500);
    r.endowment[COMMODITY.STONE * N + i] = Math.min(1, 0.25 + 0.75 * relief) * texture(2);

    /* FUEL. Coal measures are buried warm wet lowlands; the proxy is a low,
       thick sedimentary continental cell that is or was well watered. */
    const lowland = elev > 0 && elev < 700 ? 1 - elev / 700 : 0;
    const wet = Math.min(1, (h.soilMoistureM[i] as number) / 0.2);
    const coal = continental * lowland * (0.35 + 0.65 * wet) * Math.min(1, crustAge / 200);
    if (coal > 0.02) r.endowment[COMMODITY.FUEL * N + i] = Math.min(1, coal) * texture(3);

    /* TIMBER. Standing biomass in a forest biome, and only there — grassland
       carries biomass but not trees. */
    const biome = b.biome[i] as number;
    const forest = biome === BIOME.BOREAL || biome === BIOME.TEMPERATE_FOREST
      || biome === BIOME.TROPICAL_FOREST ? 1 : biome === BIOME.WETLAND ? 0.35 : 0;
    if (forest > 0) {
      const stock = Math.min(1, (b.biomassKgM2[i] as number) / 9);
      r.endowment[COMMODITY.TIMBER * N + i] = forest * stock * texture(4);
    }

    /* FOOD on land is the M6/M8 productivity of the cell. */
    r.endowment[COMMODITY.FOOD * N + i] = Math.min(1, (b.nppKgM2Yr[i] as number) / 1.8) * texture(5);
  }

  /* Planetary means over land, the reference every production ceiling is
     measured against. A planet with no land has no economy, and the guard
     keeps that from becoming a division by zero. */
  r.planetaryMean.fill(0);
  let land = 0;
  for (let i = 0; i < N; i++) {
    if (h.ocean[i] !== 0) continue;
    land++;
    for (let k = 0; k < COMMODITY_COUNT; k++) {
      r.planetaryMean[k] = (r.planetaryMean[k] as number) + (r.endowment[k * N + i] as number);
    }
  }
  if (land > 0) {
    for (let k = 0; k < COMMODITY_COUNT; k++) {
      r.planetaryMean[k] = (r.planetaryMean[k] as number) / land;
    }
  }
}

/** Total endowment of one commodity over a set of cells. Used per territory. */
export function endowmentSum(
  r: ResourceState,
  c: CommodityId,
  claim: Int32Array,
  owner: number,
  areaM2: Float64Array,
): number {
  let total = 0;
  const base = c * r.cellCount;
  for (let i = 0; i < r.cellCount; i++) {
    if (claim[i] !== owner) continue;
    total += (r.endowment[base + i] as number) * (areaM2[i] as number);
  }
  return total;
}
