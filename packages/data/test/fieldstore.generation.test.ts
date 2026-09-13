import { describe, expect, it } from 'vitest';
import {
  DIRTY_BLOCK_CELLS,
  FieldStore,
  createChangeCursor,
  fieldId,
  gridId,
  subsystemId,
  type FieldDescriptor,
} from '@ws/data';

const OWNER = subsystemId('terrain');
const ELEV = fieldId('elevation');

function desc(over: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    id: ELEV,
    grid: gridId('cubesphere', 6),
    dtype: 'i16',
    components: 1,
    quantum: 1,
    offset: 0,
    units: 'm',
    range: [-11_000, 9_000],
    owner: OWNER,
    tier: 'A',
    temporalClass: 'slow',
    doubleBuffered: true,
    persist: 'snapshot',
    ...over,
  };
}

const build = (): FieldStore => new FieldStore({ preferShared: false }).declare(desc()).seal();

function pokeGeneration(store: FieldStore, bits: number): void {
  const h = store.share(ELEV);
  const ctrl = new Int32Array(h.control as ArrayBuffer);
  ctrl[0] = bits | 0;
}

/**
 * GENERATION SIGN / WRAP (T-0079).
 *
 * Publication lives in an Int32Array control word; stamps live in a Uint32Array.
 * At 0x80000000 the signed load becomes negative while stamps stay unsigned, so
 * `stamp > cursor` is true for every block — including never-written ones.
 * That is 2^31 commits (~1.13 years at 60 Hz), half the 2^32 figure that was
 * documented. Values do not corrupt; change tracking does.
 *
 * Fix: every public generation is uint32 (`>>> 0`). Wrap at 2^32 throws rather
 * than silently aliasing stamp 0 ("never"). Infinite uptime is not required.
 */
describe('generation is uint32 through the Int32 sign bit', () => {
  it('0x7ffffffe → 0x80000000 keeps ping-pong, cursors and parity coherent', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    pokeGeneration(store, 0x7ffffffe);
    expect(store.view(ELEV).generation).toBe(0x7ffffffe);
    expect(store.view(ELEV).generation & 1).toBe(0);

    const cursor = createChangeCursor();
    cursor.generation = store.view(ELEV).generation;

    f.set(0, 10);
    f.commit();
    expect(store.view(ELEV).generation).toBe(0x7fffffff);
    expect(store.view(ELEV).generation & 1).toBe(1);
    expect(store.view(ELEV).get(0)).toBe(10);

    const seenA: number[] = [];
    store.view(ELEV).changedBlocksSince(cursor, (b) => seenA.push(b));
    expect(seenA).toEqual([0]);

    f.set(DIRTY_BLOCK_CELLS, 20);
    f.commit();
    // Sign bit of the Int32 control word is now set. Public generation must
    // stay unsigned, or the next scan reports every block.
    expect(store.view(ELEV).generation).toBe(0x80000000);
    expect(store.view(ELEV).generation & 1).toBe(0);
    expect(store.view(ELEV).get(0)).toBe(10);
    expect(store.view(ELEV).get(DIRTY_BLOCK_CELLS)).toBe(20);

    const seenB: number[] = [];
    store.view(ELEV).changedBlocksSince(cursor, (b) => seenB.push(b));
    expect(seenB).toEqual([1]);
    expect(cursor.generation).toBe(0x80000000);

    f.set(0, 30);
    f.commit();
    expect(store.view(ELEV).generation).toBe(0x80000001);
    expect(store.view(ELEV).get(0)).toBe(30);
    expect(store.view(ELEV).get(DIRTY_BLOCK_CELLS)).toBe(20);

    const seenC: number[] = [];
    store.view(ELEV).changedBlocksSince(cursor, (b) => seenC.push(b));
    expect(seenC).toEqual([0]);
    expect(seenC.length).toBe(1);
  });

  it('consistentRead generation is unsigned at the sign flip', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    pokeGeneration(store, 0x7fffffff);
    f.set(3, 5);
    f.commit();
    const r = f.consistentRead((raw, gen) => ({ v: raw[3] as number, gen }));
    expect(r.torn).toBe(false);
    expect(r.generation).toBe(0x80000000);
    expect(r.value?.gen).toBe(0x80000000);
    expect(r.value?.v).toBe(5);
  });

  it('wrap at 2^32 throws rather than aliasing stamp 0', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    pokeGeneration(store, -1); // 0xffffffff
    expect(store.view(ELEV).generation).toBe(0xffffffff);
    expect(() => {
      f.set(0, 1);
      f.commit();
    }).toThrow(/wrapped at 2\^32/);
    expect(store.view(ELEV).generation).toBe(0xffffffff);
  });
});

