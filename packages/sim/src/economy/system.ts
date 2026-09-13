/**
 * @tier A
 *
 * M10 economy: production, prices, trade, energy, industry, pollution and the
 * feedback paths back into M8 and M4.
 *
 * The point of M10 is not that there are numbers called "prices". It is that
 * the causal loop CLOSES: geology decides what is in the ground, the ground
 * decides what a polity can make, what it makes decides what it can trade,
 * trade decides which places grow, growth decides how much it burns, and what
 * it burns changes the climate that decided the geography in the first place.
 * Each of those arrows is a function in this file, and each is tested.
 *
 * PRICES ARE LOCAL AND TRADE IS LOCAL. There is no global market and no global
 * pathfinding (see `network.ts`). Every polity has its own price for every
 * commodity, set by its own scarcity; goods move along an edge when the price
 * gap exceeds the transport cost. Spatial equilibrium emerges from that, which
 * is both cheaper — O(edges), no path ever computed — and what actually
 * happens.
 *
 * STABILITY. Every stock and price is advanced with a bounded, relaxation-form
 * update rather than an explicit rate, for the same reason M8's demography is
 * closed-form (DEC-042): a step here can be 500 simulated years. A price that
 * overshoots at a 500-year step is not an inaccurate price, it is an
 * oscillator, and it would drive the population it feeds into oscillation too.
 */

import { exp, log10, type Seed } from '@ws/core';
import { CIV, type CivilisationState } from '../civilisation/system.js';
import type { HydrologyState } from '../hydrology/system.js';
import type { BiosphereState } from '../biosphere/system.js';
import type { GeologyState } from '../geology/plates.js';
import {
  COMMODITY,
  COMMODITY_COUNT,
  EXTRACTIVE,
  refreshResources,
  type CommodityId,
  type ResourceState,
} from './resources.js';
import {
  investInInfrastructure,
  networkDigest,
  rebuildTopology,
  type TransportNetwork,
} from './network.js';

/**
 * Per-capita annual demand at technology 0 and at technology 1.
 *
 * The unit is arbitrary but SHARED: food is normalised to ~1 per person per
 * year and everything else is expressed against it, so the numbers say what
 * they mean — a modern person consumes about as much energy as food by this
 * measure, and rather less manufactured goods.
 *
 * Goods were initially set at 1.6, above food. That is not a plausible ratio in
 * a food-normalised unit, and its effect was to keep manufactured goods pinned
 * at the price cap in every polity forever: demand outran what any territory's
 * ore and energy could support, so no stock ever formed and every price was
 * identical at the ceiling.
 */
const DEMAND_LOW: readonly number[] = [1.0, 0.05, 0.02, 0.004, 0.002, 0.0, 0.01];
const DEMAND_HIGH: readonly number[] = [1.1, 0.35, 0.30, 0.22, 0.85, 0.9, 0.55];

/**
 * Bulk per unit of value, by commodity — how expensive a thing is to move
 * relative to what it is worth.
 *
 * Without this every commodity has the same freight cost, so either everything
 * is traded or nothing is. In reality stone is quarried locally and
 * manufactured goods cross continents, and the difference is entirely
 * value density. This is what produces that: at 500 km by road, stone costs
 * 1.2 to move against a price near 1 (so it stays home) while goods cost 0.15
 * (so they travel).
 */
const BULK: readonly number[] = [2.5, 4.0, 8.0, 3.0, 3.0, 1.0, 1.0];

/** How many years of consumption a healthy stock covers. */
const TARGET_COVER = 2.5;

/**
 * How far output runs above bare subsistence in good conditions.
 *
 * M8's carrying capacity is defined AT subsistence: it is the population the
 * land can just feed. Setting food output equal to K x per-capita demand
 * therefore made supply exactly equal demand at M8's own equilibrium, so no
 * stock could ever accumulate, every cover ratio was zero, every price pinned
 * at the cap, every price was therefore EQUAL, and with no price gaps the
 * arbitrage that is the entire trade mechanism never fired once. The first
 * thousand-year stability run showed production frozen to 15 digits, trade
 * exactly 0, and every price at 12.00 — a "stable" economy that was stable
 * because it was stuck in a degenerate corner.
 *
 * A surplus is not a fudge factor: it is what distinguishes an economy from
 * subsistence, and it is the thing that gets stored, taxed and traded.
 */
const SUBSISTENCE_SURPLUS = 1.25;

/**
 * Timescale on which mined-out ground becomes worth mining again, years.
 *
 * Ore bodies are re-formed and re-exposed by orogeny, erosion and uplift over
 * megayears, so cumulative extraction is forgotten exponentially rather than
 * remembered forever.
 *
 * WHAT THIS DOES AND DOES NOT DO. Measured against this model's own numbers,
 * the renewal flux (~2.5e3 units/year for a typical territory) is three orders
 * of magnitude below sustained extraction (~2.2e6/year). So renewal does NOT
 * keep a continuously worked region productive — `BACKGROUND_GRADE` does. What
 * renewal governs is recovery after ABANDONMENT: a region whose people are gone
 * has its rich ground back within a few megayears, which is the right statement
 * and the one the test makes.
 *
 * An earlier version of this comment claimed renewal was what stopped the
 * planet going permanently barren. That was wrong, and the arithmetic above is
 * why; the claim is corrected rather than quietly dropped because the number it
 * justifies is still here.
 */
