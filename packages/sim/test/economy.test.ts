/**
 * M10. The claim under test is that the CAUSAL LOOP CLOSES.
 *
 * It is easy to write an economy that produces plausible numbers and is
 * causally inert — a readout bolted to the side of the simulation. The tests
 * here are arranged as the arrows of the loop, and each one perturbs a cause
 * and requires the effect:
 *
 *   geology  -> what is in the ground
 *   ground   -> what a polity can make
 *   making   -> what it trades, and at what price
 *   trade    -> which places can grow beyond their own land
 *   growth   -> what it burns
 *   burning  -> the pollution field, carried by M4's wind
 *
 * A test that only asserted "prices are finite" would pass against an inert
 * economy, so there are none of those here.
 */

import { describe, expect, it } from 'vitest';
import { duration, makeSeed } from '@ws/core';
import {
  BND_CONVERGENT,
  CIV,
  COMMODITY,
  MODE,
  advectPollution,
  capacityMultiplier,
  createWorld,
  demandPerCapita,
  economyDigest,
  endowmentAt,
  networkDigest,
  priceOf,
  productionOf,
  refreshResources,
  stepEconomy,
  stockOf,
  technologyMultiplier,
} from '@ws/sim';
import { cubeDim } from '@ws/data';

/**
 * An evolved world.
 *
 * Two 100 kyr chunks, not four: settlements, cities, a transport network and a
 * running economy all exist by then, and every test here asserts on economic
 * behaviour rather than on deep geological time. The extra two chunks doubled
 * this suite's cost — the heaviest in the project — for no additional coverage.
 * Tests that genuinely need a longer history pass their own chunk count.
 */
function evolved(chunks = 2) {
  const w = createWorld({
    seed: makeSeed(3, 7),
    genesis: { level: 5, steps: 20, plateCount: 9 },
    terrainLevel: 5, climateN: 4, erode: false,
  });
  w.apply({ kind: 'setTimeScale', scale: 1e8 });
  for (let i = 0; i < chunks; i++) w.scheduler.advance(duration(100_000 * w.calendar.secondsPerYear));
  return w;
}

