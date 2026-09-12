/**
 * @tier A
 *
 * Genesis plate simulation (T-0030, DEC-026).
 *
 * A geological history is run ONCE at world creation. The same solver is what
 * M7 will promote to a runtime subsystem; the kernel below is written so that
 * promotion is a cadence change, not a rewrite.
 *
 * Model, deliberately kinematic rather than full Stokes:
 *   1. N Euler-pole plates, seeds hashed from the world seed (DOMAIN.PLATES).
 *   2. Spherical Voronoi assignment each step (nearest seed by max dot).
 *   3. Seeds rotate about their poles. Relative velocity at a cell classifies
 *      the boundary: convergent / divergent / transform.
 *   4. Crust type, age, thickness and uplift are DIAGNOSED from that history:
 *      continents ride continental plates; ridges reset ocean age; trenches
 *      and collisions thicken and uplift. Elevation is isostatic + age-depth
 *      + orogen, NOT FBM painted on afterwards.
 *
 * Resolution: cube-sphere L6 (24 576 cells) by default. Upsampled to the
 * terrain grid after the history. 25 M L11 cells × hundreds of steps will not
 * finish in 60 s; L6 history + L8/L11 upsample is the honest split.
 */

import {
  DOMAIN,
  hashFloat01x64,
  type Seed,
  sin,
  cos,
} from '@ws/core';
import {
  cubeDim,
  cubeIndex,
  cellCount,
  cubeFaceToUnitRaw,
  neighbor,
  DIR,
  type CubeCell,
} from '@ws/data';

/* local sqrt wrapper: Math.sqrt is IEEE correctly-rounded and is not a
   transcendental under DEC-018. */

export const CRUST_OCEAN = 0;
export const CRUST_CONTINENT = 1;

export const BND_INTERIOR = 0;
export const BND_DIVERGENT = 1;
export const BND_CONVERGENT = 2;
export const BND_TRANSFORM = 3;

export interface GenesisConfig {
  readonly seed: Seed;
  readonly level: number;
  readonly plateCount: number;
  readonly steps: number;
  readonly continentFraction: number;
}

export const DEFAULT_GENESIS: Omit<GenesisConfig, 'seed'> = {
  level: 6,
  plateCount: 12,
  steps: 180,
  continentFraction: 0.29,
};

export interface GeologyState {
  readonly level: number;
  readonly cellCount: number;
  readonly plateCount: number;
  readonly plateId: Uint8Array;
  readonly crustType: Uint8Array;
  readonly crustAgeMyr: Float32Array;
  readonly crustThicknessKm: Float32Array;
  readonly boundaryType: Uint8Array;
  readonly upliftM: Float32Array;
  readonly elevationM: Float32Array;
}

interface Plate {
  id: number;
  continental: boolean;
  /* Euler pole, unit. */
  px: number;
  py: number;
  pz: number;
  omega: number;
  /* Seed position, unit. */
  sx: number;
  sy: number;
  sz: number;
}

export function defaultGenesis(seed: Seed): GenesisConfig {
  return { seed, ...DEFAULT_GENESIS };
}

/**
 * Rotate `v` about unit axis `u` by `ang` radians (Rodrigues).
 */
function rotate(
  vx: number,
  vy: number,
  vz: number,
  ux: number,
  uy: number,
  uz: number,
  ang: number,
): [number, number, number] {
  const c = cos(ang);
  const s = sin(ang);
  const d = ux * vx + uy * vy + uz * vz;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  const t = 1 - c;
  return [vx * c + cx * s + ux * d * t, vy * c + cy * s + uy * d * t, vz * c + cz * s + uz * d * t];
}

function makePlates(cfg: GenesisConfig): Plate[] {
  const plates: Plate[] = [];
  const n = cfg.plateCount;
  for (let i = 0; i < n; i++) {
    const z = hashFloat01x64(cfg.seed, DOMAIN.PLATES, i, 1) * 2 - 1;
    const phi = hashFloat01x64(cfg.seed, DOMAIN.PLATES, i, 2) * 6.283185307179586;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const sx = r * cos(phi);
    const sy = r * sin(phi);
    const sz = z;
    const pz = hashFloat01x64(cfg.seed, DOMAIN.PLATES, i, 3) * 2 - 1;
    const pphi = hashFloat01x64(cfg.seed, DOMAIN.PLATES, i, 4) * 6.283185307179586;
    const pr = Math.sqrt(Math.max(0, 1 - pz * pz));
    const omega =
      (0.008 + 0.022 * hashFloat01x64(cfg.seed, DOMAIN.PLATES, i, 5)) *
      (hashFloat01x64(cfg.seed, DOMAIN.PLATES, i, 6) < 0.5 ? -1 : 1);
    plates.push({
      id: i,
      continental: false,
      px: pr * cos(pphi),
      py: pr * sin(pphi),
      pz,
      omega,
      sx,
      sy,
      sz,
    });
  }
  /* Largest-area plates become continents until the fraction is met. Area is
     diagnosed after the first Voronoi; here we pick by a hash so the choice is
     seed-only and does not depend on scan order of equal areas. */
  const order = plates.map((p) => p.id);
  order.sort(
    (a, b) =>
      hashFloat01x64(cfg.seed, DOMAIN.PLATES, a, 20) - hashFloat01x64(cfg.seed, DOMAIN.PLATES, b, 20),
  );
  const want = Math.max(1, Math.round(n * cfg.continentFraction));
  for (let k = 0; k < want; k++) {
    const id = order[k] as number;
    (plates[id] as Plate).continental = true;
  }
  return plates;
}

