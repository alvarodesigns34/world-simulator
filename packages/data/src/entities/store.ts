/**
 * `EntityStore` (DEC-012) — SoA tables of components keyed by a stable id.
 *
 * DEC-012 split world state in two: FIELDS are dense values on a grid, ENTITIES
 * are discrete, sparse and have lifetimes. It deferred the entity half to M8,
 * "when discrete entities become numerous", with an explicit review gate:
 * re-evaluate against a real ECS with a benchmark if counts and archetype
 * variety explode. `tools/bench/entitystore.mjs` is that benchmark.
 *
 * WHY NOT OBJECTS. 10^4 settlements each holding population, food, technology
 * and territory is fine as objects. 10^6 of anything is not: per-entity objects
 * defeat the cache, make worker transfer a deep clone, and make serialisation a
 * graph walk. The columns here are typed arrays, so all three are trivial.
 *
 * WHY NOT A THIRD-PARTY ECS. DEC-012's reasoning, unchanged: we need exact
 * control of iteration order (DEC-017), memory layout (DEC-020 zero-copy) and
 * archetype churn. Adopting a library means auditing it for all three and then
 * depending on it forever, for a subset we can write in a few hundred lines.
 *
 * DETERMINISM (DEC-017). Two rules, both load-bearing:
 *
 *   1. Iteration is ALWAYS by ascending index. There is no archetype
 *      reordering, no swap-remove, no "iterate the live set" that could depend
 *      on a hash order.
 *   2. Slot reuse is a LIFO free list, so entity identity is a pure function of
 *      the create/destroy SEQUENCE — which the scheduler fixes (DEC-016). It is
 *      NOT a function of wall time, worker count or memory addresses.
 *
 * OWNERSHIP (DEC-013). A column names its owning subsystem. `columnMut` checks
 * it. `column` returns the same memory typed as read-only — which, exactly as
 * DEC-013's amendment records for FieldStore, is a capability SHAPE enforced by
 * the compiler, not memory protection. It is documented as such rather than
 * promised as something it is not.
 */

import { invariant } from '@ws/core';
import { DTYPE_BYTES, isFloatDtype, type Dtype, type SubsystemId } from '../fields/descriptor.js';

export type EntityId = number & { readonly __brand: 'EntityId' };
export type ComponentId = string & { readonly __brand: 'ComponentId' };

export function componentId(s: string): ComponentId {
  return s as ComponentId;
}

export type EntityColumn =
  | Int8Array | Uint8Array | Int16Array | Uint16Array
  | Int32Array | Uint32Array | Float32Array | Float64Array;

/**
 * A column the holder may read but not write.
 *
 * This is the same honest contract FieldStore settled on: TypeScript cannot
 * make a typed array's elements immutable, so this type removes the write
 * capability from the API SHAPE and nothing more. Handing it to code that
 * casts it back is not prevented; handing it to code that simply reads is
 * checked at compile time, which is where the mistakes actually happen.
 */
export interface ReadonlyColumn {
  readonly length: number;
  readonly [index: number]: number;
}

/**
 * Entity ids pack an index and a generation into one f64-exact number:
 *
 *   id = index * 2^32 + generation
 *
 * A plain number rather than `{index, generation}` because ids are stored in
 * columns, compared in inner loops and passed by the million; an object per id
 * reintroduces exactly the allocation pressure SoA exists to avoid.
 *
 * f64 represents integers exactly to 2^53, so with a 32-bit generation the
 * index is capped at 2^21 = 2,097,152 entities per store. That is checked, not
 * assumed. Generation counts destroys of a slot and wraps at 2^32, which at one
 * destroy per slot per simulated year is ~4 billion years.
 */
const GEN_SPAN = 0x100000000;
export const MAX_ENTITY_INDEX = 1 << 21;

export function entityIndex(id: EntityId): number {
  return Math.floor((id as number) / GEN_SPAN);
}

export function entityGeneration(id: EntityId): number {
  return (id as number) - Math.floor((id as number) / GEN_SPAN) * GEN_SPAN;
}

