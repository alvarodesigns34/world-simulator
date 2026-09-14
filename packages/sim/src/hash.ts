/**
 * `hashWorldState` (T-0022, DEC-017) — the determinism gold.
 *
 * This is the single number that answers "did two runs produce the same
 * world?". It backs same-seed identity, reversed-order identity and the
 * 1/4/8-worker identity checks, so its correctness property is not accuracy
 * but COVERAGE: any mutation of authoritative state must change it.
 *
 * T-0082 — the previous version covered M2 geology and M4 climate only, and
 * sampled even those on a stride. Everything M5, M6 and M7 added was invisible
 * to it: a worker could corrupt every lake level, every soil moisture value,
 * the entire biosphere and the whole plate-boundary state, and the digest
 * would still match. A determinism gate that cannot see two thirds of the
 * simulation is worse than no gate, because it is believed.
 *
 * Two rules follow from that, and they pull against each other:
 *
 *   1. Coverage must be COMPLETE. No striding over authoritative arrays. A
 *      stride of 8 means seven of every eight cells may diverge silently, and
 *      divergence is usually local — exactly the case a stride hides.
 *
 *   2. It must not be called every frame. This is O(total authoritative
 *      state), which is the honest cost of the guarantee. It is a checkpoint
 *      and test operation. `World.digest()` exists for tests, tooling and
 *      save-verification; nothing on the per-tick path may call it.
 *
 * Floats are quantised before folding. Quanta are chosen per field so that the
 * quantum is far below any physically meaningful change but far above f64
 * rounding, which keeps the digest stable under legitimate reassociation
 * (worker partitioning) while staying sensitive to real divergence.
 *
 * WHAT THIS DIGEST MEANS (T-0094, DEC-050).
 *
 * It is a CONTINUATION digest: it covers everything that determines how the
 * world evolves from here, not merely what its numbers are right now.
 *
 * That distinction is not academic. Two worlds can hold identical physical
 * arrays and still be different worlds — if one's climate subsystem is due in
 * an hour and the other's in a century, or if one is in the paleo regime and
 * the other synoptic, the next thing each computes is different. A digest that
 * called those equal would be answering a question nobody asks: both of its
 * consumers, the determinism gate and save/replay verification, want to know
 * "will these two continue identically?"
 *
 * So the scheduler's state machine is folded alongside the fields, reusing
 * `SchedulerSnapshot` — which is already, by construction, exactly what
 * persistence must restore to continue a world. Reusing it means the digest
 * cannot drift from the save format.
 *
 * There is deliberately ONE digest rather than a physical/continuation pair.
 * A second digest would be a second thing to pick correctly at each call site,
 * and the failure mode of picking wrong is silent.
 *
 * Not a cryptographic hash.
 */

import { hashU64, type Seed, type SimTime } from '@ws/core';
import type { GeologyState } from './geology/plates.js';
import type { DynamicGeologyState } from './geology/dynamic.js';
import type { ClimateState } from './climate/solver.js';
import type { HydrologyState } from './hydrology/system.js';
import type { BiosphereState } from './biosphere/system.js';
import type { OceanState } from './ocean/sea.js';
import type { CivilisationState } from './civilisation/system.js';
import { economyDigest, type EconomyState } from './economy/system.js';
import { citiesDigest, type CityRegistry } from './city/system.js';
import type { SchedulerSnapshot } from './scheduler/scheduler.js';

/* ---- 32-bit folding primitives -------------------------------------- */

