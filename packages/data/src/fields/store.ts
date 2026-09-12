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
 *    generation index; readers resolve front/back from that index. Nothing moves.
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

/**
 * Dirty tracking at block granularity.
 *
 * Per-cell dirty bits would cost as much as the data. Blocks of 4096 cells give
 * a 25.2 M-cell L11 field a 6144-entry bitmap (768 bytes) — small enough to scan
 * every frame, fine enough that a renderer re-uploads kilobytes instead of
 * megabytes.
 */
export const DIRTY_BLOCK_CELLS = 4096;

export class DirtyMask {
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
  readonly dirty: DirtyMask;
  /** Worker-shareable backing stores. */
  handles(): FieldHandles;
  /**
   * Seqlock-style read: load generation, run `fn` on that front, load again.
   * `torn` means a publisher committed during `fn`. Safe retry if `fn` is pure.
   */
  consistentRead<T>(fn: (raw: Readonly<TypedArray>, generation: number) => T): ConsistentRead<T>;
}

export interface FieldView extends ReadonlyFieldView {
  /** Writable back buffer for the owning subsystem. */
  rawMut(): TypedArray;
  set(cell: number, value: number, component?: number): void;
  /** Publish the back buffer. O(1): flips the generation index (rule 1). */
  commit(): void;
}

class Field implements FieldView {
  readonly descriptor: FieldDescriptor;
  readonly cellCount: number;
  readonly dirty: DirtyMask;

  private readonly buffers: readonly TypedArray[];
  private readonly dataBacking: ArrayBufferLike;
  /** [generation] — atomically published so readers see a consistent pair. */
  private readonly control: Int32Array;
  private readonly clampLo: number;
  private readonly clampHi: number;

  constructor(d: FieldDescriptor, useShared: boolean) {
    this.descriptor = d;
    this.cellCount = grid(d.grid).cellCount;
    this.dirty = new DirtyMask(this.cellCount);

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

  private frontAt(gen: number): TypedArray {
    return this.buffers[gen % this.buffers.length] as TypedArray;
  }

  private backAt(gen: number): TypedArray {
    return this.buffers.length === 1
      ? (this.buffers[0] as TypedArray)
      : (this.buffers[(gen + 1) % 2] as TypedArray);
  }

  raw(): Readonly<TypedArray> {
    return this.frontAt(this.loadGeneration());
  }

  rawMut(): TypedArray {
    return this.backAt(this.loadGeneration());
  }

  get(cell: number, component = 0): number {
    const d = this.descriptor;
    const gen = this.loadGeneration();
    const stored = this.frontAt(gen)[cell * d.components + component] as number;
    return isFloatDtype(d.dtype) ? stored : d.offset + stored * d.quantum;
  }

  set(cell: number, value: number, component = 0): void {
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
   * Publish (rule 1 + rule 2). Release store of the generation index; no data
   * moves. A single-buffered field still bumps its generation so consumers can
   * detect change.
   */
  commit(): void {
    const next = this.loadGeneration() + 1;
    if (isShared(this.control.buffer)) Atomics.store(this.control, 0, next);
    else this.control[0] = next;
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
  private readonly order: FieldId[] = [];
  private sealed = false;
  readonly usingSharedMemory: boolean;

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
      this.fields.set(id, new Field(this.descriptors.get(id) as FieldDescriptor, this.usingSharedMemory));
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
   * Mutable access, gated on ownership (DEC-013). This is the single-writer rule
   * with teeth: asking for a field you do not own throws, here, at the call site.
   */
  mut(id: FieldId, by: SubsystemId): FieldView {
    const f = this.require(id);
    assert(
      f.descriptor.owner === by,
      `'${String(by)}' may not write '${String(id)}': it is owned by ` +
        `'${String(f.descriptor.owner)}' (DEC-013 single-writer)`,
    );
    return f;
  }

  /** Read-only access. Anyone may read anything. */
  view(id: FieldId): ReadonlyFieldView {
    return this.require(id);
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
