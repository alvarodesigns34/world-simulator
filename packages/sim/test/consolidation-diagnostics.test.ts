import { describe, expect, it } from 'vitest';
import { EARTH_CALENDAR, makeSeed } from '@ws/core';
import {
  COMMODITY,
  TRADE_STATUS,
  createWorld,
  diagnoseTrade,
  endowmentAt,
  stepClimate,
  stepCivilisation,
  stepEconomy,
  stepHydrology,
} from '../src/index.js';

const log = (label: string, value: unknown): void =>
  (globalThis as unknown as { console: { log(message: string): void } }).console.log(`${label} ${JSON.stringify(value)}`);

function meanLand(values: ArrayLike<number>, ocean: Uint8Array): number {
  let sum = 0; let n = 0;
  for (let i = 0; i < values.length; i++) if (ocean[i] === 0) { sum += values[i] as number; n++; }
  return sum / Math.max(1, n);
}

describe('M1-M10 directed consolidation diagnostics', () => {
  /**
   * NOTE ON WHAT THIS SHOWS (T-0107). Every path below uses chunks of a
   * thousand years or more, so all three take the reduced-column branch and
   * all three relax fully to equilibrium. Their agreement is real but weak
   * evidence: three paths that cannot disagree do not demonstrate
   * path-independence. The sharp test — chunkings that span the relaxation
   * time, plus the one place the module IS cadence-dependent — lives in
   * `soil-path-independence.test.ts`. This one stays as a water-budget
   * closure check, which is what it is actually good at.
   */
  it('closes the water budget and equilibrates to the same soil at every millennial cadence', () => {
    const make = () => createWorld({ seed: makeSeed(3, 7), terrainLevel: 3, hydrologyLevel: 3,
      climateN: 2, genesis: { level: 3, plateCount: 7, steps: 12 }, erode: false });
    const paths = [
      { name: 'climatology', count: 800, years: 1_000 },
      { name: 'paleo', count: 8, years: 100_000 },
      { name: 'single', count: 1, years: 800_000 },
    ];
    const result = paths.map((path) => {
      const world = make();
      for (let i = 0; i < 20; i++) stepClimate(world.climate, 3600, 0.1);
      const initial = meanLand(world.hydrology.soilMoistureM, world.hydrology.ocean);
      for (let i = 0; i < path.count; i++) stepHydrology(world.hydrology, world.climate,
        path.years * EARTH_CALENDAR.secondsPerYear);
      return { path: path.name, initial, final: meanLand(world.hydrology.soilMoistureM, world.hydrology.ocean),
        precipitationM3: world.hydrology.budget.precipitationM3,
        evaporationM3: world.hydrology.budget.evaporationM3,
        oceanOutflowM3: world.hydrology.budget.oceanOutflowM3,
        storageChangeM3: world.hydrology.budget.storageChangeM3,
        residualFraction: Math.abs(world.hydrology.budget.residualM3) /
          Math.max(1, world.hydrology.budget.precipitationM3) };
    });
    const finals = result.map((r) => r.final);
    log('SOIL_DIAGNOSTIC', result);
    expect(Math.max(...finals) - Math.min(...finals)).toBeLessThan(2e-3);
    /* The reduced column closure should settle to a live, non-zero land
       bucket; an all-zero result would still be a cadence-independent bug. */
    expect(finals.every((v) => v > 0.01 && v < 0.1)).toBe(true);
    expect(result.every((r) => r.residualFraction < 1e-6)).toBe(true);
  }, 30_000);

  it('measures ore anti-correlation and economy outcomes across ten seeds', () => {
    const rows = [];
    for (let seedIndex = 0; seedIndex < 10; seedIndex++) {
      const seed = makeSeed(0x100 + seedIndex, 0x700 + seedIndex * 17);
      const world = createWorld({ seed, terrainLevel: 3, hydrologyLevel: 3, climateN: 2,
        genesis: { level: 3, plateCount: 7, steps: 12 }, erode: false });
      world.civilisation.detail = 'aggregate';
      for (let i = 0; i < 96; i++) stepCivilisation(world.civilisation, world.hydrology, 500, { seed });
      /* `totalTrade` is reset at the top of every step, so a single reading
         after the loop is the LAST step alone. Accumulating is what separates
         "this market never traded" from "this market has converged". */
      let cumulativeTrade = 0;
      for (let i = 0; i < 4; i++) {
        stepEconomy(world.economy, world.civilisation, world.hydrology, 100);
        cumulativeTrade += world.economy.totalTrade;
      }
      let planet = 0; let settled = 0; let settledCells = 0;
      for (let cell = 0; cell < world.economy.cellCount; cell++) {
        const ore = endowmentAt(world.economy.resources, cell, COMMODITY.ORE);
        planet += ore;
        const owner = world.civilisation.claim[cell] as number;
        if (owner >= 0 && world.civilisation.store.aliveAt(owner)) { settled += ore; settledCells++; }
      }
      const prices = world.economy.price;
      let priceMean = 0;
      for (let i = 0; i < prices.length; i++) priceMean += prices[i] as number;
      const extracted = world.economy.extracted.reduce((a, b) => a + b, 0);
      const planetaryMean = planet / world.economy.cellCount;
      const settledMean = settled / Math.max(1, settledCells);
      const trade = diagnoseTrade(world.economy, world.civilisation);
      rows.push({ seed: seedIndex, planetaryMean, settledMean, ratio: planetaryMean / Math.max(1e-12, settledMean),
        priceMean: priceMean / prices.length,
        tradeLastStep: world.economy.totalTrade, tradeCumulative: cumulativeTrade,
        tradeStatus: trade.status, edges: trade.edges, nodes: trade.nodes,
        bestGapRatio: trade.bestGapRatio, actionableGapRatio: trade.bestActionableGapRatio,
        tradeableStock: trade.tradeableStock,
        depletion: extracted, shortage: world.economy.worstShortage,
        settlements: world.civilisation.store.count });
    }
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => Object.values(row)
      .every((v) => typeof v === 'string' || Number.isFinite(v)))).toBe(true);
    expect(rows.filter((row) => row.settlements > 0).length).toBeGreaterThanOrEqual(8);
    log('ABUNDANCE_DIAGNOSTIC', rows);

    /*
     * T-0106. EVERY zero is explained, and nothing is calibrated to avoid one.
     *
     * The previous version of this table reported one seed with `trade: 0` and
     * no explanation, which reads as a broken market. Two separate things were
     * wrong with that reading.
     *
     * First, `totalTrade` is reset at the top of every `stepEconomy`, so a
     * single reading after four steps is the LAST step alone. That seed had in
     * fact traded 211M, 113M and 41M units before settling — a market reaching
     * its spatial equilibrium and then, correctly, stopping. The table now
     * reports both figures.
     *
     * Second, a zero in the last step still needs a reason. Calibrating until
     * all ten seeds show a positive number would be fitting the model to make
     * a diagnostic look tidy; a scattered world of self-sufficient hamlets with
     * no price gap worth a cart is the transport-cost model working. So the
     * assertion is that the reason is a NAMED structural one, and in particular
     * that it is never `unexplained` — the status that exists precisely so the
     * impossible case cannot hide inside a plausible one.
     */
    for (const row of rows) {
      expect(row.tradeStatus, `seed ${String(row.seed)}`).not.toBe(TRADE_STATUS.UNEXPLAINED);
      if (row.tradeLastStep > 0) {
        expect(row.tradeStatus, `seed ${String(row.seed)}`).toBe(TRADE_STATUS.TRADING);
        continue;
      }
      expect([
        TRADE_STATUS.NO_COUNTERPARTIES, TRADE_STATUS.NO_LINKS,
        TRADE_STATUS.NO_STOCK, TRADE_STATUS.GAPS_BELOW_CARRIAGE,
        TRADE_STATUS.EXPORTERS_EMPTY,
      ], `seed ${String(row.seed)} traded nothing for no stated reason`).toContain(row.tradeStatus);
      /* A market that stopped must be a market that ran: links, stock, and no
         fundable gap left with goods behind it. */
      expect(row.edges, `seed ${String(row.seed)}`).toBeGreaterThan(0);
      expect(row.tradeableStock, `seed ${String(row.seed)}`).toBeGreaterThan(0);
      expect(row.actionableGapRatio, `seed ${String(row.seed)}`).toBeLessThanOrEqual(1);
    }

    /* And every seed with a network must have traded at SOME point. A world
       that has settlements, links and goods and has never moved a single unit
       is a broken market whatever the last step says. */
    for (const row of rows) {
      if (row.edges > 0 && row.tradeableStock > 0) {
        expect(row.tradeCumulative, `seed ${String(row.seed)} never traded at all`).toBeGreaterThan(0);
      }
    }
  }, 60_000);
});