function mix(h: number, v: number): number {
  let x = (h ^ Math.imul(v | 0, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Quantise then fold. `quantum` is the smallest change the digest must see.
 *
 * Non-finite values fold to distinct sentinels rather than being skipped: a
 * NaN appearing in a field is itself a divergence worth catching, and two runs
 * that differ only in *where* the NaN is must not agree.
 */
function foldFloats(h: number, a: ArrayLike<number> | undefined, quantum: number): number {
  if (a === undefined) return mix(h, 0x1f0);
  let acc = mix(h, a.length);
  const inv = 1 / quantum;
  for (let i = 0; i < a.length; i++) {
    const v = a[i] as number;
    if (!Number.isFinite(v)) {
      acc = mix(acc, Number.isNaN(v) ? 0x7ff00001 : v > 0 ? 0x7ff00002 : 0x7ff00003);
      continue;
    }
    /* Round-half-away-from-zero keeps the quantisation symmetric, so a field
       and its negation quantise consistently. */
    const q = v < 0 ? -Math.round(-v * inv) : Math.round(v * inv);
    /* Fold both halves: a f64 field can legitimately exceed 2^31 counts. */
    acc = mix(acc, q | 0);
    acc = mix(acc, Math.floor(q / 0x100000000) | 0);
  }
  return acc;
}

function foldInts(h: number, a: ArrayLike<number> | undefined): number {
  if (a === undefined) return mix(h, 0x2f0);
  let acc = mix(h, a.length);
  for (let i = 0; i < a.length; i++) acc = mix(acc, a[i] as number);
  return acc;
}

function foldScalar(h: number, v: number, quantum: number): number {
  return foldFloats(h, [v], quantum);
}

/* ---- per-subsystem coverage ----------------------------------------- */

/**
 * Quanta, and why each one.
 *
 * elevation      1 mm   — below any process that runs here; DEC-028 already
 *                         quantises the render path to 15.6 mm.
 * temperature    1 uK   — climate solvers drift in the last bits; 1 uK is far
 *                         below any radiative or phase-change threshold.
 * humidity       1e-12  — specific humidity is O(1e-2), so this is ~10 decimal
 *                         digits of a dimensionless ratio.
 * water depth    1 um   — soil moisture, snow and glacier are metres of water.
 * discharge      1e-6   — m^3/s; a millilitre per second.
 * biomass/pop    1e-9   — densities are O(1..10).
 * area/volume    1 m2 / 1 m3
 *                       — catchment areas reach 5e14 m2 and lake volumes
 *                         1e15 m3. A quantum must satisfy
 *                         max_magnitude / quantum < 2^53, or the count itself
 *                         is not exactly representable and the "quantisation"
 *                         silently becomes f64 rounding of an arbitrary
 *                         multiple. A finer quantum here would be a fiction:
 *                         1 m2 is already 15 orders below a continental
 *                         catchment.
 */
const Q_ELEV = 1e-3;
const Q_TEMP = 1e-6;
const Q_HUMID = 1e-12;
const Q_WATER = 1e-6;
const Q_FLOW = 1e-6;
const Q_BIO = 1e-9;
const Q_AREA = 1;
const Q_VOLUME = 1;

function foldGeology(h: number, g: GeologyState): number {
  let acc = mix(h, g.level);
  acc = foldFloats(acc, g.elevationM, Q_ELEV);
  acc = foldInts(acc, g.plateId);
  acc = foldInts(acc, g.crustType);
  acc = foldInts(acc, g.boundaryType);
  acc = foldFloats(acc, g.crustAgeMyr, 1e-6);
  acc = foldFloats(acc, g.crustThicknessKm, 1e-9);
  acc = foldFloats(acc, g.upliftM, Q_ELEV);
  return acc;
}

function foldClimate(h: number, c: ClimateState): number {
  let acc = mix(h, c.grid.cellCount);
  acc = mix(acc, c.regime === 'explicit' ? 1 : c.regime === 'synoptic' ? 2 : c.regime === 'climatology' ? 3 : 4);
  acc = foldFloats(acc, c.T, Q_TEMP);
  acc = foldFloats(acc, c.q, Q_HUMID);
  acc = foldFloats(acc, c.u, 1e-9);
  acc = foldFloats(acc, c.v, 1e-9);
  acc = foldFloats(acc, c.h, 1e-9);
  acc = foldFloats(acc, c.precipMean, 1e-15);
  acc = foldFloats(acc, c.ice, 1e-9);
  acc = foldFloats(acc, c.Tocean, Q_TEMP);
  acc = foldFloats(acc, c.Tmean, Q_TEMP);
  return mix(acc, c.steps);
}

function foldHydrology(h: number, w: HydrologyState): number {
  let acc = mix(h, w.level);
  /* Routing topology: the receiver/order/basin triple IS the river network's
     authoritative shape. A worker that reorders it produces a different world
     even when every scalar field matches. */
  acc = foldInts(acc, w.receiver);
  acc = foldInts(acc, w.topologicalOrder);
  acc = foldInts(acc, w.basinId);
  acc = foldInts(acc, w.ocean);
  acc = foldFloats(acc, w.elevationM, Q_ELEV);
  acc = foldFloats(acc, w.filledM, Q_ELEV);
  acc = foldFloats(acc, w.contributingAreaM2, Q_AREA);
  acc = foldFloats(acc, w.runoffMps, Q_FLOW);
  acc = foldFloats(acc, w.dischargeM3s, Q_FLOW);
  acc = foldFloats(acc, w.soilMoistureM, Q_WATER);
  acc = foldFloats(acc, w.snowpackM, Q_WATER);
  acc = foldFloats(acc, w.glacierM, Q_WATER);
  acc = foldFloats(acc, w.temperatureK, Q_TEMP);
  acc = foldFloats(acc, w.precipitationRate, 1e-15);

  /* Rivers are derived from routing, but their extracted geometry is what
     downstream systems and the renderer consume. */
  acc = foldInts(acc, w.rivers.order);
  acc = foldFloats(acc, w.rivers.width, 1e-6);
  acc = foldFloats(acc, w.rivers.velocity, 1e-6);

  /* Lakes are a variable-length list; its LENGTH and ORDER are part of the
     state, so fold the count first — otherwise two different lake sets could
     collide by folding the same values in a different grouping. */
  acc = mix(acc, w.lakes.length);
  for (const lake of w.lakes) {
    acc = mix(acc, lake.id);
    acc = mix(acc, lake.outlet);
    acc = mix(acc, lake.cells.length);
    acc = foldInts(acc, lake.cells);
    acc = foldScalar(acc, lake.levelM, Q_ELEV);
    acc = foldScalar(acc, lake.volumeM3, Q_VOLUME);
    acc = foldScalar(acc, lake.inflowM3, Q_VOLUME);
    acc = foldScalar(acc, lake.evaporationM3, Q_VOLUME);
  }

  acc = foldScalar(acc, w.seaLevelM, Q_ELEV);
  acc = mix(acc, w.routingGeneration);
  /* The water budget is a conservation diagnostic; two runs that conserve
     differently are different runs. */
  acc = foldScalar(acc, w.budget.precipitationM3, Q_VOLUME);
  acc = foldScalar(acc, w.budget.evaporationM3, Q_VOLUME);
  acc = foldScalar(acc, w.budget.oceanOutflowM3, Q_VOLUME);
  acc = foldScalar(acc, w.budget.storageChangeM3, Q_VOLUME);
  return acc;
}

function foldBiosphere(h: number, b: BiosphereState): number {
  let acc = mix(h, b.level);
  acc = foldInts(acc, b.biome);
  acc = foldFloats(acc, b.nppKgM2Yr, Q_BIO);
  acc = foldFloats(acc, b.vegetationDensity, Q_BIO);
  acc = foldFloats(acc, b.biomassKgM2, Q_BIO);
  acc = foldFloats(acc, b.phenology, Q_BIO);
  acc = foldFloats(acc, b.producers, Q_BIO);
  acc = foldFloats(acc, b.herbivores, Q_BIO);
  acc = foldFloats(acc, b.predators, Q_BIO);
  acc = foldFloats(acc, b.populationDensity, Q_BIO);
  acc = mix(acc, b.steps);
  return mix(acc, b.extinctions);
}

function foldDynamicGeology(h: number, d: DynamicGeologyState): number {
  let acc = foldGeology(mix(h, d.generation), d.coarse);
  acc = foldFloats(acc, d.stress, 1e-6);
  acc = foldFloats(acc, d.volcanicActivity, 1e-6);
  /* Plate kinematics: the Euler poles and current orientations are the state
     that makes the next step reproducible. */
  acc = mix(acc, d.plates.length);
  for (const p of d.plates) {
    acc = foldScalar(acc, p.sx, 1e-12);
    acc = foldScalar(acc, p.sy, 1e-12);
    acc = foldScalar(acc, p.sz, 1e-12);
    acc = foldScalar(acc, p.px, 1e-12);
    acc = foldScalar(acc, p.py, 1e-12);
    acc = foldScalar(acc, p.pz, 1e-12);
    acc = foldScalar(acc, p.omega, 1e-15);
  }
  /* Event history is authoritative: it is replayed and surfaced to the UI. */
  acc = mix(acc, d.events.length);
  for (const e of d.events) {
    acc = mix(acc, e.id);
    acc = mix(acc, e.kind === 'earthquake' ? 1 : 2);
    acc = mix(acc, e.cell);
    acc = foldScalar(acc, e.timeMyr, 1e-9);
    acc = foldScalar(acc, e.magnitude, 1e-9);
  }
  acc = foldScalar(acc, d.elapsedMyr, 1e-9);
  acc = foldScalar(acc, d.createdCrustM2, Q_AREA);
  acc = foldScalar(acc, d.consumedCrustM2, Q_AREA);
  return acc;
}

function foldOcean(h: number, o: OceanState): number {
  let acc = foldInts(mix(h, 0x0cea), o.mask);
  acc = foldFloats(acc, o.depthM, 1e-3);
  acc = foldScalar(acc, o.seaLevel, Q_ELEV);
  return foldScalar(acc, o.oceanFraction, 1e-12);
}

function foldCivilisation(h: number, c: CivilisationState): number {
  /* EntityStore folds its own LIVE SET (dead slots are not world state), so
     the digest is invariant to which free slot a settlement happens to reuse
     but sensitive to every value a live settlement holds. */
  let acc = mix(mix(h, c.store.digest()), c.store.count);
  acc = foldInts(acc, c.claim);
  acc = foldScalar(acc, c.totalPopulation, 1e-6);
  acc = mix(acc, c.foundedTotal);
  acc = mix(acc, c.collapsedTotal);
  acc = mix(acc, c.relocatedTotal);
  acc = mix(acc, c.topologyVersion);
  acc = mix(acc, c.nextCulture);
  acc = mix(acc, c.steps);
  acc = mix(acc, c.siteCursor);
  acc = mix(acc, c.siteIndexBasis);
  acc = foldInts(acc, c.siteIndex);
  acc = mix(acc, c.store.freeContinuationDigest());
  return foldScalar(acc, c.year, 1e-6);
}

/* ---- entry point ----------------------------------------------------- */

export interface WorldHashInput {
  readonly seed: Seed;
  readonly geology: GeologyState;
  readonly climate?: ClimateState;
  readonly hydrology?: HydrologyState;
  readonly biosphere?: BiosphereState;
  readonly dynamicGeology?: DynamicGeologyState;
  readonly ocean?: OceanState;
  readonly civilisation?: CivilisationState;
  readonly economy?: EconomyState;
  /** M9 authoritative city state (not layouts — those are derived). */
  readonly cities?: CityRegistry;
  /**
   * The scheduler's continuation state.
   *
   * Two worlds whose physical arrays agree but whose next due time, cadence or
   * regime differ are NOT the same reproducible world: the next thing each will
   * compute is different. See the header note on what this digest means.
   */
  readonly scheduler?: SchedulerSnapshot;
  readonly seaLevel: number;
  readonly time: SimTime;
}

/**
 * Fold the scheduler's state machine.
 *
 * `SchedulerSnapshot` is already exactly the set of things persistence has to
 * restore to continue a world, which makes it the right definition of
 * continuation state — this reuses it rather than inventing a second one that
 * could drift from it.
 */
function foldScheduler(h: number, s: SchedulerSnapshot): number {
  /* `tick` is deliberately NOT folded. It is an `advance()` CALL COUNTER, not
     continuation state. The live app calls `advance` every frame; the command
     log coalesces consecutive advances into one (commands.ts) so a recipe of a
     world that has run two frames is `{kind:'advance', seconds: sum}`. Replay
     then issues one `advance`, so `tick` is 1 against the live 2, while
     `time`, `due` and `slot.steps` — the things that decide what happens next
     — agree. Folding tick made every multi-frame RECIPE button throw.
     Continuity is already covered by time, state, cadence, due and steps. */
  let acc = mix(h, s.state === 'running' ? 1 : s.state === 'paused' ? 2 : 3);
  acc = foldScalar(acc, s.time.seconds, 1e-6);
  acc = mix(acc, s.time.year);
  acc = mix(acc, s.slots.length);
  for (const slot of s.slots) {
    /* Subsystem id as a string fold: the slot ORDER is the resolved dependency
       order, so a reordering is itself a difference worth catching. */
    for (let i = 0; i < slot.id.length; i++) acc = mix(acc, slot.id.charCodeAt(i));
    const c = slot.cadence;
    acc = mix(acc, c.kind === 'every' ? 1 : c.kind === 'everyNOf' ? 2 : 3);
    if (c.kind === 'every') acc = foldScalar(acc, c.dt as unknown as number, 1e-6);
    if (c.kind === 'everyNOf') {
      acc = mix(acc, c.n);
      const of = c.of as unknown as string;
      for (let i = 0; i < of.length; i++) acc = mix(acc, of.charCodeAt(i));
    }
    acc = mix(acc, slot.due.year);
    acc = foldScalar(acc, slot.due.seconds, 1e-6);
    acc = mix(acc, slot.steps);
    acc = foldScalar(acc, slot.lastDt as unknown as number, 1e-6);
    acc = mix(acc, slot.lastRun === null ? 0 : 1);
    if (slot.lastRun !== null) {
      acc = mix(acc, slot.lastRun.year);
      acc = foldScalar(acc, slot.lastRun.seconds, 1e-6);
    }
    acc = mix(acc, slot.coveredThrough.year);
    acc = foldScalar(acc, slot.coveredThrough.seconds, 1e-6);
  }
  return acc;
}

/**
 * Fold every authoritative field of the world into one 32-bit digest.
 *
 * Absent subsystems fold a distinct sentinel rather than nothing, so a world
 * WITHOUT a biosphere never collides with one whose biosphere happens to be
 * all zeros.
 *
 * O(total authoritative state). Checkpoint operation — see the file header.
 */
export function hashWorldState(args: WorldHashInput): number {
  let h = hashU64(args.seed, 0xff, args.geology.level, 0, args.time.year).lo >>> 0;
  h = foldScalar(h, args.time.seconds, 1e-6);
  h = foldScalar(h, args.seaLevel, Q_ELEV);

  /* When dynamic geology is present it OWNS the coarse geological state and
     `args.geology` is the upsampled terrain view of it; both are folded, in a
     fixed order, so neither can drift unnoticed. */
  h = foldGeology(h, args.geology);
  h = args.climate !== undefined ? foldClimate(h, args.climate) : mix(h, 0xc1);
  h = args.ocean !== undefined ? foldOcean(h, args.ocean) : mix(h, 0xc2);
  h = args.hydrology !== undefined ? foldHydrology(h, args.hydrology) : mix(h, 0xc3);
  h = args.biosphere !== undefined ? foldBiosphere(h, args.biosphere) : mix(h, 0xc4);
  h = args.dynamicGeology !== undefined ? foldDynamicGeology(h, args.dynamicGeology) : mix(h, 0xc5);
  h = args.civilisation !== undefined ? foldCivilisation(h, args.civilisation) : mix(h, 0xc6);
  /* M10 folds through its own digest: stocks, prices, cumulative extraction,
     the pollution field, land use and the network topology. */
  h = args.economy !== undefined ? mix(h, economyDigest(args.economy)) : mix(h, 0xc7);
  /* M9 authoritative city state. `city/state.ts` calls this state "what
     persistence stores, and what determinism hashes" — it was the former and
     not the latter until T-0094. Layouts are derived and stay out. */
  h = args.cities !== undefined ? mix(h, citiesDigest(args.cities)) : mix(h, 0xc8);
  h = args.scheduler !== undefined ? foldScheduler(h, args.scheduler) : mix(h, 0xc9);
  return h >>> 0;
}
