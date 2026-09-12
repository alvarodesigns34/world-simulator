/**
 * The scheduler (T-0012, DEC-016, DEC-030, DEC-031).
 *
 * Advances simulation time and runs due subsystems in the deterministic order
 * `buildSchedule` resolved. What it does NOT do yet, on purpose: regimes (M4),
 * worker dispatch (T-0013). The contract for both is present so M4 is not a
 * rewrite, which is what DEC-030's consequences require.
 *
 * COMMIT DISCIPLINE (DEC-016 rule 3). Results are applied at tick boundaries in
 * the fixed subsystem order, never on arrival. A job that finishes early waits.
 * That is the price of being asynchronous and deterministic at once, and it is
 * cheap: the only cost is latency, invisible at simulation time scales.
 *
 * everyNOf `dt` is the SPAN the follower integrates, measured from its own
 * `coveredThrough` to the leader's — not `leader.lastDt * n` (T-0072).
 *
 * `(time, dt)` is the half-open span `[time, time + dt)` for every `every`
 * subsystem, and a follower's spans must tile the leader's timeline with no gap
 * and no overlap. `lastDt * n` satisfies that only while the leader's cadence
 * never varies, and DEC-030 regimes exist to vary it: a leader stepping
 * 1 d, 1 d, 10 d has covered 12 days, not 30. It was also wrong at the boundary
 * today — the first follower span started mid-timeline and left [0, 2d)
 * uncovered.
 *
 * everyNOf means "every N steps of X", not "lastDt * n". Followers are not
 * in the due-time scan; they run in the same inner loop as their leader, after
 * it (build-time validated), when `leader.steps % n === 0`. A zero dt therefore
 * cannot pin `due` and spin `advance()` until maxSteps (or forever — the
 * `stepDt <= 0` continue used not to increment the guard).
 *
 * resume() must NOT reset `due` to now. Slow-state cadence is path-independent
 * (DEC-030) only if quiesce/resume does not phase-shift it.
 */

import {
  addDuration,
  compare,
  diff,
  duration,
  invariant,
  type Calendar,
  type Duration,
  type SimTime,
} from '@ws/core';
import type { FieldStore, SubsystemId } from '@ws/data';
import { buildSchedule, type ScheduleEntry } from './graph.js';
import type { Subsystem } from './types.js';

export interface SchedulerOptions {
  readonly calendar: Calendar;
  readonly startTime: SimTime;
  readonly store?: FieldStore;
  /**
   * Largest simulated span a single subsystem step may cover. A step longer than
   * its cadence is clamped and the remainder carried, so a huge timeScale cannot
   * turn one step into an arbitrarily long integration.
   */
  readonly maxStepsPerAdvance?: number;
}

export type RunState = 'running' | 'paused' | 'quiesced';

interface Slot {
  readonly entry: ScheduleEntry;
  /** Next simulation instant at which this subsystem is due. */
  due: SimTime;
  steps: number;
  lastDt: Duration;
  lastRun: SimTime | null;
  /**
   * End of the simulated span this slot has integrated, i.e. the exclusive
   * upper bound of the last `[time, time + dt)` it ran. An everyNOf follower
   * derives its span from the difference between its own and its leader's.
   */
  coveredThrough: SimTime;
}

export class Scheduler {
  readonly calendar: Calendar;
  private readonly slots: Slot[] = [];
  private readonly byId = new Map<string, Slot>();
  private schedule: readonly ScheduleEntry[] = [];
  private readonly registered: Subsystem[] = [];
  private readonly store: FieldStore | undefined;
  private readonly maxSteps: number;

  private _time: SimTime;
  private _tick = 0;
  private _state: RunState = 'running';
  private built = false;

  constructor(opts: SchedulerOptions) {
    this.calendar = opts.calendar;
    this._time = opts.startTime;
    this.store = opts.store;
    this.maxSteps = opts.maxStepsPerAdvance ?? 512;
  }

  register(s: Subsystem): this {
    invariant(!this.built, `cannot register '${String(s.id)}' after build()`);
    this.registered.push(s);
    return this;
  }

  /**
   * Resolve the order. Throws on a cycle, a write conflict, an undeclared owner
   * or an unknown field (DEC-031 rule 3).
   */
  build(): this {
    invariant(!this.built, 'scheduler already built');
    this.schedule = buildSchedule(this.registered, this.store);
    for (const entry of this.schedule) {
      const slot: Slot = {
        entry,
        due: this._time,
        steps: 0,
        lastDt: duration(0),
        lastRun: null,
        coveredThrough: this._time,
      };
      this.slots.push(slot);
      this.byId.set(entry.subsystem.id as string, slot);
    }
    this.built = true;
    return this;
  }

  get time(): SimTime {
    return this._time;
  }
  get tick(): number {
    return this._tick;
  }
  get state(): RunState {
    return this._state;
  }
  get order(): readonly ScheduleEntry[] {
    return this.schedule;
  }

  stepCount(id: SubsystemId): number {
    return this.byId.get(id as string)?.steps ?? 0;
  }