function precomputeUnits(level: number): Float64Array {
  const n = cubeDim(level);
  const units = new Float64Array(cellCount(level) * 3);
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const p = cubeFaceToUnitRaw(face, (x + 0.5) / n, (y + 0.5) / n);
        const i = cubeIndex(face, level, x, y) * 3;
        units[i] = p.x;
        units[i + 1] = p.y;
        units[i + 2] = p.z;
      }
    }
  }
  return units;
}

function assignVoronoi(units: Float64Array, plates: readonly Plate[], plateId: Uint8Array): void {
  const cells = plateId.length;
  for (let i = 0; i < cells; i++) {
    const x = units[i * 3] as number;
    const y = units[i * 3 + 1] as number;
    const z = units[i * 3 + 2] as number;
    let best = 0;
    let bestDot = -2;
    for (let p = 0; p < plates.length; p++) {
      const pl = plates[p] as Plate;
      const d = x * pl.sx + y * pl.sy + z * pl.sz;
      if (d > bestDot) {
        bestDot = d;
        best = p;
      }
    }
    plateId[i] = best;
  }
}

function classifyBoundary(
  level: number,
  plateId: Uint8Array,
  plates: readonly Plate[],
  units: Float64Array,
  boundary: Uint8Array,
): void {
  const n = cubeDim(level);
  const dirs = [DIR.POS_U, DIR.NEG_U, DIR.POS_V, DIR.NEG_V] as const;
  boundary.fill(BND_INTERIOR);
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = cubeIndex(face, level, x, y);
        const pid = plateId[i] as number;
        const pl = plates[pid] as Plate;
        const ux = units[i * 3] as number;
        const uy = units[i * 3 + 1] as number;
        const uz = units[i * 3 + 2] as number;
        /* Velocity = ω × r */
        const vx = pl.omega * (pl.py * uz - pl.pz * uy);
        const vy = pl.omega * (pl.pz * ux - pl.px * uz);
        const vz = pl.omega * (pl.px * uy - pl.py * ux);
        let marked = BND_INTERIOR;
        const cell: CubeCell = { face, x, y };
        for (const d of dirs) {
          const nb = neighbor(cell, level, d);
          const j = cubeIndex(nb.face, level, nb.x, nb.y);
          const qid = plateId[j] as number;
          if (qid === pid) continue;
          const ql = plates[qid] as Plate;
          const nx = units[j * 3] as number;
          const ny = units[j * 3 + 1] as number;
          const nz = units[j * 3 + 2] as number;
          const qvx = ql.omega * (ql.py * nz - ql.pz * ny);
          const qvy = ql.omega * (ql.pz * nx - ql.px * nz);
          const qvz = ql.omega * (ql.px * ny - ql.py * nx);
          const rx = nx - ux;
          const ry = ny - uy;
          const rz = nz - uz;
          const rel = (qvx - vx) * rx + (qvy - vy) * ry + (qvz - vz) * rz;
          const closing = -rel;
          if (closing > 4e-5) marked = BND_CONVERGENT;
          else if (closing < -4e-5) {
            if (marked !== BND_CONVERGENT) marked = BND_DIVERGENT;
          } else if (marked === BND_INTERIOR) marked = BND_TRANSFORM;
        }
        boundary[i] = marked;
      }
    }
  }
}

function diagnose(
  plateId: Uint8Array,
  plates: readonly Plate[],
  boundary: Uint8Array,
  age: Float32Array,
  thick: Float32Array,
  uplift: Float32Array,
  crust: Uint8Array,
  elev: Float32Array,
  dtMyr: number,
): void {
  const cells = plateId.length;
  for (let i = 0; i < cells; i++) {
    const pid = plateId[i] as number;
    const pl = plates[pid] as Plate;
    const b = boundary[i] as number;
    const continental = pl.continental;
    crust[i] = continental ? CRUST_CONTINENT : CRUST_OCEAN;

    if (!continental) {
      if (b === BND_DIVERGENT) age[i] = 0;
      else age[i] = (age[i] as number) + dtMyr;
      if (age[i] as number > 180) age[i] = 180;
      thick[i] = 7;
      /* Parsons–Sclater, flattening after 70 Myr so the hypsometric mean
         stays inside the documented Earth envelope (mean ≈ −2 km). */
      const t = age[i] as number;
      const sqrtAge = Math.sqrt(t < 70 ? t : 70);
      elev[i] = -2500 - 350 * sqrtAge;
      if ((elev[i] as number) < -5500) elev[i] = -5500;
      if (b === BND_DIVERGENT) elev[i] = -2500;
      if (b === BND_CONVERGENT) elev[i] = -5200;
      uplift[i] = 0;
    } else {
      age[i] = (age[i] as number) + dtMyr;
      let u = uplift[i] as number;
      if (b === BND_CONVERGENT) u += 45 * dtMyr;
      else u *= 0.992;
      if (u > 8000) u = 8000;
      uplift[i] = u;
      thick[i] = 35 + u / 250;
      /* Isostasy + interior platform + orogen. */
      elev[i] = 250 + (thick[i] as number - 35) * 80 + u * 0.55;
      if (b === BND_DIVERGENT) elev[i] = 150; /* rift valley floor, still above sea */
    }
  }
}

