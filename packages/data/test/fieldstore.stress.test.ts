import { describe, expect, it } from 'vitest';
import {
  DIRTY_BLOCK_CELLS,
  FieldStore,
  fieldId,
  gridId,
  snapQuantum,
  subsystemId,
  type FieldDescriptor,
} from '@ws/data';

const OWNER = subsystemId('terrain');

function desc(id: string, over: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    id: fieldId(id),
    grid: gridId('cubesphere', 8),
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

describe('FieldStore stress: many fields, lookup, publication, churn', () => {
  it('seals dozens of mixed-class fields and round-trips them', () => {
    const store = new FieldStore();
    const n = 24;
    for (let i = 0; i < n; i++) {
      const cls = i % 3 === 0 ? 'slow' : i % 3 === 1 ? 'fast' : 'aggregate';
      const extra: Partial<FieldDescriptor> =
        cls === 'fast' ? { temporalClass: 'fast', doubleBuffered: true, aggregate: fieldId(`f${i + 1}`) }
        : cls === 'aggregate' ? { temporalClass: 'aggregate', grid: gridId('geodesic', 4) }
        : { temporalClass: 'slow' };
      store.declare(desc(`f${i}`, extra));
    }
    store.seal();
    expect(store.fieldIds()).toHaveLength(n);
    const f = store.mut(fieldId('f0'), OWNER);
    f.set(0, -42);
    f.commit();
    expect(f.get(0)).toBe(-42);
    expect(store.totalBytes()).toBeGreaterThan(0);
  });

  it('lookup of 16 fields is stable and does not depend on declaration-hash order', () => {
    const ids = ['zeta', 'alpha', 'mu', 'beta', 'lambda', 'gamma', 'tau', 'omega'];
    const store = new FieldStore();
    for (const id of ids) store.declare(desc(id, { grid: gridId('cubesphere', 6) }));
    store.seal();
    expect([...store.fieldIds()]).toEqual(ids);
  });

  it('dirty-block granularity is 4096 and scanning is in index order', () => {
    expect(DIRTY_BLOCK_CELLS).toBe(4096);
    const s = new FieldStore().declare(desc('e', { grid: gridId('cubesphere', 10) })).seal();
    const f = s.mut(fieldId('e'), OWNER);
    f.set(0, 1);
    f.set(4096, 1);
    f.set(4097, 1);
    f.set(20_000, 1);
    const blocks: number[] = [];
    f.dirty.forEachDirtyBlock((b) => blocks.push(b));
    expect(blocks).toEqual([0, 1, 4]);
  });

  it('per-tile offset+quantum still reconstructs after many publications', () => {
    const q = snapQuantum(600 / 65534);
    const off = 1500;
    const s = new FieldStore()
      .declare(desc('tile', { grid: gridId('cubesphere', 6), quantum: q, offset: off, range: [off - 400, off + 400] }))
      .seal();
    const f = s.mut(fieldId('tile'), OWNER);
    const values = [off - 300, off, off + 250.5];
    for (let gen = 0; gen < 50; gen++) {
      for (let i = 0; i < values.length; i++) f.set(i, values[i] as number);
      f.commit();
    }
    for (let i = 0; i < values.length; i++) {
      expect(Math.abs(f.get(i) - (values[i] as number))).toBeLessThanOrEqual(q / 2 + 1e-9);
    }
  });

  it('memory of an L11 i16 field stays at the documented 50.3 MB', () => {
    const s = new FieldStore()
      .declare(desc('elevation', { grid: gridId('cubesphere', 11) }))
      .seal();
    expect(s.totalBytes() / 1e6).toBeCloseTo(50.33, 1);
  });
});
