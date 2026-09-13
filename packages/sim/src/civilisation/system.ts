/**
 * @tier A
 *
 * M8 civilisation: settlements as entities on top of M2-M7 geography.
 *
 * WHAT IS AUTHORITATIVE. Settlement rows in an `EntityStore` (DEC-012) and one
 * `claim` raster mapping cell -> settlement. Everything else here — carrying
 * capacity, suitability, territory area — is diagnosed from those plus the
 * upstream fields, never integrated, so it cannot drift out of agreement with
 * the geography that produced it (DEC-030).
 *
 * WHY THE MATH IS CLOSED-FORM. Time scales here span seconds to millions of
 * years. At T3/T4 a single step can be 10^5 simulated years, so an explicit
 * Euler logistic step would need dt < 1/r ~ 100 yr and would either explode or
 * demand a thousand substeps. Population and technology are therefore advanced
 * by the EXACT solution of the logistic equation over the interval. That makes
 * the trajectory path-independent — one 100 kyr step and 10^5 one-year steps
 * agree to rounding — which is exactly what DEC-030 requires of slow state, and
 * it is asserted by test rather than hoped for.
 *
 * COST. Territory is one multi-source BFS over the grid, O(cells), not
 * O(settlements x cells). Founding walks a suitability-ordered site index built
 * once per habitability refresh, not a per-step scan. Nothing here is O(N^2) in
 * settlements.
 */

import {
  DIR,
  EntityStore,
  componentId,
  cubeCellSteradians,
  cubeDim,
  cubeIndex,
  neighbor,
  entityIndex,
  subsystemId,
  type EntityId,
} from '@ws/data';
import { DOMAIN, exp, hashFloat01x64, log10, type Seed } from '@ws/core';
import type { BiosphereState } from '../biosphere/system.js';
import type { HydrologyState } from '../hydrology/system.js';
import { refreshHabitability, type HabitabilityState } from './suitability.js';

const DIRS = [DIR.POS_U, DIR.NEG_U, DIR.POS_V, DIR.NEG_V] as const;
const RADIUS_M = 6_371_000;

export const OWNER_CIVILISATION = subsystemId('civilisation');

export const CIV = {
  cell: componentId('civ.cell'),
  population: componentId('civ.population'),
  foodStoreYears: componentId('civ.foodStoreYears'),
  technology: componentId('civ.technology'),
  culture: componentId('civ.culture'),
  foundedYear: componentId('civ.foundedYear'),
  territoryCells: componentId('civ.territoryCells'),
  carryingCapacity: componentId('civ.carryingCapacity'),
  stress: componentId('civ.stress'),
  /** Cumulative years the settlement has spent above its carrying capacity. */
  strainYears: componentId('civ.strainYears'),
} as const;

const COMPONENTS = [
  { id: CIV.cell, dtype: 'i32', components: 1, owner: OWNER_CIVILISATION },
  { id: CIV.population, dtype: 'f64', components: 1, owner: OWNER_CIVILISATION },
  { id: CIV.foodStoreYears, dtype: 'f32', components: 1, owner: OWNER_CIVILISATION },
  { id: CIV.technology, dtype: 'f32', components: 1, owner: OWNER_CIVILISATION },
  { id: CIV.culture, dtype: 'i32', components: 1, owner: OWNER_CIVILISATION },
  { id: CIV.foundedYear, dtype: 'f64', components: 1, owner: OWNER_CIVILISATION },
  { id: CIV.territoryCells, dtype: 'i32', components: 1, owner: OWNER_CIVILISATION },
  { id: CIV.carryingCapacity, dtype: 'f64', components: 1, owner: OWNER_CIVILISATION },
  { id: CIV.stress, dtype: 'f32', components: 1, owner: OWNER_CIVILISATION },
  { id: CIV.strainYears, dtype: 'f32', components: 1, owner: OWNER_CIVILISATION },
] as const;

