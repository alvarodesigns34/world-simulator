import { describe, expect, it } from 'vitest';
import {
  FieldStore,
  fieldId,
  gridId,
  snapQuantum,
  subsystemId,
  validateDescriptor,
  type FieldDescriptor,
} from '@ws/data';

const OWNER = subsystemId('terrain');

function desc(over: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    id: fieldId('elevation'),
    grid: gridId('cubesphere', 10),
    dtype: 'i16',
    components: 1,
    quantum: 1,
    offset: 0,
    units: 'm',
    range: [-11_000, 9_000],
    owner: OWNER,
    tier: 'A',
    temporalClass: 'slow',
    doubleBuffered: false,
    persist: 'snapshot',
    ...over,
  };
}

const none = (): undefined => undefined;

/** B1 / DEC-028: the finding that made this validation exist. */
describe('FieldStore: quantisation (DEC-028)', () => {
  it('REJECTS i16 centimetres for elevation — the Architecture v0 bug', () => {
    // 0.01 fails twice over: it is not a power of two, AND it cannot reach
    // Everest. The power-of-two check fires first.
    expect(() =>
      validateDescriptor(desc({ quantum: 0.01, range: [-11_000, 9_000] }), none),
    ).toThrow(/power of two/);

    // The nearest legal quantum of that size, 2^-7 = 7.8 mm, still spans only
    // +/-256 m — so the range check catches it on its own merits.
    expect(() =>
      validateDescriptor(desc({ quantum: 0.0078125, range: [-11_000, 9_000] }), none),
    ).toThrow(/cannot hold the declared range/);
  });

  it('states the range i16 centimetres actually covers', () => {
    // +/- 327.68 m. Everest is 8849 m.
    expect(-32768 * 0.01).toBeCloseTo(-327.68, 6);
    expect(32767 * 0.01).toBeCloseTo(327.67, 6);
  });

  it('accepts i16 metres, which covers Earth and Mars', () => {
    expect(() => validateDescriptor(desc({ quantum: 1 }), none)).not.toThrow();
    // Mars: Olympus Mons +21.9 km, Hellas -8.2 km.
    expect(() =>
      validateDescriptor(desc({ quantum: 1, range: [-8_200, 21_900] }), none),
    ).not.toThrow();
  });

  it('requires a power-of-two quantum so decoding is exactly representable', () => {
    expect(() => validateDescriptor(desc({ quantum: 0.1 }), none)).toThrow(/power of two/);
    expect(() => validateDescriptor(desc({ quantum: 3 }), none)).toThrow(/power of two/);
    for (const q of [0.25, 0.5, 1, 2, 4, 1024]) {
      expect(() => validateDescriptor(desc({ quantum: q, range: [-8000, 8000] }), none)).not.toThrow();
    }
  });

  it('accepts temperature only with an offset, not as absolute kelvin', () => {
    const t = (over: Partial<FieldDescriptor>): FieldDescriptor =>
      desc({ id: fieldId('temperature'), units: 'K', range: [180, 340], ...over });
    // i16 centikelvin absolute covers 0..327 K — fails above that.
    expect(() => validateDescriptor(t({ quantum: 0.0078125, offset: 0 }), none)).toThrow();
    // With a 273.15 K offset it is comfortable.
    expect(() =>
      validateDescriptor(t({ quantum: 0.0078125, offset: 273.15 }), none),
    ).not.toThrow();
  });

  it('snapQuantum returns powers of two at or above its input', () => {
    for (const v of [0.003, 0.5, 1, 1.1, 600 / 65534]) {
      const q = snapQuantum(v);
      expect(q).toBeGreaterThanOrEqual(v);
      expect(Math.log2(q)).toBe(Math.floor(Math.log2(q)));
    }
    // The per-tile example from DEC-028: 600 m of relief in one L18 tile.
    // 600/65534 = 9.16 mm, so the next power of two up is 2^-6 = 15.6 mm.
    // Rounding UP is required: rounding down would not fit the range in i16.
    expect(snapQuantum(600 / 65534)).toBeCloseTo(0.015625, 12);
  });

  it('per-tile offset+quantum reconstructs exactly (DEC-028 amendment 2)', () => {
    const min = 1203.75;
    const max = 1803.75;
    const quantum = snapQuantum((max - min) / 65534);
    const offset = Math.round((min + max) / 2 / quantum) * quantum;
    for (let i = 0; i < 2000; i++) {
      const h = min + ((max - min) * i) / 1999;
      const stored = Math.round((h - offset) / quantum);
      expect(stored).toBeGreaterThanOrEqual(-32768);
      expect(stored).toBeLessThanOrEqual(32767);
      const back = offset + stored * quantum;
      expect(Math.abs(back - h)).toBeLessThanOrEqual(quantum / 2 + 1e-12);
      // Exactly representable: decoding twice is bit-identical.
      expect(offset + stored * quantum).toBe(back);
    }
  });
});