  /**
   * Advance simulation time by `dt` and run everything that falls due.
   *
   * Subsystems run in resolved order within each tick, and a subsystem due more
   * than once runs the right number of times. Order never depends on how the
   * span was reached, only on the schedule.
   */
  advance(dt: Duration): void {
    invariant(this.built, 'call build() before advance()');
    if (this._state !== 'running') return;
    invariant(dt >= 0, 'cannot advance simulation time backwards');

    const target = addDuration(this._time, dt, this.calendar);

    // Advance instant by instant, NOT subsystem by subsystem.
    //
    // At each simulation instant, every subsystem due at that instant runs once,
    // in resolved order. Draining one subsystem to `target` before starting the
    // next would run `terrain` three times and only then `rivers` three times,
    // which breaks the dependency order the graph was built to guarantee: rivers
    // would read sediment from a later step than the one it is paired with.
    //
    // Slots are a plain array in schedule order, so the inner loop IS the
    // resolved order — no Map iteration reaches a result here.
    let guard = 0;
    for (;;) {
      // Earliest due instant that is still within this advance.
      // everyNOf is NOT in this scan: it follows its leader by step count.
      // onDemand is not in this scan. A non-positive `every` dt is a build error,
      // but is also skipped here so it cannot pin `due` and hang.
      let earliest: SimTime | null = null;
      for (const slot of this.slots) {
        const kind = slot.entry.subsystem.cadence.kind;
        if (kind === 'onDemand' || kind === 'everyNOf') continue;
        if (kind === 'every' && slot.entry.subsystem.cadence.dt <= 0) continue;
        // Strictly BEFORE the target: a step at instant T covers [T, T+dt), so
        // a subsystem due exactly at `target` belongs to the next advance. Using
        // <= here would run a 3-day advance at t=0,1,2,3 — four steps for three
        // days — and would double-count the boundary on every call.
        if (compare(slot.due, target) >= 0) continue;
        if (earliest === null || compare(slot.due, earliest) < 0) earliest = slot.due;
      }
      if (earliest === null) break;

      for (const slot of this.slots) {
        const c = slot.entry.subsystem.cadence;
        if (c.kind === 'onDemand') continue;

        if (c.kind === 'every') {
          if (compare(slot.due, earliest) !== 0) continue;
          const stepDt = c.dt;
          if (stepDt <= 0) continue;
          this.runSlot(slot, stepDt, slot.due);
        } else if (c.kind === 'everyNOf') {
          const leader = this.byId.get(c.of as string);
          if (leader === undefined) continue;
          // Leader ran this instant and has just reached a multiple of n.
          if (
            leader.lastRun !== null &&
            compare(leader.lastRun, earliest) === 0 &&
            leader.steps > 0 &&
            leader.steps % c.n === 0
          ) {
            // The exact span since this follower last ran, so the windows tile
            // the leader's timeline. Works whatever the leader's cadence does.
            const windowStart = slot.coveredThrough;
            const stepDt = diff(leader.coveredThrough, windowStart, this.calendar);
            if (stepDt <= 0) continue;
            this.runSlot(slot, stepDt, windowStart);
            slot.coveredThrough = leader.coveredThrough;
          } else {
            continue;
          }
        } else {
          continue;
        }

        if (++guard > this.maxSteps) {
          // Not silently dropped: dropping a step changes results, which is a
          // determinism bug wearing a performance costume (DEC-016 rule 5).
          throw new Error(
            `scheduler exceeded ${String(this.maxSteps)} steps in one advance() — ` +
              `the timeScale is too large for the declared cadences, or a cadence is too small`,
          );
        }
      }
    }

    this._time = target;
    this._tick++;
  }

  private runSlot(slot: Slot, stepDt: Duration, time: SimTime): void {
    const sys = slot.entry.subsystem;
    if (this.store !== undefined) this.store.beginStep(sys.id, sys.writes);
    try {
      sys.step({ time, dt: stepDt, step: slot.steps });
    } finally {
      if (this.store !== undefined) this.store.endStep();
    }
    slot.steps++;
    slot.lastDt = stepDt;
    slot.lastRun = time;
    slot.due = addDuration(time, stepDt, this.calendar);
    slot.coveredThrough = slot.due;
  }

  pause(): void {
    if (this._state === 'running') this._state = 'paused';
  }

  resumeRunning(): void {
    if (this._state === 'paused') this._state = 'running';
  }

  /**
   * DEC-030: `quiesce` is a no-op for slow state and discards transients for
   * fast state. Called in resolved order so the sequence is deterministic.
   */
  quiesce(): void {
    for (const slot of this.slots) {
      slot.entry.subsystem.quiesce?.({
        time: this._time,
        dt: slot.lastDt,
        step: slot.steps,
      });
    }
    this._state = 'quiesced';
  }

  /**
   * Resume from aggregates + world seed. Pure, so replay stays stable.
   *
   * Does NOT reset `due`. Resetting due to `_time` phase-shifts every slow
   * cadence (DEC-030 amendment 1): a 10-year ice step that was 4 years from
   * due would fire immediately, and two recipes that quiesced at different
   * wall-clock moments would diverge.
   */
  resume(): void {
    for (const slot of this.slots) {
      slot.entry.subsystem.resume?.({
        time: this._time,
        dt: slot.lastDt,
        step: slot.steps,
      });
    }
    this._state = 'running';
  }
}
