/**
 * @tier A
 *
 * The seam between a city's local metre grid and the planet.
 *
 * A city is a few kilometres across; a cube cell at the civilisation grid's
 * resolution is hundreds of kilometres. Sampling the nearest cell would make
 * every city perfectly flat and dry, which would make the whole of `layout.ts`
 * decorative — no grades, no bridges, no reason for a street to bend.
 *
 * So this file does two things that matter:
 *
 *   1. ELEVATION is bilinear across the cube face, not nearest-cell, so a city
 *      on a slope actually sits on a slope.
 *   2. WATER is reconstructed at sub-cell scale from M5's own routing. The
 *      river through a cell is the line joining its largest upstream tributary,
 *      the cell centre and its receiver, with the width M5 computed. That is a
 *      real river in a real place, derived from authoritative state — not a
 *      decorative squiggle, and it is what puts bridges where bridges belong.
 */

import { cubeDim, cubeFaceToUnitRaw, cubeIndex, pcf, unitToCubeFace, DIR, neighbor } from '@ws/data';
import type { HydrologyState } from '../hydrology/system.js';
import { cos, sin } from '@ws/core';
import type { TerrainSampler } from './layout.js';

const RADIUS_M = 6_371_000;
const DIRS = [DIR.POS_U, DIR.NEG_U, DIR.POS_V, DIR.NEG_V] as const;

/** Local east/north basis at a point on the sphere, in planet-fixed coords. */
export interface LocalFrame {
  readonly ox: number; readonly oy: number; readonly oz: number;
  readonly ex: number; readonly ey: number; readonly ez: number;
  readonly nx: number; readonly ny: number; readonly nz: number;
}

export function localFrameAtCell(cell: number, level: number): LocalFrame {
  const n = cubeDim(level);
  const face = Math.floor(cell / (n * n));
  const local = cell - face * n * n;
  const y = Math.floor(local / n);
  const x = local - y * n;
  const u = cubeFaceToUnitRaw(face, (x + 0.5) / n, (y + 0.5) / n);

  /* East is "along a parallel". At the poles that is degenerate, so fall back
     to a fixed axis rather than producing NaN — a polar city is rare but must
     not corrupt the frame. */
  let ex = -u.y;
  let ey = u.x;
  let ez = 0;
  let m = Math.sqrt(ex * ex + ey * ey);
  if (!(m > 1e-9)) { ex = 1; ey = 0; ez = 0; m = 1; }
  ex /= m; ey /= m; ez /= m;
  /* North = up x east, so (east, north, up) is right-handed. */
  const nx = u.y * ez - u.z * ey;
  const ny = u.z * ex - u.x * ez;
  const nz = u.x * ey - u.y * ex;
  return { ox: u.x, oy: u.y, oz: u.z, ex, ey, ez, nx, ny, nz };
}

/** Local ENU metres -> unit vector on the sphere. */
function localToUnit(f: LocalFrame, x: number, y: number): { x: number; y: number; z: number } {
  const s = 1 / RADIUS_M;
  let px = f.ox + (f.ex * x + f.nx * y) * s;
  let py = f.oy + (f.ey * x + f.ny * y) * s;
  let pz = f.oz + (f.ez * x + f.nz * y) * s;
  const inv = 1 / Math.sqrt(px * px + py * py + pz * pz);
  px *= inv; py *= inv; pz *= inv;
  return { x: px, y: py, z: pz };
}

/** Unit vector -> local ENU metres. Inverse of the above to first order. */
function unitToLocal(f: LocalFrame, x: number, y: number, z: number): { x: number; y: number } {
  const dx = x - f.ox;
  const dy = y - f.oy;
  const dz = z - f.oz;
  return {
    x: (dx * f.ex + dy * f.ey + dz * f.ez) * RADIUS_M,
    y: (dx * f.nx + dy * f.ny + dz * f.nz) * RADIUS_M,
  };
}

