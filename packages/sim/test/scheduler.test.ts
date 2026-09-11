import { describe, expect, it } from 'vitest';
import { EARTH_CALENDAR, DAY, HOUR, duration, simTime, type Duration } from '@ws/core';
import {
  FieldStore,
  fieldId,
  gridId,
  subsystemId,
  type FieldDescriptor,
  type FieldId,
  type SubsystemId,
} from '@ws/data';
import {
  Scheduler,
  SchedulerGraphError,
  buildSchedule,
  describeSchedule,
  type Phase,
  type Subsystem,
} from '@ws/sim';

const CAL = EARTH_CALENDAR;

function field(id: string, owner: string, over: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    id: fieldId(id),
    grid: gridId('cubesphere', 6),
    dtype: 'i16',
    components: 1,
    quantum: 1,
    offset: 0,
    units: 'm',
    range: [-10_000, 10_000],
    owner: subsystemId(owner),
    tier: 'A',
    temporalClass: 'slow',
    doubleBuffered: false,
    persist: 'snapshot',
    ...over,
  };
}

interface SubOpts {
  phase?: Phase;
  reads?: string[];
  writes?: string[];
  readsPrev?: string[];
  dt?: Duration;
  log?: string[];
}

function sub(id: string, o: SubOpts = {}): Subsystem {
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

/** DEC-031: order is a pure function of the registry. */
describe('scheduler: deterministic ordering (DEC-031)', () => {
  it('is independent of registration order', () => {
    const make = (): Subsystem[] => [
      sub('erosion', { reads: ['elevation'], writes: ['sediment'] }),
      sub('terrain', { writes: ['elevation'] }),
      sub('rivers', { reads: ['sediment', 'elevation'], writes: ['discharge'] }),
    ];
    const a = ids(buildSchedule(make()));
    const b = ids(buildSchedule([...make()].reverse()));
    const c = ids(buildSchedule([make()[1]!, make()[2]!, make()[0]!]));
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    // And it respects the data dependencies.
    expect(a.indexOf('terrain')).toBeLessThan(a.indexOf('erosion'));
    expect(a.indexOf('erosion')).toBeLessThan(a.indexOf('rivers'));
  });

  it('breaks ties lexically, not by insertion', () => {
    const s = ids(buildSchedule([sub('zulu'), sub('alpha'), sub('mike')]));
    expect(s).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('orders phases before intra-phase dependencies', () => {
    const s = ids(
      buildSchedule([
        sub('zzz_atmosphere', { phase: 'Atmosphere' }),
        sub('aaa_geology', { phase: 'Geology' }),
      ]),
    );
    // Geology precedes Atmosphere by phase, despite the lexical order.
    expect(s).toEqual(['aaa_geology', 'zzz_atmosphere']);
  });

  it('produces a readable dump', () => {
    const text = describeSchedule(buildSchedule([sub('a'), sub('b', { phase: 'Ocean' })]));
    expect(text).toContain('Terrain');
    expect(text).toContain('Ocean');
  });
});

/** DEC-031 rule 3: four startup errors, never warnings. */
describe('scheduler: startup errors (DEC-031)', () => {
  it('throws on a dependency cycle', () => {
    expect(() =>
      buildSchedule([
        sub('a', { reads: ['y'], writes: ['x'] }),
        sub('b', { reads: ['x'], writes: ['y'] }),
      ]),
    ).toThrow(SchedulerGraphError);
    expect(() =>
      buildSchedule([
        sub('a', { reads: ['y'], writes: ['x'] }),
        sub('b', { reads: ['x'], writes: ['y'] }),
      ]),
    ).toThrow(/cycle/);
  });

  it('throws on a write conflict — two writers of one field', () => {
    expect(() =>
      buildSchedule([sub('a', { writes: ['t'] }), sub('b', { writes: ['t'] })]),
    ).toThrow(/write conflict on field 't'/);
  });

  it('throws on a duplicate subsystem id', () => {
    expect(() => buildSchedule([sub('a'), sub('a')])).toThrow(/duplicate subsystem id/);
  });

  it('throws when a subsystem writes a field it does not own', () => {
    const store = new FieldStore().declare(field('elevation', 'terrain')).seal();
    expect(() => buildSchedule([sub('hydrology', { writes: ['elevation'] })], store)).toThrow(
      /owned by 'terrain'/,
    );
  });

  it('throws on an unknown field', () => {
    const store = new FieldStore().declare(field('elevation', 'terrain')).seal();
    expect(() => buildSchedule([sub('terrain', { reads: ['nope'] })], store)).toThrow(
      /unknown field 'nope'/,
    );
  });

  it('throws when readsPrev targets a field that is not double-buffered', () => {
    const store = new FieldStore().declare(field('t', 'ocean')).seal();
    expect(() => buildSchedule([sub('ocean', { readsPrev: ['t'] })], store)).toThrow(
      /not double-buffered/,
    );
  });

  it('the cycle message names the fix', () => {
    try {
      buildSchedule([
        sub('ocean', { reads: ['airT'], writes: ['seaT'] }),
        sub('atmos', { reads: ['seaT'], writes: ['airT'] }),
      ]);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain('readsPrev');
    }
  });
});

/** DEC-031 rule 4: readsPrev breaks a loop and creates no edge. */
describe('scheduler: explicit feedback lag (DEC-031 rule 4)', () => {
  it('readsPrev resolves what would otherwise be a cycle', () => {
    const store = new FieldStore()
      .declare(field('seaT', 'ocean', { doubleBuffered: true }))
      .declare(field('airT', 'atmos', { doubleBuffered: true }))
      .seal();
    const schedule = buildSchedule(
      [
        sub('ocean', { phase: 'Ocean', readsPrev: ['airT'], writes: ['seaT'] }),
        sub('atmos', { phase: 'Atmosphere', reads: ['seaT'], writes: ['airT'] }),
      ],
      store,
    );
    expect(ids(schedule)).toEqual(['atmos', 'ocean']); // by phase
  });
});

describe('scheduler: execution', () => {
  const build = (log: string[]): Scheduler =>
    new Scheduler({ calendar: CAL, startTime: simTime(0, 0, CAL) })
      .register(sub('rivers', { reads: ['sediment'], dt: DAY, log }))
      .register(sub('terrain', { writes: ['sediment'], dt: DAY, log }))
      .build();

  it('runs subsystems in resolved order, every tick', () => {
    const log: string[] = [];
    const s = build(log);
    s.advance(duration(3 * 86400));
    expect(log).toEqual(['terrain', 'rivers', 'terrain', 'rivers', 'terrain', 'rivers']);
  });

  it('advances simulation time exactly', () => {
    const s = build([]);
    s.advance(duration(86400));
    expect(s.time.seconds).toBeCloseTo(86400, 6);
    expect(s.tick).toBe(1);
  });

  it('respects per-subsystem cadence, not a global step', () => {
    const log: string[] = [];
    const s = new Scheduler({ calendar: CAL, startTime: simTime(0, 0, CAL) })
      .register(sub('hourly', { dt: HOUR, log }))
      .register(sub('daily', { dt: DAY, log }))
      .build();
    s.advance(duration(86400));
    expect(log.filter((x) => x === 'hourly')).toHaveLength(24);
    expect(log.filter((x) => x === 'daily')).toHaveLength(1);
  });

  it('gives identical results whether advanced in one step or many', () => {
    const a: string[] = [];
    const sa = build(a);
    sa.advance(duration(10 * 86400));

    const b: string[] = [];
    const sb = build(b);
    for (let i = 0; i < 10; i++) sb.advance(duration(86400));

    expect(b).toEqual(a);
    expect(sb.time.year).toBe(sa.time.year);
    expect(sb.time.seconds).toBeCloseTo(sa.time.seconds, 6);
  });

  it('refuses to advance backwards', () => {
    expect(() => build([]).advance(duration(-1))).toThrow();
  });

  it('throws rather than silently dropping steps when a cadence is unreachable', () => {
    const s = new Scheduler({
      calendar: CAL,
      startTime: simTime(0, 0, CAL),
      maxStepsPerAdvance: 100,
    })
      .register(sub('fast', { dt: duration(1) }))
      .build();
    // 1000 s of sim time at a 1 s cadence needs 1000 steps.
    expect(() => s.advance(duration(1000))).toThrow(/exceeded 100 steps/);
  });

  it('pause stops advancement; resume restores it', () => {
    const log: string[] = [];
    const s = build(log);
    s.pause();
    s.advance(duration(86400));
    expect(log).toHaveLength(0);
    s.resumeRunning();
    s.advance(duration(86400));
    expect(log.length).toBeGreaterThan(0);
  });

  it('quiesce and resume run in resolved order (DEC-030)', () => {
    const calls: string[] = [];
    const mk = (id: string): Subsystem => ({
      ...sub(id),
      quiesce: () => calls.push(`q:${id}`),
      resume: () => calls.push(`r:${id}`),
    });
    const s = new Scheduler({ calendar: CAL, startTime: simTime(0, 0, CAL) })
      .register(mk('zulu'))
      .register(mk('alpha'))
      .build();
    s.quiesce();
    expect(s.state).toBe('quiesced');
    s.resume();
    expect(calls).toEqual(['q:alpha', 'q:zulu', 'r:alpha', 'r:zulu']);
    expect(s.state).toBe('running');
  });

  it('refuses registration after build', () => {
    const s = build([]);
    expect(() => s.register(sub('late'))).toThrow(/after build/);
  });
});

/**
 * DEC-030 amendment 1: slow state steps on a fixed sim-time cadence, so its
 * trajectory does not depend on the timeScale path taken to reach an instant.
 */
describe('scheduler: slow state is path-independent (DEC-030)', () => {
  it('takes the same number of steps regardless of how the span was advanced', () => {
    const counts: number[] = [];
    for (const chunks of [[365], [180, 185], [1, 1, 363], Array(365).fill(1)]) {
      let steps = 0;
      const slow: Subsystem = {
        ...sub('iceSheet', { dt: duration(10 * 86400) }),
        step: () => {
          steps++;
        },
      };
      const s = new Scheduler({
        calendar: CAL,
        startTime: simTime(0, 0, CAL),
        maxStepsPerAdvance: 10_000,
      })
        .register(slow)
        .build();
      for (const days of chunks as number[]) s.advance(duration(days * 86400));
      counts.push(steps);
    }
    // All four paths reach the same simulated instant and take the same steps.
    expect(new Set(counts).size).toBe(1);
  });
});

describe('scheduler: types', () => {
  it('exposes the phase order the architecture documents', () => {
    const s = buildSchedule([
      sub('e', { phase: 'Economy' }),
      sub('g', { phase: 'Geology' }),
      sub('a', { phase: 'Atmosphere' }),
      sub('i', { phase: 'Input' }),
    ]);
    expect(ids(s)).toEqual(['i', 'g', 'a', 'e']);
  });

  it('accepts a subsystem id as a branded type', () => {
    const id: SubsystemId = subsystemId('x');
    const f: FieldId = fieldId('y');
    expect(String(id)).toBe('x');
    expect(String(f)).toBe('y');
  });
});
