/**
 * DEC-012's entity half. The properties tested here are the ones that make it
 * usable as simulation state rather than as a container: stable identity across
 * slot reuse, deterministic iteration, single-writer enforcement, and a digest
 * that folds the live set rather than raw memory.
 */

import { describe, expect, it } from 'vitest';
import {
  EntityStore,
  MAX_ENTITY_INDEX,
  NO_ENTITY,
  componentId,
  entityGeneration,
  entityIndex,
  subsystemId,
} from '@ws/data';

const OWNER = subsystemId('test.owner');
const OTHER = subsystemId('test.other');
const HP = componentId('hp');
const POS = componentId('pos');

function store(capacity = 16) {
  return new EntityStore({
    name: 'test',
    capacity,
    components: [
      { id: HP, dtype: 'f64', components: 1, owner: OWNER },
      { id: POS, dtype: 'i32', components: 2, owner: OWNER },
    ],
  });
}

describe('EntityStore (DEC-012)', () => {
  it('gives every entity a distinct index and a stable id', () => {
    const s = store();
    const a = s.create();
    const b = s.create();
    expect(entityIndex(a)).toBe(0);
    expect(entityIndex(b)).toBe(1);
    expect(s.alive(a)).toBe(true);
    expect(s.count).toBe(2);
    expect(s.idAt(0)).toBe(a);
  });

  it('invalidates a stale id after the slot is reused', () => {
    /* The failure this prevents: a settlement collapses, a new one is founded
       in the same row, and code still holding the old handle silently starts
       reading the new settlement's population. */
    const s = store();
    const a = s.create();
    expect(s.destroy(a)).toBe(true);
    expect(s.alive(a)).toBe(false);
    const b = s.create();
    expect(entityIndex(b)).toBe(entityIndex(a));
    expect(entityGeneration(b)).toBe(entityGeneration(a) + 1);
    expect(s.alive(a)).toBe(false);
    expect(s.alive(b)).toBe(true);
    expect(s.destroy(a)).toBe(false);
  });

  it('zeroes a reused row so no state is inherited', () => {
    const s = store();
    const a = s.create();
    const hp = s.columnMut(HP, OWNER);
    const pos = s.columnMut(POS, OWNER);
    hp[entityIndex(a)] = 1234;
    pos[entityIndex(a) * 2] = 7;
    pos[entityIndex(a) * 2 + 1] = 9;
    s.destroy(a);
    const b = s.create();
    expect(hp[entityIndex(b)]).toBe(0);
    expect(pos[entityIndex(b) * 2]).toBe(0);
    expect(pos[entityIndex(b) * 2 + 1]).toBe(0);
  });

  it('iterates live entities in ascending index order, always', () => {
    const s = store();
    const ids = [s.create(), s.create(), s.create(), s.create(), s.create()];
    /* Destroy out of order, then refill: LIFO reuse means indices come back in
       a specific order, and iteration must still be ascending regardless. */
    s.destroy(ids[1] as never);
    s.destroy(ids[3] as never);
    s.create();
    s.create();
    const out = new Int32Array(s.count);
    const n = s.liveIndices(out);
    expect(n).toBe(5);
    for (let i = 1; i < n; i++) expect(out[i] as number).toBeGreaterThan(out[i - 1] as number);
  });

  it('reuses slots as a pure function of the create/destroy sequence', () => {
    const play = (): number[] => {
      const s = store();
      const seen: number[] = [];
      const live = [s.create(), s.create(), s.create()];
      s.destroy(live[0] as never);
      s.destroy(live[2] as never);
      seen.push(entityIndex(s.create()), entityIndex(s.create()), entityIndex(s.create()));
      return seen;
    };
    expect(play()).toEqual(play());
  });

  it('enforces the single writer (DEC-013)', () => {
    const s = store();
    s.create();
    expect(() => s.columnMut(HP, OTHER)).toThrow(/DEC-013/);
    expect(() => s.column(HP)).not.toThrow();
  });

  it('refuses an undeclared component rather than inventing one', () => {
    const s = store();
    expect(() => s.column(componentId('nope'))).toThrow(/not declared/);
  });

  it('refuses to grow past its declared capacity', () => {
    const s = store(2);
    s.create();
    s.create();
    /* Growing would reallocate the columns and invalidate every reference a
       worker is holding, which is worse than failing loudly. */
    expect(() => s.create()).toThrow(/capacity/);
  });

  it('rejects a capacity the id packing cannot address exactly', () => {
    expect(() => new EntityStore({
      name: 'huge', capacity: MAX_ENTITY_INDEX + 1,
      components: [{ id: HP, dtype: 'f64', components: 1, owner: OWNER }],
    })).toThrow(/address exactly/);
  });

  it('digests the live set, not leftover memory in dead slots', () => {
    const a = store();
    const b = store();
    for (const s of [a, b]) {
      const e = s.create();
      s.columnMut(HP, OWNER)[entityIndex(e)] = 42;
    }
    expect(a.digest()).toBe(b.digest());

    /* `a` churns through a slot and lands back in the same live state. The
       dead row's bytes differ from `b`'s, and the digest must not care. */
    const ghost = a.create();
    a.columnMut(HP, OWNER)[entityIndex(ghost)] = 99999;
    a.destroy(ghost);
    expect(a.count).toBe(b.count);
    expect(a.digest()).toBe(b.digest());

    /* But a live difference must show. */
    a.columnMut(HP, OWNER)[0] = 43;
    expect(a.digest()).not.toBe(b.digest());
  });

  it('has no entity id equal to NO_ENTITY', () => {
    const s = store();
    expect(s.idAt(0)).toBe(NO_ENTITY);
    expect(s.alive(NO_ENTITY)).toBe(false);
    const a = s.create();
    expect(a).not.toBe(NO_ENTITY);
  });
});