/** Bilinear sample of a cube-grid field at a unit direction. */
function sampleBilinear(field: ArrayLike<number>, level: number, px: number, py: number, pz: number): number {
  const c = unitToCubeFace(pcf(px, py, pz));
  const n = cubeDim(level);
  /* Cell centres sit at (i + 0.5)/n, so the continuous index is u*n - 0.5. */
  const fx = c.u * n - 0.5;
  const fy = c.v * n - 0.5;
  const x0 = Math.max(0, Math.min(n - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(n - 1, Math.floor(fy)));
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const f = c.face;
  const v00 = field[cubeIndex(f, level, x0, y0)] as number;
  const v10 = field[cubeIndex(f, level, x1, y0)] as number;
  const v01 = field[cubeIndex(f, level, x0, y1)] as number;
  const v11 = field[cubeIndex(f, level, x1, y1)] as number;
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

interface Channel {
  /** Polyline in local metres, 2 floats per point. */
  readonly pts: Float64Array;
  readonly halfWidthM: number;
}

/**
 * Reconstruct the river through a cell from M5's flow routing.
 *
 * The channel runs from the largest upstream tributary through the cell centre
 * to the receiver. Nothing here is invented: the direction is M5's `receiver`
 * link, the width is the same formula `buildRivers` uses on discharge (NOT
 * `rivers.width[cell]` — that array is edge-indexed). A cell with no meaningful
 * discharge gets no channel at all.
 */
function channelAt(h: HydrologyState, cell: number): Channel | null {
  const discharge = h.dischargeM3s[cell] as number;
  if (!(discharge > 1)) return null;
  const width = Math.max(1, Math.sqrt(discharge) * 2.5);

  const f = localFrameAtCell(cell, h.level);
  const n = cubeDim(h.level);
  const face = Math.floor(cell / (n * n));
  const loc = cell - face * n * n;
  const cy = Math.floor(loc / n);
  const cx = loc - cy * n;

  const centreOf = (idx: number): { x: number; y: number } => {
    const ff = Math.floor(idx / (n * n));
    const ll = idx - ff * n * n;
    const yy = Math.floor(ll / n);
    const xx = ll - yy * n;
    const u = cubeFaceToUnitRaw(ff, (xx + 0.5) / n, (yy + 0.5) / n);
    return unitToLocal(f, u.x, u.y, u.z);
  };

  /* Downstream: half-way to the receiver. */
  const recv = h.receiver[cell] as number;
  const down = recv >= 0 ? centreOf(recv) : { x: 0, y: 0 };

  /* Upstream: the neighbour that drains INTO this cell with the most water. */
  let bestUp = -1;
  let bestQ = 0;
  for (const d of DIRS) {
    const nb = neighbor({ face, x: cx, y: cy }, h.level, d);
    const j = cubeIndex(nb.face, h.level, nb.x, nb.y);
    if (h.receiver[j] !== cell) continue;
    const q = h.dischargeM3s[j] as number;
    /* Ties break on the lower cell index so the channel is a function of the
       state, not of neighbour iteration order (DEC-017). */
    if (q > bestQ || (q === bestQ && bestUp >= 0 && j < bestUp)) { bestQ = q; bestUp = j; }
  }
  const up = bestUp >= 0 ? centreOf(bestUp) : { x: -down.x, y: -down.y };

  const pts = new Float64Array([up.x * 0.5, up.y * 0.5, 0, 0, down.x * 0.5, down.y * 0.5]);
  return { pts, halfWidthM: Math.max(4, width * 0.5) };
}

function distanceToPolyline(pts: Float64Array, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i] as number, ay = pts[i + 1] as number;
    const bx = pts[i + 2] as number, by = pts[i + 3] as number;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t - x;
    const py = ay + dy * t - y;
    const d = Math.sqrt(px * px + py * py);
    if (d < best) best = d;
  }
  return best;
}

/**
 * A `TerrainSampler` for a city sitting on cell `cell`.
 *
 * Captures the fields by reference, so it reflects the world as it is when
 * sampled. A layout built from it is only valid while that state holds, which
 * is exactly why `CityState.layoutGeneration` exists.
 */
export function cityTerrainSampler(h: HydrologyState, cell: number): TerrainSampler {
  const frame = localFrameAtCell(cell, h.level);
  const level = h.level;
  const channel = channelAt(h, cell);
  const seaLevel = h.seaLevelM;

  return {
    elevationAt(x: number, y: number): number {
      const u = localToUnit(frame, x, y);
      return sampleBilinear(h.elevationM, level, u.x, u.y, u.z);
    },
    waterAt(x: number, y: number): boolean {
      /* A river first: it is the sub-cell feature, and the one that decides
         whether the city needs bridges. */
      if (channel !== null && distanceToPolyline(channel.pts, x, y) <= channel.halfWidthM) return true;
      const u = localToUnit(frame, x, y);
      const elev = sampleBilinear(h.elevationM, level, u.x, u.y, u.z);
      if (elev < seaLevel) return true;
      /* A lake is where the depression-filled surface stands above the ground.
         Same test M5 uses, sampled continuously. */
      const filled = sampleBilinear(h.filledM, level, u.x, u.y, u.z);
      return filled > elev + 0.5;
    },
  };
}

/** Bearings (local ENU radians) toward water within `radiusM`. Drives ports. */
export function waterBearings(sampler: TerrainSampler, radiusM: number): number[] {
  const out: number[] = [];
  const probes = 16;
  for (let k = 0; k < probes; k++) {
    const a = (k / probes) * Math.PI * 2;
    const x = cos(a) * radiusM;
    const y = sin(a) * radiusM;
    if (sampler.waterAt(x, y)) out.push(a);
  }
  return out;
}
