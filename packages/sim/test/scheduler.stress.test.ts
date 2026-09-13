import { describe, expect, it } from 'vitest';
import { EARTH_CALENDAR, DAY, duration, simTime, type Duration } from '@ws/core';
import { fieldId, subsystemId } from '@ws/data';
import {
  Scheduler,
  SchedulerGraphError,
  buildSchedule,
  type Phase,
  type Subsystem,
} from '@ws/sim';

const CAL = EARTH_CALENDAR;
const PHASES: Phase[] = [
  'Input',
  'Geology',
  'Terrain',
  'Hydrology',
  'Atmosphere',
  'Ocean',
  'Biosphere',
  'Civilisation',
  'Economy',
  'Derived',
  'Presentation',
];

function sub(
  id: string,
  o: {
    phase?: Phase;
    reads?: string[];
    writes?: string[];
    readsPrev?: string[];
    dt?: Duration;
    log?: string[];
  } = {},
): Subsystem {
  return {
    id: subsystemId(id),
    phase: o.phase ?? 'Terrain',
    cadence: { kind: 'every', dt: o.dt ?? DAY },
    reads: (o.reads ?? []).map(fieldId),
    writes: (o.writes ?? []).map(fieldId),
    ...(o.readsPrev ? { readsPrev: o.readsPrev.map(fieldId) } : {}),
    step: () => {
      o.log?.push(id);
    },
  };
}

const ids = (s: readonly { subsystem: Subsystem }[]): string[] =>
  s.map((e) => e.subsystem.id as string);

function shuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let x = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

describe('scheduler stress', () => {
  it('emits a whole ready wave before discovering dependents (not one-at-a-time Kahn)', () => {
    // A, C independent; B reads A's write. Lexical A < B < C.
    // Wave order: A, C then B. Classic Kahn one-at-a-time would do A, B, C.
    const order = ids(
      buildSchedule([
        sub('C', { writes: ['c'] }),
        sub('B', { reads: ['a'], writes: ['b'] }),
        sub('A', { writes: ['a'] }),
      ]),
    );
    expect(order).toEqual(['A', 'C', 'B']);
  });

  it('one subsystem runs', () => {
    const log: string[] = [];
    const s = new Scheduler({ calendar: CAL, startTime: simTime(0, 0, CAL) })
      .register(sub('only', { log, writes: ['x'] }))
      .build();
    s.advance(duration(DAY * 3));
    expect(log).toEqual(['only', 'only', 'only']);
  });

  it('tens of independent subsystems stay in lexical order within a phase', () => {
    const names = ['q', 'a', 'm', 'z', 'b', 'c', 'n', 'd', 'y', 'e', 'x', 'f'];
    const order = ids(buildSchedule(names.map((n) => sub(n, { writes: [n] }))));
    expect(order).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('a hundred mixed-phase subsystems still produce a total order and stay acyclic', () => {
    const subs: Subsystem[] = [];
    for (let i = 0; i < 100; i++) {
      const phase = PHASES[i % PHASES.length] as Phase;
      const prevPhase = PHASES[(i - 1) % PHASES.length] as Phase;
      const couple = i % 7 === 0 && i > 0;
      const backward = couple && PHASES.indexOf(phase) < PHASES.indexOf(prevPhase);
      subs.push(
        sub(`n${String(i).padStart(3, '0')}`, {
          phase,
          writes: [`w${i}`],
          reads: couple && !backward ? [`w${i - 1}`] : [],
          ...(couple && backward ? { readsPrev: [`w${i - 1}`] } : {}),
        }),
      );
    }
    const t0 = Date.now();
    const schedule = buildSchedule(subs);
    const t1 = Date.now();
    expect(schedule).toHaveLength(100);
    expect(t1 - t0).toBeLessThan(50);
    // Phase order is the primary key.
    let prevPhase = -1;
    const indexOf = (p: Phase): number => PHASES.indexOf(p);
    for (const e of schedule) {
      const pi = indexOf(e.subsystem.phase);
      expect(pi).toBeGreaterThanOrEqual(prevPhase);
      prevPhase = pi;
    }
  });

  it('a long pipeline (chain of 20) respects the chain', () => {
    const subs: Subsystem[] = [];
    for (let i = 0; i < 20; i++) {
      subs.push(
        sub(`p${String(i).padStart(2, '0')}`, {
          writes: [`c${i}`],
          reads: i === 0 ? [] : [`c${i - 1}`],
        }),
      );
    }
    const order = ids(buildSchedule(shuffle(subs, 7)));
    for (let i = 1; i < 20; i++) {
      expect(order.indexOf(`p${String(i).padStart(2, '0')}`)).toBeGreaterThan(
        order.indexOf(`p${String(i - 1).padStart(2, '0')}`),
      );
    }
  });

  it('a wide independent set of 40 is sorted lexically as one wave', () => {
    const subs = Array.from({ length: 40 }, (_, i) =>
      sub(`w${String.fromCharCode(97 + (i % 26))}${i}`, { writes: [`f${i}`] }),
    );
    const order = ids(buildSchedule(shuffle(subs, 99)));
    const sorted = [...order].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(order).toEqual(sorted);
  });

  it('cycles are startup errors, never silent', () => {
    expect(() =>
      buildSchedule([
        sub('A', { reads: ['b'], writes: ['a'] }),
        sub('B', { reads: ['a'], writes: ['b'] }),
      ]),
    ).toThrow(SchedulerGraphError);
  });

  it('write conflicts are startup errors', () => {
    expect(() =>
      buildSchedule([
        sub('A', { writes: ['x'] }),
        sub('B', { writes: ['x'] }),
      ]),
    ).toThrow(/write conflict/);
  });

  it('mixed temporal classes still share one union graph', () => {
    const order = ids(
      buildSchedule([
        sub('fast', { phase: 'Atmosphere', writes: ['wind'] }),
        sub('slow', { phase: 'Geology', writes: ['crust'] }),
        sub('agg', { phase: 'Derived', reads: ['wind', 'crust'], writes: ['mean'] }),
      ]),
    );
    expect(order.indexOf('slow')).toBeLessThan(order.indexOf('fast'));
    expect(order.indexOf('fast')).toBeLessThan(order.indexOf('agg'));
  });

  it('pause/resume/quiesce are order-preserving', () => {
    const log: string[] = [];
    const s = new Scheduler({ calendar: CAL, startTime: simTime(0, 0, CAL) })
      .register(sub('tick', { log, writes: ['t'] }))
      .build();
    s.advance(DAY);
    s.pause();
    s.advance(DAY); // ignored
    s.resumeRunning();
    s.advance(DAY);
    s.quiesce();
    s.advance(DAY); // ignored
    s.resume();
    s.advance(DAY);
    expect(log).toEqual(['tick', 'tick', 'tick']);
  });

  it('accelerated time still respects cadence and the [T, T+dt) rule', () => {
    const log: string[] = [];
    const s = new Scheduler({ calendar: CAL, startTime: simTime(0, 0, CAL) })
      .register(sub('day', { log, writes: ['d'], dt: DAY }))
      .build();
    s.advance(duration(DAY * 10));
    expect(log).toHaveLength(10);
  });

  it('registration order never changes the resolved order (property)', () => {
    const make = (): Subsystem[] => [
      sub('C', { writes: ['c'] }),
      sub('A', { writes: ['a'] }),
      sub('B', { reads: ['a'], writes: ['b'] }),
    ];
    const golden = ids(buildSchedule(make()));
    for (const seed of [1, 2, 99, 12345, 0x51a51a51]) {
      expect(ids(buildSchedule(shuffle(make(), seed)))).toEqual(golden);
    }
  });
});
