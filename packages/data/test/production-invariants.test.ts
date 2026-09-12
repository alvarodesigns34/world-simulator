import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PRODUCTION SAFETY INVARIANTS (T-0075).
 *
 * Grok found that `mut()`'s ownership check ran through `assert()`, which a
 * production build strips — so DEC-013's single-writer rule evaporated in the
 * only build that ships. He fixed that one. This sweeps for the rest.
 *
 * The distinction that matters:
 *
 *   DEV DIAGNOSTIC       a wrong value produces visibly wrong output. Stripping
 *                        it in production is the point: it costs nothing and
 *                        the failure is obvious. Hot-path range checks.
 *   PRODUCTION INVARIANT stripping it lets the system continue with corrupted
 *                        or silently wrong authoritative state. These must
 *                        throw in every build.
 *
 * These tests re-import the modules with `__WS_DEV__` forced false, which is
 * what a production bundle does, and assert that the second class still throws.
 */
describe('invariants that must survive a production build', () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).__WS_DEV__ = false;
  });

  const load = async (): Promise<typeof import('@ws/data')> =>
    (await import('@ws/data')) as typeof import('@ws/data');

  it('assert() really is stripped — the premise of this suite', async () => {
    const core = await import('@ws/core');
    expect(core.DEV).toBe(false);
    expect(() => core.assert(false, 'should be stripped')).not.toThrow();
  });

  /**
   * The DEC-028 enforcement. If `validateDescriptor` no-ops in production, an
   * i16-centimetres elevation field ships and silently truncates Everest — the
   * exact bug DEC-028 exists to prevent, reintroduced by a build flag.
   */
  it('validateDescriptor still rejects a descriptor that cannot hold its range', async () => {
    const d = await load();
    const bad = {
      id: d.fieldId('elevation'),
      grid: d.gridId('cubesphere', 6),
      dtype: 'i16' as const,
      components: 1,
      quantum: 0.0078125, // power of two, but only spans +/-256 m
      offset: 0,
      units: 'm',
      range: [-11_000, 9_000] as const,
      owner: d.subsystemId('terrain'),
      tier: 'A' as const,
      temporalClass: 'slow' as const,
      doubleBuffered: false,
      persist: 'snapshot' as const,
    };
    expect(() => d.validateDescriptor(bad, () => undefined)).toThrow(/cannot hold the declared range/);
  });

  it('validateDescriptor still rejects a non-power-of-two quantum', async () => {
    const d = await load();
    const bad = {
      id: d.fieldId('e'),
      grid: d.gridId('cubesphere', 6),
      dtype: 'i16' as const,
      components: 1,
      quantum: 0.1,
      offset: 0,
      units: 'm',
      range: [-100, 100] as const,
      owner: d.subsystemId('t'),
      tier: 'A' as const,
      temporalClass: 'slow' as const,
      doubleBuffered: false,
      persist: 'snapshot' as const,
    };
    expect(() => d.validateDescriptor(bad, () => undefined)).toThrow(/power of two/);
  });

  it('a duplicate field id is still refused', async () => {
    const d = await load();
    const mk = (): Parameters<InstanceType<typeof d.FieldStore>['declare']>[0] => ({
      id: d.fieldId('dup'),
      grid: d.gridId('cubesphere', 6),
      dtype: 'i16',
      components: 1,
      quantum: 1,
      offset: 0,
      units: 'm',
      range: [-100, 100],
      owner: d.subsystemId('t'),
      tier: 'A',
      temporalClass: 'slow',
      doubleBuffered: false,
      persist: 'snapshot',
    });
    const s = new d.FieldStore({ preferShared: false }).declare(mk());
    // Silently overwriting would give two subsystems different views of one id.
    expect(() => s.declare(mk())).toThrow(/duplicate field id/);
  });

  it('an unknown field is still refused rather than returning undefined', async () => {
    const d = await load();
    const s = new d.FieldStore({ preferShared: false }).seal();
    expect(() => s.view(d.fieldId('nope'))).toThrow(/unknown field/);
    expect(() => s.descriptor(d.fieldId('nope'))).toThrow(/unknown field/);
  });

  it('using an unsealed store is still refused', async () => {
    const d = await load();
    const s = new d.FieldStore({ preferShared: false });
    expect(() => s.view(d.fieldId('x'))).toThrow(/not sealed/);
  });

  it('an unknown grid is still refused', async () => {
    const d = await load();
    expect(() => d.grid('cubesphere@L99')).toThrow(/unknown grid/);
  });

  it('packId beyond the safe level is still refused', async () => {
    const d = await load();
    // Silently wrapping would collide tile-cache keys across levels.
    expect(() =>
      d.quadkey.packId({ face: 0, level: d.quadkey.MAX_PACKABLE_LEVEL + 1, x: 0, y: 0 }),
    ).toThrow(/MAX_PACKABLE_LEVEL/);
  });

  /**
   * Field.set() used assertFinite(), which this suite proves is stripped.
   * A float NaN/Inf is published as-is; an integer NaN encodes to 0 and
   * ±Inf clamp to dtype min/max. Authoritative state continues. T-0081.
   */
  it('set() still rejects NaN and ±Infinity on a float field', async () => {
    const d = await load();
    const id = d.fieldId('f');
    const owner = d.subsystemId('t');
    const store = new d.FieldStore({ preferShared: false })
      .declare({
        id,
        grid: d.gridId('cubesphere', 6),
        dtype: 'f32',
        components: 1,
        quantum: 1,
        offset: 0,
        units: 'm',
        range: [-1, 1],
        owner,
        tier: 'A',
        temporalClass: 'slow',
        doubleBuffered: false,
        persist: 'snapshot',
      })
      .seal();
    const f = store.mut(id, owner);
    expect(() => f.set(0, NaN)).toThrow(/not finite/);
    expect(() => f.set(0, Infinity)).toThrow(/not finite/);
    expect(() => f.set(0, -Infinity)).toThrow(/not finite/);
    f.set(0, 0.25);
    f.commit();
    expect(store.view(id).get(0)).toBeCloseTo(0.25);
  });

  it('set() still rejects NaN and ±Infinity on an integer field', async () => {
    const d = await load();
    const id = d.fieldId('i');
    const owner = d.subsystemId('t');
    const store = new d.FieldStore({ preferShared: false })
      .declare({
        id,
        grid: d.gridId('cubesphere', 6),
        dtype: 'i16',
        components: 1,
        quantum: 1,
        offset: 0,
        units: 'm',
        range: [-100, 100],
        owner,
        tier: 'A',
        temporalClass: 'slow',
        doubleBuffered: false,
        persist: 'snapshot',
      })
      .seal();
    const f = store.mut(id, owner);
    expect(() => f.set(0, NaN)).toThrow(/not finite/);
    expect(() => f.set(0, Infinity)).toThrow(/not finite/);
    expect(() => f.set(0, -Infinity)).toThrow(/not finite/);
    f.set(0, 12);
    f.commit();
    expect(store.view(id).get(0)).toBe(12);
    expect((f.raw() as Int16Array)[0]).toBe(12);
  });
});

