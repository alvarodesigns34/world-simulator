/**
 * M11 historical state navigation: bounded in-memory checkpoints (T-0095).
 *
 * WHAT THIS FIXES. The timeline slider was a cursor over recorded SERIES: it
 * read population and temperature samples, wrote a label saying
 * "HISTORY VIEW · RECORDED SNAPSHOT", and left the planet exactly where it was.
 * No field, no geology, no city, no scheduler slot moved. M11's acceptance
 * asks for scrub, jump, bookmarks, history and replay, and only the plotting
 * half of that existed.
 *
 * THE MECHANISM. Checkpoints of the authoritative state are captured as the
 * world advances, kept under a byte budget, and thinned so that recent history
 * stays dense while distant history stays reachable. Scrubbing restores the
 * nearest checkpoint at or before the target and replays the command log
 * forward to it, so a scrub never resimulates from year zero when a nearer
 * checkpoint exists.
 *
 * WHY IT IS SEPARATE FROM `persistence.ts`. That module's `encode` turns every
 * typed array into a JSON `number[]`, which is right for a file and wrong for
 * memory: a Float64 field becomes ~20 bytes per cell of boxed text instead of
 * 8. This clones structurally and keeps typed arrays typed, so a checkpoint
 * costs about what the state costs.
 *
 * WHAT IS NEVER CHECKPOINTED: derived city geometry, GPU buffers, layout
 * caches, route caches. They are regenerable by construction (DEC-043), and
 * storing them would make history navigation quietly authoritative over
 * rendering.
 */

import type { SimTime } from '@ws/core';
import type { EntityStoreSnapshot } from '@ws/data';
import type { SchedulerSnapshot } from '../scheduler/scheduler.js';
import type { HistorySnapshot } from './history.js';
import { dropAllLayouts } from '../city/system.js';
import { publishWorldState, type World } from '../world.js';

/* ---- structural clone that keeps typed arrays typed ------------------- */

type TypedArrayLike = { readonly constructor: { readonly name: string }; slice(): unknown; readonly length: number };
type Frozen = unknown;

function isTyped(v: unknown): v is TypedArrayLike {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

function freeze(value: unknown, omit: ReadonlySet<string>): Frozen {
  if (value === null || typeof value !== 'object') return value;
  if (isTyped(value)) return value.slice();
  if (Array.isArray(value)) return value.map((item) => freeze(item, omit));
  const out: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (omit.has(key)) continue;
    if (typeof record[key] === 'function') continue;
    out[key] = freeze(record[key], omit);
  }
  return out;
}

/**
 * Restore in place, preserving object identity wherever possible.
 *
 * Identity matters: the renderer, the field store and several subsystems hold
 * long-lived references to these arrays and objects. Replacing them would leave
 * consumers reading a detached copy — which is exactly the class of bug that
 * "the slider does nothing" was.
 */
function thaw(target: unknown, frozen: Frozen): unknown {
  if (frozen === undefined) return target;
  if (target === null || typeof target !== 'object') return frozen;
  if (isTyped(target)) {
    const src = frozen as { length: number } & ArrayLike<number>;
    const dst = target as unknown as { length: number; set(v: ArrayLike<number>): void };
    if (dst.length !== src.length) return frozen;
    dst.set(src);
    return target;
  }
  if (Array.isArray(target)) {
    target.splice(0, target.length, ...(frozen as unknown[]));
    return target;
  }
  const record = target as Record<string, unknown>;
  const source = frozen as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const current = record[key];
    if (current !== null && typeof current === 'object' && typeof source[key] === 'object') {
      record[key] = thaw(current, source[key]);
    } else {
      record[key] = source[key];
    }
  }
  return target;
}

function measure(value: unknown, seen = new Set<object>()): number {
  if (value === null || typeof value !== 'object') return 8;
  if (isTyped(value)) return (value as unknown as { byteLength: number }).byteLength;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    let n = 16;
    for (const item of value) n += measure(item, seen);
    return n;
  }
  let n = 16;
  for (const v of Object.values(value as Record<string, unknown>)) n += measure(v, seen) + 24;
  return n;
}