/**
 * Temporal detail (DEC-030 / DEC-015).
 *
 *  full        every settlement integrated individually.
 *  aggregate   settlements below a population floor are advanced with the same
 *              closed-form solution but their territory is not re-grown and no
 *              new sites are evaluated. Used at paleo time scales, where the
 *              interesting quantity is the population envelope, not which
 *              hamlet founded which.
 */
export type CivDetail = 'full' | 'aggregate';

export interface CivilisationState {
  readonly level: number;
  readonly cellCount: number;
  readonly store: EntityStore;
  readonly habitability: HabitabilityState;
  /** cell -> live settlement index, or -1. The spatial index. */
  readonly claim: Int32Array;
  /** cell -> BFS distance to its claiming settlement, in cells. */
  readonly claimDistance: Uint16Array;
  readonly cellAreaM2: Float64Array;
  /** Cells ordered by descending suitability; the founding candidate list. */
  siteIndex: Int32Array;
  siteCursor: number;
  /** `habitability.suitableCount` when the site index was last built. */
  siteIndexBasis: number;
  detail: CivDetail;
  year: number;
  steps: number;
  totalPopulation: number;
  foundedTotal: number;
  collapsedTotal: number;
  relocatedTotal: number;
  nextCulture: number;
  /** Diagnostic: settlements that hit their food ceiling on the last step. */
  strainedCount: number;
}

export interface CivConfig {
  readonly seed: Seed;
  readonly capacity?: number;
  /** Minimum suitability at which anyone will settle at technology 0. */
  readonly foundingThreshold?: number;
}

const DEFAULT_CAPACITY = 16384;
const DEFAULT_FOUNDING_THRESHOLD = 0.28;

export function initCivilisation(
  h: HydrologyState,
  b: BiosphereState,
  habitability: HabitabilityState,
  cfg: CivConfig,
): CivilisationState {
  const N = h.cellCount;
  const store = new EntityStore({
    name: 'settlements',
    capacity: cfg.capacity ?? DEFAULT_CAPACITY,
    components: COMPONENTS.map((c) => ({ ...c })),
  });
  const cellAreaM2 = new Float64Array(N);
  const n = cubeDim(h.level);
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        cellAreaM2[cubeIndex(face, h.level, x, y)] =
          cubeCellSteradians({ face, x, y }, h.level) * RADIUS_M * RADIUS_M;
      }
    }
  }
  const s: CivilisationState = {
    level: h.level,
    cellCount: N,
    store,
    habitability,
    claim: new Int32Array(N).fill(-1),
    claimDistance: new Uint16Array(N),
    cellAreaM2,
    siteIndex: new Int32Array(0),
    siteCursor: 0,
    siteIndexBasis: -1,
    detail: 'full',
    year: 0,
    steps: 0,
    totalPopulation: 0,
    foundedTotal: 0,
    collapsedTotal: 0,
    relocatedTotal: 0,
    nextCulture: 1,
    strainedCount: 0,
  };
  refreshHabitability(habitability, h, b);
  rebuildSiteIndex(s, cfg);
  return s;
}

/**
 * Rebuild the founding candidate list after the geography changes.
 *
 * Sorted descending by suitability with the cell index as a total-order
 * tie-break, so the list — and therefore the founding sequence — is a pure
 * function of the fields, not of the sort implementation (DEC-017).
 */
export function rebuildSiteIndex(s: CivilisationState, cfg: CivConfig): void {
  const suit = s.habitability.suitability;
  const threshold = (cfg.foundingThreshold ?? DEFAULT_FOUNDING_THRESHOLD) * 0.5;
  const candidates: number[] = [];
  for (let i = 0; i < s.cellCount; i++) {
    if ((suit[i] as number) >= threshold) candidates.push(i);
  }
  candidates.sort((a, bb) => {
    const d = (suit[bb] as number) - (suit[a] as number);
    return d !== 0 ? d : a - bb;
  });
  s.siteIndex = Int32Array.from(candidates);
  s.siteCursor = 0;
  s.siteIndexBasis = s.habitability.suitableCount;
}