const RESERVE_RENEWAL_YEARS = 2.0e6;

/**
 * What a territory of PLANETARY-AVERAGE endowment can produce, as a multiple of
 * its own demand.
 *
 * Slightly above 1, so an average place roughly feeds itself, a rich one
 * exports and a poor one must import. That spread is the entire trade signal:
 * with every territory identical there are no price gaps, no arbitrage, and
 * total trade over a thousand years is exactly zero — which is what the first
 * two stability runs measured.
 *
 * Measuring against the planetary mean rather than an absolute scale is what
 * makes this robust. The first version used absolute endowment and a constant
 * of 2.4, which assumed a mean endowment around 0.3; the geology actually
 * produces about 0.01 for ore, so every non-food commodity was ~50x
 * under-produced, every stock sat at zero and every price pinned at the cap.
 * Normalising removes the assumption instead of re-tuning it.
 *
 * The old implementation used a global ABUNDANCE = 8 multiplier. Ten-seed
 * sensitivity showed that it was not robust: settled/planetary ore ratios
 * ranged from 0.39 to 2.78 as geography changed. Production now derives a
 * bounded normalisation from the current settled-land statistics each step;
 * the anti-correlation remains causal, but no seed-specific constant remains.
 */
/**
 * Share of the ceiling that low-grade ground supplies indefinitely.
 *
 * A single reservoir cannot be both "worked out in centuries" and "still there
 * after a megayear", and the real grade-tonnage curve is not one reservoir: the
 * rich seams work out while low-grade rock remains, at more effort per unit.
 * Modelling both is what lets a mining region visibly decline over centuries
 * without leaving the planet permanently barren.
 */
const BACKGROUND_GRADE = 0.18;

/** Years of full-rate extraction the high-grade deposits support. */
const RESERVE_YEARS = 400;


export interface EconomyState {
  readonly level: number;
  readonly cellCount: number;
  readonly resources: ResourceState;
  readonly network: TransportNetwork;

  /** Per settlement slot, per commodity. Row-major by commodity. */
  stock: Float64Array;
  price: Float64Array;
  production: Float64Array;
  consumption: Float64Array;
  imports: Float64Array;
  /** Cumulative extraction per settlement per commodity — depletion. */
  extracted: Float64Array;

  /** Per settlement: fraction of territory converted to farm/urban/industry. */
  landUse: Float64Array;
  /** Per settlement: energy produced this step, and pollution emitted. */
  energyOutput: Float64Array;
  emission: Float64Array;

  /** Per cell: airborne pollution, arbitrary units. Authoritative slow state. */
  readonly pollution: Float64Array;

  /** Per edge: units carried this step. Drives infrastructure investment. */
  traffic: Float64Array;
  /** Scratch, sized once: per-settlement emission share and the advection
   *  destination. Allocating these per tick would churn megabytes a year. */
  readonly emissionPerCell: Float64Array;
  /** Fuel actually burnt for energy this step, per settlement. Recorded rather
   *  than recomputed, so consumption nets exactly what production consumed. */
  readonly fuelBurnt: Float64Array;
  readonly advectScratch: Float64Array;

  capacity: number;
  /** Settlement-set version the topology was built for. */
  topologyBasis: number;
  routingBasis: number;
  steps: number;
  year: number;
  /**
   * Diagnostics.
   *
   * `totalTrade` is PER STEP — it is reset at the top of every `stepEconomy`.
   * A reader who samples it once after several steps is reading the last step
   * alone, and a converged market legitimately reports zero there while having
   * moved a great deal of freight getting to that equilibrium. A ten-seed
   * diagnostic did exactly that and recorded one world as having no trade at
   * all (T-0106). Sum it across steps for a cumulative figure.
   */
  totalTrade: number;
  totalProduction: number;
  worstShortage: number;
}

export interface EconomyConfig {
  readonly seed: Seed;
}

export function initEconomy(
  civ: CivilisationState,
  resources: ResourceState,
  network: TransportNetwork,
): EconomyState {
  const cap = civ.store.capacity;
  const w = cap * COMMODITY_COUNT;
  return {
    level: civ.level,
    cellCount: civ.cellCount,
    resources,
    network,
    stock: new Float64Array(w),
    price: new Float64Array(w).fill(1),
    production: new Float64Array(w),
    consumption: new Float64Array(w),
    imports: new Float64Array(w),
    extracted: new Float64Array(w),
    landUse: new Float64Array(cap),
    energyOutput: new Float64Array(cap),
    emission: new Float64Array(cap),
    pollution: new Float64Array(civ.cellCount),
    traffic: new Float64Array(0),
    emissionPerCell: new Float64Array(cap),
    fuelBurnt: new Float64Array(cap),
    advectScratch: new Float64Array(civ.cellCount),
    capacity: cap,
    topologyBasis: -1,
    routingBasis: -1,
    steps: 0,
    year: 0,
    totalTrade: 0,
    totalProduction: 0,
    worstShortage: 0,
  };
}

const at = (e: EconomyState, c: number, i: number): number => c * e.capacity + i;

export function stockOf(e: EconomyState, i: number, c: CommodityId): number {
  return e.stock[at(e, c, i)] as number;
}
export function priceOf(e: EconomyState, i: number, c: CommodityId): number {
  return e.price[at(e, c, i)] as number;
}
export function productionOf(e: EconomyState, i: number, c: CommodityId): number {
  return e.production[at(e, c, i)] as number;
}

