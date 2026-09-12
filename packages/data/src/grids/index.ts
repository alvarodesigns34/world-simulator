/**
 * Grid registry (DEC-007, DEC-008).
 *
 * Two discretisations, chosen for two different problems:
 *   - cube-sphere quadtree levels, for terrain and rendering;
 *   - icosahedral geodesic levels, for the circulation solver.
 *
 * A field names exactly one grid. An aggregate may name a COARSER grid than its
 * instant field (DEC-030 rule 3) — a 12-month i16 T+P climatology is 1.21 GB on
 * cube L11 and 1.97 MB on geodesic n6.
 */

import { assert } from '@ws/core';

export type GridId = string & { readonly __brand: 'GridId' };

export type GridKind = 'cubesphere' | 'geodesic';

export interface GridDescriptor {
  readonly id: GridId;
  readonly kind: GridKind;
  /** Quadtree level for cube-sphere; refinement level n for geodesic. */
  readonly level: number;
  readonly cellCount: number;
  /** Mean cell spacing in metres on an Earth-sized planet, for documentation. */
  readonly meanSpacingM: number;
}

const EARTH_R = 6_371_000;

function cubeSphere(level: number): GridDescriptor {
  const cells = 6 * 4 ** level;
  return {
    id: `cubesphere@L${level}` as GridId,
    kind: 'cubesphere',
    level,
    cellCount: cells,
    meanSpacingM: (Math.PI * EARTH_R) / 2 / 2 ** level,
  };
}

function geodesic(n: number): GridDescriptor {
  const cells = 10 * 4 ** n + 2;
  return {
    id: `geodesic@n${n}` as GridId,
    kind: 'geodesic',
    level: n,
    cellCount: cells,
    meanSpacingM: Math.sqrt((4 * Math.PI * EARTH_R * EARTH_R) / cells),
  };
}

const GRIDS: readonly GridDescriptor[] = [
  ...[6, 8, 10, 11, 12].map(cubeSphere),
  ...[4, 5, 6, 7].map(geodesic),
];

const BY_ID = new Map(GRIDS.map((g) => [g.id, g]));

export function grid(id: GridId | string): GridDescriptor {
  const g = BY_ID.get(id as GridId);
  assert(g !== undefined, `unknown grid: ${String(id)}`);
  return g as GridDescriptor;
}

/** deterministic-order: GRIDS is a fixed literal array, not insertion-ordered state. */
export function allGrids(): readonly GridDescriptor[] {
  return GRIDS;
}

export function gridId(kind: GridKind, level: number): GridId {
  return (kind === 'cubesphere' ? `cubesphere@L${level}` : `geodesic@n${level}`) as GridId;
}

/**
 * True when `coarse` is a legal aggregate grid for `fine` — same kind is not
 * required (climatology on a geodesic aggregates a cube-sphere field), but the
 * aggregate must not be finer, or it is not an aggregate.
 */
export function isCoarserOrEqual(coarse: GridDescriptor, fine: GridDescriptor): boolean {
  return coarse.cellCount <= fine.cellCount;
}