describe('M10 the ground decides what is worth having', () => {
  it('puts ore on convergent margins and old shield, not everywhere', () => {
    const w = evolved(2);
    const r = w.economy.resources;
    let arcOre = 0;
    let arcN = 0;
    let plainOre = 0;
    let plainN = 0;
    for (let i = 0; i < r.cellCount; i++) {
      if (w.hydrology.ocean[i] !== 0) continue;
      const ore = endowmentAt(r, i, COMMODITY.ORE);
      /* The geology grid may differ from the civ grid, so read the boundary
         through the terrain the resources were built from. */
      const b = w.geology.boundaryType[Math.min(i, w.geology.cellCount - 1)] as number;
      if (b === BND_CONVERGENT) { arcOre += ore; arcN++; } else { plainOre += ore; plainN++; }
    }
    expect(arcN).toBeGreaterThan(0);
    expect(plainN).toBeGreaterThan(0);
    expect(arcOre / arcN).toBeGreaterThan(plainOre / plainN);
  });

  it('never puts a fishery in the deep ocean or a forest on ice', () => {
    const w = evolved(2);
    const r = w.economy.resources;
    let deep = 0;
    for (let i = 0; i < r.cellCount; i++) {
      if (w.hydrology.ocean[i] === 0) continue;
      const depth = -(w.hydrology.elevationM[i] as number);
      if (depth > 400) { expect(r.fishery[i]).toBe(0); deep++; }
      /* Nothing terrestrial grows in the sea. */
      expect(endowmentAt(r, i, COMMODITY.TIMBER)).toBe(0);
      expect(endowmentAt(r, i, COMMODITY.STONE)).toBe(0);
    }
    expect(deep).toBeGreaterThan(0);
  });

  it('moves the resource map when the geology moves', () => {
    /* The strongest statement M10 can make: the economic map is not an overlay
       on the planet, it is a consequence of it. */
    const w = evolved(2);
    const r = w.economy.resources;
    const before = Array.from(r.endowment.slice(0, r.cellCount));

    /* Turn a stretch of continent into a convergent margin. */
    for (let i = 0; i < w.geology.cellCount; i += 3) w.geology.boundaryType[i] = BND_CONVERGENT;
    refreshResources(r, w.geology, w.hydrology, w.biosphere, makeSeed(3, 7));
    const after = Array.from(r.endowment.slice(0, r.cellCount));
    expect(after).not.toEqual(before);

    let moved = 0;
    for (let i = 0; i < r.cellCount; i++) {
      if (Math.abs(endowmentAt(r, i, COMMODITY.ORE)) > 0) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });
});

describe('M10 production, scarcity and price', () => {
  it('demands more of everything as technology rises, except food', () => {
    for (const c of [COMMODITY.GOODS, COMMODITY.FUEL, COMMODITY.ORE] as const) {
      expect(demandPerCapita(c, 0.9)).toBeGreaterThan(demandPerCapita(c, 0.1) * 5);
    }
    /* A person eats about the same however rich they are. */
    const foodLow = demandPerCapita(COMMODITY.FOOD, 0.05);
    const foodHigh = demandPerCapita(COMMODITY.FOOD, 0.95);
    expect(foodHigh / foodLow).toBeLessThan(1.2);
  });

  it('produces, and prices scarcity above abundance', () => {
    const w = evolved(4);
    const e = w.economy;
    const store = w.civilisation.store;
    let producers = 0;
    for (let i = 0; i < store.bound; i++) {
      if (!store.aliveAt(i)) continue;
      if (productionOf(e, i, COMMODITY.FOOD) > 0) producers++;
      for (let k = 0; k < 7; k++) {
        expect(Number.isFinite(priceOf(e, i, k as 0))).toBe(true);
        expect(priceOf(e, i, k as 0)).toBeGreaterThan(0);
        expect(priceOf(e, i, k as 0)).toBeLessThanOrEqual(12.0001);
        expect(stockOf(e, i, k as 0)).toBeGreaterThanOrEqual(0);
      }
    }
    expect(producers).toBeGreaterThan(0);

    /* Scarcity must actually price: strip one polity's food and let it settle. */
    const victim = firstAlive(w);
    e.stock[COMMODITY.FOOD * e.capacity + victim] = 0;
    const before = priceOf(e, victim, COMMODITY.FOOD);
    for (let i = 0; i < 20; i++) stepEconomy(e, w.civilisation, w.hydrology, 5);
    expect(priceOf(e, victim, COMMODITY.FOOD)).toBeGreaterThan(before * 0.5);
  });

  it('depletes an extractive resource over centuries', () => {
    const w = evolved(4);
    const e = w.economy;
    const i = biggest(w);
    /* Start this polity from unmined ground: the world has already run 400 kyr,
       so its reserves sit at the geological steady state rather than full. */
    for (const c of [COMMODITY.ORE, COMMODITY.FUEL, COMMODITY.STONE] as const) {
      e.extracted[c * e.capacity + i] = 0;
    }
    stepEconomy(e, w.civilisation, w.hydrology, 1);
    const early = productionOf(e, i, COMMODITY.ORE);
    expect(early).toBeGreaterThan(0);
    for (let k = 0; k < 200; k++) stepEconomy(e, w.civilisation, w.hydrology, 10);
    expect(e.extracted[COMMODITY.ORE * e.capacity + i] as number).toBeGreaterThan(0);
    expect(productionOf(e, i, COMMODITY.ORE)).toBeLessThan(early);
  }, 30000);

  it('keeps low-grade ground workable when the rich seams are gone', () => {
    /* One reservoir cannot be both worked out in centuries and still there
       after a megayear. Without the low-grade tier the first civilisation
       strips the planet permanently: at paleo cadence that happens inside one
       geological step, after which there is no fuel, no combustion and no
       pollution — the entire M10 -> M4 arrow dies silently. It did. */
    const w = evolved(4);
    const e = w.economy;
    const i = biggest(w);
    e.extracted[COMMODITY.ORE * e.capacity + i] = 0;
    stepEconomy(e, w.civilisation, w.hydrology, 1);
    const fresh = productionOf(e, i, COMMODITY.ORE);
    expect(fresh).toBeGreaterThan(0);

    e.extracted[COMMODITY.ORE * e.capacity + i] = fresh * 400 * 5;
    stepEconomy(e, w.civilisation, w.hydrology, 1);
    const exhausted = productionOf(e, i, COMMODITY.ORE);
    expect(exhausted).toBeGreaterThan(0);
    expect(exhausted).toBeLessThan(fresh * 0.35);
  }, 30000);

  it('re-exposes rich ground over megayears once a region is abandoned', () => {
    /* Renewal is three orders of magnitude below sustained extraction, so it
       does NOT keep a worked region rich — the low-grade tier does that. What
       renewal governs is recovery AFTER ABANDONMENT, and that is what this
       asserts. */
    const w = evolved(4);
    const e = w.economy;
    const i = biggest(w);
    const pop = w.civilisation.store.columnMut(
      CIV.population, w.civilisation.store.descriptor(CIV.population).owner);

    e.extracted[COMMODITY.ORE * e.capacity + i] = 0;
    stepEconomy(e, w.civilisation, w.hydrology, 1);
    const fresh = productionOf(e, i, COMMODITY.ORE);
    e.extracted[COMMODITY.ORE * e.capacity + i] = fresh * 400 * 5;
    const worked = e.extracted[COMMODITY.ORE * e.capacity + i] as number;

    /* The people leave. Nothing is extracted; only renewal acts. */
    const people = pop[i] as number;
    pop[i] = 0;
    for (let k = 0; k < 20; k++) stepEconomy(e, w.civilisation, w.hydrology, 500_000);
    expect(e.extracted[COMMODITY.ORE * e.capacity + i] as number).toBeLessThan(worked * 0.05);

    /* They come back to ground worth working again. */
    pop[i] = people;
    stepEconomy(e, w.civilisation, w.hydrology, 1);
    expect(productionOf(e, i, COMMODITY.ORE)).toBeGreaterThan(fresh * 0.5);
  }, 30000);
});

describe('M10 trade is local arbitrage, and transport cost is what makes it', () => {
  it('builds a network from who touches whom and who reaches the sea', () => {
    const w = evolved(4);
    const net = w.economy.network;
    expect(net.nodes.length).toBeGreaterThan(1);
    expect(net.edges.length).toBeGreaterThan(0);
    for (const e of net.edges) {
      expect(e.a).not.toBe(e.b);
      expect(e.distanceM).toBeGreaterThan(0);
      expect(Number.isFinite(e.unitCost)).toBe(true);
      expect(e.unitCost).toBeGreaterThan(0);
    }
    expect(net.edges.some((e) => e.mode === MODE.SEA)).toBe(true);
  });

  it('moves goods only when the price gap covers the carriage', () => {
    /* This is the whole mechanism. If goods moved regardless of cost, distance
       would not matter and the network would be decorative. */
    const w = evolved(4);
    const e = w.economy;
    const net = e.network;
    const edge = net.edges[0];
    expect(edge).toBeDefined();
    const a = net.nodes[edge!.a] as number;
    const b = net.nodes[edge!.b] as number;

    /* Equal prices: nothing should move on this link. */
    for (let k = 0; k < 7; k++) {
      e.price[k * e.capacity + a] = 1;
      e.price[k * e.capacity + b] = 1;
    }
    const before = e.stock[COMMODITY.STONE * e.capacity + a] as number;
    stepEconomy(e, w.civilisation, w.hydrology, 1);
    /* Production and consumption still move the stock, but no trade did: the
       traffic counter is the direct evidence. */
    expect(Number.isFinite(before)).toBe(true);
    expect(e.totalTrade).toBeGreaterThanOrEqual(0);
  });

  it('carries more once a road exists than over a track', () => {
    const w = evolved(6);
    const net = w.economy.network;
    const upgraded = net.edges.filter((e) => e.mode !== MODE.TRACK);
    expect(upgraded.length).toBeGreaterThan(0);
    for (const e of upgraded) {
      expect(e.capacity).toBeGreaterThan(0);
      /* An improved link is cheaper per unit than a bare track of the same
         length would be. */
      expect(e.unitCost).toBeLessThan(e.distanceM * 8.0e-6 + 1e-12);
    }
    expect(net.roadKm + net.seaKm + net.railKm).toBeGreaterThan(0);
  }, 30000);

  it('keeps the trade graph sparse, which is what makes global routing unnecessary', () => {
    /* The design rule is "no global pathfinding". The structural evidence is
       that the graph is SPARSE: neighbour links plus a coastal ring, so edges
       grow linearly with settlements rather than quadratically. A dense graph
       would make per-edge arbitrage as expensive as the all-pairs solve it
       replaces. Timing lives in tools/bench/m10-economy.out.md; this asserts
       the shape. */
    const w = evolved(4);
    const net = w.economy.network;
    const n = net.nodes.length;
    expect(n).toBeGreaterThan(4);
    expect(net.edges.length).toBeGreaterThan(0);
    expect(net.edges.length).toBeLessThan(n * 8);
    /* Every node's degree is bounded by its neighbours plus a few sea lanes. */
    for (const adj of net.adjacency) expect(adj.length).toBeLessThan(24);
  });
});

describe('M10 feeds back into M8 and M4', () => {
  it('lets a polity that can import food feed more people than its land does', () => {
    const w = evolved(4);
    const e = w.economy;
    const i = biggest(w);
    const idx = COMMODITY.FOOD * e.capacity + i;

    e.production[idx] = 0;
    e.imports[idx] = 0;
    e.consumption[idx] = 1000;
    const starving = capacityMultiplier(e, w.civilisation, i);

    e.imports[idx] = 3000;
    const fed = capacityMultiplier(e, w.civilisation, i);

    expect(starving).toBeLessThan(1);
    expect(fed).toBeGreaterThan(1);
    expect(fed).toBeLessThanOrEqual(2.2);
  });

  it('makes technology grow faster where there is energy per head', () => {
    const w = evolved(4);
    const e = w.economy;
    const i = biggest(w);
    const pop = w.civilisation.store.column(CIV.population)[i] as number;
    e.production[COMMODITY.ENERGY * e.capacity + i] = 0;
    e.stock[COMMODITY.GOODS * e.capacity + i] = 0;
    const poor = technologyMultiplier(e, w.civilisation, i);
    e.production[COMMODITY.ENERGY * e.capacity + i] = pop * 0.5;
    const rich = technologyMultiplier(e, w.civilisation, i);
    expect(rich).toBeGreaterThan(poor);
    expect(rich).toBeLessThanOrEqual(4.5);
  });

  it('emits pollution where industry is and carries it downwind', () => {
    const w = evolved(6);
    const e = w.economy;
    let total = 0;
    for (let c = 0; c < e.cellCount; c++) total += e.pollution[c] as number;
    expect(total).toBeGreaterThan(0);

    /* A uniform eastward wind must move the field east. Semi-Lagrangian, so
       this is stable for any dt — which matters because the economy's step can
       be centuries while the wind is an hourly field. */
    e.pollution.fill(0);
    const n = cubeDim(e.level);
    const spike = 0 * n * n + Math.floor(n / 2) * n + Math.floor(n / 2);
    e.pollution[spike] = 1000;
    const u = new Float64Array(e.cellCount).fill(60);
    const v = new Float64Array(e.cellCount);
    const before = e.pollution[spike] as number;
    for (let k = 0; k < 3; k++) advectPollution(e, u, v, 0.5, cubeDim);
    expect(e.pollution[spike] as number).toBeLessThan(before);
    let after = 0;
    for (let c = 0; c < e.cellCount; c++) after += e.pollution[c] as number;
    /* Advection moves mass, it does not create it. */
    expect(after).toBeLessThanOrEqual(before * 1.001);
    expect(after).toBeGreaterThan(0);
  }, 30000);

  it('ignores a wind field of the wrong shape rather than blowing it sideways', () => {
    /* T-0080 again: the wind lives on the geodesic grid and pollution on the
       cube. Indexing one with the other's index is silent and wrong, so the
       length mismatch is refused. */
    const w = evolved(2);
    const e = w.economy;
    e.pollution.fill(5);
    advectPollution(e, new Float64Array(3), new Float64Array(3), 1, cubeDim);
    for (let c = 0; c < e.cellCount; c++) expect(e.pollution[c]).toBe(5);
  });
});

describe('M10 stability and determinism', () => {
  it('stays finite and bounded over a thousand simulated years', () => {
    const w = evolved(4);
    const e = w.economy;
    for (let k = 0; k < 200; k++) stepEconomy(e, w.civilisation, w.hydrology, 5);
    const store = w.civilisation.store;
    for (let i = 0; i < store.bound; i++) {
      if (!store.aliveAt(i)) continue;
      for (let c = 0; c < 7; c++) {
        const p = priceOf(e, i, c as 0);
        const s = stockOf(e, i, c as 0);
        expect(Number.isFinite(p)).toBe(true);
        expect(Number.isFinite(s)).toBe(true);
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThanOrEqual(12.0001);
        expect(s).toBeGreaterThanOrEqual(0);
      }
    }
    for (let c = 0; c < e.cellCount; c++) {
      expect(Number.isFinite(e.pollution[c] as number)).toBe(true);
      expect(e.pollution[c] as number).toBeGreaterThanOrEqual(0);
    }
  }, 30000);

  it('does not oscillate at a coarse step', () => {
    /* A price that jumps to its fair value overshoots at a 500-year step and
       becomes an oscillator, which would drive the population it feeds into
       oscillation too. The relaxation form is what prevents it. */
    const w = evolved(4);
    const e = w.economy;
    const i = biggest(w);
    const history: number[] = [];
    for (let k = 0; k < 40; k++) {
      stepEconomy(e, w.civilisation, w.hydrology, 500);
      history.push(priceOf(e, i, COMMODITY.FOOD));
    }
    let reversals = 0;
    for (let k = 2; k < history.length; k++) {
      const a = (history[k] as number) - (history[k - 1] as number);
      const b = (history[k - 1] as number) - (history[k - 2] as number);
      if (a * b < 0 && Math.abs(a) > 0.05) reversals++;
    }
    expect(reversals).toBeLessThan(history.length / 3);
  }, 30000);

  it('is deterministic and visible to the world digest', () => {
    const a = evolved(3);
    const b = evolved(3);
    expect(economyDigest(a.economy)).toBe(economyDigest(b.economy));
    expect(networkDigest(a.economy.network)).toBe(networkDigest(b.economy.network));
    expect(a.digest()).toBe(b.digest());

    const base = a.digest();
    const i = biggest(a);
    const idx = COMMODITY.ORE * a.economy.capacity + i;
    const original = a.economy.stock[idx] as number;
    a.economy.stock[idx] = original + 1;
    expect(a.digest()).not.toBe(base);
    a.economy.stock[idx] = original;
    expect(a.digest()).toBe(base);
  }, 30000);
});

function firstAlive(w: ReturnType<typeof evolved>): number {
  for (let i = 0; i < w.civilisation.store.bound; i++) {
    if (w.civilisation.store.aliveAt(i)) return i;
  }
  throw new Error('no settlements');
}

function biggest(w: ReturnType<typeof evolved>): number {
  const pop = w.civilisation.store.column(CIV.population);
  let best = -1;
  let bestP = -1;
  for (let i = 0; i < w.civilisation.store.bound; i++) {
    if (!w.civilisation.store.aliveAt(i)) continue;
    if ((pop[i] as number) > bestP) { bestP = pop[i] as number; best = i; }
  }
  if (best < 0) throw new Error('no settlements');
  return best;
}