/** Per-capita annual demand for a commodity at a technology level. */
export function demandPerCapita(c: CommodityId, technology: number): number {
  const lo = DEMAND_LOW[c] as number;
  const hi = DEMAND_HIGH[c] as number;
  return lo + (hi - lo) * Math.min(1, Math.max(0, technology));
}

/**
 * Recompute the endowment map. Called when the geology or biosphere moves,
 * not per tick — it is O(cells).
 */
export function refreshEconomyResources(
  e: EconomyState,
  geology: GeologyState,
  h: HydrologyState,
  b: BiosphereState,
  cfg: EconomyConfig,
): void {
  refreshResources(e.resources, geology, h, b, cfg.seed);
}

export function stepEconomy(
  e: EconomyState,
  civ: CivilisationState,
  h: HydrologyState,
  dtYears: number,
): void {
  if (!(dtYears > 0) || !Number.isFinite(dtYears)) return;
  const store = civ.store;
  const pop = store.column(CIV.population);
  const tech = store.column(CIV.technology);
  const terr = store.column(CIV.territoryCells);

  /* Topology follows the settlement set, and only that: rebuilding every tick
     would be O(cells) for a graph that has not changed. */
  if (e.topologyBasis !== civ.topologyVersion || e.routingBasis !== h.routingGeneration) {
    if (e.routingBasis !== h.routingGeneration) e.network.routeCache.clear();
    rebuildTopology(e.network, civ, h);
    e.topologyBasis = civ.topologyVersion;
    e.routingBasis = h.routingGeneration;
    e.traffic = new Float64Array(e.network.edges.length);
  }
  e.traffic.fill(0);

  produce(e, civ, pop, tech, terr, dtYears);
  consumeAndPrice(e, civ, pop, tech, dtYears);
  trade(e, civ, dtYears);
  emitPollution(e, civ, dtYears);
  investInInfrastructure(e.network, civ, e.traffic, dtYears);

  e.year += dtYears;
  e.steps++;
}

/* ---- production ------------------------------------------------------ */

/**
 * Production, expressed relative to the SAME quantity M8 uses for carrying
 * capacity.
 *
 * The first version priced production in absolute units per square metre and
 * demand in units per person, with no relation between the two constants. They
 * were out by roughly 650x for food and 8x for fuel: every polity sat in
 * permanent famine, no fuel stock ever accumulated, nothing was ever burnt, and
 * the whole M10 -> M4 pollution arrow was dead code that looked like it worked.
 * Two tests caught it. No amount of tuning would have fixed it, because the two
 * sides were not measuring the same thing.
 *
 * The fix is structural rather than numerical. A polity's food output and its
 * carrying capacity are the SAME physical fact — how much the land feeds — so
 * food production is derived from M8's carrying capacity directly and the two
 * cannot disagree. Every other commodity is scaled against that same reference
 * by its territory's MEAN endowment, which makes the model about comparative
 * advantage: an ore-rich territory exports ore and imports food whatever the
 * absolute scale of the world.
 */
