/**
 * Cube-face seam topology (T-0020, DEC-035).
 *
 * Orientation is given: ∂u×∂v is outward on every face. This module does not
 * reopen winding. It answers the discrete question hydrology will ask:
 *
 *   from cell (face, x, y), who is the 4-connected neighbour in direction d,
 *   including across a face edge, and which three cells meet at each of the
 *   eight valence-3 cube corners?
 *
 * A 4-connected step always hits an edge, never a corner, so the neighbour is
 * unique. At a cube corner three faces meet: a diagonal (8-connected) step
 * would be ambiguous. M5 hydrology must use `valence3Corners` rather than
 * inventing a fourth neighbour.
 */

import { invariant } from '@ws/core';
import { cubeFaceToUnitRaw, cubeDim } from './cubesphere.js';
import { FACE, FACE_COUNT, type PCF } from './frames.js';
import { quadKey, type QuadKey } from './quadkey.js';

/** +u, −u, +v, −v in the face's own parameterisation. */
export const DIR = { POS_U: 0, NEG_U: 1, POS_V: 2, NEG_V: 3 } as const;
export type Dir = (typeof DIR)[keyof typeof DIR];

export const DIR_COUNT = 4;

export interface CubeCell {
  readonly face: number;
  readonly x: number;
  readonly y: number;
}

/**
 * 4-connected neighbour, wrapping across cube-face edges via the 3-D image.
 *
 * Implementation: take a half-cell step past the edge in UV, convert with the
 * unclamped face map, convert back with `unitToCubeFace`'s inverse by snapping
 * to the unique cell whose centre is nearest the image on the neighbouring
 * face. For an on-face step this is just x±1 / y±1.
 */
export function neighbor(cell: CubeCell, level: number, dir: Dir): CubeCell {
  const n = cubeDim(level);
  invariant(cell.face >= 0 && cell.face < FACE_COUNT, 'neighbor: face');
  invariant(cell.x >= 0 && cell.x < n && cell.y >= 0 && cell.y < n, 'neighbor: xy');
  let x = cell.x;
  let y = cell.y;
  if (dir === DIR.POS_U) x += 1;
  else if (dir === DIR.NEG_U) x -= 1;
  else if (dir === DIR.POS_V) y += 1;
  else y -= 1;
  if (x >= 0 && x < n && y >= 0 && y < n) return { face: cell.face, x, y };
  return snapAcross(cell.face, level, x, y);
}

function snapAcross(face: number, level: number, x: number, y: number): CubeCell {
  const n = cubeDim(level);
  const u = (x + 0.5) / n;
  const v = (y + 0.5) / n;
  const p = cubeFaceToUnitRaw(face, u, v);
  /* Inverse of cubeFaceToUnit without importing the clamped path's assert. */
  const c = unitToFaceUnclamped(p);
  const xx = Math.min(n - 1, Math.max(0, Math.floor(c.u * n)));
  const yy = Math.min(n - 1, Math.max(0, Math.floor(c.v * n)));
  return { face: c.face, x: xx, y: yy };
}

function unitToFaceUnclamped(p: PCF): { face: number; u: number; v: number } {
  const ax = Math.abs(p.x);
  const ay = Math.abs(p.y);
  const az = Math.abs(p.z);
  let face: number;
  let a: number;
  let b: number;
  if (ax >= ay && ax >= az) {
    if (p.x > 0) {
      face = FACE.POS_X;
      a = p.y / ax;
      b = p.z / ax;
    } else {
      face = FACE.NEG_X;
      a = -p.y / ax;
      b = p.z / ax;
    }
  } else if (ay >= az) {
    if (p.y > 0) {
      face = FACE.POS_Y;
      a = p.x / ay;
      b = -p.z / ay;
    } else {
      face = FACE.NEG_Y;
      a = p.x / ay;
      b = p.z / ay;
    }
  } else if (p.z > 0) {
    face = FACE.POS_Z;
    a = p.x / az;
    b = p.y / az;
  } else {
    face = FACE.NEG_Z;
    a = p.x / az;
    b = -p.y / az;
  }
  const QUARTER_PI = Math.PI / 4;
  const u = (Math.atan(Math.min(1, Math.max(-1, a))) / QUARTER_PI + 1) * 0.5;
  const v = (Math.atan(Math.min(1, Math.max(-1, b))) / QUARTER_PI + 1) * 0.5;
  return { face, u, v };
}

export function neighborKey(key: QuadKey, dir: Dir): QuadKey {
  const n = neighbor({ face: key.face, x: key.x, y: key.y }, key.level, dir);
  return quadKey(n.face, key.level, n.x, n.y);
}

/**
 * The 24 directed face-edge adjacencies: 6 faces × 4 edges.
 * Each maps a source edge to a destination (face, edge) with a UV flip flag.
 * Derived, not tabulated, so DEC-035 orientation changes cannot silently
 * desynchronise a handwritten table. Tests pin the 3-D identification.
 */
export function edgeAdjacencies(level: number): readonly {
  from: CubeCell;
  dir: Dir;
  to: CubeCell;
}[] {
  const n = cubeDim(level);
  const out: { from: CubeCell; dir: Dir; to: CubeCell }[] = [];
  for (let face = 0; face < FACE_COUNT; face++) {
    /* One representative cell per edge (the midpoint). */
    const samples: { cell: CubeCell; dir: Dir }[] = [
      { cell: { face, x: n - 1, y: n >> 1 }, dir: DIR.POS_U },
      { cell: { face, x: 0, y: n >> 1 }, dir: DIR.NEG_U },
      { cell: { face, x: n >> 1, y: n - 1 }, dir: DIR.POS_V },
      { cell: { face, x: n >> 1, y: 0 }, dir: DIR.NEG_V },
    ];
    for (const s of samples) {
      out.push({ from: s.cell, dir: s.dir, to: neighbor(s.cell, level, s.dir) });
    }
  }
  return out;
}