function makeId(index: number, generation: number): EntityId {
  return (index * GEN_SPAN + generation) as EntityId;
}

/** The id no entity ever has. Distinct from index 0 generation 0. */
export const NO_ENTITY = -1 as EntityId;

export interface ComponentDescriptor {
  readonly id: ComponentId;
  readonly dtype: Dtype;
  /** 1 = scalar, 2/3 = vector; components are interleaved per row. */
  readonly components: number;
  /** Single-writer owner (DEC-013). */
  readonly owner: SubsystemId;
}

export interface EntitySchema {
  readonly name: string;
  readonly capacity: number;
  readonly components: readonly ComponentDescriptor[];
  /**
   * Allocate columns in a SharedArrayBuffer so workers can read them without a
   * copy (DEC-020). Falls back silently to ArrayBuffer where SAB is
   * unavailable — the store is correct either way, only zero-copy is lost.
   */
  readonly shared?: boolean;
}

export interface EntityStoreSnapshot {
  readonly schema: 1;
  readonly capacity: number;
  readonly highWater: number;
  readonly liveCount: number;
  readonly freeCount: number;
  readonly structuralVersion: number;
  readonly generations: readonly number[];
  readonly alive: readonly number[];
  readonly freeList: readonly number[];
  readonly columns: Readonly<Record<string, readonly number[]>>;
}