function produce(
  e: EconomyState,
  civ: CivilisationState,
  pop: { [i: number]: number },
  tech: { [i: number]: number },
  terr: { [i: number]: number },
  dtYears: number,
): void {
  void terr;
  const store = civ.store;
  const res = e.resources;
  const N = res.cellCount;
  const capCol = store.column(CIV.carryingCapacity);

  /* One pass over the claim raster accumulates endowment and area for every
     owner and commodity at once: O(cells x commodities), never
     O(settlements x cells). */
  const owned = new Float64Array(e.capacity * COMMODITY_COUNT);
  const areaOf = new Float64Array(e.capacity);
  for (let c = 0; c < N; c++) {
    const owner = civ.claim[c] as number;
    if (owner < 0 || !store.aliveAt(owner)) continue;
    const area = civ.cellAreaM2[c] as number;
    areaOf[owner] = (areaOf[owner] as number) + area;
    for (let k = 0; k < COMMODITY_COUNT; k++) {
      const idx = at(e, k, owner);
      owned[idx] = (owned[idx] as number) + (res.endowment[k * N + c] as number) * area;
    }
  }

  /* GEOLOGICAL RENEWAL APPLIES EVERYWHERE, whether or not anyone is there.
     Decaying `extracted` inside the has-population branch meant an abandoned
     region's ground never recovered — the one case renewal actually governs.
     Rock does not wait for people. */
  const renew = exp(-dtYears / RESERVE_RENEWAL_YEARS);
  for (let idx = 0; idx < e.extracted.length; idx++) {
    e.extracted[idx] = (e.extracted[idx] as number) * renew;
  }

  e.totalProduction = 0;
  /* Settlements are not a random sample of land. Derive a world-local
     comparative-advantage normalisation from their actual claimed cells. This
     replaces the former fixed ABUNDANCE constant and keeps the economy
     calibrated across seeds without changing endowment geography. */
  const settledSum = new Float64Array(COMMODITY_COUNT);
  let settledCells = 0;
  for (let c = 0; c < N; c++) {
    const owner = civ.claim[c] as number;
    if (owner < 0 || !store.aliveAt(owner)) continue;
    settledCells++;
    for (let k = 0; k < COMMODITY_COUNT; k++) settledSum[k] = (settledSum[k] as number) + (res.endowment[k * N + c] as number);
  }
  const abundance = new Float64Array(COMMODITY_COUNT).fill(1);
  for (let k = 0; k < COMMODITY_COUNT; k++) {
    const settledMean = (settledSum[k] as number) / Math.max(1, settledCells);
    const planetary = res.planetaryMean[k] as number;
    if (settledMean > 1e-12 && planetary > 1e-12) {
      abundance[k] = Math.min(8, Math.max(0.25, planetary / settledMean));
    }
  }
  for (let i = 0; i < store.bound; i++) {
    if (!store.aliveAt(i)) continue;
    const P = pop[i] as number;
    const t = tech[i] as number;
    if (!(P > 0)) {
      for (let k = 0; k < COMMODITY_COUNT; k++) e.production[at(e, k, i)] = 0;
      e.energyOutput[i] = 0;
      e.emission[i] = 0;
      e.fuelBurnt[i] = 0;
      continue;
    }
    const K = capCol[i] as number;
    const area = areaOf[i] as number;
    /* The reference scale: what this territory's land supports. The population
       floor keeps a polity whose capacity has collapsed from dividing by zero. */
    const scale = Math.max(P * 0.25, K);
    /* Endowment RELATIVE to the planetary mean: 1 is an average territory. */
    const rel = (k: number): number => {
      if (!(area > 0)) return 0;
      const m = (owned[at(e, k, i)] as number) / area;
      const planetary = res.planetaryMean[k] as number;
      return planetary > 1e-12 ? m / planetary : 0;
    };

    /* FOOD is M8's carrying capacity, by construction — plus the surplus that
       makes it an economy rather than subsistence. */
    e.production[at(e, COMMODITY.FOOD, i)] =
      K * demandPerCapita(COMMODITY.FOOD, t) * SUBSISTENCE_SURPLUS;

    /* TIMBER regrows; its ceiling is the standing forest. */
    e.production[at(e, COMMODITY.TIMBER, i)] =
      rel(COMMODITY.TIMBER) * (abundance[COMMODITY.TIMBER] as number) * scale * demandPerCapita(COMMODITY.TIMBER, t);

    /* STONE, ORE, FUEL come out of the ground, deplete over centuries, and are
       renewed by tectonics over megayears. */
    for (const k of EXTRACTIVE) {
      const ceiling = rel(k) * (abundance[k] as number) * scale * demandPerCapita(k, t) * (0.55 + 0.75 * t);
      const taken = e.extracted[at(e, k, i)] as number;
      const stockTotal = ceiling * RESERVE_YEARS;
      const richLeft = stockTotal > 0 ? Math.max(0, 1 - taken / stockTotal) : 0;
      const rate = ceiling * (BACKGROUND_GRADE + (1 - BACKGROUND_GRADE) * richLeft);
      e.production[at(e, k, i)] = rate;
      e.extracted[at(e, k, i)] = taken + rate * dtYears;
    }

    /* ENERGY: burnt fuel plus a technology-dependent non-combustion share. The
       clean share is a separate term rather than a fudge, because it is what
       eventually decouples growth from emissions. */
    const fuelAvailable = (e.production[at(e, COMMODITY.FUEL, i)] as number)
      + (e.imports[at(e, COMMODITY.FUEL, i)] as number)
      + (e.stock[at(e, COMMODITY.FUEL, i)] as number) / Math.max(dtYears, 1);
    const wantEnergy = scale * demandPerCapita(COMMODITY.ENERGY, t);
    const perUnit = 3.6 * (0.25 + 0.55 * t);
    const cleanShare = t > 0.75 ? Math.min(0.85, (t - 0.75) * 3.2) : 0;
    const clean = wantEnergy * cleanShare;
    const thermalWanted = Math.max(0, wantEnergy - clean);
    const fuelBurnt = Math.max(0, Math.min(fuelAvailable * 0.6, thermalWanted / Math.max(0.5, perUnit)));
    const thermal = fuelBurnt * perUnit;
    e.production[at(e, COMMODITY.ENERGY, i)] = thermal + clean;
    e.energyOutput[i] = thermal + clean;
    e.fuelBurnt[i] = fuelBurnt;
    /* Only combustion pollutes. */
    e.emission[i] = thermal;

    /* GOODS: a Leontief minimum of ore, energy and labour — you cannot
       substitute coal for iron. */
    const wantGoods = scale * demandPerCapita(COMMODITY.GOODS, t);
    const oreIn = (e.production[at(e, COMMODITY.ORE, i)] as number)
      + (e.imports[at(e, COMMODITY.ORE, i)] as number)
      + (e.stock[at(e, COMMODITY.ORE, i)] as number) / Math.max(dtYears, 1);
    const labour = P * 0.42 * (0.15 + 2.2 * t);
    e.production[at(e, COMMODITY.GOODS, i)] = Math.max(0, Math.min(
      wantGoods * 1.6,
      oreIn * 1.1,
      (e.production[at(e, COMMODITY.ENERGY, i)] as number) * 1.4,
      labour,
    ));

    for (let k = 0; k < COMMODITY_COUNT; k++) {
      e.totalProduction += e.production[at(e, k, i)] as number;
    }
  }
}

/* ---- consumption, stocks and prices ---------------------------------- */

