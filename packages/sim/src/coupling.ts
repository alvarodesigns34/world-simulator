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
  /**
   * Children of each destination, grouped (CSR layout).
   *
   * `childIndex[childStart[d] .. childStart[d + 1])` are the source cells that
   * reduce into destination `d`, in ascending source order.
   *
   * This exists so a reduction that needs to look at one destination's children
   * — the categorical mode, which cannot be accumulated commutatively the way a
   * sum can — does not have to rescan the whole source array per destination.
   * Built once per level pair, in O(srcCount), and cached with the plan.
   */
  readonly childStart: Int32Array;
  readonly childIndex: Int32Array;
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

  /* CSR grouping: prefix-sum the tally, then place each source cell. Two
     linear passes, no sort, and the ascending-source order within a destination
     is what keeps the categorical tie-break identical to a full scan. */
  const childStart = new Int32Array(dstCount + 1);
  for (let d = 0; d < dstCount; d++) {
    childStart[d + 1] = (childStart[d] as number) + (dstTally[d] as number);
  }
  const childIndex = new Int32Array(srcCount);
  const cursor = new Int32Array(dstCount);
  for (let i = 0; i < srcCount; i++) {
    const d = srcToDst[i] as number;
    childIndex[(childStart[d] as number) + (cursor[d] as number)] = i;
    cursor[d] = (cursor[d] as number) + 1;
  }

  const plan: CubeDownsamplePlan = {
    srcLevel, dstLevel, srcCount, dstCount, srcToDst, dstTally, childStart, childIndex,
  };
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
 * Reduce a categorical cube field by deterministic mode.
 *
 * Category identifiers are labels, not magnitudes: averaging boundary type
 * 1 and 3 into 2 invents a category that never existed.  Equal-frequency
 * ties are resolved to the numerically smallest label so the result is
 * independent of traversal and worker order.
 *
 * COMPLEXITY (T-0093). The first version of this was correct and quadratic: for
 * each destination it rescanned every source cell looking for its own children,
 * giving O(srcCount x dstCount). The unit tests used L2 -> L1 — 96 x 24 cells —
 * so nothing showed. At the application's DEFAULT configuration the same call
 * is L8 -> L6, which is 393,216 x 24,576 = 9.7e9 comparisons, and
 * `refreshResources` makes two of them (boundaryType and crustType) on every
 * geological refresh. Measured: **29.3 s per reduction**, so roughly a minute of
 * the default world's construction, repeated on every geology step.
 *
 * It is now O(srcCount): the plan's CSR grouping gives each destination its own
 * children directly, so every source cell is visited exactly once in total. The
 * counting table is dense when the label range is small — which is the real case
 * for enums like boundaryType (0..3) and crustType (0..1) — and only the labels
 * actually touched are reset, so clearing costs no more than counting.
 *
 * The tie-break is preserved EXACTLY, including its incremental form: children
 * are visited in ascending source order, the running argmax is updated with the
 * same comparison, and the result is therefore identical to the old scan's for
 * every input.
 */

/** Label range above which the dense counting table stops being worthwhile. */
const DENSE_LABEL_LIMIT = 4096;

/* Reused across calls so a per-tick reduction allocates nothing. */
let denseCounts: Int32Array = new Int32Array(0);
let denseTouched: Int32Array = new Int32Array(0);

export function cubeDownsampleCategorical(
  plan: CubeDownsamplePlan,
  src: ArrayLike<number>,
  out: Int32Array | Float64Array,
): void {
  const { childStart, childIndex, dstCount } = plan;

  /* One pass to size the counting table. Enum fields land in a handful of
     labels; ids like basin or territory can be wide, hence the fallback. */
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < plan.srcCount; i++) {
    const c = Math.trunc(src[i] as number);
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    out.fill(0);
    return;
  }
  const span = hi - lo + 1;

  if (span <= DENSE_LABEL_LIMIT) {
    if (denseCounts.length < span) denseCounts = new Int32Array(span);
    if (denseTouched.length < span) denseTouched = new Int32Array(span);
    const counts = denseCounts;
    const touched = denseTouched;
    for (let d = 0; d < dstCount; d++) {
      const from = childStart[d] as number;
      const to = childStart[d + 1] as number;
      if (from === to) { out[d] = 0; continue; }
      let nTouched = 0;
      let winner = 0;
      let winnerCount = -1;
      for (let k = from; k < to; k++) {
        const category = Math.trunc(src[childIndex[k] as number] as number);
        const slot = category - lo;
        const count = (counts[slot] as number) + 1;
        if (count === 1) { touched[nTouched] = slot; nTouched++; }
        counts[slot] = count;
        if (count > winnerCount || (count === winnerCount && category < winner)) {
          winner = category;
          winnerCount = count;
        }
      }
      /* Reset only what was used: O(children), not O(span). */
      for (let t = 0; t < nTouched; t++) counts[touched[t] as number] = 0;
      out[d] = winner;
    }
    return;
  }

  /* Wide, sparse label space (ids rather than enums). Same algorithm with a
     Map; still one visit per source cell, still the same tie-break. */
  const counts = new Map<number, number>();
  for (let d = 0; d < dstCount; d++) {
    const from = childStart[d] as number;
    const to = childStart[d + 1] as number;
    if (from === to) { out[d] = 0; continue; }
    counts.clear();
    let winner = 0;
    let winnerCount = -1;
    for (let k = from; k < to; k++) {
      const category = Math.trunc(src[childIndex[k] as number] as number);
      const count = (counts.get(category) ?? 0) + 1;
      counts.set(category, count);
      if (count > winnerCount || (count === winnerCount && category < winner)) {
        winner = category;
        winnerCount = count;
      }
    }
    out[d] = winner;
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

/**
 * Move category labels between cube levels without continuous interpolation.
 * Downsampling uses the mode; upsampling uses the unique ancestor label.
 */
export function mapCubeCategories(
  src: ArrayLike<number>,
  srcLevel: number,
  dstLevel: number,
  out: Int32Array | Float64Array,
): void {
  if (srcLevel === dstLevel) {
    for (let i = 0; i < out.length; i++) out[i] = Math.trunc(src[i] as number);
    return;
  }
  if (srcLevel > dstLevel) {
    cubeDownsampleCategorical(cubeDownsamplePlan(srcLevel, dstLevel), src, out);
    return;
  }
  cubeUpsampleInject(cubeDownsamplePlan(dstLevel, srcLevel), src, out as Float64Array);
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
