/**
 * T-0080. Cross-grid coupling must be coordinate-aware.
 *
 * The defect these tests exist to prevent is proportional indexing:
 *
 *   src[Math.floor(i * src.length / dst.length)]
 *
 * which type-checks, produces plausible-looking output, conserves nothing, and
 * silently erodes the wrong continent. It is invisible to any test that only
 * checks array shape, finiteness, or a global mean — so every test here is
 * spatial.
 */

import { describe, expect, it } from 'vitest';
import {
  cubeDim,
  cubeFaceToUnitRaw,
  cubeIndex,
  geodesicGrid,
} from '@ws/data';
import { cubeDownsamplePlan, mapCubeCategories, mapCubeToCube, mapGeoToCube } from '@ws/sim';

/** Unit-sphere centre of a cube cell. */
function cubeCentre(face: number, level: number, x: number, y: number) {
  const n = cubeDim(level);
  return cubeFaceToUnitRaw(face, (x + 0.5) / n, (y + 0.5) / n);
}

/** Proportional indexing — the defect, kept here as the control. */
function proportional(src: ArrayLike<number>, out: Float64Array): void {
  for (let i = 0; i < out.length; i++) {
    out[i] = src[Math.floor((i * src.length) / out.length)] as number;
  }
}

describe('T-0080 cross-grid spatial coupling', () => {
  it('lands a geodesic field on the cube cell that occupies the same place', () => {
    /* Forcing = the x-component of position. Smooth, planetary, and its value
       at any point is knowable independently of any grid, so the mapping can
       be checked pointwise rather than in aggregate. */
    const n = 6;
    const level = 4;
    const grid = geodesicGrid(n);
    const src = new Float64Array(grid.cellCount);
    for (let i = 0; i < grid.cellCount; i++) src[i] = grid.positions[i * 3] as number;

    const dim = cubeDim(level);
    const out = new Float64Array(6 * dim * dim);
    mapGeoToCube(src, n, level, out);

    let worst = 0;
    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < dim; y++) {
        for (let x = 0; x < dim; x++) {
          const want = cubeCentre(face, level, x, y).x;
          const got = out[cubeIndex(face, level, x, y)] as number;
          worst = Math.max(worst, Math.abs(got - want));
        }
      }
    }
    /* Piecewise-constant injection from an n=8 geodesic grid: the error is
       bounded by how much x varies across one geodesic cell. */
    expect(worst).toBeLessThan(0.25);

    /* The control: proportional indexing puts the wrong hemisphere's value in
       roughly half the cells. */
    const bad = new Float64Array(out.length);
    proportional(src, bad);
    let worstBad = 0;
    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < dim; y++) {
        for (let x = 0; x < dim; x++) {
          const want = cubeCentre(face, level, x, y).x;
          worstBad = Math.max(worstBad, Math.abs((bad[cubeIndex(face, level, x, y)] as number) - want));
        }
      }
    }
    expect(worstBad).toBeGreaterThan(1.0);
  });

  it('preserves position when aggregating a finer cube onto a coarser one', () => {
    const src = 6;
    const dst = 3;
    const srcDim = cubeDim(src);
    const dstDim = cubeDim(dst);
    const a = new Float64Array(6 * srcDim * srcDim);
    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < srcDim; y++) {
        for (let x = 0; x < srcDim; x++) {
          a[cubeIndex(face, src, x, y)] = cubeCentre(face, src, x, y).z;
        }
      }
    }
    const out = new Float64Array(6 * dstDim * dstDim);
    mapCubeToCube(a, src, dst, out);
    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < dstDim; y++) {
        for (let x = 0; x < dstDim; x++) {
          const want = cubeCentre(face, dst, x, y).z;
          expect(out[cubeIndex(face, dst, x, y)] as number).toBeCloseTo(want, 1);
        }
      }
    }
  });

  it('injects a coarser cube onto a finer one without moving the field', () => {
    /* Hydrology runs at min(6, geology.level), so runoff can be COARSER than
       geology. That direction must work, not throw and not transpose. */
    const src = 3;
    const dst = 5;
    const srcDim = cubeDim(src);
    const dstDim = cubeDim(dst);
    const a = new Float64Array(6 * srcDim * srcDim);
    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < srcDim; y++) {
        for (let x = 0; x < srcDim; x++) a[cubeIndex(face, src, x, y)] = cubeCentre(face, src, x, y).y;
      }
    }
    const out = new Float64Array(6 * dstDim * dstDim);
    mapCubeToCube(a, src, dst, out);
    let worst = 0;
    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < dstDim; y++) {
        for (let x = 0; x < dstDim; x++) {
          worst = Math.max(worst, Math.abs(
            (out[cubeIndex(face, dst, x, y)] as number) - cubeCentre(face, dst, x, y).y));
        }
      }
    }
    expect(worst).toBeLessThan(0.35);
  });

  it('round-trips a constant through both cube directions exactly', () => {
    for (const [a, b] of [[5, 3], [3, 5], [4, 4]] as const) {
      const dimA = cubeDim(a);
      const dimB = cubeDim(b);
      const src = new Float64Array(6 * dimA * dimA).fill(7.25);
      const out = new Float64Array(6 * dimB * dimB);
      mapCubeToCube(src, a, b, out);
      for (let i = 0; i < out.length; i++) expect(out[i] as number).toBe(7.25);
    }
  });

  it('refuses to fabricate an ancestry map in the wrong direction', () => {
    expect(() => cubeDownsamplePlan(2, 5)).toThrow(/coarser/);
  });

  it('partitions every fine cell into exactly one coarse ancestor', () => {
    const plan = cubeDownsamplePlan(5, 2);
    let tallied = 0;
    for (let d = 0; d < plan.dstCount; d++) tallied += plan.dstTally[d] as number;
    expect(tallied).toBe(plan.srcCount);
    /* Uniform refinement: every coarse cell owns the same 4^(5-2) fine cells. */
    for (let d = 0; d < plan.dstCount; d++) expect(plan.dstTally[d]).toBe(4 ** 3);
  });

  it('reduces categories by mode and never invents an enum value', () => {
    const srcLevel = 2;
    const dstLevel = 1;
    const src = new Uint8Array(6 * cubeDim(srcLevel) ** 2);
    const plan = cubeDownsamplePlan(srcLevel, dstLevel);
    for (let i = 0; i < plan.srcCount; i++) {
      const ancestor = plan.srcToDst[i] as number;
      src[i] = i % 4 === 0 ? 3 : ancestor % 2 === 0 ? 1 : 2;
    }
    const out = new Int32Array(plan.dstCount);
    mapCubeCategories(src, srcLevel, dstLevel, out);
    for (let i = 0; i < out.length; i++) {
      expect([1, 2]).toContain(out[i] as number);
    }
  });

  it('resolves categorical ties deterministically to the smallest id', () => {
    const srcLevel = 1;
    const dstLevel = 0;
    const src = new Uint8Array(6 * cubeDim(srcLevel) ** 2);
    for (let i = 0; i < src.length; i += 4) src.set([7, 4, 7, 4], i);
    const a = new Int32Array(6);
    const b = new Int32Array(6);
    mapCubeCategories(src, srcLevel, dstLevel, a);
    mapCubeCategories(src, srcLevel, dstLevel, b);
    expect([...a]).toEqual([4, 4, 4, 4, 4, 4]);
    expect([...b]).toEqual([...a]);
  });
});