function consumeAndPrice(
  e: EconomyState,
  civ: CivilisationState,
  pop: { [i: number]: number },
  tech: { [i: number]: number },
  dtYears: number,
): void {
  const store = civ.store;
  e.worstShortage = 0;

  for (let i = 0; i < store.bound; i++) {
    if (!store.aliveAt(i)) continue;
    const P = pop[i] as number;
    const t = tech[i] as number;
    for (let k = 0; k < COMMODITY_COUNT; k++) {
      const idx = at(e, k, i);
      const want = P * demandPerCapita(k as CommodityId, t);
      e.consumption[idx] = want;

      /* Inputs consumed by production are netted out here rather than in
         `produce`, so a stock can never go negative between the two. */
      let drain = want;
      if (k === COMMODITY.ORE) drain += (e.production[at(e, COMMODITY.GOODS, i)] as number) / 1.1;
      if (k === COMMODITY.FUEL) drain += e.fuelBurnt[i] as number;

      const supply = (e.production[idx] as number) + (e.imports[idx] as number);
      const net = (supply - drain) * dtYears;
      let s = (e.stock[idx] as number) + net;
      /* Energy is not storable; everything else is, and spoils slowly. */
      if (k === COMMODITY.ENERGY) s = Math.max(0, supply - drain) * 0.01;
      else s = Math.max(0, s) * exp(-0.004 * dtYears);
      e.stock[idx] = s;

      /* PRICE.
       *
       * Scarcity has to be measured on the FLOW as well as the stock. Pricing
       * on stock cover alone pins every price at the cap whenever stocks are
       * thin, and a world where every price is identical has no price gaps,
       * hence no arbitrage, hence no trade at all — which is exactly what the
       * first stability run measured. The flow term is what gives two polities
       * different prices for the same commodity, and that difference IS the
       * trade signal.
       *
       * Relaxed toward the fair value rather than jumped to it: an instant
       * price is an oscillator at a 500-year step. */
      const target = Math.max(1e-9, want * TARGET_COVER);
      const cover = s / target;
      const flow = want > 0 ? supply / want : (supply > 0 ? 3 : 1);
      const abundance = 0.65 * Math.min(4, flow) + 0.35 * Math.min(3, cover);
      /* Bounded 0.1x .. 12x. An unbounded price on a commodity nobody has is
         infinite, and infinity propagates through every downstream term. */
      const fair = Math.min(12, Math.max(0.1, 1 / Math.max(0.08, abundance)));
      const relax = 1 - exp(-dtYears * 0.35);
      const p = (e.price[idx] as number);
      e.price[idx] = p + (fair - p) * relax;

      if (k === COMMODITY.FOOD && want > 0) {
        const shortage = Math.max(0, 1 - (supply / want));
        if (shortage > e.worstShortage) e.worstShortage = shortage;
      }
    }
  }
}

/* ---- trade: local arbitrage over the network ------------------------- */

function trade(e: EconomyState, civ: CivilisationState, dtYears: number): void {
  const net = e.network;
  const store = civ.store;
  e.imports.fill(0);
  e.totalTrade = 0;
  if (net.edges.length === 0) return;

  /* Information propagation is measured per SIMULATED interval, not per call.
     A fixed three passes made a 500-year paleo tick move price information
     less far per century than annual ticks. Grow virtual passes with dt until
     a bounded regional-equilibrium cap; this remains O(edges * min(nodes, 8)) and
     is deterministic. The cap is explicit temporal LOD: beyond it this tick
     solves a regional equilibrium rather than pretending markets stopped. */
  const passes = arbitragePasses(dtYears, net.nodes.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let ei = 0; ei < net.edges.length; ei++) {
      const edge = net.edges[ei]!;
      const ai = net.nodes[edge.a] as number;
      const bi = net.nodes[edge.b] as number;
      if (!store.aliveAt(ai) || !store.aliveAt(bi)) continue;

      for (let k = 0; k < COMMODITY_COUNT; k++) {
        /* Energy does not travel on carts. Before a grid exists it is consumed
           where it is made, which is why industry clusters on coalfields. */
        if (k === COMMODITY.ENERGY) continue;
        const ia = at(e, k, ai);
        const ib = at(e, k, bi);
        const pa = e.price[ia] as number;
        const pb = e.price[ib] as number;
        const gap = pb - pa;
        const cost = edge.unitCost * (BULK[k] as number);
        /* No trade unless the gap covers the carriage. This is the whole
           mechanism: transport cost is what makes geography matter. */
        if (Math.abs(gap) <= cost) continue;

        const fromIsA = gap > 0;
        const from = fromIsA ? ia : ib;
        const to = fromIsA ? ib : ia;
        const available = (e.stock[from] as number);
        if (!(available > 0)) continue;

        /* Move a bounded share: enough to close the gap, capped by what the
           link can carry and by not stripping the exporter. */
        const room = (Math.abs(gap) - cost) / Math.max(0.05, Math.abs(gap));
        const wanted = available * 0.25 * room;
        const shipped = Math.min(wanted, edge.capacity * dtYears * 1e3);
        if (!(shipped > 0)) continue;

        e.stock[from] = available - shipped;
        e.stock[to] = (e.stock[to] as number) + shipped;
        e.imports[to] = (e.imports[to] as number) + shipped / Math.max(dtYears, 1e-6);
        e.traffic[ei] = (e.traffic[ei] as number) + shipped;
        e.totalTrade += shipped;

        /* Prices move toward each other as the goods move — that convergence
           IS the spatial equilibrium, reached without any global solve. */
        const settle = 0.35 * room;
        e.price[from] = (e.price[from] as number) + (e.price[to] as number - (e.price[from] as number)) * settle * 0.5;
        e.price[to] = (e.price[to] as number) + ((e.price[from] as number) - (e.price[to] as number)) * settle;
      }
    }
  }
}

