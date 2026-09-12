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
 */

import {
  addDuration,
  assert,
  compare,
  duration,
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
    assert(!this.built, `cannot register '${String(s.id)}' after build()`);
    this.registered.push(s);
    return this;
  }

  /**
   * Resolve the order. Throws on a cycle, a write conflict, an undeclared owner
   * or an unknown field (DEC-031 rule 3).
   */
  build(): this {
    assert(!this.built, 'scheduler already built');
    this.schedule = buildSchedule(this.registered, this.store);
    for (const entry of this.schedule) {
      const slot: Slot = { entry, due: this._time, steps: 0, lastDt: duration(0) };
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
    assert(this.built, 'call build() before advance()');
    if (this._state !== 'running') return;
    assert(dt >= 0, 'cannot advance simulation time backwards');

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
      let earliest: SimTime | null = null;
      for (const slot of this.slots) {
        if (slot.entry.subsystem.cadence.kind === 'onDemand') continue;
        // Strictly BEFORE the target: a step at instant T covers [T, T+dt), so
        // a subsystem due exactly at `target` belongs to the next advance. Using
        // <= here would run a 3-day advance at t=0,1,2,3 — four steps for three
        // days — and would double-count the boundary on every call.
        if (compare(slot.due, target) >= 0) continue;
        if (earliest === null || compare(slot.due, earliest) < 0) earliest = slot.due;
      }
      if (earliest === null) break;

      for (const slot of this.slots) {
        if (slot.entry.subsystem.cadence.kind === 'onDemand') continue;
        if (compare(slot.due, earliest) !== 0) continue;

        const stepDt = this.cadenceDt(slot);
        if (stepDt <= 0) continue;

        slot.entry.subsystem.step({ time: slot.due, dt: stepDt, step: slot.steps });
        slot.steps++;
        slot.lastDt = stepDt;
        slot.due = addDuration(slot.due, stepDt, this.calendar);

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

  private cadenceDt(slot: Slot): Duration {
    const c = slot.entry.subsystem.cadence;
    if (c.kind === 'every') return c.dt;
    if (c.kind === 'everyNOf') {
      const other = this.byId.get(c.of as string);
      assert(other !== undefined, `'${String(slot.entry.subsystem.id)}' follows unknown '${String(c.of)}'`);
      return duration((other as Slot).lastDt * c.n);
    }
    return duration(0);
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

  /** Resume from aggregates + world seed. Pure, so replay stays stable. */
  resume(): void {
    for (const slot of this.slots) {
      slot.entry.subsystem.resume?.({
        time: this._time,
        dt: slot.lastDt,
        step: slot.steps,
      });
      slot.due = this._time;
    }
    this._state = 'running';
  }
}