/**
 * changedBlocksSince vs commit (T-0082).
 *
 * The ten-step interleaving (publish N, scan, stamps still N-1, cursor←N,
 * then stamp N) cannot run against the same `Field` object from two threads:
 * `Field` is not transferred, and `blockGeneration` is not in `FieldHandles`.
 * DEC-020 phase separation is the concurrency rule.
 *
 * What CAN run on one thread is a commit inside the scan callback. Stamp
 * then publish, plus `since < stamp <= now`, means that generation is not
 * consumed with a cursor that then skips it.
 */
describe('changedBlocksSince vs commit', () => {
  it('share() handles do not include change-tracking metadata', () => {
    const store = build();
    const h = store.share(ELEV);
    expect(Object.keys(h).sort()).toEqual(['control', 'copies', 'data', 'dtype', 'elems', 'shared']);
    expect(
      (h as unknown as { blockGeneration?: unknown }).blockGeneration,
    ).toBeUndefined();
  });

  it('after commit() returns, dirty-block stamps equal the published generation', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    const v = store.view(ELEV);
    f.set(0, 1);
    f.set(DIRTY_BLOCK_CELLS, 2);
    f.commit();
    expect(v.blockChangedAt(0)).toBe(v.generation);
    expect(v.blockChangedAt(1)).toBe(v.generation);
    expect(v.blockChangedAt(2)).toBe(0);
  });

  it('a commit inside the scan callback is not lost on the next scan', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    const v = store.view(ELEV);
    f.set(0, 1);
    f.commit();

    const cursor = createChangeCursor();
    const first: number[] = [];
    v.changedBlocksSince(cursor, (b) => {
      first.push(b);
      f.set(DIRTY_BLOCK_CELLS, 2);
      f.commit();
    });
    // Snapshotted `now` means the reentrant generation is not visited here.
    expect(first).toEqual([0]);

    const second: number[] = [];
    v.changedBlocksSince(cursor, (b) => second.push(b));
    expect(second).toEqual([1]);
    expect(v.get(0)).toBe(1);
    expect(v.get(DIRTY_BLOCK_CELLS)).toBe(2);
  });
});

describe('copyRange snapshots one generation', () => {
  it('matches get() for the published generation, raw and decoded', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    for (let i = 0; i < 8; i++) f.set(i, (i + 1) * 10);
    f.commit();
    const v = store.view(ELEV);
    const raw = new Int16Array(8);
    expect(v.copyRange(0, 8, raw)).toBe(8);
    const decoded = new Float64Array(8);
    expect(v.copyRange(0, 8, decoded, true)).toBe(8);
    for (let i = 0; i < 8; i++) {
      expect(raw[i]).toBe(v.get(i));
      expect(decoded[i]).toBe(v.get(i));
    }
  });

  it('sees the new generation after commit, not a mix of front and back', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    f.set(0, 1);
    f.set(1, 2);
    f.commit();
    f.set(0, 3);
    f.commit();
    const out = new Int16Array(2);
    store.view(ELEV).copyRange(0, 2, out);
    expect(Array.from(out)).toEqual([3, 2]);
  });
});