export function arbitragePasses(dtYears: number, nodeCount: number): number {
  const regionalCap = Math.max(1, Math.min(8, Math.max(1, nodeCount - 1)));
  return Math.min(regionalCap, Math.max(1, Math.ceil(3 + 2 * log10(Math.max(1, dtYears)))));
}

/* ---- pollution and its coupling back to the climate ------------------ */

/**
 * Emit each polity's combustion into the pollution field, then let it decay.
 *
 * Advection by M4's wind is applied separately by `advectPollution`, which the
 * world calls with the current wind field: the emission source is an economic
 * fact and the transport is an atmospheric one, and keeping them separate is
 * what stops M10 quietly owning a piece of M4.
 */
function emitPollution(e: EconomyState, civ: CivilisationState, dtYears: number): void {
  const store = civ.store;
  const terr = store.column(CIV.territoryCells);
  const cellOf = store.column(CIV.cell);

  /* ONE pass over the cells, not one per settlement.
   *
   * The obvious form — for each polity, scan every cell for its claim — is
   * O(settlements x cells): 1.1 million tests per step at only 184 polities on
   * a 6 144-cell grid, and quadratic in exactly the way the design forbids.
   * Precomputing each polity's per-cell share first makes the raster sweep
   * O(cells) regardless of how many polities exist. */
  const perCell = e.emissionPerCell;
  perCell.fill(0);
  for (let i = 0; i < store.bound; i++) {
    if (!store.aliveAt(i)) continue;
    const emitted = (e.emission[i] as number) * dtYears;
    if (!(emitted > 0)) continue;
    /* Half at the seat — industry is where the people are, not spread evenly
       over an empire — and half across the territory. */
    const seat = cellOf[i] as number;
    if (seat >= 0 && seat < e.cellCount) {
      e.pollution[seat] = (e.pollution[seat] as number) + emitted * 0.5;
    }
    perCell[i] = (emitted * 0.5) / Math.max(1, terr[i] as number);
  }

  const survive = exp(-dtYears * 0.03);
  for (let c = 0; c < e.cellCount; c++) {
    const owner = civ.claim[c] as number;
    const add = owner >= 0 && owner < perCell.length && store.aliveAt(owner)
      ? (perCell[owner] as number) : 0;
    /* Deposition and chemical loss, exponential so it is dt-exact. */
    e.pollution[c] = ((e.pollution[c] as number) + add) * survive;
  }
}

/**
 * Advect the pollution field with M4's wind.
 *
 * Semi-Lagrangian on the cube grid: for each cell, look UPWIND by one step and
 * take what was there. Unconditionally stable for any dt, which matters because
 * the economy's step can be centuries while the wind is an hourly field — and a
 * forward-Euler advection would go unstable long before that.
 *
 * `windU`/`windV` are on the CLIMATE grid, so the caller must resample them
 * onto the economy grid first (T-0080): passing bare arrays of the wrong
 * length would blow pollution in an arbitrary direction.
 */
export function advectPollution(
  e: EconomyState,
  windU: ArrayLike<number>,
  windV: ArrayLike<number>,
  dtYears: number,
  cubeDimAt: (level: number) => number,
): void {
  if (windU.length !== e.cellCount || windV.length !== e.cellCount) return;
  const n = cubeDimAt(e.level);
  const out = e.advectScratch;
  /* Cell width in metres, roughly; enough for a sub-cell Courant number. */
  const cellM = (Math.PI * 6_371_000) / 2 / n;
  const seconds = dtYears * 31_556_952;

  for (let c = 0; c < e.cellCount; c++) {
    const face = Math.floor(c / (n * n));
    const local = c - face * n * n;
    const y = Math.floor(local / n);
    const x = local - y * n;
    /* Displacement in cells, clamped: over a century the wind would carry a
       parcel around the planet many times, and beyond one cell per step the
       upwind sample is meaningless — the field is then effectively well mixed,
       which the clamp plus repeated stepping reproduces. */
    const du = Math.max(-1, Math.min(1, -((windU[c] as number) * seconds) / cellM));
    const dv = Math.max(-1, Math.min(1, -((windV[c] as number) * seconds) / cellM));
    const sx = Math.max(0, Math.min(n - 1, Math.round(x + du)));
    const sy = Math.max(0, Math.min(n - 1, Math.round(y + dv)));
    out[c] = e.pollution[face * n * n + sy * n + sx] as number;
  }
  /* Blend rather than replace: pure upwind sampling on a coarse grid is a
     shift, and a shift loses the source. Half-and-half diffuses as it moves,
     which is what a plume does. */
  for (let c = 0; c < e.cellCount; c++) {
    e.pollution[c] = (e.pollution[c] as number) * 0.35 + (out[c] as number) * 0.65;
  }
}

/* ---- feedback into M8 ------------------------------------------------- */

/**
 * What the economy does back to the people.
 *
 * Returns a per-settlement multiplier on M8's carrying capacity. This is the
 * arrow that makes M10 part of the simulation rather than a readout: a polity
 * that can IMPORT food supports more people than its own land feeds, which is
 * how every trading city in history worked, and a polity in famine supports
 * fewer.
 */