/* ---- what a checkpoint holds ------------------------------------------ */

/** Derived state, excluded exactly as `saveSnapshot` excludes it. */
const CLIMATE_DERIVED = new Set([
  'grid', 'lat', 'sinLat', 'cosLat', 'eastX', 'eastY', 'northX', 'northY', 'northZ',
  'gradCoeffE', 'gradCoeffN', 'gradT', 'gradH', 'gradElev', 'edgeI', 'edgeJ', 'edgeLength',
  'edgeUi', 'edgeVi', 'edgeUj', 'edgeVj', 'edgeFlux', 'outgoing', 'transportDelta',
  'heightDelta', 'areaM2', 'qsat',
]);
const DYNAMIC_GEOLOGY_DERIVED = new Set(['units']);
const CIVILISATION_DERIVED = new Set(['store', 'habitability', 'cellAreaM2']);
/** Layout geometry and route corridors are regenerable; never stored. */
const CITY_DERIVED = new Set<string>([]);
const ECONOMY_DERIVED = new Set(['routeCache']);

export interface WorldCheckpoint {
  readonly time: SimTime;
  /** Absolute simulated seconds, for ordering and nearest-search. */
  readonly at: number;
  /** Continuation digest at capture (DEC-050). Verifies a restore. */
  readonly digest: number;
  readonly bytes: number;
  /** Command-log length at capture; replay resumes from here. */
  readonly commandCount: number;
  readonly roots: Readonly<Record<string, Frozen>>;
  readonly scheduler: SchedulerSnapshot;
  readonly entities: EntityStoreSnapshot;
  readonly history: HistorySnapshot;
  readonly presentation: { readonly timeScale: number; readonly visualField: string };
  readonly geologyEventCursor: number;
}

export function absoluteSeconds(t: SimTime, secondsPerYear: number): number {
  return t.year * secondsPerYear + t.seconds;
}

export function captureCheckpoint(world: World): WorldCheckpoint {
  const roots: Record<string, Frozen> = {
    geology: freeze(world.geology, new Set()),
    ocean: freeze(world.ocean, new Set()),
    climate: freeze(world.climate, CLIMATE_DERIVED),
    hydrology: freeze(world.hydrology, new Set()),
    biosphere: freeze(world.biosphere, new Set()),
    dynamicGeology: freeze(world.dynamicGeology, DYNAMIC_GEOLOGY_DERIVED),
    habitability: freeze(world.habitability, new Set()),
    civilisation: freeze(world.civilisation, CIVILISATION_DERIVED),
    cities: freeze(world.cities, CITY_DERIVED),
    economy: freeze(world.economy, ECONOMY_DERIVED),
  };
  const cp: WorldCheckpoint = {
    time: world.scheduler.time,
    at: absoluteSeconds(world.scheduler.time, world.calendar.secondsPerYear),
    digest: world.digest(),
    bytes: measure(roots),
    commandCount: world.commands.entries.length,
    roots,
    scheduler: world.scheduler.snapshot(),
    entities: world.civilisation.store.snapshot(),
    history: world.history.snapshot(),
    presentation: { timeScale: world.timeScale, visualField: world.visualField },
    geologyEventCursor: world.geologyEventCursor,
  };
  return cp;
}

export function restoreCheckpoint(world: World, cp: WorldCheckpoint): void {
  thaw(world.geology, cp.roots.geology);
  thaw(world.ocean, cp.roots.ocean);
  thaw(world.climate, cp.roots.climate);
  thaw(world.hydrology, cp.roots.hydrology);
  thaw(world.biosphere, cp.roots.biosphere);
  thaw(world.dynamicGeology, cp.roots.dynamicGeology);
  thaw(world.habitability, cp.roots.habitability);
  thaw(world.civilisation, cp.roots.civilisation);
  thaw(world.cities, cp.roots.cities);
  thaw(world.economy, cp.roots.economy);
  world.civilisation.store.restore(cp.entities);
  world.scheduler.restore(cp.scheduler);
  world.history.restore(cp.history);
  world.timeScale = cp.presentation.timeScale;
  world.visualField = cp.presentation.visualField;
  world.geologyEventCursor = cp.geologyEventCursor;
  /* Derived caches keyed on authoritative state must not outlive a rewind. */
  world.economy.network.routeCache.clear();
  dropAllLayouts(world.cities);
  publishWorldState(world);
}

