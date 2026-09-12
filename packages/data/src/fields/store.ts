/**
 * FieldStore (T-0011, DEC-012, DEC-020, DEC-028, DEC-030, DEC-032).
 *
 * Structure-of-arrays storage for dense rasters, backed by SharedArrayBuffer
 * where available and ordinary ArrayBuffer otherwise.
 *
 * THREE DESIGN RULES, each closing an audit finding:
 *
 * 1. COMMIT IS A PUBLISH, NOT A MEMCPY (DEC-032 rule 4, AUDIT-V0 M4).
 *    A double-buffered L11 field is 50 MB. Copying it would need ~25 GB/s to fit
 *    the 2.0 ms simCommit budget, which JS does not deliver. So a commit flips a
 *    generation index; readers resolve front/back from that index. Nothing of
 *    the WHOLE field moves.
 *
 *    Partial writes still have to land on BOTH buffers, otherwise the next flip
 *    republishes stale cells (write cell 0, commit, write cell 1, commit, cell 0
 *    reads as 0). After the index flip we replicate only the dirty-this-gen
 *    blocks from the new front into the new back — O(dirty), not O(field).
 *
 * 2. THE GENERATION INDEX IS PUBLISHED ATOMICALLY (AUDIT-V0 M4).
 *    Under SAB, a non-atomic store of the index can be observed out of order
 *    with respect to the writes it publishes. `Atomics.store`/`Atomics.load`
 *    give the release/acquire pair. This is the one place `Atomics` touches
 *    field data, and it touches the INDEX, not the data — DEC-020's "no locks on
 *    field data" is intact.
 *
 *    Every read path loads the generation ONCE and uses that snapshot to pick
 *    the front buffer. Two separate loads can observe N then N+1 and mix a
 *    generation with a buffer from another — that pairing is the actual race.
 *
 *    Ping-pong indexing is `gen & 1`, not `gen % 2`. JS `%` of a negative Int32
 *    wrap is negative; `& 1` stays a valid buffer index.
 *
 * 3. QUANTISATION IS EXACT (DEC-028).
 *    quantum is a power of two and offset a multiple of it, so
 *    `offset + stored * quantum` is exactly representable and decodes
 *    bit-identically everywhere. Enforced in `validateDescriptor`.
 *
 * PHASE SEPARATION (DEC-020) is what makes double-buffering safe under SAB:
 * a reader may not hold a `raw()` view across a `commit()` of a writer that
 * will then overwrite that buffer. `consistentRead` detects a torn generation
 * so a concurrent worker can retry. Holding the TypedArray itself across a
 * commit is still a data race — don't.
 *
 * CAPABILITY, NOT A TS QUALIFIER. `view()` returns a handle that does not have
 * `rawMut` / `set` / `commit` / writable dirty at runtime. `Readonly<Field>`
 * is a compile-time fiction and does not survive a cast.
 *
 * 4. READ-ONLY IS A CAPABILITY SHAPE, NOT MEMORY PROTECTION (T-0070).
 *    Said plainly, because the alternative is a promise we cannot keep:
 *    **JavaScript has no way to hand out a zero-copy, non-writable view of a
 *    TypedArray.** `Readonly<TypedArray>` is erased at compile time,
 *    `Object.freeze` does not constrain indexed elements of a TypedArray, and a
 *    Proxy costs 10-100x per element, which destroys the very hot path the raw
 *    access exists for. Anyone holding the array, or the ArrayBuffer behind it,
 *    can write to authoritative state.
 *
 *    So the boundary is drawn by NAMING rather than by enforcement. `view()`
 *    returns a genuinely safe surface — `get`, `copyRange`, `changedBlocksSince`
 *    — with no live memory in it at all. Everything that hands out live memory
 *    lives behind one door, `FieldStore.unsafeRawAccess(id, reason)`, which
 *    takes a mandatory reason string so that every such call is visible in a
 *    diff and greppable in review. `share()` is the same idea for workers.
 *
 *    This does not defend against malicious code and is not trying to. It makes
 *    it hard for render/UI to corrupt authoritative state BY ACCIDENT, which is
 *    the actual threat (DEC-011, DEC-013). The descriptor object handed out by
 *    `view()` / `descriptor()` is a frozen copy of the metadata (T-0080):
 *    TypeScript `readonly` does not stop `view(id).descriptor.owner = …` from
 *    rewriting ownership, decode, or persistence.
 *
 * 5. TWO DIRTY LIFETIMES, TWO MECHANISMS (T-0071).
 *    A single mask cannot be both "what commit must replicate" (scoped to one
 *    generation, must be cleared) and "what a consumer still has to upload"
 *    (must survive until seen, and there may be several consumers). Holding
 *    both in one mask made the replication set grow monotonically: N
 *    generations touching one block each replicated N(N+1)/2 blocks, turning an
 *    O(dirty) publish into an O(field) memcpy — exactly what DEC-032 rule 4
 *    forbids. See `replicationDirty` and `blockGeneration` below.
 */