describe('FieldStore: temporal classes and aggregates (DEC-030)', () => {
  it('rejects an aggregate on a FINER grid', () => {
    const agg = desc({
      id: fieldId('precip.monthly'),
      grid: gridId('cubesphere', 12),
      temporalClass: 'aggregate',
    });
    const inst = desc({
      id: fieldId('precip.instant'),
      grid: gridId('geodesic', 6),
      temporalClass: 'fast',
      aggregate: fieldId('precip.monthly'),
    });
    expect(() => validateDescriptor(inst, (id) => (id === agg.id ? agg : undefined))).toThrow(
      /FINER grid/,
    );
  });

  it('ACCEPTS an aggregate on a coarser grid — the memory fix', () => {
    const agg = desc({
      id: fieldId('precip.monthly'),
      grid: gridId('geodesic', 6),
      temporalClass: 'aggregate',
    });
    const inst = desc({
      id: fieldId('precip.instant'),
      grid: gridId('cubesphere', 11),
      temporalClass: 'fast',
      aggregate: fieldId('precip.monthly'),
    });
    expect(() =>
      validateDescriptor(inst, (id) => (id === agg.id ? agg : undefined)),
    ).not.toThrow();
  });

  it('shows why: L11 monthly climatology vs geodesic n6', () => {
    const l11 = 6 * 4 ** 11;
    const n6 = 10 * 4 ** 6 + 2;
    const monthlyTP = (cells: number): number => 12 * 2 * cells * 2;
    expect(monthlyTP(l11) / 1e9).toBeGreaterThan(1.2); // 1.21 GB — over the 700 MB budget
    expect(monthlyTP(n6) / 1e6).toBeLessThan(3); // 1.97 MB
  });

  it('rejects slow state that claims an aggregate', () => {
    const agg = desc({ id: fieldId('x.agg'), temporalClass: 'aggregate' });
    const slow = desc({ temporalClass: 'slow', aggregate: fieldId('x.agg') });
    expect(() => validateDescriptor(slow, (id) => (id === agg.id ? agg : undefined))).toThrow(
      /slow state has no aggregate/,
    );
  });

  it('rejects persisting tier C data (DEC-018)', () => {
    expect(() => validateDescriptor(desc({ tier: 'C', persist: 'snapshot' }), none)).toThrow(
      /not authoritative/,
    );
  });
});