/* ---- the store --------------------------------------------------------- */

export interface CheckpointStoreOptions {
  /** Total in-memory budget. Thinning keeps the store under it. */
  readonly budgetBytes?: number;
  /** Minimum simulated seconds between captures. */
  readonly minSpacingSeconds?: number;
  /** Hard cap on retained checkpoints, whatever the budget allows. */
  readonly maxCheckpoints?: number;
}

/**
 * Bounded checkpoint history.
 *
 * Thinning is exponential: the most recent checkpoints are kept as captured and
 * older ones are dropped every other one, repeatedly. That gives dense recent
 * history — where a user scrubs most — and logarithmically sparse deep history,
 * under a fixed budget, without ever leaving a region unreachable.
 */
export class CheckpointStore {
  private readonly list: WorldCheckpoint[] = [];
  private lastCaptureAt = -Infinity;
  readonly budgetBytes: number;
  readonly minSpacingSeconds: number;
  readonly maxCheckpoints: number;

  constructor(options: CheckpointStoreOptions = {}) {
    this.budgetBytes = options.budgetBytes ?? 192 * 1024 * 1024;
    this.minSpacingSeconds = options.minSpacingSeconds ?? 1;
    this.maxCheckpoints = options.maxCheckpoints ?? 64;
  }

  get count(): number { return this.list.length; }
  get bytes(): number { return this.list.reduce((n, c) => n + c.bytes, 0); }
  get checkpoints(): readonly WorldCheckpoint[] { return this.list; }

  /** Capture if enough simulated time has passed since the last one. */
  maybeCapture(world: World): WorldCheckpoint | undefined {
    const at = absoluteSeconds(world.scheduler.time, world.calendar.secondsPerYear);
    if (at - this.lastCaptureAt < this.minSpacingSeconds) return undefined;
    return this.capture(world);
  }

  capture(world: World): WorldCheckpoint {
    const cp = captureCheckpoint(world);
    /* Replacing rather than appending keeps the list strictly increasing when
       the world has been rewound and re-advanced over the same interval. */
    while (this.list.length > 0 && (this.list[this.list.length - 1] as WorldCheckpoint).at >= cp.at) {
      this.list.pop();
    }
    this.list.push(cp);
    this.lastCaptureAt = cp.at;
    this.thin();
    return cp;
  }

  /** The newest checkpoint at or before `at`, or undefined. */
  nearestAtOrBefore(at: number): WorldCheckpoint | undefined {
    let best: WorldCheckpoint | undefined;
    for (const cp of this.list) {
      if (cp.at <= at + 1e-6) best = cp; else break;
    }
    return best;
  }

  clear(): void {
    this.list.length = 0;
    this.lastCaptureAt = -Infinity;
  }

  private thin(): void {
    /* Drop every other checkpoint from the OLDEST half until the store fits.
       Recent history therefore stays at full resolution. */
    let guard = 0;
    while ((this.list.length > this.maxCheckpoints || this.bytes > this.budgetBytes)
      && this.list.length > 2 && guard < 64) {
      guard++;
      const half = Math.max(1, Math.floor(this.list.length / 2));
      for (let i = half - 1; i >= 1; i -= 2) this.list.splice(i, 1);
    }
    /* Budget still blown with two entries: keep the newest, which is the one a
       "return to live" needs. */
    while (this.bytes > this.budgetBytes && this.list.length > 1) this.list.shift();
  }
}
