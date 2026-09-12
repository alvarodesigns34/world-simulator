/**
 * @tier A
 *
 * Stream-power erosion + hillslope diffusion (T-0031).
 *
 * Run at genesis resolution (L6) plus one L8 refinement. Full L11 stream-power
 * over 25 M cells is a 60 s budget by itself; that is documented, not faked.
 *
 *   dh/dt = U − K A^m S^n + κ ∇²h
 *
 * Drainage uses 4-connected steepest descent with seam neighbours (T-0020).
 * Depressions get a few pit-fill iterations so flow can escape; full
 * priority-flood is T-0032 / M5.
 */

import { DOMAIN, hashFloat01x64, type Seed, pow } from '@ws/core';
import { cubeDim, cubeIndex, neighbor, DIR, type CubeCell } from '@ws/data';

export interface ErosionConfig {
  readonly steps: number;
  readonly K: number;
  readonly m: number;
  readonly n: number;
  readonly kappa: number;
  readonly fillPasses: number;
}

export const DEFAULT_EROSION: ErosionConfig = {
  steps: 12,
  K: 1.5e-6,
  m: 0.5,
  n: 1,
  kappa: 0.08,
  fillPasses: 4,
};

const DIRS = [DIR.POS_U, DIR.NEG_U, DIR.POS_V, DIR.NEG_V] as const;

export function erode(
  elevation: Float32Array,
  level: number,
  cfg: ErosionConfig = DEFAULT_EROSION,
): Float32Array {
  const n = cubeDim(level);
  const cells = elevation.length;
  const h = elevation;
  const acc = new Float32Array(cells);
  const sink = new Int32Array(cells);

  for (let step = 0; step < cfg.steps; step++) {
    pitFill(h, level, n, cfg.fillPasses);
    steepest(h, level, n, sink);
    accumulate(sink, acc);
    streamPower(h, acc, sink, cfg);
    diffuse(h, level, n, cfg.kappa);
  }
  return h;
}

function pitFill(h: Float32Array, level: number, n: number, passes: number): void {
  for (let p = 0; p < passes; p++) {
    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = cubeIndex(face, level, x, y);
          let minN = h[i] as number;
          const cell: CubeCell = { face, x, y };
          for (const d of DIRS) {
            const nb = neighbor(cell, level, d);
            const j = cubeIndex(nb.face, level, nb.x, nb.y);
            const hj = h[j] as number;
            if (hj < minN) minN = hj;
          }
          const hi = h[i] as number;
          if (hi + 2 < minN) h[i] = minN - 1;
        }
      }
    }
  }
}

function steepest(h: Float32Array, level: number, n: number, sink: Int32Array): void {
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = cubeIndex(face, level, x, y);
        let best = i;
        let bestH = h[i] as number;
        const cell: CubeCell = { face, x, y };
        for (const d of DIRS) {
          const nb = neighbor(cell, level, d);
          const j = cubeIndex(nb.face, level, nb.x, nb.y);
          const hj = h[j] as number;
          if (hj < bestH) {
            bestH = hj;
            best = j;
          }
        }
        sink[i] = best;
      }
    }
  }
}

function accumulate(sink: Int32Array, acc: Float32Array): void {
  acc.fill(1);
  /* Multiple sweeps, cell-index order. Not as good as topological order but
     deterministic and cheap. 8 sweeps drain L6. */
  for (let sweep = 0; sweep < 8; sweep++) {
    for (let i = 0; i < sink.length; i++) {
      const s = sink[i] as number;
      if (s !== i) acc[s] = (acc[s] as number) + (acc[i] as number) * 0.25;
    }
  }
}

function streamPower(h: Float32Array, acc: Float32Array, sink: Int32Array, cfg: ErosionConfig): void {
  for (let i = 0; i < h.length; i++) {
    const s = sink[i] as number;
    if (s === i) continue;
    const slope = (h[i] as number) - (h[s] as number);
    if (slope <= 0) continue;
    const A = acc[i] as number;
    const dh = cfg.K * pow(A, cfg.m) * pow(slope, cfg.n);
    const cut = dh > slope * 0.4 ? slope * 0.4 : dh;
    h[i] = (h[i] as number) - cut;
  }
}

function diffuse(h: Float32Array, level: number, n: number, kappa: number): void {
  const tmp = new Float32Array(h.length);
  tmp.set(h);
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = cubeIndex(face, level, x, y);
        let lap = 0;
        let c = 0;
        const cell: CubeCell = { face, x, y };
        for (const d of DIRS) {
          const nb = neighbor(cell, level, d);
          const j = cubeIndex(nb.face, level, nb.x, nb.y);
          lap += tmp[j] as number;
          c++;
        }
        h[i] = (tmp[i] as number) + kappa * (lap / c - (tmp[i] as number));
      }
    }
  }
}

/**
 * Sub-grid relief hashed from (seed, face, x, y). Mean-zero over a parent cell
 * so it cannot invent mountain belts the plates did not produce (DEC-026).
 */
export function detailNoise(seed: Seed, face: number, x: number, y: number, metres: number): number {
  const u = hashFloat01x64(seed, DOMAIN.TERRAIN_DETAIL, face, x, y);
  return (u * 2 - 1) * metres;
}
