/**
 * Field descriptors (DEC-012, DEC-013, DEC-028, DEC-030).
 *
 * A field is NOT "a typed array with a name". Every field declares what it is,
 * who may write it, how it is quantised, how long its memory is, and whether it
 * has an aggregate — because each of those is load-bearing somewhere:
 *
 *   owner          single-writer rule (DEC-013), scheduler conflict detection
 *   dtype/quantum  memory budget and Earth-representability (DEC-028)
 *   offset         lets i16 cover a range that does not straddle zero
 *   temporalClass  what quiesce/resume may do to it (DEC-030)
 *   tier           whether the GPU may produce it (DEC-018)
 *   aggregate      what a coarse regime reads instead (DEC-030 rule 2)
 *   grid           which discretisation it lives on (DEC-007/008)
 *
 * The registry is closed: fields are declared up front, not created at runtime.
 * An "arbitrary container" is exactly what this must not become.
 */

import { invariant } from '@ws/core';
import { grid, isCoarserOrEqual, type GridId } from '../grids/index.js';

export type FieldId = string & { readonly __brand: 'FieldId' };
export type SubsystemId = string & { readonly __brand: 'SubsystemId' };

export function fieldId(s: string): FieldId {
  return s as FieldId;
}
export function subsystemId(s: string): SubsystemId {
  return s as SubsystemId;
}

export type Dtype = 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'f32' | 'f64';

/**
 * Temporal class (DEC-030).
 *
 *  slow      Long memory; cannot be reconstructed from an aggregate. Ice sheets,
 *            ocean interior, groundwater, crust. Always live; steps on a FIXED
 *            sim-time cadence independent of timeScale, which is what makes its
 *            trajectory path-independent. `quiesce` is a no-op for slow state.
 *  fast      Regime-switched transients. Wind, storms, convection. May be
 *            discarded on `quiesce` and re-seeded on `resume` from aggregate +
 *            world seed, purely, so replay of the same command log is stable.
 *  aggregate Running statistics of fast state. Always-on windows, not
 *            flush-at-transition. May live on a coarser grid.
 */
export type TemporalClass = 'slow' | 'fast' | 'aggregate';

/** Determinism tier (DEC-018). The GPU may only ever produce tier 'C'. */
export type Tier = 'A' | 'B' | 'C';

export interface FieldDescriptor {
  readonly id: FieldId;
  readonly grid: GridId;
  readonly dtype: Dtype;
  /** 1 = scalar, 2/3 = vector. Components are interleaved per cell. */
  readonly components: number;
  /**
   * Physical value per integer step (DEC-028). `1` for float dtypes.
   *
   * MUST be a power of two for integer dtypes, so that encode and decode are
   * exactly representable in IEEE-754 and a field decodes bit-identically on
   * every platform. A non-power-of-two quantum silently drops the field out of
   * determinism tier A.
   */
  readonly quantum: number;
  /** Physical value at stored 0. Lets i16 cover kelvin, or a tile's own range. */
  readonly offset: number;
  readonly units: string;
  readonly range: readonly [number, number];
  readonly owner: SubsystemId;
  readonly tier: Tier;
  readonly temporalClass: TemporalClass;
  /**
   * Double-buffer only fields with a genuine read-write hazard (DEC-020). 2x
   * memory is too expensive to apply by default.
   */
  readonly doubleBuffered: boolean;
  /** The field a coarse regime reads instead. May live on a coarser grid. */
  readonly aggregate?: FieldId;
  readonly persist: 'snapshot' | 'derived' | 'never';
}

export const DTYPE_BYTES: Readonly<Record<Dtype, number>> = {
  i8: 1,
  u8: 1,
  i16: 2,
  u16: 2,
  i32: 4,
  f32: 4,
  f64: 8,
};

export const DTYPE_RANGE: Readonly<Record<Dtype, readonly [number, number]>> = {
  i8: [-128, 127],
  u8: [0, 255],
  i16: [-32768, 32767],
  u16: [0, 65535],
  i32: [-2147483648, 2147483647],
  f32: [-3.4e38, 3.4e38],
  f64: [-1.8e308, 1.8e308],
};

export function isFloatDtype(d: Dtype): boolean {
  return d === 'f32' || d === 'f64';
}

export function isPowerOfTwo(x: number): boolean {
  if (!(x > 0) || !Number.isFinite(x)) return false;
  const m = Math.log2(x);
  return m === Math.floor(m);
}

/**
 * Snap a quantum up to the next power of two (DEC-028 amendment 2).
 * Used when baking a tile whose range determines its own quantum.
 */
export function snapQuantum(q: number): number {
  invariant(q > 0 && Number.isFinite(q), `quantum must be positive and finite: ${String(q)}`);
  return 2 ** Math.ceil(Math.log2(q));
}

