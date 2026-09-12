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
 */

import { assert, assertFinite } from '@ws/core';
import { grid } from '../grids/index.js';
import {
  DTYPE_BYTES,
  DTYPE_RANGE,
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

/** Query half of a dirty mask. No mutators — this is what a read view exposes. */
export interface DirtyQuery {
  readonly blockCount: number;
  readonly dirtyBlockCount: number;
  isBlockDirty(block: number): boolean;
  forEachDirtyBlock(fn: (block: number, startCell: number, endCell: number) => void): void;
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

/** SAB handles a worker needs. Small, transferable as a structured object of SABs. */
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
  /** Raw stored integers/floats of the current front buffer. */
  raw(): Readonly<TypedArray>;
  /** Decoded physical value: `offset + stored * quantum`. */
  get(cell: number, component?: number): number;
  readonly dirty: DirtyQuery;
  /** Worker-shareable backing stores. Prefer `FieldStore.share(id)`. */
  handles(): FieldHandles;
  /**
   * Seqlock-style read: load generation, run `fn` on that front, load again.
   * `torn` means a publisher committed during `fn`. Safe retry if `fn` is pure.
   */
  consistentRead<T>(fn: (raw: Readonly<TypedArray>, generation: number) => T): ConsistentRead<T>;
}

export interface FieldView extends ReadonlyFieldView {
  readonly dirty: DirtyMask;
  /** Writable back buffer for the owning subsystem. */
  rawMut(): TypedArray;
  set(cell: number, value: number, component?: number): void;
  /** Publish the back buffer. O(1) index flip, then O(dirty) replicate. */
  commit(): void;
}

class Field implements FieldView {
  readonly descriptor: FieldDescriptor;
  readonly cellCount: number;
  readonly dirty: DirtyMask;
  readonly dirtyQuery: DirtyQuery;

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
    this.dirty = new DirtyMask(this.cellCount);
    this.dirtyQuery = new DirtyQueryView(this.dirty);
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
    return isShared(this.control.buffer)
      ? Atomics.load(this.control, 0)
      : (this.control[0] as number);
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

  raw(): Readonly<TypedArray> {
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
    assertFinite(value, `${d.id}[${String(cell)}]`);
    const i = cell * d.components + component;
    const back = this.backAt(this.loadGeneration());
    if (isFloatDtype(d.dtype)) {
      back[i] = value;
    } else {
      const q = Math.round((value - d.offset) / d.quantum);
      back[i] = Math.min(this.clampHi, Math.max(this.clampLo, q));
    }
    this.dirty.markCell(cell);
  }

  /**
   * Publish (rule 1 + rule 2). Release store of the generation index; the whole
   * field does not move. Dirty blocks of THIS generation are then replicated
   * from the new front into the new back so the next partial write cannot
   * republish a stale sibling cell. The dirty mask itself is left for the
   * consumer (renderer upload); we do not clear it here.
   */
  commit(): void {
    this.store.assertWritable(this.descriptor.id);
    const next = this.loadGeneration() + 1;
    if (isShared(this.control.buffer)) Atomics.store(this.control, 0, next);
    else this.control[0] = next;

    if (this.buffers.length === 2) {
      const front = this.frontAt(next);
      const back = this.backAt(next);
      const comps = this.descriptor.components;
      this.dirty.forEachDirtyBlock((_b, startCell, endCell) => {
        const i0 = startCell * comps;
        const i1 = Math.min(endCell, this.cellCount) * comps;
        if (i1 > i0) back.set(front.subarray(i0, i1), i0);
      });
    }
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
 * Runtime read handle. Deliberately a different object from `Field`: it has no
 * `set` / `rawMut` / `commit`, and its dirty mask has no mutators. A cast to
 * `FieldView` still cannot write through it because the methods are absent.
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
  get dirty(): DirtyQuery {
    return this.field.dirtyQuery;
  }
  raw(): Readonly<TypedArray> {
    return this.field.raw();
  }
  get(cell: number, component = 0): number {
    return this.field.get(cell, component);
  }
  handles(): FieldHandles {
    return this.field.handles();
  }
  consistentRead<T>(fn: (raw: Readonly<TypedArray>, generation: number) => T): ConsistentRead<T> {
    return this.field.consistentRead(fn);
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
    assert(!this.sealed, `FieldStore is sealed; cannot declare '${d.id}'`);
    assert(!this.descriptors.has(d.id), `duplicate field id '${d.id}'`);
    this.descriptors.set(d.id, d);
    this.order.push(d.id);
    return this;
  }

  /** Validate every descriptor, allocate, and close the registry. */
  seal(): this {
    assert(!this.sealed, 'FieldStore already sealed');
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
    assert(d !== undefined, `unknown field '${String(id)}'`);
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

  /** Read-only access. Anyone may read anything. Capability-safe at runtime. */
  view(id: FieldId): ReadonlyFieldView {
    this.require(id);
    return this.views.get(id) as SafeReadView;
  }

  /** Worker-shareable handles without handing out a writable view. */
  share(id: FieldId): FieldHandles {
    return this.require(id).handles();
  }

  private require(id: FieldId): Field {
    assert(this.sealed, `FieldStore is not sealed; call seal() before use`);
    const f = this.fields.get(id);
    assert(f !== undefined, `unknown field '${String(id)}'`);
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
