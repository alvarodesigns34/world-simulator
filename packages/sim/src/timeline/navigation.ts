/**
 * M11 timeline navigation (T-0095).
 *
 * Historical VIEWING and timeline MUTATION are deliberately different things,
 * and this class only does the first. While the navigator is in history the
 * world is a faithful reconstruction of a past instant and does not advance;
 * returning to live restores the exact head state. There is no branching, and
 * therefore no ambiguity about which timeline the command log describes.
 *
 * Branching — resuming simulation from a past instant and discarding the
 * future — is a different operation with different semantics (it invalidates
 * the log tail and every later checkpoint). It is deliberately NOT offered
 * here rather than being offered ambiguously.
 */

import type { SimTime } from '@ws/core';
import type { World } from '../world.js';
import {
  CheckpointStore,
  absoluteSeconds,
  captureCheckpoint,
  restoreCheckpoint,
  type CheckpointStoreOptions,
  type WorldCheckpoint,
} from './checkpoints.js';

export type NavigatorMode = 'live' | 'history';

export interface ScrubResult {
  /** Simulated seconds actually reached (may differ if the target is clamped). */
  readonly at: number;
  readonly time: SimTime;
  /** Checkpoint the replay started from, if any. */
  readonly fromCheckpoint: number | undefined;
  /** Simulated seconds replayed forward from that checkpoint. */
  readonly replayedSeconds: number;
  /** True when the target was reached without replaying anything. */
  readonly exact: boolean;
}

export class TimelineNavigator {
  readonly store: CheckpointStore;
  private head: WorldCheckpoint | undefined;
  private _mode: NavigatorMode = 'live';
  /** Monotonic token; a newer scrub supersedes an in-flight older one. */
  private token = 0;

  constructor(private readonly world: World, options: CheckpointStoreOptions = {}) {
    this.store = new CheckpointStore(options);
  }

  get mode(): NavigatorMode { return this._mode; }
  get liveTime(): SimTime | undefined { return this.head?.time; }

  /** Record a checkpoint of the live head. Call after advancing. */
  record(): void {
    if (this._mode !== 'live') return;
    this.store.maybeCapture(this.world);
  }

  /** Earliest instant history can reconstruct. */
  earliestReachable(): number {
    const first = this.store.checkpoints[0];
    return first === undefined ? this.now() : first.at;
  }

  latestReachable(): number {
    return this.head === undefined ? this.now() : this.head.at;
  }

  private now(): number {
    return absoluteSeconds(this.world.scheduler.time, this.world.calendar.secondsPerYear);
  }

