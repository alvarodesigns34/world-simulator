import { describe, expect, it } from 'vitest';
import { EARTH_GEOMETRY, cubeFaceToUnit, quadkey, cellSize } from '@ws/data';
import { arcSagitta, bilinearSag, makeNode } from '@ws/render';

const P = EARTH_GEOMETRY;
const R = P.radius;

/** Max radial deviation of the rendered bilinear quad, sampled densely. */
function measuredDeviation(face: number, level: number, x: number, y: number, n = 24): number {
  const key = quadkey.quadKey(face, level, x, y);
  const [u0, v0, u1, v1] = quadkey.bounds(key);
  const c = (u: number, v: number): readonly [number, number, number] => {
    const p = cubeFaceToUnit({ face, u, v });
    return [p.x * R, p.y * R, p.z * R];
  };
  const a00 = c(u0, v0), a10 = c(u1, v0), a01 = c(u0, v1), a11 = c(u1, v1);
  let worst = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const s = i / n, t = j / n;
      const A = [0, 1, 2].map((k) => a00[k]! + (a10[k]! - a00[k]!) * s);
      const B = [0, 1, 2].map((k) => a01[k]! + (a11[k]! - a01[k]!) * s);
      const Q = [0, 1, 2].map((k) => A[k]! + (B[k]! - A[k]!) * t);
      worst = Math.max(worst, R - Math.hypot(Q[0]!, Q[1]!, Q[2]!));
    }
  }
  return worst;
}

/**
 * BILINEAR SAG (T-0063).
 *
 * The shader interpolates four sphere corners bilinearly, so the drawn surface
 * is a bilinear quad and its interior falls INSIDE the sphere. Grok flagged
 * this; these tests put numbers on it and pin the error model that depends on
 * them.
 */
describe('bilinear sag: the drawn surface is inside the sphere', () => {
  it('matches the closed form R·sin²(θ/2) across every face', () => {
    // `cellSize` is the MEAN cell arc; the tangent warp leaves a residual ~1.30x
    // spread in cell AREA (~1.14x linear), so individual cells deviate a little
    // either side of the closed form. The band below is that spread, measured —
    // it is not a fudge factor, and a mapping change would break it.
    for (const level of [4, 6, 8, 10]) {
      const predicted = bilinearSag(level, P);
      let lo = Infinity;
      let hi = 0;
      for (let face = 0; face < 6; face++) {
        const n = 2 ** level;
        for (const [x, y] of [[0, 0], [n >> 1, n >> 1], [n - 1, 0], [n - 1, n - 1]] as const) {
          const d = measuredDeviation(face, level, x, y, 12);
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
      }
      // The largest cell is within a fraction of a percent of the closed form,
      // and no cell exceeds it — so the model is a valid upper bound on error.
      expect(hi / predicted).toBeGreaterThan(0.99);
      expect(hi / predicted).toBeLessThan(1.01);
      expect(lo / predicted).toBeGreaterThan(0.7);
    }
  });

  it('is exactly twice the arc sagitta — the factor the old model missed', () => {
    for (const level of [6, 8, 10, 12]) {
      expect(bilinearSag(level, P) / arcSagitta(level, P)).toBeCloseTo(2, 3);
    }
  });

  it('the node error model reports the bilinear sag, not the arc sagitta', () => {
    for (const level of [4, 6, 8, 10]) {
      const node = makeNode(quadkey.quadKey(0, level, 0, 0), P);
      expect(node.geometricError).toBeCloseTo(bilinearSag(level, P), 6);
      expect(node.geometricError).toBeGreaterThan(arcSagitta(level, P) * 1.9);
    }
  });

  /** Reference table, so a future change to the mapping shows up as a number. */
  it('has the documented magnitudes', () => {
    const expected: Record<number, number> = {
      4: 15339, // 15.3 km
      6: 959, //  959 m
      8: 60, //   60 m
      10: 3.75, //  3.7 m
      12: 0.234, // 23 cm
      14: 0.0146, // 1.5 cm
    };
    for (const [levelStr, metres] of Object.entries(expected)) {
      const got = bilinearSag(Number(levelStr), P);
      expect(got / metres).toBeGreaterThan(0.98);
      expect(got / metres).toBeLessThan(1.02);
    }
  });
});

/**
 * The consequence that matters for M2 and for the E1 benchmark: every vertex of
 * an n×n patch lies on the SAME bilinear quad, so raising `patchVerticesPerSide`
 * buys no geometric accuracy at all. Accuracy comes only from splitting patches.
 *
 * This is pinned deliberately. When M2 introduces spherical interpolation the
 * test must be updated, and that update is the record that tessellation started
 * paying for itself.
 */
describe('tessellation is currently geometrically inert', () => {
  it('a 65×65 patch deviates exactly as much as a 2×2 patch', () => {
    // Deviation is a property of the four corners, not of the grid between
    // them, so sampling at any density gives the same worst value.
    for (const level of [6, 8]) {
      const coarse = measuredDeviation(4, level, 0, 0, 2);
      const fine = measuredDeviation(4, level, 0, 0, 64);
      // A 2-sample grid hits the centre, which is the worst point.
      expect(fine / coarse).toBeGreaterThan(0.999);
      expect(fine / coarse).toBeLessThan(1.001);
    }
  });

  it('splitting one level quarters the deviation — the only lever there is', () => {
    for (const level of [6, 8, 10]) {
      expect(bilinearSag(level, P) / bilinearSag(level + 1, P)).toBeCloseTo(4, 1);
    }
  });
});

describe('cell size reference', () => {
  it('matches the documented arc lengths', () => {
    expect(cellSize(0, P)).toBeCloseTo(10_007_543, 0);
    expect(cellSize(12, P)).toBeCloseTo(2443.2, 1);
  });
});