export function fieldBytes(d: FieldDescriptor): number {
  const cells = grid(d.grid).cellCount;
  return cells * d.components * DTYPE_BYTES[d.dtype] * (d.doubleBuffered ? 2 : 1);
}

/**
 * Validate a descriptor. Every failure here is a bug that would otherwise show
 * up months later as a field that silently cannot hold its own values — which is
 * precisely what `i16` centimetres did (AUDIT-V0 B1).
 */
export function validateDescriptor(
  d: FieldDescriptor,
  lookup: (id: FieldId) => FieldDescriptor | undefined,
): void {
  invariant(d.components >= 1 && d.components <= 4, `${d.id}: components must be 1..4`);
  invariant(d.range[0] < d.range[1], `${d.id}: range must be ordered`);

  const g = grid(d.grid); // throws if unknown

  if (isFloatDtype(d.dtype)) {
    invariant(d.quantum === 1 && d.offset === 0, `${d.id}: float fields take quantum 1, offset 0`);
  } else {
    invariant(
      isPowerOfTwo(d.quantum),
      `${d.id}: quantum ${String(d.quantum)} is not a power of two (DEC-028) — ` +
        `encode/decode would not be exactly representable and the field would leave tier A`,
    );

    // The check that DEC-022's i16-centimetres clause would have failed.
    const [lo, hi] = DTYPE_RANGE[d.dtype];
    const repLo = d.offset + lo * d.quantum;
    const repHi = d.offset + hi * d.quantum;
    invariant(
      repLo <= d.range[0] && repHi >= d.range[1],
      `${d.id}: dtype ${d.dtype} with quantum ${String(d.quantum)} and offset ${String(d.offset)} ` +
        `represents [${String(repLo)}, ${String(repHi)}] ${d.units}, which cannot hold the ` +
        `declared range [${String(d.range[0])}, ${String(d.range[1])}] ${d.units}`,
    );
  }

  if (d.aggregate !== undefined) {
    const agg = lookup(d.aggregate);
    invariant(agg !== undefined, `${d.id}: aggregate '${d.aggregate}' is not registered`);
    const a = agg as FieldDescriptor;
    invariant(
      a.temporalClass === 'aggregate',
      `${d.id}: aggregate '${a.id}' must have temporalClass 'aggregate', has '${a.temporalClass}'`,
    );
    invariant(
      isCoarserOrEqual(grid(a.grid), g),
      `${d.id}: aggregate '${a.id}' is on a FINER grid (${a.grid} > ${d.grid}); ` +
        `an aggregate may be coarser or equal, never finer (DEC-030)`,
    );
  }

  // DEC-030 rule 2: a fast field that is read across a regime boundary needs an
  // aggregate. We cannot see consumers here, so the rule is enforced at
  // scheduler build time; what we can check is that slow state never claims one.
  invariant(
    !(d.temporalClass === 'slow' && d.aggregate !== undefined),
    `${d.id}: slow state has no aggregate — it is never reconstructed from statistics (DEC-030)`,
  );

  // DEC-018: the GPU is never authoritative.
  invariant(
    !(d.tier === 'C' && d.persist === 'snapshot'),
    `${d.id}: tier C data is not authoritative and must not be persisted as a snapshot (DEC-018)`,
  );
}

/**
 * Canonical, runtime-immutable descriptor (T-0080).
 *
 * `readonly` on `FieldDescriptor` is a TypeScript qualifier and does not exist
 * at runtime. `view(id).descriptor` and `store.descriptor(id)` used to return
 * the live registry object, so a reader could reassign `owner` / `quantum` /
 * `offset` / `tier` / `doubleBuffered` and change ownership, decode, and
 * persistence. Metadata is small: copy + `Object.freeze`, including `range`.
 */
export function freezeDescriptor(d: FieldDescriptor): FieldDescriptor {
  const range = Object.freeze([d.range[0], d.range[1]] as [number, number]);
  const copy: FieldDescriptor =
    d.aggregate !== undefined
      ? {
          id: d.id,
          grid: d.grid,
          dtype: d.dtype,
          components: d.components,
          quantum: d.quantum,
          offset: d.offset,
          units: d.units,
          range,
          owner: d.owner,
          tier: d.tier,
          temporalClass: d.temporalClass,
          doubleBuffered: d.doubleBuffered,
          persist: d.persist,
          aggregate: d.aggregate,
        }
      : {
          id: d.id,
          grid: d.grid,
          dtype: d.dtype,
          components: d.components,
          quantum: d.quantum,
          offset: d.offset,
          units: d.units,
          range,
          owner: d.owner,
          tier: d.tier,
          temporalClass: d.temporalClass,
          doubleBuffered: d.doubleBuffered,
          persist: d.persist,
        };
  return Object.freeze(copy);
}