  /**
   * Reconstruct the world at `targetSeconds`.
   *
   * Restores the nearest checkpoint at or before the target and replays the
   * command log forward (T-0133). A scrub never resimulates from year zero
   * while a nearer checkpoint exists, and never leaves the world
   * half-restored: the restore completes before any replay begins, and a
   * superseding scrub is detected before the expensive part rather than after.
   */
  scrubTo(targetSeconds: number): ScrubResult {
    const myToken = ++this.token;

    const latest = this.latestReachable();
    const earliest = this.earliestReachable();
    const target = Math.max(earliest, Math.min(latest, targetSeconds));
    const current = this.now();

    /* Scrubbing the live head is a no-op, not an entry into history. Entering
       history freezes the world (the app stops advancing); labelling that
       LIVE while the clock is stopped was T-0095 inverted. */
    if (this._mode === 'live' && Math.abs(target - current) < 1e-6) {
      return { at: current, time: this.world.scheduler.time, fromCheckpoint: undefined, replayedSeconds: 0, exact: true };
    }

    /* Entering history for the first time: remember exactly where live was, so
       returning is a restore rather than a resimulation. */
    if (this._mode === 'live') {
      this.head = captureCheckpoint(this.world);
      this._mode = 'history';
    }

    if (Math.abs(this.now() - target) < 1e-6) {
      return { at: target, time: this.world.scheduler.time, fromCheckpoint: undefined, replayedSeconds: 0, exact: true };
    }

    const cp = this.store.nearestAtOrBefore(target)
      ?? (this.head !== undefined && this.head.at <= target + 1e-6 ? this.head : undefined);

    if (cp === undefined) {
      /* Nothing at or before the target: the earliest reconstructible state
         is the best honest answer, and the caller is told so via `at`. */
      const first = this.store.checkpoints[0] ?? this.head;
      if (first === undefined) {
        return { at: current, time: this.world.scheduler.time, fromCheckpoint: undefined, replayedSeconds: 0, exact: false };
      }
      restoreCheckpoint(this.world, first);
      return { at: first.at, time: first.time, fromCheckpoint: first.at, replayedSeconds: 0, exact: false };
    }
    restoreCheckpoint(this.world, cp);

    if (this.token !== myToken) {
      /* Superseded. The world is on a checkpoint boundary — a consistent
         state — so abandoning here leaves nothing half-applied. */
      return { at: this.now(), time: this.world.scheduler.time, fromCheckpoint: cp.at, replayedSeconds: 0, exact: false };
    }

    const start = this.now();
    if (target - start > 1e-6) this.replayLog(cp.commandCount, target);

    const reached = this.now();
    return {
      at: reached,
      time: this.world.scheduler.time,
      fromCheckpoint: cp.at,
      replayedSeconds: Math.max(0, reached - start),
      exact: Math.abs(reached - target) < 1e-3,
    };
  }

  /** Return to the live head, exactly. */
  returnToLive(): void {
    this.token++;
    if (this._mode === 'live' || this.head === undefined) { this._mode = 'live'; return; }
    restoreCheckpoint(this.world, this.head);
    this.head = undefined;
    this._mode = 'live';
  }

  /**
   * Replay logged commands from `fromIndex` until the world clock hits
   * `targetSeconds` (T-0133).
   *
   * `scheduler.advance(dt)` is not a command-log replay: a `setTimeScale` or
   * `setRegime` issued between checkpoints would be skipped, and the
   * reconstruction would integrate the interval under the checkpoint's
   * cadences. Commands already in the log are applied unlogged so the live
   * tail is not duplicated.
   */
  private replayLog(fromIndex: number, targetSeconds: number): void {
    const year = this.world.calendar.secondsPerYear;
    const log = this.world.commands.entries;
    for (let i = fromIndex; i < log.length; i++) {
      const now = this.now();
      if (now >= targetSeconds - 1e-6) return;
      const entry = log[i]!;
      const cmd = entry.cmd;
      if (cmd.kind === 'advance') {
        this.advanceUnlogged(Math.min(cmd.seconds, targetSeconds - now));
        continue;
      }
      if (cmd.kind === 'advanceDeepTime') {
        const takeYears = Math.min(cmd.years, (targetSeconds - now) / year);
        if (takeYears > 0) this.world.applyUnlogged({ kind: 'advanceDeepTime', years: takeYears });
        if (takeYears < cmd.years - 1e-12) return;
        continue;
      }
      const at = absoluteSeconds(entry.time, year);
      if (at > targetSeconds + 1e-6) return;
      this.world.applyUnlogged(cmd);
    }
  }

  /**
   * Chunked unlogged advance, matching `applyReplayCommand` so a scrubbed
   * interval follows the same integration path as a recipe of the same log.
   */
  private advanceUnlogged(seconds: number): void {
    const year = this.world.calendar.secondsPerYear;
    let remaining = seconds;
    let guard = 0;
    while (remaining > 1e-6 && guard < 100_000) {
      guard++;
      const regime = this.world.climate.regime;
      const max = regime === 'paleo' ? 4_000_000 * year
        : regime === 'climatology' ? 50_000 * year
        : regime === 'synoptic' ? 4 * year
        : 300 * 86400;
      const step = Math.min(remaining, max);
      this.world.applyUnlogged({ kind: 'advance', seconds: step });
      remaining -= step;
    }
  }
}
