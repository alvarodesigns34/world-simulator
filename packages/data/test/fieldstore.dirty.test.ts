import { describe, expect, it } from 'vitest';
import {
  DIRTY_BLOCK_CELLS,
  createChangeCursor,
  FieldStore,
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
    grid: gridId('cubesphere', 8), // 393 216 cells => 96 dirty blocks
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

const build = (): FieldStore =>
  new FieldStore({ preferShared: false }).declare(desc()).seal();

/**
 * DIRTY MASK LIFETIME (T-0071).
 *
 * One `DirtyMask` is doing two incompatible jobs:
 *
 *   A. WRITER REPLICATION SET — which blocks `commit` must copy from the new
 *      front into the new back so the next partial write does not republish a
 *      stale sibling. Must be scoped to THIS generation.
 *   B. CONSUMER INVALIDATION SET — which blocks a renderer still has to upload.
 *      Must survive until that consumer has seen them.
 *
 * Because B forbids clearing, A never gets cleared either, so the replication
 * set grows monotonically. Each generation touches one block; commit N copies
 * N blocks. At L11 (6150 blocks, 50 MB) that degrades an O(dirty) publish into
 * an O(whole field) memcpy — exactly what DEC-032 rule 4 forbids.
 */
describe('dirty mask: replication set must not grow monotonically', () => {
  it('replicates only the blocks written in THIS generation', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);

    const replicatedPerCommit: number[] = [];
    for (let gen = 0; gen < 8; gen++) {
      f.set(gen * DIRTY_BLOCK_CELLS, 100 + gen); // one distinct block each time
      // The set that `commit` iterates to replicate IS the dirty mask.
      replicatedPerCommit.push(f.pendingReplication.dirtyBlockCount);
      f.commit();
    }

    // Each generation dirtied exactly one block, so each commit should replicate
    // exactly one. Monotonic growth is the defect.
    expect(replicatedPerCommit).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('ping-pong correctness survives the narrower replication set', () => {
    // The bug Grok fixed must stay fixed: partial writes across generations
    // must not republish stale siblings.
    const store = build();
    const f = store.mut(ELEV, OWNER);
    f.set(0, 10);
    f.commit();
    f.set(1, 20);
    f.commit();
    expect(store.view(ELEV).get(0)).toBe(10);
    expect(store.view(ELEV).get(1)).toBe(20);

    // And across many generations with interleaved blocks.
    for (let i = 2; i < 40; i++) {
      f.set(i * DIRTY_BLOCK_CELLS, i);
      f.commit();
    }
    const v = store.view(ELEV);
    expect(v.get(0)).toBe(10);
    expect(v.get(1)).toBe(20);
    for (let i = 2; i < 40; i++) expect(v.get(i * DIRTY_BLOCK_CELLS)).toBe(i);
  });

  it('total blocks replicated over N generations is O(N), not O(N²)', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    let total = 0;
    const N = 40;
    for (let gen = 0; gen < N; gen++) {
      f.set((gen % 90) * DIRTY_BLOCK_CELLS, gen);
      total += f.pendingReplication.dirtyBlockCount;
      f.commit();
    }
    // O(N) is N. O(N²) is N(N+1)/2 = 820 for N = 40.
    expect(total).toBe(N);
  });
});

/**
 * The consumer half of the split (lifetime B). Generation-stamped, so several
 * consumers track the same field independently with no global clear and no
 * lost changes — the property a single shared mask could not provide.
 */
describe('consumer change tracking is per-consumer and generation-scoped', () => {
  it('two consumers advance independently and neither loses a change', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    const v = store.view(ELEV);

    const renderer = createChangeCursor();
    const analytics = createChangeCursor();

    f.set(0 * DIRTY_BLOCK_CELLS, 1);
    f.commit();
    f.set(1 * DIRTY_BLOCK_CELLS, 2);
    f.commit();

    // The renderer catches up and sees both blocks.
    const seenByRenderer: number[] = [];
    v.changedBlocksSince(renderer, (b) => seenByRenderer.push(b));
    expect(seenByRenderer).toEqual([0, 1]);

    // A third change arrives.
    f.set(2 * DIRTY_BLOCK_CELLS, 3);
    f.commit();

    // The renderer sees only what is new to IT...
    const rendererAgain: number[] = [];
    v.changedBlocksSince(renderer, (b) => rendererAgain.push(b));
    expect(rendererAgain).toEqual([2]);

    // ...while analytics, which never looked, still sees all three.
    const seenByAnalytics: number[] = [];
    v.changedBlocksSince(analytics, (b) => seenByAnalytics.push(b));
    expect(seenByAnalytics).toEqual([0, 1, 2]);
  });

  it('a caught-up consumer sees nothing until the next commit', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    const v = store.view(ELEV);
    const cursor = createChangeCursor();

    f.set(0, 5);
    f.commit();
    let n = 0;
    v.changedBlocksSince(cursor, () => n++);
    expect(n).toBe(1);

    n = 0;
    v.changedBlocksSince(cursor, () => n++);
    expect(n).toBe(0);
  });

  it('re-writing the same block re-notifies a caught-up consumer', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    const v = store.view(ELEV);
    const cursor = createChangeCursor();

    f.set(0, 1);
    f.commit();
    v.changedBlocksSince(cursor, () => undefined);

    f.set(0, 2);
    f.commit();
    const blocks: number[] = [];
    v.changedBlocksSince(cursor, (b) => blocks.push(b));
    expect(blocks).toEqual([0]);
  });

  it('block stamps record the generation, not just a flag', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    const v = store.view(ELEV);
    f.set(0, 1);
    f.commit();
    const g1 = v.blockChangedAt(0);
    f.set(DIRTY_BLOCK_CELLS, 2);
    f.commit();
    expect(v.blockChangedAt(0)).toBe(g1); // untouched block keeps its stamp
    expect(v.blockChangedAt(1)).toBeGreaterThan(g1);
    expect(v.blockChangedAt(2)).toBe(0); // never written
  });
});

/** The safe bulk path, so nobody needs `unsafeRawAccess` for an upload. */
describe('copyRange is the safe bulk read', () => {
  it('copies raw stored values and decoded values', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    for (let i = 0; i < 8; i++) f.set(i, i * 10);
    f.commit();

    const v = store.view(ELEV);
    const raw = new Int16Array(8);
    expect(v.copyRange(0, 8, raw)).toBe(8);
    expect(Array.from(raw)).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);

    const decoded = new Float64Array(8);
    v.copyRange(0, 8, decoded, true);
    expect(Array.from(decoded)).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
  });

  it('refuses an undersized destination rather than truncating silently', () => {
    const store = build();
    const v = store.view(ELEV);
    expect(() => v.copyRange(0, 100, new Int16Array(10))).toThrow(/needs 100 elements/);
  });

  it('clamps the range to the field instead of reading past it', () => {
    const store = build();
    const v = store.view(ELEV);
    const out = new Int16Array(16);
    expect(v.copyRange(-5, 4, out)).toBe(4);
    expect(v.copyRange(v.cellCount - 2, v.cellCount + 100, out)).toBe(2);
  });
});
