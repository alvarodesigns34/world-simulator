/**
 * Conservative cube-sphere ↔ geodesic resampling (T-0034, DEC-008).
 *
 * Extensive quantities (mass) use a partition of cube-cell area: each cube
 * cell is assigned to the geodesic cell containing its centre. That makes
 *
 *   sum(geo_ext) = sum(cube_ext)
 *
 * exact in f64 (rounding ~1e-15, target 1e-9). Intensive quantities are
 * recovered by dividing by the partitioned area, not the spherical polygon
 * area — otherwise a constant field would not round-trip.
 *
 * Mapping is built once per (cubeLevel, n) pair.
 */

import { invariant } from '@ws/core';
import { cubeDim, cubeIndex, cubeFaceToUnitRaw, cubeCellSteradians } from '../coords/index.js';
import { geodesicGrid, type GeodesicGrid } from './geodesic.js';

export interface ResamplePlan {
  readonly cubeLevel: number;
  readonly n: number;
  readonly cubeCount: number;
  readonly geoCount: number;
  /** For each cube cell, the geodesic cell it maps to. */
  readonly cubeToGeo: Int32Array;
  /** Cube-cell steradians. */
  readonly cubeArea: Float64Array;
  /** Sum of cube areas assigned to each geodesic cell. */
  readonly geoArea: Float64Array;
}

const PLANS = new Map<string, ResamplePlan>();

export function resamplePlan(cubeLevel: number, n: number): ResamplePlan {
  const key = `${cubeLevel}:${n}`;
  const hit = PLANS.get(key);
  if (hit) return hit;
  const plan = buildPlan(cubeLevel, n);
  PLANS.set(key, plan);
  return plan;
}

function buildPlan(cubeLevel: number, n: number): ResamplePlan {
  const grid = geodesicGrid(n);
  const dim = cubeDim(cubeLevel);
  const cubeCount = 6 * dim * dim;
  const cubeToGeo = new Int32Array(cubeCount);
  const cubeArea = new Float64Array(cubeCount);
  const geoArea = new Float64Array(grid.cellCount);

  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < dim; y++) {
      for (let x = 0; x < dim; x++) {
        const i = cubeIndex(face, cubeLevel, x, y);
        const u = cubeFaceToUnitRaw(face, (x + 0.5) / dim, (y + 0.5) / dim);
        cubeToGeo[i] = nearestCell(grid, u.x, u.y, u.z);
        cubeArea[i] = cubeCellSteradians({ face, x, y }, cubeLevel);
        const g = cubeToGeo[i] as number;
        geoArea[g] = (geoArea[g] as number) + (cubeArea[i] as number);
      }
    }
  }
  return {
    cubeLevel,
    n,
    cubeCount,
    geoCount: grid.cellCount,
    cubeToGeo,
    cubeArea,
    geoArea,
  };
}

function nearestCell(grid: GeodesicGrid, x: number, y: number, z: number): number {
  let best = 0;
  let bestDot = -2;
  const p = grid.positions;
  for (let i = 0; i < grid.cellCount; i++) {
    const d = x * (p[i * 3] as number) + y * (p[i * 3 + 1] as number) + z * (p[i * 3 + 2] as number);
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  }
  return best;
}

/** Extensive cube → geodesic. `outGeo[g] = sum_{c→g} inCube[c]`. */
export function cubeToGeoExtensive(plan: ResamplePlan, inCube: ArrayLike<number>, outGeo: Float64Array): void {
  invariant(inCube.length === plan.cubeCount, 'cubeToGeoExtensive: cube count');
  invariant(outGeo.length === plan.geoCount, 'cubeToGeoExtensive: geo count');
  outGeo.fill(0);
  for (let c = 0; c < plan.cubeCount; c++) {
    const g = plan.cubeToGeo[c] as number;
    outGeo[g] = (outGeo[g] as number) + (inCube[c] as number);
  }
}

/** Intensive cube → geodesic (area-weighted mean). */
export function cubeToGeoIntensive(plan: ResamplePlan, inCube: ArrayLike<number>, outGeo: Float64Array): void {
  const mass = new Float64Array(plan.geoCount);
  for (let c = 0; c < plan.cubeCount; c++) {
    const g = plan.cubeToGeo[c] as number;
    mass[g] = (mass[g] as number) + (inCube[c] as number) * (plan.cubeArea[c] as number);
  }
  for (let g = 0; g < plan.geoCount; g++) {
    const a = plan.geoArea[g] as number;
    outGeo[g] = a > 0 ? (mass[g] as number) / a : 0;
  }
}

/** Extensive geodesic → cube: distribute by cube-area share of the geo cell. */
export function geoToCubeExtensive(plan: ResamplePlan, inGeo: ArrayLike<number>, outCube: Float64Array): void {
  invariant(inGeo.length === plan.geoCount, 'geoToCubeExtensive: geo count');
  for (let c = 0; c < plan.cubeCount; c++) {
    const g = plan.cubeToGeo[c] as number;
    const a = plan.geoArea[g] as number;
    outCube[c] = a > 0 ? ((inGeo[g] as number) * (plan.cubeArea[c] as number)) / a : 0;
  }
}

/** Intensive geodesic → cube: inject the parent cell's value. */
export function geoToCubeIntensive(plan: ResamplePlan, inGeo: ArrayLike<number>, outCube: Float64Array): void {
  for (let c = 0; c < plan.cubeCount; c++) {
    outCube[c] = inGeo[plan.cubeToGeo[c] as number] as number;
  }
}

export function relativeMassError(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i++) sa += a[i] as number;
  for (let i = 0; i < b.length; i++) sb += b[i] as number;
  const scale = Math.max(Math.abs(sa), Math.abs(sb), 1e-300);
  return Math.abs(sa - sb) / scale;
}