/**
 * Eight cube corners, each a triple of cells that share a single 3-D point.
 *
 * Hydrology at these cells is 3-way, not 4-way: there is no fourth face.
 * A flow algorithm that assumes every vertex has degree 4 will stall or
 * double-count here. M5 must branch on this list.
 *
 * Order of the triple is face-id ascending (deterministic).
 */
export function valence3Corners(level: number): readonly (readonly [CubeCell, CubeCell, CubeCell])[] {
  const n = cubeDim(level);
  const last = n - 1;
  /* The 8 cube corners in 3-D, and the (u,v) corner of each incident face. */
  const signs: readonly [number, number, number][] = [
    [1, 1, 1],
    [1, 1, -1],
    [1, -1, 1],
    [1, -1, -1],
    [-1, 1, 1],
    [-1, 1, -1],
    [-1, -1, 1],
    [-1, -1, -1],
  ];
  const triples: (readonly [CubeCell, CubeCell, CubeCell])[] = [];
  for (const [sx, sy, sz] of signs) {
    const cells: CubeCell[] = [];
    for (let face = 0; face < FACE_COUNT; face++) {
      const uv = cornerUvOnFace(face, sx, sy, sz);
      if (uv === null) continue;
      cells.push({
        face,
        x: uv.u === 1 ? last : 0,
        y: uv.v === 1 ? last : 0,
      });
    }
    invariant(cells.length === 3, `valence-3: expected 3 faces, got ${String(cells.length)}`);
    cells.sort((a, b) => a.face - b.face || a.y - b.y || a.x - b.x);
    triples.push([cells[0] as CubeCell, cells[1] as CubeCell, cells[2] as CubeCell]);
  }
  return triples;
}

function cornerUvOnFace(
  face: number,
  sx: number,
  sy: number,
  sz: number,
): { u: 0 | 1; v: 0 | 1 } | null {
  /* A cube corner (sx,sy,sz) lies on a face iff the face's axis matches. */
  switch (face) {
    case FACE.POS_X:
      if (sx !== 1) return null;
      return { u: sy === 1 ? 1 : 0, v: sz === 1 ? 1 : 0 };
    case FACE.NEG_X:
      if (sx !== -1) return null;
      return { u: sy === -1 ? 1 : 0, v: sz === 1 ? 1 : 0 };
    case FACE.POS_Y:
      if (sy !== 1) return null;
      return { u: sx === 1 ? 1 : 0, v: sz === -1 ? 1 : 0 };
    case FACE.NEG_Y:
      if (sy !== -1) return null;
      return { u: sx === 1 ? 1 : 0, v: sz === 1 ? 1 : 0 };
    case FACE.POS_Z:
      if (sz !== 1) return null;
      return { u: sx === 1 ? 1 : 0, v: sy === 1 ? 1 : 0 };
    case FACE.NEG_Z:
      if (sz !== -1) return null;
      return { u: sx === 1 ? 1 : 0, v: sy === -1 ? 1 : 0 };
    default:
      return null;
  }
}

/** Shared 3-D point of a valence-3 triple (unit sphere). */
export function cornerPoint(triple: readonly [CubeCell, CubeCell, CubeCell], level: number): PCF {
  const n = cubeDim(level);
  const c = triple[0];
  const u = c.x === 0 ? 0 : 1;
  const v = c.y === 0 ? 0 : 1;
  void n;
  return cubeFaceToUnitRaw(c.face, u, v);
}

export function cellCenterUnit(cell: CubeCell, level: number): PCF {
  const n = cubeDim(level);
  return cubeFaceToUnitRaw(cell.face, (cell.x + 0.5) / n, (cell.y + 0.5) / n);
}

/** Spherical area of a cube-sphere cell, steradians. Two spherical triangles. */
export function cubeCellSteradians(cell: CubeCell, level: number): number {
  const n = cubeDim(level);
  const u0 = cell.x / n;
  const v0 = cell.y / n;
  const u1 = (cell.x + 1) / n;
  const v1 = (cell.y + 1) / n;
  const p00 = cubeFaceToUnitRaw(cell.face, u0, v0);
  const p10 = cubeFaceToUnitRaw(cell.face, u1, v0);
  const p01 = cubeFaceToUnitRaw(cell.face, u0, v1);
  const p11 = cubeFaceToUnitRaw(cell.face, u1, v1);
  return sphericalTri(p00, p10, p11) + sphericalTri(p00, p11, p01);
}

function sphericalTri(a: PCF, b: PCF, c: PCF): number {
  /* van Oosterom & Strackee: tan(E/2) = [a,b,c] / (1 + a·b + b·c + c·a). */
  const triple =
    a.x * (b.y * c.z - b.z * c.y) + a.y * (b.z * c.x - b.x * c.z) + a.z * (b.x * c.y - b.y * c.x);
  const denom =
    1 +
    (a.x * b.x + a.y * b.y + a.z * b.z) +
    (b.x * c.x + b.y * c.y + b.z * c.z) +
    (c.x * a.x + c.y * a.y + c.z * a.z);
  return Math.abs(2 * Math.atan2(triple, denom));
}

