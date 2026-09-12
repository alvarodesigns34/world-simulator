import { describe, expect, it } from 'vitest';
import { DAY, EARTH_CALENDAR, diff, duration, simTime, type Duration, type SimTime } from '@ws/core';
import { subsystemId } from '@ws/data';
import { Scheduler, type Cadence, type Subsystem } from '@ws/sim';

const CAL = EARTH_CALENDAR;
const T0 = simTime(0, 0, CAL);

interface Window {
  start: SimTime;
  dt: Duration;
}

function sys(id: string, cadence: Cadence, sink?: (w: Window) => void): Subsystem {
  return {
    id: subsystemId(id),
    phase: 'Terrain',
    cadence,
    reads: [],
    writes: [],
    step: (ctx) => sink?.({ start: ctx.time, dt: ctx.dt }),
  };
}

/**
 * `dt` SEMANTICS FOR everyNOf (T-0072).
 *
 * Grok correctly re-read `everyNOf` as "every N steps of X" and pulled
 * followers out of the due-time scan, which fixed a hang. What is left is the
 * meaning of the follower's `dt`, currently `leader.lastDt × n`.
 *
 * That is right only while the leader's cadence never varies — and DEC-030
 * regimes exist precisely to vary it. It is also wrong TODAY at the boundary:
 * `(time, dt)` is a half-open span `[time, time + dt)` for every `every`
 * subsystem, and the follower's spans must tile the leader's timeline with no
 * gap and no overlap, or the follower is integrating over the wrong interval.
 *
 * These tests pin the tiling contract, which is checkable now and which a
 * varying-cadence leader in M4 cannot silently break.
 */
describe('everyNOf: follower spans tile the leader timeline', () => {
  const run = (n: number, days: number): { windows: Window[]; leader: Window[] } => {
    const windows: Window[] = [];
    const leader: Window[] = [];
    const s = new Scheduler({ calendar: CAL, startTime: T0 })
      .register(sys('leader', { kind: 'every', dt: DAY }, (w) => leader.push(w)))
      .register(
        sys('follower', { kind: 'everyNOf', n, of: subsystemId('leader') }, (w) => windows.push(w)),
      )
      .build();
    s.advance(duration(days * 86400));
    return { windows, leader };
  };

  it('the first follower span starts at the scheduler start, not mid-timeline', () => {
    const { windows } = run(3, 9);
    expect(windows.length).toBeGreaterThan(0);
    expect(diff(windows[0]!.start, T0, CAL)).toBeCloseTo(0, 6);
  });

  it('consecutive spans are contiguous — no gap, no overlap', () => {
    const { windows } = run(3, 12);
    for (let i = 1; i < windows.length; i++) {
      const prevEnd = diff(windows[i - 1]!.start, T0, CAL) + windows[i - 1]!.dt;
      const thisStart = diff(windows[i]!.start, T0, CAL);
      expect(thisStart).toBeCloseTo(prevEnd, 6);
    }
  });

  it('each span covers exactly n leader steps of simulated time', () => {
    const { windows } = run(3, 12);
    for (const w of windows) expect(w.dt).toBeCloseTo(3 * 86400, 6);
  });

  it('holds for n = 1 and n = 5 too', () => {
    for (const n of [1, 5]) {
      const { windows } = run(n, 20);
      expect(windows.length).toBeGreaterThan(0);
      expect(diff(windows[0]!.start, T0, CAL)).toBeCloseTo(0, 6);
      for (const w of windows) expect(w.dt).toBeCloseTo(n * 86400, 6);
    }
  });

  it('the covered span never runs ahead of the leader', () => {
    const { windows, leader } = run(4, 20);
    const leaderEnd = diff(leader[leader.length - 1]!.start, T0, CAL) + leader[leader.length - 1]!.dt;
    for (const w of windows) {
      expect(diff(w.start, T0, CAL) + w.dt).toBeLessThanOrEqual(leaderEnd + 1e-6);
    }
  });
});

/**
 * Ordering must come from the graph, not from the alphabet. Before the implicit
 * leader→follower edge, `leader`/`follower` failed to build while
 * `aLeader`/`zFollower` succeeded — identical semantics, different names.
 */
describe('everyNOf ordering does not depend on subsystem names', () => {
  it.each([
    ['leader', 'follower'], // follower sorts FIRST lexically
    ['aLeader', 'zFollower'], // follower sorts last
    ['zzz', 'aaa'], // leader sorts last
  ])('builds and orders correctly for %s / %s', (leaderId, followerId) => {
    const order: string[] = [];
    const s = new Scheduler({ calendar: CAL, startTime: T0 })
      .register(sys(leaderId, { kind: 'every', dt: DAY }, () => order.push(leaderId)))
      .register(
        sys(followerId, { kind: 'everyNOf', n: 2, of: subsystemId(leaderId) }, () =>
          order.push(followerId),
        ),
      )
      .build();
    s.advance(duration(4 * 86400));
    expect(order.length).toBeGreaterThan(0);
    expect(order[0]).toBe(leaderId);
    // The follower never runs before its leader in any tick.
    for (let i = 0; i < order.length; i++) {
      if (order[i] === followerId) expect(order.slice(0, i)).toContain(leaderId);
    }
  });
})
;