export function capacityMultiplier(e: EconomyState, civ: CivilisationState, i: number): number {
  if (!civ.store.aliveAt(i)) return 1;
  const idx = at(e, COMMODITY.FOOD, i);
  const want = e.consumption[idx] as number;
  if (!(want > 0)) return 1;
  const supply = (e.production[idx] as number) + (e.imports[idx] as number);
  const ratio = supply / want;
  /* Bounded both ways. Trade can roughly double what the land alone feeds —
     more than that and the polity is a city-state living entirely on imports,
     which is a real thing but not one a bounded model should reach by
     accident. */
  return Math.min(2.2, Math.max(0.35, 0.55 + 0.45 * ratio));
}

/**
 * Technology bonus from energy and goods per head.
 *
 * The industrial revolution is not a date, it is what happens when energy per
 * head crosses a threshold — so M8's technology growth is multiplied by this
 * rather than running on its own clock.
 */
export function technologyMultiplier(e: EconomyState, civ: CivilisationState, i: number): number {
  if (!civ.store.aliveAt(i)) return 1;
  const pop = civ.store.column(CIV.population)[i] as number;
  if (!(pop > 0)) return 1;
  const energyPerHead = (e.production[at(e, COMMODITY.ENERGY, i)] as number) / pop;
  const goodsPerHead = (e.stock[at(e, COMMODITY.GOODS, i)] as number) / pop;
  const drive = log10(1 + energyPerHead * 900 + goodsPerHead * 300);
  return Math.min(4.5, 0.55 + drive);
}

/** Land converted to farm, town and works — the M10 -> M6 land-use arrow. */
export function updateLandUse(e: EconomyState, civ: CivilisationState): void {
  const store = civ.store;
  const pop = store.column(CIV.population);
  const cap = store.column(CIV.carryingCapacity);
  for (let i = 0; i < store.bound; i++) {
    if (!store.aliveAt(i)) { e.landUse[i] = 0; continue; }
    const k = cap[i] as number;
    /* Cultivated fraction tracks how hard the land is being worked. */
    e.landUse[i] = k > 0 ? Math.min(0.92, (pop[i] as number) / k * 0.8) : 0;
  }
}

/**
 * Digest of the economy's CONTINUATION state (T-0094).
 *
 * The classification below is the substance of this function; the folding is
 * mechanical. Every member of `EconomyState` is in exactly one class.
 *
 * A — AUTHORITATIVE / CONTINUATION-RELEVANT. Read on a later tick, so two
 *     worlds differing here diverge. All folded.
 *       stock, price, extracted, landUse, pollution   (already were)
 *       production, consumption, imports              (were NOT — see below)
 *       year, topologyBasis, routingBasis, steps      (were NOT)
 *       network (via networkDigest)
 *
 *     `production`, `consumption` and `imports` are the ones that mattered.
 *     M8 runs in the Civilisation phase, which precedes Economy, so
 *     `capacityMultiplier` and `technologyMultiplier` read the PREVIOUS tick's
 *     values; `imports` additionally survives into the next `produce()` as
 *     available fuel and ore. Two worlds could therefore agree on the old
 *     digest and feed a different number of people on the very next step.
 *
 *     `topologyBasis` and `routingBasis` are a state machine: they decide
 *     whether the next step rebuilds the transport topology and clears the
 *     route cache. Same digest, different rebuild, different world.
 *
 * B — DIAGNOSTIC. Recomputed from scratch every step before anything reads
 *     them: totalTrade, totalProduction, worstShortage. Not folded.
 *
 * C — DERIVED / REGENERABLE. `resources` is a pure function of geology, the
 *     biosphere and the seed, refreshed whenever those change; folding it would
 *     be folding the geology twice. `network.routeCache` is a cache keyed by
 *     inputs that are themselves folded.
 *
 * D — SCRATCH. Fully written before being read within a step, so their value at
 *     a tick boundary cannot influence anything: energyOutput, emission,
 *     fuelBurnt, traffic, emissionPerCell, advectScratch. Not folded.
 *
 * `level`, `cellCount` and `capacity` are structural constants of the
 * configuration; they are folded because it is free and a mismatch there means
 * two incomparable worlds are being compared.
 */
/**
 * Why is trade what it is? (T-0106)
 *
 * A ten-seed diagnostic reported one world with `trade: 0` and nothing else.
 * Zero trade is not automatically a bug — a scattered world of self-sufficient
 * hamlets with no price gap worth a cart is a correct outcome, and calibrating
 * until every seed shows a positive number would be tuning the model to make a
 * diagnostic look tidy. But an UNEXPLAINED zero is indistinguishable from a
 * broken market, and "it is probably fine" is not a finding.
 *
 * So the question is answered structurally: walk the same edges and commodities
 * the arbitrage pass walks, and report which precondition failed. Every zero
 * then has a reason attached, and a reason that is not on this list is a bug
 * worth chasing.
 *
 * READ-ONLY. It writes nothing and is not part of any digest.
 */