export function runGenesis(cfg: GenesisConfig): GeologyState {
  const level = cfg.level;
  const nCells = cellCount(level);
  const units = precomputeUnits(level);
  const plates = makePlates(cfg);
  const plateId = new Uint8Array(nCells);
  const crust = new Uint8Array(nCells);
  const age = new Float32Array(nCells);
  const thick = new Float32Array(nCells);
  const boundary = new Uint8Array(nCells);
  const uplift = new Float32Array(nCells);
  const elev = new Float32Array(nCells);

  const dtMyr = 2; /* 180 steps × 2 Myr ≈ 360 Myr of drift, Earth-like. */
  assignVoronoi(units, plates, plateId);
  for (let step = 0; step < cfg.steps; step++) {
    for (const pl of plates) {
      const r = rotate(pl.sx, pl.sy, pl.sz, pl.px, pl.py, pl.pz, pl.omega);
      pl.sx = r[0];
      pl.sy = r[1];
      pl.sz = r[2];
    }
    assignVoronoi(units, plates, plateId);
    classifyBoundary(level, plateId, plates, units, boundary);
    diagnose(plateId, plates, boundary, age, thick, uplift, crust, elev, dtMyr);
  }

  return {
    level,
    cellCount: nCells,
    plateCount: cfg.plateCount,
    plateId,
    crustType: crust,
    crustAgeMyr: age,
    crustThicknessKm: thick,
    boundaryType: boundary,
    upliftM: uplift,
    elevationM: elev,
  };
}

/**
 * Nearest-neighbour upsample of a geology raster onto a finer cube-sphere
 * level. Detail is NOT invented here; terrain/derive.ts adds seed-hashed
 * sub-grid relief that is a function of (seed, quadkey) so streaming order
 * cannot change it.
 */
export function upsampleField(src: GeologyState, field: Float32Array | Uint8Array, toLevel: number): Float32Array | Uint8Array {
  const from = src.level;
  if (toLevel < from) throw new Error('upsample: target coarser than source');
  if (toLevel === from) return field.slice() as typeof field;
  const shift = toLevel - from;
  const nTo = cubeDim(toLevel);
  const outIsInt = field instanceof Uint8Array;
  const out = outIsInt ? new Uint8Array(cellCount(toLevel)) : new Float32Array(cellCount(toLevel));
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < nTo; y++) {
      for (let x = 0; x < nTo; x++) {
        const sx = x >> shift;
        const sy = y >> shift;
        const si = cubeIndex(face, from, sx, sy);
        (out as { [k: number]: number })[cubeIndex(face, toLevel, x, y)] = field[si] as number;
      }
    }
  }
  return out;
}

export function upsampleGeology(src: GeologyState, toLevel: number): GeologyState {
  if (toLevel === src.level) return src;
  return {
    level: toLevel,
    cellCount: cellCount(toLevel),
    plateCount: src.plateCount,
    plateId: upsampleField(src, src.plateId, toLevel) as Uint8Array,
    crustType: upsampleField(src, src.crustType, toLevel) as Uint8Array,
    crustAgeMyr: upsampleField(src, src.crustAgeMyr, toLevel) as Float32Array,
    crustThicknessKm: upsampleField(src, src.crustThicknessKm, toLevel) as Float32Array,
    boundaryType: upsampleField(src, src.boundaryType, toLevel) as Uint8Array,
    upliftM: upsampleField(src, src.upliftM, toLevel) as Float32Array,
    elevationM: upsampleField(src, src.elevationM, toLevel) as Float32Array,
  };
}

/** Bit-fold of elevation used as a determinism gold. */
export function geologyDigest(g: GeologyState): number {
  let h = 2166136261;
  for (let i = 0; i < g.cellCount; i++) {
    const e = g.elevationM[i] as number;
    /* Quantise to mm so tiny f32 rounding cannot hide a real divergence. */
    const q = Math.round(e * 1000) | 0;
    h ^= (q + (g.plateId[i] as number) * 131 + (g.boundaryType[i] as number) * 17) >>> 0;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