describe('scheduler invariants that must survive a production build', () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).__WS_DEV__ = false;
  });

  it('advance() before build() is still refused rather than silently doing nothing', async () => {
    const sim = await import('@ws/sim');
    const core = await import('@ws/core');
    const s = new sim.Scheduler({
      calendar: core.EARTH_CALENDAR,
      startTime: core.simTime(0, 0, core.EARTH_CALENDAR),
    });
    expect(() => s.advance(core.duration(1))).toThrow(/build\(\)/);
  });

  it('advancing simulation time backwards is still refused', async () => {
    const sim = await import('@ws/sim');
    const core = await import('@ws/core');
    const s = new sim.Scheduler({
      calendar: core.EARTH_CALENDAR,
      startTime: core.simTime(0, 0, core.EARTH_CALENDAR),
    }).build();
    expect(() => s.advance(core.duration(-1))).toThrow(/backwards/);
  });

  it('registering after build() is still refused', async () => {
    const sim = await import('@ws/sim');
    const core = await import('@ws/core');
    const data = await import('@ws/data');
    const s = new sim.Scheduler({
      calendar: core.EARTH_CALENDAR,
      startTime: core.simTime(0, 0, core.EARTH_CALENDAR),
    }).build();
    expect(() =>
      s.register({
        id: data.subsystemId('late'),
        phase: 'Terrain',
        cadence: { kind: 'every', dt: core.DAY },
        reads: [],
        writes: [],
        step: () => undefined,
      }),
    ).toThrow(/after build/);
  });
});