/**
 * Rebuild the site index only when the habitable map has actually moved.
 *
 * The index is a sort, so rebuilding it every tick would put O(cells log cells)
 * on the civilisation step for nothing: habitability is slow state and usually
 * identical between consecutive years. It is rebuilt when the count of
 * habitable cells shifts by more than 2%, or on the first step, or whenever an
 * upstream subsystem invalidates it explicitly.
 */
function maybeRebuildSiteIndex(s: CivilisationState, cfg: CivConfig): void {
  const now = s.habitability.suitableCount;
  const basis = s.siteIndexBasis;
  if (basis < 0 || Math.abs(now - basis) > Math.max(8, basis * 0.02)) {
    rebuildSiteIndex(s, cfg);
  }
}

/* ---- closed-form logistic ------------------------------------------- */

/**
 * Exact solution of dP/dt = r P (1 - P/K) over `dt`.
 *
 * Path-independent by construction: advancing by dt once equals advancing by
 * dt/n, n times, to f64 rounding. That property is what lets the same code run
 * at one-year and 100-kyr steps, and it is the reason this is not Euler.
 */
export function logisticStep(p0: number, k: number, r: number, dt: number): number {
  if (!(k > 0)) return 0;
  if (!(p0 > 0)) return 0;
  if (!(dt > 0) || !(r > 0)) return p0;
  const g = exp(r * dt);
  /* Written to stay finite when g overflows: the limit is exactly K. */
  if (!Number.isFinite(g)) return k;
  const denom = k + p0 * (g - 1);
  if (!(denom > 0) || !Number.isFinite(denom)) return k;
  return (k * p0 * g) / denom;
}

/** Exponential relaxation toward a target — also exact over any dt. */
function relax(x: number, target: number, rate: number, dt: number): number {
  if (!(dt > 0) || !(rate > 0)) return x;
  const decay = exp(-rate * dt);
  return target + (x - target) * decay;
}

/* ---- the step -------------------------------------------------------- */

/** Technology multiplies the food a hectare yields. 1x at 0, ~9x at 1. */
export function foodTechMultiplier(tech: number): number {
  return 1 + 8 * tech * tech;
}

/** Technology extends how far a polity can hold territory, in cells. */
function reachCells(population: number, tech: number): number {
  /* sqrt: territory scales with population, radius with its square root. */
  return Math.min(64, 1 + Math.sqrt(Math.max(0, population) / 2000) * (1 + 3 * tech));
}

/**
 * What M10 does back to M8.
 *
 * Passed in rather than read out, so the dependency runs one way: civilisation
 * does not import the economy, it accepts a forcing. Both arrays are indexed by
 * settlement slot and default to 1 when absent, so M8 runs correctly on its own
 * — which is what makes the economy's contribution testable by comparing a run
 * with it against a run without.
 */
export interface EconomicForcing {
  /** Multiplier on carrying capacity: food trade feeds people the land cannot. */
  readonly capacity?: ArrayLike<number>;
  /** Multiplier on the technology growth rate: energy and goods per head. */
  readonly technology?: ArrayLike<number>;
}

