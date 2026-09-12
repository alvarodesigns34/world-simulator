/**
 * Cross-grid spatial coupling (T-0080).
 *
 * M5–M7 live on three different discretisations: climate on the geodesic grid,
 * hydrology on a cube-sphere level, geology on the coarser genesis cube level.
 * Moving a field between them by PROPORTIONAL INDEXING —
 * `src[floor(i * srcLen / dstLen)]` — is not a resampling, it is a reinterpret.
 * Two grids with different cell orderings will map Africa's rainfall onto an
 * arbitrary other region, and the error is invisible because the array shapes
 * agree.
 *
 * These helpers do the coordinate-aware mapping instead, reusing the plan
 * infrastructure the project already has:
 *
 *   geodesic -> cube    `resamplePlan` + `geoToCubeIntensive` (DEC-008)
 *   cube L_a -> cube L_b   quadtree ancestry: a cell at the finer level is
 *                       contained by exactly one cell at the coarser level, so
 *                       the mapping is `(face, x >> d, y >> d)`.
 *
 * Plans are cached by (srcLevel, dstLevel) because they are pure functions of
 * the grid pair, and building one is O(cells).
 */

import { cubeDim, cubeIndex } from '@ws/data';
import { geoToCubeIntensive, resamplePlan } from '@ws/data';

/** Finer-cube-cell -> coarser-cube-cell index map, and the count per coarse cell. */
export interface CubeDownsamplePlan {
  readonly srcLevel: number;
  readonly dstLevel: number;
  readonly srcCount: number;
  readonly dstCount: number;
  readonly srcToDst: Int32Array;
  readonly dstTally: Int32Array;
}

const DOWN_PLANS = new Map<string, CubeDownsamplePlan>();

/**
 * Build (or reuse) the ancestry map from a finer cube level to a coarser one.
 * `srcLevel >= dstLevel` is required: aggregating downward is well defined,
 * inventing detail upward is not.
 */
export function cubeDownsamplePlan(srcLevel: number, dstLevel: number): CubeDownsamplePlan {
  if (srcLevel < dstLevel) {
    throw new Error(
      `cubeDownsamplePlan: source level ${String(srcLevel)} is coarser than target ` +
        `${String(dstLevel)}; upsampling needs interpolation, not ancestry`,
    );
  }
  const key = `${srcLevel}>${dstLevel}`;
  const hit = DOWN_PLANS.get(key);
  if (hit !== undefined) return hit;

  const srcDim = cubeDim(srcLevel);
  const shift = srcLevel - dstLevel;
  const srcCount = 6 * srcDim * srcDim;
  const dstDim = cubeDim(dstLevel);
  const dstCount = 6 * dstDim * dstDim;

  const srcToDst = new Int32Array(srcCount);
  const dstTally = new Int32Array(dstCount);
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < srcDim; y++) {
      for (let x = 0; x < srcDim; x++) {
        const si = cubeIndex(face, srcLevel, x, y);
        const di = cubeIndex(face, dstLevel, x >> shift, y >> shift);
        srcToDst[si] = di;
        dstTally[di] = (dstTally[di] as number) + 1;
      }
    }
  }

  const plan: CubeDownsamplePlan = { srcLevel, dstLevel, srcCount, dstCount, srcToDst, dstTally };
  DOWN_PLANS.set(key, plan);
  return plan;
}

/**
 * Area-mean a finer cube field onto a coarser cube grid.
 *
 * Intensive (a rate, a temperature): the coarse value is the mean of the fine
 * values it contains, so units are preserved.
 */
export function cubeDownsampleIntensive(
  plan: CubeDownsamplePlan,
  src: ArrayLike<number>,
  out: Float64Array,
): void {
  out.fill(0);
  for (let i = 0; i < plan.srcCount; i++) {
    const d = plan.srcToDst[i] as number;
    out[d] = (out[d] as number) + (src[i] as number);
  }
  for (let d = 0; d < plan.dstCount; d++) {
    const n = plan.dstTally[d] as number;
    if (n > 0) out[d] = (out[d] as number) / n;
  }
}

/**
 * Inject a coarser cube field onto a finer cube grid.
 *
 * Each fine cell takes the value of the unique coarse cell that contains it.
 * This is piecewise-constant, not interpolation: it invents no detail and it
 * preserves the area-mean exactly, which is what an intensive forcing needs.
 * (Bilinear would be smoother but would also cross face seams, and DEC-035's
 * face orientations make that a separate problem — one this coupling does not
 * need to solve to be correct.)
 */
export function cubeUpsampleInject(
  plan: CubeDownsamplePlan,
  src: ArrayLike<number>,
  out: Float64Array,
): void {
  /* `plan` maps fine -> coarse; injecting is the same map read backwards. */
  for (let i = 0; i < plan.srcCount; i++) {
    out[i] = src[plan.srcToDst[i] as number] as number;
  }
}

/**
 * Move an intensive cube field between cube levels in either direction.
 *
 * Same level      -> copy.
 * Finer -> coarser -> area-mean (aggregation).
 * Coarser -> finer -> ancestry injection.
 *
 * The direction matters and is decided here rather than by the caller, because
 * the caller does not always statically know which grid is finer: hydrology
 * runs at `min(6, geology.level)`, so runoff can be at, below, or equal to the
 * geology level depending on world configuration.
 */
export function mapCubeToCube(
  src: ArrayLike<number>,
  srcLevel: number,
  dstLevel: number,
  out: Float64Array,
): void {
  if (srcLevel === dstLevel) {
    for (let i = 0; i < out.length; i++) out[i] = src[i] as number;
    return;
  }
  if (srcLevel > dstLevel) {
    cubeDownsampleIntensive(cubeDownsamplePlan(srcLevel, dstLevel), src, out);
    return;
  }
  cubeUpsampleInject(cubeDownsamplePlan(dstLevel, srcLevel), src, out);
}

/** Geodesic (climate) -> cube (geology/hydrology), area-weighted and intensive. */
export function mapGeoToCube(
  src: ArrayLike<number>,
  geodesicN: number,
  cubeLevel: number,
  out: Float64Array,
): void {
  geoToCubeIntensive(resamplePlan(cubeLevel, geodesicN), src, out);
}

/**
 * Scratch buffers keyed by length, so the per-step coupling allocates nothing
 * after the first call. Deterministic: contents are always fully overwritten
 * before use.
 */
const SCRATCH = new Map<number, Float64Array>();

export function couplingScratch(length: number): Float64Array {
  const hit = SCRATCH.get(length);
  if (hit !== undefined) return hit;
  const buf = new Float64Array(length);
  SCRATCH.set(length, buf);
  return buf;
}