function makeColumn(dtype: Dtype, buffer: ArrayBufferLike, byteOffset: number, length: number): EntityColumn {
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

interface Table {
  readonly desc: ComponentDescriptor;
  readonly data: EntityColumn;
}

export class EntityStore {
  readonly name: string;
  readonly capacity: number;

  private readonly tables = new Map<ComponentId, Table>();
  private readonly generations: Uint32Array;
  private readonly aliveFlags: Uint8Array;
  /** LIFO stack of free indices, and its depth. */
  private readonly freeList: Int32Array;
  private freeCount = 0;
  /** One past the highest index ever allocated. Iteration bound. */
  private highWater = 0;
  private liveCount = 0;
  /** Increments on every create and destroy; lets observers detect churn. */
  private structuralVersion = 0;

  constructor(schema: EntitySchema) {
    invariant(schema.capacity > 0, `EntityStore ${schema.name}: capacity must be positive`);
    invariant(
      schema.capacity <= MAX_ENTITY_INDEX,
      `EntityStore ${schema.name}: capacity ${String(schema.capacity)} exceeds the ` +
        `${String(MAX_ENTITY_INDEX)} the f64 id packing can address exactly`,
    );
    this.name = schema.name;
    this.capacity = schema.capacity;
    this.generations = new Uint32Array(schema.capacity);
    this.aliveFlags = new Uint8Array(schema.capacity);
    this.freeList = new Int32Array(schema.capacity);

    let bytes = 0;
    for (const c of schema.components) {
      invariant(c.components >= 1 && c.components <= 4, `component ${c.id}: 1..4 components`);
      invariant(!this.tables.has(c.id), `component ${c.id} declared twice`);
      bytes += DTYPE_BYTES[c.dtype] * c.components * schema.capacity;
      /* Placeholder so the duplicate check above sees it; replaced below. */
      this.tables.set(c.id, { desc: c, data: new Uint8Array(0) });
    }

    const shared = schema.shared === true && typeof SharedArrayBuffer !== 'undefined';
    const buffer: ArrayBufferLike = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
    let offset = 0;
    for (const c of schema.components) {
      const length = c.components * schema.capacity;
      this.tables.set(c.id, { desc: c, data: makeColumn(c.dtype, buffer, offset, length) });
      offset += DTYPE_BYTES[c.dtype] * length;
    }
  }

  /* ---- lifetime ---- */

  get count(): number { return this.liveCount; }
  /** Iterate `0 .. bound` and test `aliveAt`. Never iterate to `capacity`. */
  get bound(): number { return this.highWater; }
  get version(): number { return this.structuralVersion; }

  create(): EntityId {
    let index: number;
    if (this.freeCount > 0) {
      this.freeCount--;
      index = this.freeList[this.freeCount] as number;
    } else {
      invariant(
        this.highWater < this.capacity,
        `EntityStore ${this.name}: capacity ${String(this.capacity)} exhausted. ` +
          `Capacity is declared, not grown: a store that silently reallocates ` +
          `invalidates every column reference a worker is holding.`,
      );
      index = this.highWater;
      this.highWater++;
    }
    this.aliveFlags[index] = 1;
    this.liveCount++;
    this.structuralVersion++;
    /* Zero every column so a reused slot never inherits the dead entity's
       values — a stale population or territory would otherwise resurrect. */
    for (const t of this.tables.values()) {
      const w = t.desc.components;
      const base = index * w;
      for (let k = 0; k < w; k++) t.data[base + k] = 0;
    }
    return makeId(index, this.generations[index] as number);
  }

  destroy(id: EntityId): boolean {
    const index = entityIndex(id);
    if (!this.alive(id)) return false;
    this.aliveFlags[index] = 0;
    /* Bump BEFORE the slot can be reused, so every id handed out previously
       for this slot is now stale. */
    this.generations[index] = ((this.generations[index] as number) + 1) >>> 0;
    this.freeList[this.freeCount] = index;
    this.freeCount++;
    this.liveCount--;
    this.structuralVersion++;
    return true;
  }

  alive(id: EntityId): boolean {
    if ((id as number) < 0) return false;
    const index = entityIndex(id);
    if (index >= this.highWater) return false;
    return this.aliveFlags[index] === 1 && this.generations[index] === entityGeneration(id);
  }

  aliveAt(index: number): boolean {
    return index < this.highWater && this.aliveFlags[index] === 1;
  }

  /** The current id of a live slot, or `NO_ENTITY`. */
  idAt(index: number): EntityId {
    if (!this.aliveAt(index)) return NO_ENTITY;
    return makeId(index, this.generations[index] as number);
  }

  /* ---- columns ---- */

  has(cid: ComponentId): boolean { return this.tables.has(cid); }

  /** Read access. See `ReadonlyColumn`: a capability shape, not a memory guard. */
  column(cid: ComponentId): ReadonlyColumn {
    return this.table(cid).data;
  }

  /** Write access, gated on the declared single writer (DEC-013). */
  columnMut(cid: ComponentId, owner: SubsystemId): EntityColumn {
    const t = this.table(cid);
    invariant(
      t.desc.owner === owner,
      `component ${cid} is written by ${t.desc.owner}, not ${owner} (DEC-013)`,
    );
    return t.data;
  }

  descriptor(cid: ComponentId): ComponentDescriptor {
    return this.table(cid).desc;
  }

  private table(cid: ComponentId): Table {
    const t = this.tables.get(cid);
    invariant(t !== undefined, `component ${cid} is not declared in ${this.name}`);
    return t;
  }

  /**
   * Live indices in ascending order (DEC-017 rule 1).
   *
   * Fills `out` and returns how many were written, so a hot loop allocates
   * nothing. `out` must hold at least `count` entries.
   */
  liveIndices(out: Int32Array): number {
    invariant(out.length >= this.liveCount, `liveIndices: out too small for ${String(this.liveCount)}`);
    let n = 0;
    for (let i = 0; i < this.highWater; i++) {
      if (this.aliveFlags[i] === 1) { out[n] = i; n++; }
    }
    return n;
  }

  /**
   * Fold the store into the world digest (DEC-040).
   *
   * Folds the LIVE SET and its generations, not raw column memory: a dead
   * slot's leftover bytes are not world state, and two runs that differ only in
   * which slots happen to be free are the same world.
   */
  digest(): number {
    let h = 0x9e3779b1 >>> 0;
    const mix = (x: number, v: number): number => {
      let y = (x ^ Math.imul(v | 0, 0x9e3779b1)) >>> 0;
      y = Math.imul(y ^ (y >>> 16), 0x7feb352d) >>> 0;
      return (y ^ (y >>> 15)) >>> 0;
    };
    h = mix(h, this.liveCount);
    /* Explicit comparator: the default sort is implementation-defined for
       anything but strings, and DEC-017 does not accept "it happens to work". */
    const cids = [...this.tables.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i < this.highWater; i++) {
      if (this.aliveFlags[i] !== 1) continue;
      h = mix(h, i);
      h = mix(h, this.generations[i] as number);
      for (const cid of cids) {
        const t = this.table(cid);
        const w = t.desc.components;
        const float = isFloatDtype(t.desc.dtype);
        for (let k = 0; k < w; k++) {
          const v = t.data[i * w + k] as number;
          if (!float) { h = mix(h, v); continue; }
          if (!Number.isFinite(v)) { h = mix(h, Number.isNaN(v) ? 0x7ff1 : 0x7ff2); continue; }
          /* 1e-6 relative-free quantum: entity quantities here are populations,
             fractions and rates, all well inside +/-1e12. */
          const q = v < 0 ? -Math.round(-v * 1e6) : Math.round(v * 1e6);
          h = mix(h, q | 0);
          h = mix(h, Math.floor(q / GEN_SPAN) | 0);
        }
      }
    }
    return h >>> 0;
  }

  /**
   * Continuation of the LIFO free list (T-0137).
   *
   * `digest()` is the live set: two worlds that differ only in which dead
   * slot holds leftover bytes are the same world. The NEXT create, however,
   * pops this list, so the order of free indices is continuation state —
   * a founding that lands in slot 7 is not the same world as one that lands
   * in slot 3, even after T-0123 zeros the inherited row.
   */
  freeContinuationDigest(): number {
    const mix = (x: number, v: number): number => {
      let y = (x ^ Math.imul(v | 0, 0x9e3779b1)) >>> 0;
      y = Math.imul(y ^ (y >>> 16), 0x7feb352d) >>> 0;
      return (y ^ (y >>> 15)) >>> 0;
    };
    let h = mix(0x51eef1ee, this.freeCount);
    for (let i = 0; i < this.freeCount; i++) h = mix(h, this.freeList[i] as number);
    return h >>> 0;
  }

  /** Authoritative, renderer-free state used by M11 snapshot saves. */
  snapshot(): EntityStoreSnapshot {
    const columns: Record<string, readonly number[]> = {};
    const ids = [...this.tables.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const id of ids) columns[id as string] = Array.from(this.table(id).data);
    return {
      schema: 1,
      capacity: this.capacity,
      highWater: this.highWater,
      liveCount: this.liveCount,
      freeCount: this.freeCount,
      structuralVersion: this.structuralVersion,
      generations: Array.from(this.generations),
      alive: Array.from(this.aliveFlags),
      freeList: Array.from(this.freeList),
      columns,
    };
  }

  restore(snapshot: EntityStoreSnapshot): void {
    invariant(snapshot.schema === 1, `unsupported EntityStore snapshot schema ${String(snapshot.schema)}`);
    invariant(snapshot.capacity === this.capacity, 'EntityStore snapshot capacity mismatch');
    invariant(snapshot.highWater >= 0 && snapshot.highWater <= this.capacity, 'invalid EntityStore highWater');
    this.generations.set(snapshot.generations);
    this.aliveFlags.set(snapshot.alive);
    this.freeList.set(snapshot.freeList);
    this.highWater = snapshot.highWater;
    this.liveCount = snapshot.liveCount;
    this.freeCount = snapshot.freeCount;
    this.structuralVersion = snapshot.structuralVersion;
    for (const [id, values] of Object.entries(snapshot.columns)) {
      const table = this.tables.get(id as ComponentId);
      invariant(table !== undefined, `snapshot contains unknown component ${id}`);
      invariant(values.length === table.data.length, `snapshot component ${id} length mismatch`);
      table.data.set(values);
    }
  }
}