export function stepCivilisation(
  s: CivilisationState,
  h: HydrologyState,
  dtYears: number,
  cfg: CivConfig,
  forcing: EconomicForcing = {},
): void {
  if (!(dtYears > 0) || !Number.isFinite(dtYears)) return;
  const store = s.store;
  const cell = store.columnMut(CIV.cell, OWNER_CIVILISATION);
  const pop = store.columnMut(CIV.population, OWNER_CIVILISATION);
  const food = store.columnMut(CIV.foodStoreYears, OWNER_CIVILISATION);
  const tech = store.columnMut(CIV.technology, OWNER_CIVILISATION);
  const terr = store.columnMut(CIV.territoryCells, OWNER_CIVILISATION);
  const cap = store.columnMut(CIV.carryingCapacity, OWNER_CIVILISATION);
  const stress = store.columnMut(CIV.stress, OWNER_CIVILISATION);
  const strain = store.columnMut(CIV.strainYears, OWNER_CIVILISATION);

  /* TEMPORAL LOD (DEC-015/DEC-030).
   *
   * `aggregate` reduces FIDELITY, never existence. An earlier version skipped
   * founding entirely at paleo detail, which meant that at the only time scale
   * on which civilisations actually arise, none ever did — the LOD had quietly
   * deleted the phenomenon it was supposed to summarise.
   *
   * What it actually skips is territory rework, the one part of the step whose
   * result barely changes between consecutive coarse ticks: borders are
   * regrown every 8th step instead of every step. Demography, technology,
   * collapse and founding all continue, because each is O(settlements) and
   * each is the thing being summarised. */
  /* A seat that the geography has destroyed is not a seat. Before anything
     else, move or end the settlements whose own cell drowned or froze. */
  reseatOrCollapse(s, h, cell);

  const territoryDue = s.detail === 'full' || s.steps % 8 === 0;
  if (territoryDue) {
    maybeRebuildSiteIndex(s, cfg);
    growTerritory(s, h, pop, tech, cell);
  }
  accumulateCapacity(s, cap, terr, tech, h);
  /* Trade is the difference between what the land feeds and what the polity
     feeds. Applied after the land-based capacity is accumulated, so the base
     stays a property of the geography. */
  const capMul = forcing.capacity;
  if (capMul !== undefined) {
    for (let i = 0; i < store.bound; i++) {
      if (!store.aliveAt(i)) continue;
      const m = capMul[i] as number;
      if (Number.isFinite(m) && m > 0) cap[i] = (cap[i] as number) * m;
    }
  }

  /* --- demography, technology, collapse --- */
  let total = 0;
  let strained = 0;
  for (let i = 0; i < store.bound; i++) {
    if (!store.aliveAt(i)) continue;
    const k = cap[i] as number;
    const p0 = pop[i] as number;

    if (!(k > 0)) {
      /* The land stopped feeding them. This is the feedback path from M4-M7:
         a climate shift or a river avulsion can empty a valley. */
      const decayed = p0 * exp(-0.05 * dtYears);
      pop[i] = decayed;
      stress[i] = 1;
      strain[i] = (strain[i] as number) + dtYears;
      if (decayed < 20) { collapse(s, i, cell); continue; }
      total += decayed;
      strained++;
      continue;
    }

    /* Intrinsic growth: pre-industrial societies grow at ~0.04%/yr; the ceiling
       here is ~1.2%/yr, reached only with high technology. */
    const r = 0.0004 + 0.011 * (tech[i] as number);
    const p1 = logisticStep(p0, k, r, dtYears);
    const load = p1 / k;
    stress[i] = Math.min(4, load);
    if (load > 1.02) {
      strain[i] = (strain[i] as number) + dtYears;
      strained++;
    } else {
      strain[i] = Math.max(0, (strain[i] as number) - dtYears * 0.5);
    }
    food[i] = Math.max(0, Math.min(6, 1 / Math.max(0.05, load)));

    /* Technology: needs people to carry it and food surplus to fund it. A
       settlement at its ceiling stagnates; one with slack advances. */
    const surplus = Math.max(0, 1 - load);
    const scale = log10(1 + Math.max(0, p1)) / 6;
    const target = Math.min(1, 0.15 + 0.85 * scale);
    const techMul = forcing.technology !== undefined ? (forcing.technology[i] as number) : 1;
    const rate = 2.5e-4 * surplus * scale * (Number.isFinite(techMul) && techMul > 0 ? techMul : 1);
    tech[i] = relax(tech[i] as number, target, rate, dtYears);

    pop[i] = p1;
    if (p1 < 20) { collapse(s, i, cell); continue; }
    total += p1;
  }

  foundSettlements(s, h, dtYears, cfg, cell, pop, tech, store);

  s.totalPopulation = total;
  s.strainedCount = strained;
  s.year += dtYears;
  s.steps++;
}