export const TRADE_STATUS = {
  /** Goods moved. */
  TRADING: 'trading',
  /** Fewer than two settlements are in the network. Nobody to trade with. */
  NO_COUNTERPARTIES: 'no-counterparties',
  /** Settlements exist but nothing links them: no shared border, no shared sea. */
  NO_LINKS: 'no-links',
  /** Links exist and nobody has anything to ship. */
  NO_STOCK: 'no-stock',
  /**
   * Links, stock and prices all exist, and no price gap anywhere covers the
   * cost of carriage. This is the model working: transport cost is what makes
   * geography matter, and sometimes geography says stay home.
   */
  GAPS_BELOW_CARRIAGE: 'gaps-below-carriage',
  /**
   * Gaps wide enough to pay for carriage exist, but at the cheap end of every
   * one of them the warehouse is empty. Also the model working — a price gap
   * you cannot supply is not a trade — and distinct from the case above,
   * because the two have different causes and different fixes.
   */
  EXPORTERS_EMPTY: 'exporters-empty',
  /**
   * Links, stock, and a fundable gap with goods behind it, and still nothing
   * moved. Nothing should produce this. It is here so that the impossible case
   * has a name instead of being absorbed into a plausible one.
   */
  UNEXPLAINED: 'unexplained',
} as const;
export type TradeStatus = (typeof TRADE_STATUS)[keyof typeof TRADE_STATUS];

export interface TradeDiagnosis {
  readonly status: TradeStatus;
  readonly nodes: number;
  readonly edges: number;
  /** Largest |price gap| / carriage cost seen on any edge. >1 permits trade. */
  readonly bestGapRatio: number;
  /** The same, but only where the exporting end actually has stock to ship. */
  readonly bestActionableGapRatio: number;
  /** Total tradeable stock held by settlements in the network. */
  readonly tradeableStock: number;
  readonly totalTrade: number;
}

export function diagnoseTrade(e: EconomyState, civ: CivilisationState): TradeDiagnosis {
  const net = e.network;
  const store = civ.store;
  let bestGapRatio = 0;
  let bestActionableGapRatio = 0;
  let tradeableStock = 0;
  let liveNodes = 0;

  for (let n = 0; n < net.nodes.length; n++) {
    const i = net.nodes[n] as number;
    if (!store.aliveAt(i)) continue;
    liveNodes++;
    for (let k = 0; k < COMMODITY_COUNT; k++) {
      if (k === COMMODITY.ENERGY) continue;
      tradeableStock += e.stock[at(e, k, i)] as number;
    }
  }

  for (const edge of net.edges) {
    const ai = net.nodes[edge.a] as number;
    const bi = net.nodes[edge.b] as number;
    if (!store.aliveAt(ai) || !store.aliveAt(bi)) continue;
    for (let k = 0; k < COMMODITY_COUNT; k++) {
      if (k === COMMODITY.ENERGY) continue;
      const pa = e.price[at(e, k, ai)] as number;
      const pb = e.price[at(e, k, bi)] as number;
      const signed = pb - pa;
      const cost = edge.unitCost * (BULK[k] as number);
      const ratio = Math.abs(signed) / Math.max(1e-12, cost);
      if (ratio > bestGapRatio) bestGapRatio = ratio;
      /* Goods flow from the cheap end to the dear one, so it is the CHEAP
         end's warehouse that decides whether a gap is actionable. */
      const exporter = signed > 0 ? ai : bi;
      if ((e.stock[at(e, k, exporter)] as number) > 0 && ratio > bestActionableGapRatio) {
        bestActionableGapRatio = ratio;
      }
    }
  }

  const status: TradeStatus = e.totalTrade > 0 ? TRADE_STATUS.TRADING
    : liveNodes < 2 ? TRADE_STATUS.NO_COUNTERPARTIES
    : net.edges.length === 0 ? TRADE_STATUS.NO_LINKS
    : tradeableStock <= 0 ? TRADE_STATUS.NO_STOCK
    : bestActionableGapRatio > 1 ? TRADE_STATUS.UNEXPLAINED
    : bestGapRatio > 1 ? TRADE_STATUS.EXPORTERS_EMPTY
    : TRADE_STATUS.GAPS_BELOW_CARRIAGE;

  return { status, nodes: liveNodes, edges: net.edges.length,
    bestGapRatio, bestActionableGapRatio, tradeableStock, totalTrade: e.totalTrade };
}

export function economyDigest(e: EconomyState): number {
  const mix = (h: number, v: number): number => {
    let x = (h ^ Math.imul(v | 0, 0x9e3779b1)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
    return (x ^ (x >>> 15)) >>> 0;
  };
  let h = mix(0x9e3779b1, e.steps);
  h = mix(h, e.level);
  h = mix(h, e.cellCount);
  h = mix(h, e.capacity);
  h = mix(h, e.topologyBasis);
  h = mix(h, e.routingBasis);
  h = mix(h, networkDigest(e.network));
  const fold = (a: Float64Array, q: number): void => {
    for (let i = 0; i < a.length; i++) {
      const v = a[i] as number;
      if (!Number.isFinite(v)) { h = mix(h, 0x7ff1); continue; }
      const s = Math.round(v * q);
      h = mix(h, s | 0);
      h = mix(h, Math.floor(s / 0x100000000) | 0);
    }
  };
  fold(e.stock, 1e3);
  fold(e.price, 1e6);
  fold(e.production, 1e3);
  fold(e.consumption, 1e3);
  fold(e.imports, 1e3);
  fold(e.extracted, 1e3);
  fold(e.pollution, 1e6);
  fold(e.landUse, 1e6);
  /* Simulated years elapsed; a scalar, folded through the same quantiser. */
  const y = Math.round(e.year * 1e3);
  h = mix(h, y | 0);
  h = mix(h, Math.floor(y / 0x100000000) | 0);
  return h >>> 0;
}