describe('FieldStore: storage, ownership and commit', () => {
  const build = (over: Partial<FieldDescriptor> = {}): FieldStore =>
    new FieldStore().declare(desc({ grid: gridId('cubesphere', 6), ...over })).seal();

  it('round-trips values through quantisation', () => {
    const s = build();
    const f = s.mut(fieldId('elevation'), OWNER);
    f.set(0, 1234);
    f.set(1, -987);
    f.set(2, 8849);
    f.commit();
    expect(f.get(0)).toBe(1234);
    expect(f.get(1)).toBe(-987);
    expect(f.get(2)).toBe(8849); // Everest, which i16 cm could not hold
  });

  it('enforces single-writer ownership (DEC-013)', () => {
    const s = build();
    expect(() => s.mut(fieldId('elevation'), subsystemId('hydrology'))).toThrow(
      /owned by 'terrain'/,
    );
    expect(() => s.view(fieldId('elevation'))).not.toThrow(); // anyone may read
  });

  it('commit is O(1): it publishes a generation, it does not copy', () => {
    const s = build({ doubleBuffered: true });
    const f = s.mut(fieldId('elevation'), OWNER);
    const g0 = f.generation;
    f.set(5, 100);
    f.commit();
    expect(f.generation).toBe(g0 + 1);
    expect(f.get(5)).toBe(100);
    // Writing the back buffer does not disturb the published front buffer.
    f.set(5, 200);
    expect(f.get(5)).toBe(100);
    f.commit();
    expect(f.get(5)).toBe(200);
  });

  it('tracks dirty blocks rather than cells', () => {
    const s = build();
    const f = s.mut(fieldId('elevation'), OWNER);
    expect(f.dirty.dirtyBlockCount).toBe(0);
    f.set(0, 1);
    f.set(10_000, 1);
    expect(f.dirty.dirtyBlockCount).toBe(2);
    const blocks: number[] = [];
    f.dirty.forEachDirtyBlock((b) => blocks.push(b));
    expect(blocks).toEqual([...blocks].sort((a, b) => a - b)); // ascending, deterministic
    f.dirty.clear();
    expect(f.dirty.dirtyBlockCount).toBe(0);
  });

  it('is a closed registry: no fields after seal, no unknown fields', () => {
    const s = build();
    expect(() => s.declare(desc({ id: fieldId('late') }))).toThrow(/sealed/);
    expect(() => s.view(fieldId('nope'))).toThrow(/unknown field/);
  });

  it('reports field ids in declaration order, never Map order', () => {
    const s = new FieldStore()
      .declare(desc({ id: fieldId('zebra'), grid: gridId('cubesphere', 6) }))
      .declare(desc({ id: fieldId('alpha'), grid: gridId('cubesphere', 6) }))
      .seal();
    expect(s.fieldIds()).toEqual(['zebra', 'alpha']);
  });

  it('computes a footprint that matches the documented L11 figure', () => {
    const s = new FieldStore().declare(desc({ grid: gridId('cubesphere', 11) })).seal();
    expect(s.totalBytes() / 1e6).toBeCloseTo(50.33, 1);
    expect(s.totalBytes() / 1024 / 1024).toBeCloseTo(48, 1);
  });

  it('works with shared memory disabled (DEC-020 fallback, R-05)', () => {
    const s = new FieldStore({ preferShared: false })
      .declare(desc({ grid: gridId('cubesphere', 6), doubleBuffered: true }))
      .seal();
    expect(s.usingSharedMemory).toBe(false);
    const f = s.mut(fieldId('elevation'), OWNER);
    f.set(3, 777);
    f.commit();
    expect(f.get(3)).toBe(777);
  });

  it('partial writes survive the next publish (dirty-block replicate, DEC-032)', () => {
    const s = build({ doubleBuffered: true });
    const f = s.mut(fieldId('elevation'), OWNER);
    f.set(0, 10);
    f.commit();
    expect(f.get(0)).toBe(10);
    f.set(1, 20);
    f.commit();
    // Without the dirty-block copy, the ping-pong republishes cell 0 as 0.
    expect(f.get(0)).toBe(10);
    expect(f.get(1)).toBe(20);
    f.set(2, 30);
    f.commit();
    expect(f.get(0)).toBe(10);
    expect(f.get(1)).toBe(20);
    expect(f.get(2)).toBe(30);
  });

  it('partial writes in different dirty blocks also survive', () => {
    const s = build({ doubleBuffered: true, grid: gridId('cubesphere', 8) });
    const f = s.mut(fieldId('elevation'), OWNER);
    f.set(0, 11);
    f.commit();
    f.set(4096, 22);
    f.commit();
    expect(f.get(0)).toBe(11);
    expect(f.get(4096)).toBe(22);
  });

  it('view() is a capability-safe read handle, not a TS-only Readonly', () => {
    const s = build({ doubleBuffered: true });
    const v = s.view(fieldId('elevation')) as unknown as Record<string, unknown>;
    expect(typeof v.set).not.toBe('function');
    expect(typeof v.rawMut).not.toBe('function');
    expect(typeof v.commit).not.toBe('function');
    expect(typeof v.get).toBe('function');
    const dirty = v.dirty as Record<string, unknown>;
    expect(typeof dirty.markCell).not.toBe('function');
    expect(typeof dirty.clear).not.toBe('function');
    expect(typeof dirty.markAll).not.toBe('function');
  });

  it('share() exposes worker handles without a writable view', () => {
    const s = build({ doubleBuffered: true });
    const h = s.share(fieldId('elevation'));
    expect(h.copies).toBe(2);
    expect(h.elems).toBeGreaterThan(0);
    expect(h.dtype).toBe('i16');
  });

  it('rejects out-of-range cells and components', () => {
    const s = build();
    const f = s.mut(fieldId('elevation'), OWNER);
    expect(() => f.set(-1, 1)).toThrow(/out of range/);
    expect(() => f.set(f.cellCount, 1)).toThrow(/out of range/);
    expect(() => f.get(-1)).toThrow(/out of range/);
    expect(() => f.set(0, 1, 1)).toThrow(/component/);
    expect(() => f.get(0, 4)).toThrow(/component/);
  });

  it('mut() always throws on ownership, not only in DEV (DEC-013)', () => {
    const s = build();
    expect(() => s.mut(fieldId('elevation'), subsystemId('hydrology'))).toThrow(
      /owned by 'terrain'/,
    );
  });

  it('write barrier rejects undeclared writes during a step (DEC-016)', () => {
    const s = new FieldStore()
      .declare(desc({ id: fieldId('elevation'), grid: gridId('cubesphere', 6) }))
      .declare(desc({ id: fieldId('secret'), grid: gridId('cubesphere', 6) }))
      .seal();
    const sneak = s.mut(fieldId('secret'), OWNER);
    s.beginStep(OWNER, [fieldId('elevation')]);
    const elev = s.mut(fieldId('elevation'), OWNER);
    elev.set(0, 5);
    elev.commit();
    expect(() => sneak.set(0, 99)).toThrow(/write barrier|undeclared write/);
    expect(() => s.mut(fieldId('secret'), OWNER)).toThrow(/write barrier|undeclared write/);
    s.endStep();
    // Outside a step the captured handle is writable again (genesis / tests).
    sneak.set(0, 7);
    sneak.commit();
    expect(sneak.get(0)).toBe(7);
  });
});