/**
 * Relocate a settlement whose seat has become uninhabitable, or end it.
 *
 * Sea level rises, ice advances, a river avulses, a plate carries the valley
 * into the wrong latitude — the cell a town was founded on does not stay
 * habitable forever. Leaving the town there produced two visibly wrong states:
 * settlements sitting on ocean, and territory maps claiming water. Real
 * polities move their seat to the best land they still hold, and end when they
 * hold none.
 *
 * One O(cells) pass finds each settlement's best remaining cell, so this is
 * independent of how many settlements are relocating at once. Ties break on the
 * lower cell index, which is a total order (DEC-017).
 */
function reseatOrCollapse(
  s: CivilisationState,
  h: HydrologyState,
  cell: { [i: number]: number },
): void {
  const store = s.store;
  const suit = s.habitability.suitability;
  const bound = store.bound;
  if (bound === 0) return;

  const bestCell = new Int32Array(bound).fill(-1);
  const bestSuit = new Float64Array(bound);
  for (let c = 0; c < s.cellCount; c++) {
    const o = s.claim[c] as number;
    if (o < 0 || o >= bound || !store.aliveAt(o)) continue;
    if (h.ocean[c] !== 0) continue;
    const q = suit[c] as number;
    if (!(q > 0)) continue;
    const b = bestSuit[o] as number;
    if (q > b || (q === b && c < (bestCell[o] as number))) {
      bestSuit[o] = q;
      bestCell[o] = c;
    }
  }

  for (let i = 0; i < bound; i++) {
    if (!store.aliveAt(i)) continue;
    const c = cell[i] as number;
    const habitable = c >= 0 && c < s.cellCount && h.ocean[c] === 0 && (suit[c] as number) > 0;
    if (habitable) continue;
    const move = bestCell[i] as number;
    if (move >= 0) {
      cell[i] = move;
      s.relocatedTotal++;
    } else {
      collapse(s, i, cell);
    }
  }
}

/**
 * A settlement ends.
 *
 * The territory is NOT swept here. A per-collapse O(cells) scan would make a
 * mass die-off O(collapses x cells), which is the O(N^2) this file exists to
 * avoid. Instead `growTerritory` rebuilds the claim map from the live set each
 * step, and every consumer of `claim` checks that the owner is still alive —
 * so an abandoned claim is inert rather than inherited.
 */
function collapse(s: CivilisationState, index: number, cell: { [i: number]: number }): void {
  const id = s.store.idAt(index);
  cell[index] = -1;
  s.store.destroy(id);
  s.collapsedTotal++;
}

/**
 * Multi-source BFS from every settlement at once.
 *
 * O(cells), not O(settlements x cells): each cell is claimed once, by whichever
 * settlement reaches it in the fewest steps. Ties break on settlement index,
 * which is a total order, so the map does not depend on iteration accidents.
 *
 * Reach is per-settlement, so a village holds a valley and an empire holds a
 * continent without either being special-cased.
 */
