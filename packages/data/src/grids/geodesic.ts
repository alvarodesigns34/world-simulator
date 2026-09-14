/**
 * Icosahedral geodesic grid (T-0034, DEC-008).
 *
 * Frequency ν = 2^n, cell count = 10 ν² + 2 = 10·4^n + 2.
 * Dual of a subdivided icosahedron: 12 pentagons + the rest hexagons.
 *
 * Neighbours, areas and positions are exact functions of n. Construction
 * walks faces then barycentric (i,j) in that order; the intern table is a
 * lookup, not a reduction (DEC-017).
 */

import { asin, atan2, invariant } from '@ws/core';

export interface GeodesicGrid {
  readonly n: number;
  readonly frequency: number;
  readonly cellCount: number;
  /** Unit PCF, 3 components per cell. */
  readonly positions: Float64Array;
  /** Steradians. Sum equals 4π. */
  readonly areas: Float64Array;
  /** 6 slots per cell, −1 if unused (pentagons). */
  readonly neighbors: Int32Array;
  readonly neighborCount: Uint8Array;
}

const PHI = (1 + Math.sqrt(5)) / 2;

const ICO_VERTS: readonly (readonly [number, number, number])[] = [
  [-1, PHI, 0],
  [1, PHI, 0],
  [-1, -PHI, 0],
  [1, -PHI, 0],
  [0, -1, PHI],
  [0, 1, PHI],
  [0, -1, -PHI],
  [0, 1, -PHI],
  [PHI, 0, -1],
  [PHI, 0, 1],
  [-PHI, 0, -1],
  [-PHI, 0, 1],
];

const ICO_FACES: readonly (readonly [number, number, number])[] = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
];

function norm(x: number, y: number, z: number): [number, number, number] {
  const l = Math.sqrt(x * x + y * y + z * z);
  return [x / l, y / l, z / l];
}

function keyOf(x: number, y: number, z: number): string {
  /* 12 decimal places separates n=7 vertices and identifies shared edges. */
  return `${x.toFixed(12)},${y.toFixed(12)},${z.toFixed(12)}`;
}

const CACHE: GeodesicGrid[] = [];

export function geodesicGrid(n: number): GeodesicGrid {
  invariant(n >= 0 && n <= 7 && (n | 0) === n, `geodesic n in 0..7, got ${String(n)}`);
  const hit = CACHE[n];
  if (hit) return hit;
  const grid = build(n);
  CACHE[n] = grid;
  return grid;
}

function build(n: number): GeodesicGrid {
  const nu = 2 ** n;
  const intern = new Map<string, number>();
  const pos: number[] = [];
  const triangles: number[] = [];

  const ico = ICO_VERTS.map((v) => norm(v[0], v[1], v[2]));

  const internV = (x: number, y: number, z: number): number => {
    const p = norm(x, y, z);
    const k = keyOf(p[0], p[1], p[2]);
    const existing = intern.get(k);
    if (existing !== undefined) return existing;
    const id = intern.size;
    intern.set(k, id);
    pos.push(p[0], p[1], p[2]);
    return id;
  };

  for (const f of ICO_FACES) {
    const A = ico[f[0]] as [number, number, number];
    const B = ico[f[1]] as [number, number, number];
    const C = ico[f[2]] as [number, number, number];
    const rows: number[][] = [];
    for (let i = 0; i <= nu; i++) {
      const row: number[] = [];
      for (let j = 0; j <= nu - i; j++) {
        const k = nu - i - j;
        const x = (k * A[0] + j * B[0] + i * C[0]) / nu;
        const y = (k * A[1] + j * B[1] + i * C[1]) / nu;
        const z = (k * A[2] + j * B[2] + i * C[2]) / nu;
        row.push(internV(x, y, z));
      }
      rows.push(row);
    }
    for (let i = 0; i < nu; i++) {
      const row = rows[i] as number[];
      const next = rows[i + 1] as number[];
      for (let j = 0; j < nu - i; j++) {
        const a = row[j] as number;
        const b = row[j + 1] as number;
        const c = next[j] as number;
        triangles.push(a, b, c);
        if (j < nu - i - 1) {
          const d = next[j + 1] as number;
          triangles.push(b, d, c);
        }
      }
    }
  }

  const cellCount = pos.length / 3;
  invariant(cellCount === 10 * 4 ** n + 2, `geodesic n=${String(n)} cells ${String(cellCount)}`);

  const neighborCount = new Uint8Array(cellCount);
  const adj: number[][] = [];
  for (let i = 0; i < cellCount; i++) adj.push([]);

  const addEdge = (a: number, b: number): void => {
    const list = adj[a] as number[];
    for (let k = 0; k < list.length; k++) if (list[k] === b) return;
    list.push(b);
  };

  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] as number;
    const b = triangles[t + 1] as number;
    const c = triangles[t + 2] as number;
    addEdge(a, b);
    addEdge(b, a);
    addEdge(b, c);
    addEdge(c, b);
    addEdge(c, a);
    addEdge(a, c);
  }

  const neighbors = new Int32Array(cellCount * 6);
  neighbors.fill(-1);
  for (let i = 0; i < cellCount; i++) {
    const list = adj[i] as number[];
    list.sort((x, y) => x - y);
    neighborCount[i] = list.length;
    for (let k = 0; k < list.length && k < 6; k++) neighbors[i * 6 + k] = list[k] as number;
  }

  const areas = new Float64Array(cellCount);
  const positions = Float64Array.from(pos);
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] as number;
    const b = triangles[t + 1] as number;
    const c = triangles[t + 2] as number;
    const area = sphTri(
      positions[a * 3] as number,
      positions[a * 3 + 1] as number,
      positions[a * 3 + 2] as number,
      positions[b * 3] as number,
      positions[b * 3 + 1] as number,
      positions[b * 3 + 2] as number,
      positions[c * 3] as number,
      positions[c * 3 + 1] as number,
      positions[c * 3 + 2] as number,
    );
    const share = area / 3;
    areas[a] = (areas[a] as number) + share;
    areas[b] = (areas[b] as number) + share;
    areas[c] = (areas[c] as number) + share;
  }

  return {
    n,
    frequency: nu,
    cellCount,
    positions,
    areas,
    neighbors,
    neighborCount,
  };
}

function sphTri(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): number {
  const triple = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  const denom = 1 + (ax * bx + ay * by + az * bz) + (bx * cx + by * cy + bz * cz) + (cx * ax + cy * ay + cz * az);
  return Math.abs(2 * atan2(triple, denom));
}

export function geodesicLat(grid: GeodesicGrid, cell: number): number {
  const z = grid.positions[cell * 3 + 2] as number;
  const zz = z < -1 ? -1 : z > 1 ? 1 : z;
  return asin(zz);
}

export function geodesicLon(grid: GeodesicGrid, cell: number): number {
  const x = grid.positions[cell * 3] as number;
  const y = grid.positions[cell * 3 + 1] as number;
  return atan2(y, x);
}

export function geodesicCellCount(n: number): number {
  return 10 * 4 ** n + 2;
}
