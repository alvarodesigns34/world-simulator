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
import { cubeDownsampleCategorical, cubeDownsamplePlan, mapCubeCategories, mapCubeToCube, mapGeoToCube } from '@ws/sim';

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

/**
 * T-0093. Categorical reduction: semantics AND complexity.
 *
 * The semantics were already right; the implementation was quadratic. The unit
 * tests only exercised L2 -> L1, so a 9.7e9-comparison reduction at the app's
 * default L8 -> L6 went unnoticed. These tests pin both halves, because either
 * one alone would have let this ship.
 */
describe('T-0093 categorical reduction', () => {
  /**
   * The original implementation, kept verbatim as the reference oracle.
   *
   * Quadratic and therefore only usable on small grids — which is exactly what
   * makes it a good oracle: it is obviously correct by inspection, and the fast
   * path must agree with it on every input.
   */
  function referenceMode(
    plan: ReturnType<typeof cubeDownsamplePlan>,
    src: ArrayLike<number>,
    out: Int32Array,
  ): void {
    const counts = new Map<number, number>();
    for (let d = 0; d < plan.dstCount; d++) {
      counts.clear();
      let winner = 0;
      let winnerCount = -1;
      for (let i = 0; i < plan.srcCount; i++) {
        if ((plan.srcToDst[i] as number) !== d) continue;
        const category = Math.trunc(src[i] as number);
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

  /** Deterministic integer stream; no Math.random in a determinism project. */
  function stream(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) ^ (s >>> 12)) >>> 0;
      s = (Math.imul(s ^ (s >>> 7), 0x297a2d39) ^ (s >>> 15)) >>> 0;
      return s;
    };
  }

  it('agrees with the reference implementation on every label distribution', () => {
    /* Enum-width labels (the dense path), id-width labels (the Map path),
       negative labels, a single label, and labels that force ties. */
    const cases: Array<{ name: string; spans: number; offset: number }> = [
      { name: 'boundary-like enum', spans: 4, offset: 0 },
      { name: 'binary crust-like', spans: 2, offset: 0 },
      { name: 'single label', spans: 1, offset: 7 },
      { name: 'negative labels', spans: 5, offset: -3 },
      { name: 'wide id space (Map path)', spans: 9000, offset: 0 },
    ];
    for (const [srcLevel, dstLevel] of [[3, 1], [4, 2], [4, 1], [3, 3]] as const) {
      const plan = cubeDownsamplePlan(srcLevel, dstLevel);
      for (const c of cases) {
        const next = stream(0x1234 ^ (srcLevel * 31 + dstLevel) ^ c.spans);
        const src = new Int32Array(plan.srcCount);
        for (let i = 0; i < src.length; i++) src[i] = c.offset + (next() % c.spans);
        const fast = new Int32Array(plan.dstCount);
        const slow = new Int32Array(plan.dstCount);
        cubeDownsampleCategorical(plan, src, fast);
        referenceMode(plan, src, slow);
        expect(Array.from(fast), `${c.name} at L${srcLevel}->L${dstLevel}`)
          .toEqual(Array.from(slow));
      }
    }
  });

  it('breaks ties on the lowest label, whatever order the labels arrive in', () => {
    /* Two labels, exactly equal counts, arranged both ways round. The mode is
       ambiguous; the contract says the smaller label wins, and it must not
       depend on which one was seen first. */
    const plan = cubeDownsamplePlan(2, 1);
    const per = plan.srcCount / plan.dstCount;
    expect(per % 2).toBe(0);
    for (const flip of [false, true]) {
      const src = new Int32Array(plan.srcCount);
      for (let d = 0; d < plan.dstCount; d++) {
        for (let k = 0; k < per; k++) {
          const i = plan.childIndex[(plan.childStart[d] as number) + k] as number;
          const first = k < per / 2;
          src[i] = (flip ? !first : first) ? 5 : 9;
        }
      }
      const out = new Int32Array(plan.dstCount);
      cubeDownsampleCategorical(plan, src, out);
      for (let d = 0; d < plan.dstCount; d++) expect(out[d]).toBe(5);
    }
  });

  it('never invents a category that was not in the source', () => {
    /* The whole reason this is a mode and not a mean: averaging boundary types
       1 and 3 produces 2, which is a different boundary. */
    const plan = cubeDownsamplePlan(4, 2);
    const src = new Int32Array(plan.srcCount);
    for (let i = 0; i < src.length; i++) src[i] = i % 2 === 0 ? 1 : 3;
    const out = new Int32Array(plan.dstCount);
    cubeDownsampleCategorical(plan, src, out);
    for (let d = 0; d < plan.dstCount; d++) expect([1, 3]).toContain(out[d] as number);
  });

  it('groups every source cell under exactly one destination, in source order', () => {
    /* The CSR grouping is what makes the reduction linear. If it ever lost or
       duplicated a child, the mode would silently change. */
    const plan = cubeDownsamplePlan(5, 2);
    expect(plan.childStart.length).toBe(plan.dstCount + 1);
    expect(plan.childStart[plan.dstCount]).toBe(plan.srcCount);
    const seen = new Uint8Array(plan.srcCount);
    for (let d = 0; d < plan.dstCount; d++) {
      const from = plan.childStart[d] as number;
      const to = plan.childStart[d + 1] as number;
      expect(to - from).toBe(plan.dstTally[d]);
      for (let k = from; k < to; k++) {
        const i = plan.childIndex[k] as number;
        expect(plan.srcToDst[i]).toBe(d);
        expect(seen[i]).toBe(0);
        seen[i] = 1;
        if (k > from) expect(i).toBeGreaterThan(plan.childIndex[k - 1] as number);
      }
    }
    for (let i = 0; i < plan.srcCount; i++) expect(seen[i]).toBe(1);
  });

  it('reduces the DEFAULT application scale (L8 -> L6) in well under a second', () => {
    /* The regression this exists to catch. The quadratic version took 29.3 s
       for this exact call, and the application makes two of them on every
       geological refresh. A budget of 1 s is ~3 orders of magnitude clear of
       the linear cost and ~30x inside the quadratic one, so it cannot pass by
       accident on a fast machine. */
    const plan = cubeDownsamplePlan(8, 6);
    expect(plan.srcCount).toBe(393_216);
    expect(plan.dstCount).toBe(24_576);
    const src = new Int32Array(plan.srcCount);
    for (let i = 0; i < src.length; i++) src[i] = i % 4;
    const out = new Int32Array(plan.dstCount);
    const t0 = Date.now();
    cubeDownsampleCategorical(plan, src, out);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(1000);
  }, 120000);

  it('scales linearly in the source, not with source x destination', () => {
    /* A direct complexity assertion. Holding the destination fixed and
       quadrupling the source must roughly quadruple the work; under the old
       implementation it quadrupled too — so the discriminating case is holding
       the SOURCE fixed and growing the DESTINATION, which a linear algorithm
       barely notices and a quadratic one scales with. */
    const src = new Int32Array(cubeDownsamplePlan(7, 2).srcCount);
    for (let i = 0; i < src.length; i++) src[i] = i % 3;

    const time = (dstLevel: number): number => {
      const plan = cubeDownsamplePlan(7, dstLevel);
      const out = new Int32Array(plan.dstCount);
      cubeDownsampleCategorical(plan, src, out);
      /* Enough repetitions that Date.now()'s millisecond resolution is not
         what is being measured. */
      const t0 = Date.now();
      for (let r = 0; r < 40; r++) cubeDownsampleCategorical(plan, src, out);
      return (Date.now() - t0) / 40;
    };

    /* 4096x more destinations for the same source. */
    const coarse = time(1);
    const fine = time(7);
    expect(cubeDownsamplePlan(7, 7).dstCount / cubeDownsamplePlan(7, 1).dstCount)
      .toBeGreaterThan(4000);
    /* Linear: within a small constant factor. Quadratic: thousands of times. */
    expect(fine).toBeLessThan(Math.max(coarse * 12, 60));
  }, 120000);
});