function growTerritory(
  s: CivilisationState,
  h: HydrologyState,
  pop: { [i: number]: number },
  tech: { [i: number]: number },
  cell: { [i: number]: number },
): void {
  const store = s.store;
  s.claim.fill(-1);
  s.claimDistance.fill(0);
  const n = cubeDim(s.level);
  const suit = s.habitability.suitability;

  /* Distance-bucketed frontier: processing ring by ring is what makes the BFS
     order-independent of the seed order within a ring. */
  let frontier: number[] = [];
  const reach = new Float64Array(store.bound);
  for (let i = 0; i < store.bound; i++) {
    if (!store.aliveAt(i)) continue;
    const c = cell[i] as number;
    if (c < 0 || c >= s.cellCount || h.ocean[c] !== 0) continue;
    reach[i] = reachCells(pop[i] as number, tech[i] as number);
    /* A seed contests its own cell against any settlement already there;
       lower index wins, deterministically. */
    if (s.claim[c] === -1 || (s.claim[c] as number) > i) {
      s.claim[c] = i;
      frontier.push(c);
    }
  }

  let distance = 0;
  while (frontier.length > 0) {
    distance++;
    const next: number[] = [];
    for (const c of frontier) {
      const owner = s.claim[c] as number;
      if (owner < 0 || distance > (reach[owner] as number)) continue;
      const face = Math.floor(c / (n * n));
      const local = c - face * n * n;
      const y = Math.floor(local / n);
      const x = local - y * n;
      for (const d of DIRS) {
        const nb = neighbor({ face, x, y }, s.level, d);
        const j = cubeIndex(nb.face, s.level, nb.x, nb.y);
        /* Unclaimable land is unclaimable: ocean and dead ground are not
           territory just because someone is adjacent to them. */
        if ((suit[j] as number) <= 0) continue;
        if (h.ocean[j] !== 0) continue;
        if (s.claim[j] === -1) {
          s.claim[j] = owner;
          s.claimDistance[j] = distance;
          next.push(j);
        } else if ((s.claim[j] as number) > owner && (s.claimDistance[j] as number) === distance) {
          /* Same ring, lower index wins — the tie-break that makes the border
             a function of the state rather than of visit order. */
          s.claim[j] = owner;
        }
      }
    }
    frontier = next;
    if (distance > 4096) break;
  }
}

/** Sum each settlement's territory into a carrying capacity, in people. */
function accumulateCapacity(
  s: CivilisationState,
  cap: { [i: number]: number },
  terr: { [i: number]: number },
  tech: { [i: number]: number },
  h: HydrologyState,
): void {
  const store = s.store;
  for (let i = 0; i < store.bound; i++) {
    if (store.aliveAt(i)) { cap[i] = 0; terr[i] = 0; }
  }
  const food = s.habitability.baseFoodDensity;
  for (let c = 0; c < s.cellCount; c++) {
    const owner = s.claim[c] as number;
    /* A claim outliving its settlement is inert, never inherited. */
    if (owner < 0 || !store.aliveAt(owner)) continue;
    /* Land under permanent ice or ocean feeds nobody even if it is claimed. */
    if (h.ocean[c] !== 0) continue;
    cap[owner] = (cap[owner] as number) + (food[c] as number) * (s.cellAreaM2[c] as number);
    terr[owner] = (terr[owner] as number) + 1;
  }
  for (let i = 0; i < store.bound; i++) {
    if (!store.aliveAt(i)) continue;
    cap[i] = (cap[i] as number) * foodTechMultiplier(tech[i] as number);
  }
}

/**
 * Found new settlements at the best unclaimed sites.
 *
 * Two sources, both causal rather than arbitrary:
 *   - virgin land good enough to settle at all;
 *   - colonies pushed out of a settlement that is over its ceiling.
 *
 * The rate is bounded per unit time so that a 100 kyr step does not found a
 * hundred thousand towns in one tick.
 */
