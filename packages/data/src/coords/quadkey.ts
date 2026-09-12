/**
 * Quadtree addressing over the cube-sphere (DEC-006, DEC-007).
 *
 * A QuadKey identifies one node of the LOD quadtree. It is simultaneously:
 *   - the LOD node identity,
 *   - the tile cache key,
 *   - the chunk seed key (DEC-017), which is why cache eviction and generation
 *     order are invisible,
 *   - the raster field index at that level.
 *
 * That is the unification DEC-007 is about.
 */

import { assert, assertInteger } from '@ws/core';
import type { CubeFace } from './frames.js';

export interface QuadKey {
  readonly face: number;
  readonly level: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Beyond this, a QuadKey no longer packs into an f64-safe integer id
 * (3 face bits + 5 level bits + 2*20 coordinate bits = 48 bits). Level 20 is
 * ~9.5 m cells, well past the L18 authoritative floor (DEC-019), so the cap does
 * not constrain the simulation — only the numeric id form.
 */
export const MAX_PACKABLE_LEVEL = 20;

export function quadKey(face: number, level: number, x: number, y: number): QuadKey {
  assertInteger(level, 'level');
  assert(level >= 0, 'level must be >= 0');
  assert(face >= 0 && face < 6, `invalid face: ${String(face)}`);
  const n = 2 ** level;
  assert(x >= 0 && x < n && y >= 0 && y < n, `quadkey out of range at level ${String(level)}`);
  return { face, level, x, y };
}

export function rootKey(face: number): QuadKey {
  return { face, level: 0, x: 0, y: 0 };
}

export function parent(k: QuadKey): QuadKey {
  assert(k.level > 0, 'root has no parent');
  return { face: k.face, level: k.level - 1, x: k.x >> 1, y: k.y >> 1 };
}

/** Children in fixed order: (0,0), (1,0), (0,1), (1,1). Order is part of the
 *  contract — traversal order must not depend on anything else (DEC-017). */
export function children(k: QuadKey): readonly [QuadKey, QuadKey, QuadKey, QuadKey] {
  const l = k.level + 1;
  const x = k.x * 2;
  const y = k.y * 2;
  return [
    { face: k.face, level: l, x, y },
    { face: k.face, level: l, x: x + 1, y },
    { face: k.face, level: l, x, y: y + 1 },
    { face: k.face, level: l, x: x + 1, y: y + 1 },
  ];
}

/** The QuadKey containing a surface point at a given level. */
export function fromCubeFace(c: CubeFace, level: number): QuadKey {
  const n = 2 ** level;
  const x = Math.min(n - 1, Math.floor(c.u * n));
  const y = Math.min(n - 1, Math.floor(c.v * n));
  return { face: c.face, level, x, y };
}

/** The node's centre in face coordinates. */
export function centerCubeFace(k: QuadKey): CubeFace {
  const n = 2 ** k.level;
  return { face: k.face, u: (k.x + 0.5) / n, v: (k.y + 0.5) / n };
}

/** The node's extent in face coordinates: [u0, v0, u1, v1]. */
export function bounds(k: QuadKey): readonly [number, number, number, number] {
  const n = 2 ** k.level;
  return [k.x / n, k.y / n, (k.x + 1) / n, (k.y + 1) / n];
}

export function contains(a: QuadKey, b: QuadKey): boolean {
  if (a.face !== b.face || a.level > b.level) return false;
  const shift = b.level - a.level;
  return (b.x >> shift) === a.x && (b.y >> shift) === a.y;
}

export function equals(a: QuadKey, b: QuadKey): boolean {
  return a.face === b.face && a.level === b.level && a.x === b.x && a.y === b.y;
}

/**
 * Pack into a single safe integer, usable as a Map key or a cache index.
 * Valid up to MAX_PACKABLE_LEVEL. Uses multiplication rather than bit shifts
 * because the result exceeds 32 bits.
 */
export function packId(k: QuadKey): number {
  assert(k.level <= MAX_PACKABLE_LEVEL, `level ${String(k.level)} exceeds MAX_PACKABLE_LEVEL`);
  return ((k.face * 32 + k.level) * 2 ** 20 + k.x) * 2 ** 20 + k.y;
}

export function unpackId(id: number): QuadKey {
  const y = id % 2 ** 20;
  const rest = (id - y) / 2 ** 20;
  const x = rest % 2 ** 20;
  const head = (rest - x) / 2 ** 20;
  const level = head % 32;
  const face = (head - level) / 32;
  return { face, level, x, y };
}

/** Human-readable, stable, usable as a filename in the OPFS tile cache. */
export function toString(k: QuadKey): string {
  return `f${k.face}/l${k.level}/${k.x}_${k.y}`;
}

/**
 * Total-order comparator. Required wherever QuadKeys are sorted, because
 * `Array.prototype.sort` without an explicit comparator is banned in sim code
 * (DEC-017) — reductions must fold in key order, never completion order.
 */
export function compare(a: QuadKey, b: QuadKey): number {
  if (a.face !== b.face) return a.face - b.face;
  if (a.level !== b.level) return a.level - b.level;
  if (a.y !== b.y) return a.y - b.y;
  return a.x - b.x;
}