import { invariant, requireFinite } from '@ws/core';
import { grid } from '../grids/index.js';
import {
  DTYPE_BYTES,
  DTYPE_RANGE,
  freezeDescriptor,
  isFloatDtype,
  validateDescriptor,
  type Dtype,
  type FieldDescriptor,
  type FieldId,
  type SubsystemId,
} from './descriptor.js';


export type TypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Float32Array
  | Float64Array;

function makeArray(dtype: Dtype, buffer: ArrayBufferLike, byteOffset: number, length: number): TypedArray {
  switch (dtype) {
    case 'i8': return new Int8Array(buffer, byteOffset, length);
    case 'u8': return new Uint8Array(buffer, byteOffset, length);
    case 'i16': return new Int16Array(buffer, byteOffset, length);
    case 'u16': return new Uint16Array(buffer, byteOffset, length);
    case 'i32': return new Int32Array(buffer, byteOffset, length);
    case 'f32': return new Float32Array(buffer, byteOffset, length);
    case 'f64': return new Float64Array(buffer, byteOffset, length);
  }
}

function isShared(buf: ArrayBufferLike): boolean {
  return typeof SharedArrayBuffer === 'function' && buf instanceof SharedArrayBuffer;
}

/** Is SharedArrayBuffer usable here? Requires COOP/COEP in a browser (DEC-020). */
export function sharedMemoryAvailable(): boolean {
  return typeof SharedArrayBuffer === 'function';
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Dirty tracking at block granularity.
 *
 * Per-cell dirty bits would cost as much as the data. Blocks of 4096 cells give
 * a 25.2 M-cell L11 field a 6144-entry bitmap (768 bytes) — small enough to scan
 * every frame, fine enough that a renderer re-uploads kilobytes instead of
 * megabytes.
 */
export const DIRTY_BLOCK_CELLS = 4096;

/** Query half of a dirty mask. No mutators. Writer-side introspection only. */
export interface DirtyQuery {
  readonly blockCount: number;
  readonly dirtyBlockCount: number;
  isBlockDirty(block: number): boolean;
  forEachDirtyBlock(fn: (block: number, startCell: number, endCell: number) => void): void;
}

/**
 * A consumer's position in a field's change history.
 *
 * Each consumer keeps its own cursor, so there is no global `clear()` to get
 * wrong and no way for one consumer to swallow another's changes. Start at 0 to
 * mean "I have seen nothing"; `changedBlocksSince` hands back the generation to
 * store for next time.
 */
export interface ChangeCursor {
  generation: number;
}

export function createChangeCursor(): ChangeCursor {
  return { generation: 0 };
}

export class DirtyMask implements DirtyQuery {
  private readonly words: Uint32Array;
  readonly blockCount: number;

  constructor(cellCount: number) {
    this.blockCount = Math.ceil(cellCount / DIRTY_BLOCK_CELLS);
    this.words = new Uint32Array(Math.ceil(this.blockCount / 32));
  }

  markCell(index: number): void {
    const b = (index / DIRTY_BLOCK_CELLS) | 0;
    this.words[(b / 32) | 0] = ((this.words[(b / 32) | 0] as number) | (1 << b % 32)) >>> 0;
  }

  markRange(start: number, endExclusive: number): void {
    const b0 = (start / DIRTY_BLOCK_CELLS) | 0;
    const b1 = ((endExclusive - 1) / DIRTY_BLOCK_CELLS) | 0;
    for (let b = b0; b <= b1; b++) {
      this.words[(b / 32) | 0] = ((this.words[(b / 32) | 0] as number) | (1 << b % 32)) >>> 0;
    }
  }

  markAll(): void {
    this.words.fill(0xffffffff);
  }

  clear(): void {
    this.words.fill(0);
  }

  isBlockDirty(block: number): boolean {
    return (((this.words[(block / 32) | 0] as number) >>> block % 32) & 1) === 1;
  }

  get dirtyBlockCount(): number {
    let n = 0;
    for (let b = 0; b < this.blockCount; b++) if (this.isBlockDirty(b)) n++;
    return n;
  }

  /** Dirty blocks in ascending index order — deterministic by construction. */
  forEachDirtyBlock(fn: (block: number, startCell: number, endCell: number) => void): void {
    for (let b = 0; b < this.blockCount; b++) {
      if (this.isBlockDirty(b)) fn(b, b * DIRTY_BLOCK_CELLS, (b + 1) * DIRTY_BLOCK_CELLS);
    }
  }
}

class DirtyQueryView implements DirtyQuery {
  constructor(private readonly inner: DirtyMask) {}
  get blockCount(): number {
    return this.inner.blockCount;
  }
  get dirtyBlockCount(): number {
    return this.inner.dirtyBlockCount;
  }
  isBlockDirty(block: number): boolean {
    return this.inner.isBlockDirty(block);
  }
  forEachDirtyBlock(fn: (block: number, startCell: number, endCell: number) => void): void {
    this.inner.forEachDirtyBlock(fn);
  }
}

/** SAB handles a worker needs. Small, transferable as a structured object of SABs.
 *  Change-tracking (`blockGeneration`) is NOT included: it is main-thread
 *  metadata. Workers publish by writing `data` and the `control` generation;
 *  they do not call `changedBlocksSince` / `commit` on a `Field` they cannot
 *  hold. DEC-020 phase separation is the concurrency rule, not a lock. */
export interface FieldHandles {
  readonly data: ArrayBufferLike;
  readonly control: ArrayBufferLike;
  readonly copies: number;
  readonly elems: number;
  readonly dtype: Dtype;
  readonly shared: boolean;
}

export interface ConsistentRead<T> {
  readonly value: T;
  readonly generation: number;
  /** True if the generation changed during the callback — retry. */
  readonly torn: boolean;
}

/** Read-only view of one field. This is what `render` and the UI ever see. */
export interface ReadonlyFieldView {
  readonly descriptor: FieldDescriptor;
  readonly cellCount: number;
  readonly generation: number;
  /** Decoded physical value: `offset + stored * quantum`. */
  get(cell: number, component?: number): number;
  /**
   * Copy a half-open cell range into a caller-provided array, decoded or raw.
   *
   * Safe bulk path. One dirty block is 4096 cells (8 KB for i16). Snapshots one
   * generation: if the published generation moves during the copy (a worker
   * release-stored a new index), the copy retries. Same-thread `commit` cannot
   * run during this call — the Field API is single-threaded (DEC-020). Does
   * not protect a data-plane race on the buffer itself; that is undefined.
   * Returns the number of elements written.
   */
  copyRange(startCell: number, endCell: number, out: TypedArray, decoded?: boolean): number;
  /**
   * Visit the blocks changed since `cursor.generation` and advance the cursor.
   *
   * Generation-scoped and per-consumer, so several consumers can track the same
   * field independently, nothing is lost, and nothing has to be cleared.
   */
  changedBlocksSince(
    cursor: ChangeCursor,
    fn: (block: number, startCell: number, endCell: number) => void,
  ): number;
  /** Generation at which `block` last changed. 0 means never. */
  blockChangedAt(block: number): number;
  readonly blockCount: number;
}

/**
 * Live memory. Everything here can corrupt authoritative state; the type name
 * and `unsafeRawAccess(id, reason)` are the whole enforcement (see note 4).
 */
export interface UnsafeFieldAccess {
  readonly descriptor: FieldDescriptor;
  readonly generation: number;
  /** The live front buffer. Writable in fact, whatever the type says. */
  raw(): TypedArray;
  /** Worker-shareable backing stores. */
  handles(): FieldHandles;
  /**
   * Seqlock-style read: load generation, run `fn` on that front, load again.
   * `torn` means a commit landed mid-read and the caller should retry.
   */
  consistentRead<T>(fn: (raw: TypedArray, generation: number) => T): ConsistentRead<T>;
}

export interface FieldView extends ReadonlyFieldView {
  /** Writable back buffer for the owning subsystem. */
  rawMut(): TypedArray;
  set(cell: number, value: number, component?: number): void;
  /**
   * Mark cells the owner wrote through `rawMut`. `set` marks for you.
   *
   * These replaced a directly exposed `DirtyMask`. Handing the writer a mask
   * with `clear()` on it was a live hazard: clearing between a write and a
   * commit skips replication and republishes a stale sibling cell.
   */
  markDirty(cell: number): void;
  markDirtyRange(startCell: number, endCellExclusive: number): void;
  markAllDirty(): void;
  /** Blocks that the next `commit` will replicate. Introspection, not control. */
  readonly pendingReplication: DirtyQuery;
  /** Publish the back buffer. O(1) index flip, then O(dirty-this-gen) replicate. */
  commit(): void;
  raw(): TypedArray;
  handles(): FieldHandles;
  consistentRead<T>(fn: (raw: TypedArray, generation: number) => T): ConsistentRead<T>;
}

class Field implements FieldView, UnsafeFieldAccess {
  readonly descriptor: FieldDescriptor;
  readonly cellCount: number;
  /**
   * WRITER REPLICATION SET (lifetime A). Blocks written since the last commit.
   * Cleared by `commit` once replicated. Never escapes the writer.
   */
  private readonly replicationDirty: DirtyMask;
  readonly pendingReplication: DirtyQuery;
  /**
   * CONSUMER CHANGE RECORD (lifetime B). `blockGeneration[b]` is the generation
   * at which block b was last published as changed; 0 means never.
   *
   * A stamp rather than a mask, because a mask forces a single global `clear()`
   * and there is more than one consumer. Each consumer holds a cursor and asks
   * for blocks stamped after it, so nothing is lost and nothing is cleared.
   * Cost is 4 bytes per block — 24 KB for a 50 MB L11 field.
   */
  private readonly blockGeneration: Uint32Array;
  readonly blockCount: number;

  private readonly buffers: readonly TypedArray[];
  private readonly dataBacking: ArrayBufferLike;
  /** [generation] — atomically published so readers see a consistent pair. */
  private readonly control: Int32Array;
  private readonly clampLo: number;
  private readonly clampHi: number;
  private readonly store: FieldStore;

  constructor(d: FieldDescriptor, useShared: boolean, store: FieldStore) {
    this.descriptor = d;
    this.cellCount = grid(d.grid).cellCount;
    this.replicationDirty = new DirtyMask(this.cellCount);
    this.pendingReplication = new DirtyQueryView(this.replicationDirty);
    this.blockCount = this.replicationDirty.blockCount;
    this.blockGeneration = new Uint32Array(this.blockCount);
    this.store = store;

    const elems = this.cellCount * d.components;
    const bytes = elems * DTYPE_BYTES[d.dtype];
    const copies = d.doubleBuffered ? 2 : 1;

    const Buf = useShared && sharedMemoryAvailable() ? SharedArrayBuffer : ArrayBuffer;
    const backing = new Buf(bytes * copies);
    this.dataBacking = backing;
    const arrs: TypedArray[] = [];
    for (let i = 0; i < copies; i++) arrs.push(makeArray(d.dtype, backing, i * bytes, elems));
    this.buffers = arrs;

    const CtrlBuf = useShared && sharedMemoryAvailable() ? SharedArrayBuffer : ArrayBuffer;
    this.control = new Int32Array(new CtrlBuf(4));

    const [lo, hi] = DTYPE_RANGE[d.dtype];
    this.clampLo = lo;
    this.clampHi = hi;
  }

  private loadGeneration(): number {
    const v = isShared(this.control.buffer)
      ? Atomics.load(this.control, 0)
      : (this.control[0] as number);
    // Int32Array / Atomics.load return signed bits. Generation, stamps and
    // cursors are uint32. Mixing them silently inverts `stamp > cursor` at
    // 2^31 (~1.13 years at 60 commits/s), half the wrap T-0079 documented.
    return v >>> 0;
  }

  /** Acquire load of the published generation (rule 2). */
  get generation(): number {
    return this.loadGeneration();
  }

  /**
   * Ping-pong: `gen & 1` stays a valid index after Int32 wrap. `gen % 2` of a
   * negative generation is negative in JS and would index `undefined`.
   */
  private frontAt(gen: number): TypedArray {
    return this.buffers.length === 1
      ? (this.buffers[0] as TypedArray)
      : (this.buffers[gen & 1] as TypedArray);
  }

  private backAt(gen: number): TypedArray {
    return this.buffers.length === 1
      ? (this.buffers[0] as TypedArray)
      : (this.buffers[(gen + 1) & 1] as TypedArray);
  }

  private checkCell(cell: number, component: number): void {
    if (cell < 0 || cell >= this.cellCount || (cell | 0) !== cell) {
      fail(`${String(this.descriptor.id)} cell ${String(cell)} out of range [0, ${String(this.cellCount)})`);
    }
    const n = this.descriptor.components;
    if (component < 0 || component >= n || (component | 0) !== component) {
      fail(
        `${String(this.descriptor.id)} component ${String(component)} out of range [0, ${String(n)})`,
      );
    }
  }

  raw(): TypedArray {
    return this.frontAt(this.loadGeneration());
  }

  rawMut(): TypedArray {
    this.store.assertWritable(this.descriptor.id);
    return this.backAt(this.loadGeneration());
  }

  get(cell: number, component = 0): number {
    this.checkCell(cell, component);
    const d = this.descriptor;
    const gen = this.loadGeneration();
    const stored = this.frontAt(gen)[cell * d.components + component] as number;
    return isFloatDtype(d.dtype) ? stored : d.offset + stored * d.quantum;
  }

  set(cell: number, value: number, component = 0): void {
    this.store.assertWritable(this.descriptor.id);
    this.checkCell(cell, component);
    const d = this.descriptor;
    requireFinite(value, `${d.id}[${String(cell)}]`);
    const i = cell * d.components + component;
    const back = this.backAt(this.loadGeneration());
    if (isFloatDtype(d.dtype)) {
      back[i] = value;
    } else {
      const q = Math.round((value - d.offset) / d.quantum);
      back[i] = Math.min(this.clampHi, Math.max(this.clampLo, q));
    }
    this.replicationDirty.markCell(cell);
  }

  markDirty(cell: number): void {
    this.store.assertWritable(this.descriptor.id);
    this.checkCell(cell, 0);
    this.replicationDirty.markCell(cell);
  }

  markDirtyRange(startCell: number, endCellExclusive: number): void {
    this.store.assertWritable(this.descriptor.id);
    if (endCellExclusive <= startCell) return;
    this.checkCell(startCell, 0);
    this.checkCell(Math.min(endCellExclusive, this.cellCount) - 1, 0);
    this.replicationDirty.markRange(startCell, Math.min(endCellExclusive, this.cellCount));
  }

  markAllDirty(): void {
    this.store.assertWritable(this.descriptor.id);
    this.replicationDirty.markAll();
  }

  copyRange(startCell: number, endCell: number, out: TypedArray, decoded = false): number {
    const d = this.descriptor;
    const lo = Math.max(0, startCell);
    const hi = Math.min(this.cellCount, endCell);
    if (hi <= lo) return 0;
    const comps = d.components;
    const n = (hi - lo) * comps;
    if (out.length < n) {
      fail(`${String(d.id)}: copyRange needs ${String(n)} elements, got ${String(out.length)}`);
    }
    const decode = decoded && !isFloatDtype(d.dtype);
    const retries = 3;
    for (let attempt = 0; attempt < retries; attempt++) {
      const g0 = this.loadGeneration();
      const src = this.frontAt(g0);
      if (!decode) {
        out.set(src.subarray(lo * comps, hi * comps) as unknown as ArrayLike<number>, 0);
      } else {
        const base = lo * comps;
        const q = d.quantum;
        const off = d.offset;
        for (let i = 0; i < n; i++) {
          out[i] = off + (src[base + i] as number) * q;
        }
      }
      if (this.loadGeneration() === g0) return n;
    }
    fail(
      `${String(d.id)}: copyRange saw a concurrent generation change after ${String(retries)} retries`,
    );
  }

  changedBlocksSince(
    cursor: ChangeCursor,
    fn: (block: number, startCell: number, endCell: number) => void,
  ): number {
    // `stamp <= now` is what makes stamp-before-publish safe, and what stops a
    // reentrant commit inside `fn` from being consumed with a cursor that then
    // skips it. Generation and stamps are uint32; `>>> 0` on the cursor so a
    // leftover signed value from an old Int32 load cannot invert the compare.
    const since = cursor.generation >>> 0;
    const now = this.loadGeneration();
    for (let b = 0; b < this.blockCount; b++) {
      const stamp = this.blockGeneration[b] as number;
      if (stamp > since && stamp <= now) {
        fn(b, b * DIRTY_BLOCK_CELLS, Math.min((b + 1) * DIRTY_BLOCK_CELLS, this.cellCount));
      }
    }
    cursor.generation = now;
    return now;
  }

  blockChangedAt(block: number): number {
    return (this.blockGeneration[block] as number) ?? 0;
  }

  /**
   * Publish (rule 1 + rule 2).
   *
   * Order, which is load-bearing (T-0082):
   *   1. Stamp dirty blocks with the *next* generation. Metadata only —
   *      `blockGeneration` is not on the SAB.
   *   2. Release-store the generation index. A reader that observes `next`
   *      then observes stamps for this generation (`stamp <= now`).
   *   3. Replicate this generation's dirty blocks from the new front into
   *      the new back. O(dirty), not O(field). This writes the unpublished
   *      buffer. Doing it *before* the flip would mutate the live front, and
   *      a `consistentRead` finishing between replicate and publish would
   *      return `torn: false` on corrupted data (T-0073).
   *   4. Clear the writer replication set. Consumer cursors do not use it.
   */
  commit(): void {
    this.store.assertWritable(this.descriptor.id);
    const prev = this.loadGeneration();
    invariant(
      prev !== 0xffffffff,
      `${String(this.descriptor.id)}: generation wrapped at 2^32 ` +
        `(~2.3 years at 60 commits/s). Restart the world.`,
    );
    const next = (prev + 1) >>> 0;
    const stampGen = next;
    const comps = this.descriptor.components;
    const twoBuffers = this.buffers.length === 2;

    this.replicationDirty.forEachDirtyBlock((b) => {
      this.blockGeneration[b] = stampGen;
    });

    if (isShared(this.control.buffer)) Atomics.store(this.control, 0, next | 0);
    else this.control[0] = next | 0;

    const front = this.frontAt(next);
    const back = this.backAt(next);
    this.replicationDirty.forEachDirtyBlock((_b, startCell, endCell) => {
      if (twoBuffers) {
        const i0 = startCell * comps;
        const i1 = Math.min(endCell, this.cellCount) * comps;
        if (i1 > i0) back.set(front.subarray(i0, i1), i0);
      }
    });
    this.replicationDirty.clear();
  }

  handles(): FieldHandles {
    return {
      data: this.dataBacking,
      control: this.control.buffer,
      copies: this.buffers.length,
      elems: this.cellCount * this.descriptor.components,
      dtype: this.descriptor.dtype,
      shared: isShared(this.dataBacking),
    };
  }

  consistentRead<T>(fn: (raw: Readonly<TypedArray>, generation: number) => T): ConsistentRead<T> {
    const g0 = this.loadGeneration();
    const value = fn(this.frontAt(g0), g0);
    const g1 = this.loadGeneration();
    return { value, generation: g0, torn: g0 !== g1 };
  }
}

/**
 * Runtime read handle (T-0070).
 *
 * Deliberately a different object from `Field`, and deliberately WITHOUT
 * `raw()`, `handles()` or `consistentRead()`: those hand out live memory, and
 * `Readonly<TypedArray>` does not survive into JavaScript. A cast to
 * `FieldView` cannot write through this because the methods are simply absent.
 *
 * A consumer that genuinely needs live memory asks for it by name through
 * `FieldStore.unsafeRawAccess(id, reason)`, which is greppable in review.
 */
class SafeReadView implements ReadonlyFieldView {
  constructor(private readonly field: Field) {}
  get descriptor(): FieldDescriptor {
    return this.field.descriptor;
  }
  get cellCount(): number {
    return this.field.cellCount;
  }
  get generation(): number {
    return this.field.generation;
  }
  get blockCount(): number {
    return this.field.blockCount;
  }
  get(cell: number, component = 0): number {
    return this.field.get(cell, component);
  }
  copyRange(startCell: number, endCell: number, out: TypedArray, decoded = false): number {
    return this.field.copyRange(startCell, endCell, out, decoded);
  }
  changedBlocksSince(
    cursor: ChangeCursor,
    fn: (block: number, startCell: number, endCell: number) => void,
  ): number {
    return this.field.changedBlocksSince(cursor, fn);
  }
  blockChangedAt(block: number): number {
    return this.field.blockChangedAt(block);
  }
}

export interface FieldStoreOptions {
  /** Default true. Set false to exercise the non-SAB path (DEC-020, R-05). */
  readonly preferShared?: boolean;
}

/**
 * The store. A closed registry: declare fields, then use them. There is no
 * `createFieldAtRuntime`, deliberately — that is the road to an arbitrary
 * container, and it would also defeat the scheduler's startup validation.
 */
export class FieldStore {
  private readonly descriptors = new Map<FieldId, FieldDescriptor>();
  private readonly fields = new Map<FieldId, Field>();
  private readonly views = new Map<FieldId, SafeReadView>();
  private readonly order: FieldId[] = [];
  private sealed = false;
  readonly usingSharedMemory: boolean;

  /**
   * DEC-016 write barrier. `null` means "no step in flight" (tests, genesis).
   * During a subsystem step this is the declared `writes[]` of the author.
   */
  private stepWrites: Set<FieldId> | null = null;
  private stepAuthor: SubsystemId | null = null;

  constructor(opts: FieldStoreOptions = {}) {
    this.usingSharedMemory = (opts.preferShared ?? true) && sharedMemoryAvailable();
  }

  declare(d: FieldDescriptor): this {
    invariant(!this.sealed, `FieldStore is sealed; cannot declare '${d.id}'`);
    invariant(!this.descriptors.has(d.id), `duplicate field id '${d.id}'`);
    this.descriptors.set(d.id, freezeDescriptor(d));
    this.order.push(d.id);
    return this;
  }

  /** Validate every descriptor, allocate, and close the registry. */
  seal(): this {
    invariant(!this.sealed, 'FieldStore already sealed');
    const lookup = (id: FieldId): FieldDescriptor | undefined => this.descriptors.get(id);
    // Ascending declaration order — a plain array, so validation order is stable.
    for (const id of this.order) {
      validateDescriptor(this.descriptors.get(id) as FieldDescriptor, lookup);
    }
    for (const id of this.order) {
      const f = new Field(this.descriptors.get(id) as FieldDescriptor, this.usingSharedMemory, this);
      this.fields.set(id, f);
      this.views.set(id, new SafeReadView(f));
    }
    this.sealed = true;
    return this;
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  /** Field ids in declaration order. Never Map iteration order at a call site. */
  fieldIds(): readonly FieldId[] {
    return this.order;
  }

  descriptor(id: FieldId): FieldDescriptor {
    const d = this.descriptors.get(id);
    invariant(d !== undefined, `unknown field '${String(id)}'`);
    return d as FieldDescriptor;
  }

  /**
   * DEC-016 write barrier. The scheduler calls this around `subsystem.step`.
   * While a step is in flight, `set` / `rawMut` / `commit` on any field not in
   * `writes` throws — including through a `FieldView` obtained earlier.
   */
  beginStep(author: SubsystemId, writes: readonly FieldId[]): void {
    if (this.stepWrites !== null) {
      fail(`nested beginStep: '${String(this.stepAuthor)}' is already in flight`);
    }
    this.stepAuthor = author;
    this.stepWrites = new Set(writes);
  }

  endStep(): void {
    this.stepWrites = null;
    this.stepAuthor = null;
  }

  /** Always throws, including in production. DEV-stripped assert is not a lock. */
  assertWritable(id: FieldId): void {
    if (this.stepWrites === null) return;
    if (!this.stepWrites.has(id)) {
      fail(
        `undeclared write to '${String(id)}' during step of '${String(this.stepAuthor)}' ` +
          `(DEC-016 write barrier; field is not in writes[])`,
      );
    }
  }

  /**
   * Mutable access, gated on ownership (DEC-013). This is the single-writer rule
   * with teeth: asking for a field you do not own throws, here, at the call site,
   * in production as well as in DEV. A stripped `assert` is not a lock.
   */
  mut(id: FieldId, by: SubsystemId): FieldView {
    const f = this.require(id);
    if (f.descriptor.owner !== by) {
      fail(
        `'${String(by)}' may not write '${String(id)}': it is owned by ` +
          `'${String(f.descriptor.owner)}' (DEC-013 single-writer)`,
      );
    }
    if (this.stepWrites !== null && this.stepAuthor !== by) {
      fail(
        `'${String(by)}' is not the in-flight author '${String(this.stepAuthor)}' (DEC-016 write barrier)`,
      );
    }
    this.assertWritable(id);
    return f;
  }

  /**
   * Read-only access. Anyone may read anything.
   *
   * Safe at runtime in the only sense JavaScript allows: the handle contains no
   * live memory, so there is nothing to write through. See note 4 in the module
   * header for why that is the honest limit of the guarantee.
   */
  view(id: FieldId): ReadonlyFieldView {
    this.require(id);
    return this.views.get(id) as SafeReadView;
  }

  /**
   * Live memory, for callers that genuinely need zero-copy access — a GPU
   * upload, a worker kernel, a whole-field scan.
   *
   * THIS CAN CORRUPT AUTHORITATIVE STATE. Writing through the returned array
   * bypasses ownership, the write barrier, the generation counter and dirty
   * tracking, so a later commit will silently publish or overwrite it.
   *
   * `reason` is mandatory and unused at runtime. It exists so that every
   * escape from the safe surface is self-documenting in a diff and greppable in
   * review — which is the whole enforcement mechanism (note 4).
   */
  unsafeRawAccess(id: FieldId, reason: string): UnsafeFieldAccess {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      fail(`unsafeRawAccess('${String(id)}') requires a non-empty reason`);
    }
    return this.require(id);
  }

  /** Worker-shareable handles without handing out a writable view. */
  share(id: FieldId): FieldHandles {
    return this.require(id).handles();
  }

  private require(id: FieldId): Field {
    invariant(this.sealed, `FieldStore is not sealed; call seal() before use`);
    const f = this.fields.get(id);
    invariant(f !== undefined, `unknown field '${String(id)}'`);
    return f as Field;
  }

  /** Total resident bytes. Compared against budgets.MEMORY_BYTES.simState. */
  totalBytes(): number {
    let n = 0;
    for (const id of this.order) {
      const d = this.descriptors.get(id) as FieldDescriptor;
      n += grid(d.grid).cellCount * d.components * DTYPE_BYTES[d.dtype] * (d.doubleBuffered ? 2 : 1);
    }
    return n;
  }
}