function foundSettlements(
  s: CivilisationState,
  h: HydrologyState,
  dtYears: number,
  cfg: CivConfig,
  cell: { [i: number]: number },
  pop: { [i: number]: number },
  tech: { [i: number]: number },
  store: EntityStore,
): void {
  const threshold = cfg.foundingThreshold ?? DEFAULT_FOUNDING_THRESHOLD;
  const suit = s.habitability.suitability;
  /* At most one founding attempt per 40 simulated years, capped so a paleo
     step stays bounded. Founding is a slow process and must not become a
     function of how coarsely we happen to be sampling time. */
  const attempts = Math.min(256, Math.max(1, Math.floor(dtYears / 40)));
  const sites = s.siteIndex;
  if (sites.length === 0) return;

  for (let a = 0; a < attempts; a++) {
    if (store.count >= store.capacity) return;
    let placed = false;
    /* Walk the suitability-ordered index from the cursor. Bounded scan: a full
       sweep of the candidate list per step would be O(cells) again. */
    const scanLimit = Math.min(sites.length, 4096);
    for (let k = 0; k < scanLimit; k++) {
      const c = sites[(s.siteCursor + k) % sites.length] as number;
      if (s.claim[c] !== -1) continue;
      if (h.ocean[c] !== 0) continue;
      const q = suit[c] as number;
      if (q < threshold) continue;
      /* A stateless hash gates founding, so the same world founds the same
         towns in the same order however it is stepped (DEC-017). */
      const roll = hashFloat01x64(cfg.seed, DOMAIN.SETTLEMENT, c, Math.floor(s.year / 40), s.foundedTotal);
      if (roll > q) continue;
      found(s, c, cell, pop, tech, store);
      s.siteCursor = (s.siteCursor + k + 1) % sites.length;
      placed = true;
      break;
    }
    if (!placed) {
      s.siteCursor = (s.siteCursor + scanLimit) % sites.length;
      return;
    }
  }
}

function found(
  s: CivilisationState,
  c: number,
  cell: { [i: number]: number },
  pop: { [i: number]: number },
  tech: { [i: number]: number },
  store: EntityStore,
): EntityId {
  const id = store.create();
  const index = entityIndex(id);
  cell[index] = c;
  pop[index] = 60;
  tech[index] = 0.02;
  const culture = store.columnMut(CIV.culture, OWNER_CIVILISATION);
  const founded = store.columnMut(CIV.foundedYear, OWNER_CIVILISATION);
  culture[index] = s.nextCulture;
  founded[index] = s.year;
  s.nextCulture++;
  s.foundedTotal++;
  s.claim[c] = index;
  return id;
}

/* ---- diagnostics used by tests, tooling and the visualiser ---------- */

export interface SettlementView {
  readonly index: number;
  readonly cell: number;
  readonly population: number;
  readonly technology: number;
  readonly territoryCells: number;
  readonly carryingCapacity: number;
  readonly culture: number;
  readonly foundedYear: number;
}

/** Live settlements, ascending by index (DEC-017). Allocates; not a hot path. */
export function settlements(s: CivilisationState): SettlementView[] {
  const st = s.store;
  const cell = st.column(CIV.cell);
  const pop = st.column(CIV.population);
  const tech = st.column(CIV.technology);
  const terr = st.column(CIV.territoryCells);
  const cap = st.column(CIV.carryingCapacity);
  const culture = st.column(CIV.culture);
  const founded = st.column(CIV.foundedYear);
  const out: SettlementView[] = [];
  for (let i = 0; i < st.bound; i++) {
    if (!st.aliveAt(i)) continue;
    out.push({
      index: i,
      cell: cell[i] as number,
      population: pop[i] as number,
      technology: tech[i] as number,
      territoryCells: terr[i] as number,
      carryingCapacity: cap[i] as number,
      culture: culture[i] as number,
      foundedYear: founded[i] as number,
    });
  }
  return out;
}

/** The largest settlement, or -1. Used by M9 to pick a city to realise. */
export function largestSettlement(s: CivilisationState): number {
  const pop = s.store.column(CIV.population);
  let best = -1;
  let bestPop = -1;
  for (let i = 0; i < s.store.bound; i++) {
    if (!s.store.aliveAt(i)) continue;
    const p = pop[i] as number;
    if (p > bestPop) { bestPop = p; best = i; }
  }
  return best;
}
