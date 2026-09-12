/**
 * @tier A
 *
 * M4 atmospheric solver (T-0035, DEC-036).
 *
 * Choice: one-layer primitive-equation approximation on the n-level geodesic
 * grid — shallow-water momentum + Newtonian temperature + moisture. Full 3-D
 * PE is too expensive for the 40 ms n6 budget in JS; prescribed cells (M3)
 * cannot be the M4 result because they do not emerge.
 *
 * Why this formulation, in one paragraph: Held–Suarez-style Newtonian cooling
 * toward a latitudinal T_eq plus Coriolis on a free surface is the smallest
 * system that produces Hadley/Ferrel-like cells and trades/westerlies from
 * state rather than from a painted wind atlas. Moisture is advected on the
 * same mesh so orographic precipitation and rain shadows are forced by M2
 * terrain, not by a texture.
 *
 * Temporal LOD shares this state. Regime only changes dt and which terms run.
 */

import { DOMAIN, hashFloat01x64, type Seed, sin, cos, exp, hypot, STABLE_PI, STABLE_PI_2 } from '@ws/core';
import {
  geodesicGrid,
  geodesicLat,
  geodesicLon,
  resamplePlan,
  cubeToGeoIntensive,
  type GeodesicGrid,
} from '@ws/data';
import type { GeologyState } from '../geology/plates.js';
import { dailyMeanInsolation } from '../atmosphere/insolation.js';
import {
  C_LAND,
  C_OCEAN,
  albedo,
  equilibriumT,
  heatCapacity,
  lapse,
  olr,
} from '../atmosphere/radiation.js';
import type { OrbitParams } from '../atmosphere/orbit.js';
import { EARTH_ORBIT } from '../atmosphere/orbit.js';

export type Regime = 'explicit' | 'synoptic' | 'climatology' | 'paleo';

export const OMEGA = 7.292115e-5;
export const RADIUS = 6_371_000;
export const G = 9.81;
export const H0 = 8000; /* equivalent depth, m */
const VMAX = 80; /* m/s, hard cap so a bad Φ gradient cannot CFL-explode */
const HMIN = 2000;
const HMAX = 16000;
const H_RELAX = 2 * 86400; /* equivalent-depth Newtonian timescale */

export interface ClimateState {
  readonly n: number;
  readonly grid: GeodesicGrid;
  readonly T: Float64Array;
  readonly u: Float64Array;
  readonly v: Float64Array;
  readonly q: Float64Array;
  readonly h: Float64Array;
  readonly precip: Float64Array;
  readonly precipAcc: Float64Array;
  readonly evapAcc: Float64Array;
  readonly ice: Float64Array;
  readonly Tocean: Float64Array;
  readonly elev: Float64Array;
  readonly ocean: Float64Array;
  readonly Tmean: Float64Array;
  readonly precipMean: Float64Array;
  readonly qsat: Float64Array;
  regime: Regime;
  steps: number;
}

export function initClimate(opts: {
  n: number;
  geology: GeologyState;
  seaLevel: number;
  seed: Seed;
  orbit?: OrbitParams;
}): ClimateState {
  const grid = geodesicGrid(opts.n);
  const N = grid.cellCount;
  const plan = resamplePlan(opts.geology.level, opts.n);
  const elev = new Float64Array(N);
  cubeToGeoIntensive(plan, opts.geology.elevationM, elev);
  const ocean = new Float64Array(N);
  const oceanCube = new Float64Array(plan.cubeCount);
  for (let i = 0; i < plan.cubeCount; i++) {
    oceanCube[i] = (opts.geology.elevationM[i] as number) < opts.seaLevel ? 1 : 0;
  }
  cubeToGeoIntensive(plan, oceanCube, ocean);

  const T = new Float64Array(N);
  const Tocean = new Float64Array(N);
  const u = new Float64Array(N);
  const v = new Float64Array(N);
  const q = new Float64Array(N);
  const h = new Float64Array(N);
  const ice = new Float64Array(N);
  const orbit = opts.orbit ?? EARTH_ORBIT;
  for (let i = 0; i < N; i++) {
    const lat = geodesicLat(grid, i);
    const Q = dailyMeanInsolation(lat, 0, orbit);
    const oc = ocean[i] as number;
    const a = albedo(oc, 0);
    let t = equilibriumT(Q, a);
    t = lapse(t, elev[i] as number);
    if (t < 200) t = 200;
    if (t > 320) t = 320;
    /* Tiny seed hash so two worlds differ; not the circulation. */
    t += (hashFloat01x64(opts.seed, DOMAIN.ATMOSPHERE, i) - 0.5) * 0.2;
    T[i] = t;
    Tocean[i] = oc > 0.5 ? t : t;
    h[i] = H0 * (t / 255);
    q[i] = qsatOf(t) * 0.6;
    if (t < 271.2 && oc > 0.5) ice[i] = 0.4;
  }
  return {
    n: opts.n,
    grid,
    T,
    u,
    v,
    q,
    h,
    precip: new Float64Array(N),
    precipAcc: new Float64Array(N),
    evapAcc: new Float64Array(N),
    ice,
    Tocean,
    elev,
    ocean,
    Tmean: T.slice(),
    precipMean: new Float64Array(N),
    qsat: new Float64Array(N),
    regime: 'explicit',
    steps: 0,
  };
}

function qsatOf(T: number): number {
  /* Tetens, liquid, relative to 1e5 Pa. Clamp T so the exp argument stays
     inside the Cody–Waite domain even if a cell is mid-clamp. */
  const t = T < 180 ? 180 : T > 340 ? 340 : T;
  const tc = t - 273.15;
  const es = 611.2 * exp((17.67 * tc) / (tc + 243.5));
  return 0.622 * es / 1.0e5;
}

export function classifyRegime(timeScale: number): Regime {
  if (timeScale <= 6) return 'explicit';
  if (timeScale <= 720) return 'synoptic'; /* 6 h .. 30 d  of sim / wall-s roughly */
  if (timeScale <= 3.15e7) return 'climatology';
  return 'paleo';
}

export interface StepDiagnostics {
  readonly waterMass: number;
  readonly energy: number;
  readonly toaIn: number;
  readonly toaOut: number;
  readonly maxWind: number;
  readonly meanT: number;
}

export function stepClimate(
  s: ClimateState,
  dt: number,
  decl: number,
  orbit: OrbitParams = EARTH_ORBIT,
): StepDiagnostics {
  const g = s.grid;
  const N = g.cellCount;
  const T = s.T;
  const u = s.u;
  const v = s.v;
  const q = s.q;
  const h = s.h;
  const ice = s.ice;
  const ocean = s.ocean;
  const elev = s.elev;

  const damp =
    s.regime === 'explicit' ? 2e-6 : s.regime === 'synoptic' ? 8e-6 : s.regime === 'climatology' ? 2e-5 : 1e-4;
  const doSW = s.regime === 'explicit' || s.regime === 'synoptic';
  const doAdvect = s.regime !== 'paleo';

  let toaIn = 0;
  let toaOut = 0;
  let energy = 0;
  let water = 0;
  let maxWind = 0;
  let sumT = 0;

  const gT = new Float64Array(N * 2);
  const gH = new Float64Array(N * 2);
  const gQ = new Float64Array(N * 2);
  grads(g, T, gT);
  if (doSW) grads(g, h, gH);
  if (doAdvect) grads(g, q, gQ);

  for (let i = 0; i < N; i++) {
    const lat = geodesicLat(g, i);
    const area = g.areas[i] as number;
    const Q = dailyMeanInsolation(lat, decl, orbit);
    const a = albedo(ocean[i] as number, ice[i] as number);
    const abs = (1 - a) * Q;
    const out = olr(T[i] as number);
    toaIn += abs * area;
    toaOut += out * area;

    const C = heatCapacity(ocean[i] as number, ice[i] as number);
    let tEq = equilibriumT(Q, a);
    tEq = lapse(tEq, elev[i] as number);
    const tau = s.regime === 'paleo' ? 20 * 86400 : 15 * 86400;
    let dT = (tEq - (T[i] as number)) / tau + (abs - out) / C;

    const f = 2 * OMEGA * sin(lat);
    let uu = u[i] as number;
    let vv = v[i] as number;

    if (doAdvect) {
      dT -= uu * (gT[i * 2] as number) + vv * (gT[i * 2 + 1] as number);
    }

    /* Moisture */
    const qs = qsatOf(T[i] as number);
    s.qsat[i] = qs;
    const spd = hypot(uu, vv);
    const evap =
      (ocean[i] as number) > 0.3 && (ice[i] as number) < 0.5
        ? 1.2e-8 * (spd + 2) * (qs - (q[i] as number))
        : 0;
    let dq = evap;
    if (doAdvect) dq -= uu * (gQ[i * 2] as number) + vv * (gQ[i * 2 + 1] as number);
    let pr = 0;
    if ((elev[i] as number) > 800 && (q[i] as number) > qs * 0.5 && doAdvect) {
      const extra = 3e-9 * ((elev[i] as number) / 2000) * (spd + 1);
      dq -= extra;
      pr += extra;
    }
    if ((q[i] as number) + dq * dt > qs) {
      const cond = ((q[i] as number) + dq * dt - qs) / Math.max(dt, 1);
      dq -= cond;
      pr += cond;
      dT += (cond * 8e5) / C;
    }
    s.precip[i] = pr;
    /* Rain shadow: moisture already removed windward because we advect q and
       condense where q>qsat, which is where air is forced up (colder T / lower
       qsat on mountains via lapse). */

    if (doSW) {
      const dPhiE = G * (gH[i * 2] as number);
      const dPhiN = G * (gH[i * 2 + 1] as number);
      const du = f * vv - dPhiE - damp * uu;
      const dv = -f * uu - dPhiN - damp * vv;
      uu += du * dt;
      vv += dv * dt;
      const href = H0 * ((T[i] as number) / 255);
      let hh = (h[i] as number) + dt * (href - (h[i] as number)) / H_RELAX;
      if (hh < HMIN) hh = HMIN;
      if (hh > HMAX) hh = HMAX;
      h[i] = hh;
    } else if (s.regime === 'climatology') {
      /* Diagnostic thermal wind. */
      uu += dt * (f * 0 - G * (gT[i * 2] as number) * 4 - damp * uu);
      vv += dt * (-G * (gT[i * 2 + 1] as number) * 4 - damp * vv);
    } else {
      uu *= 0.5;
      vv *= 0.5;
    }
    {
      const spdCap = hypot(uu, vv);
      if (spdCap > VMAX) {
        const s = VMAX / spdCap;
        uu *= s;
        vv *= s;
      }
    }

    T[i] = (T[i] as number) + dT * dt;
    q[i] = (q[i] as number) + dq * dt;
    if ((q[i] as number) < 0) {
      s.evapAcc[i] = (s.evapAcc[i] as number) - (q[i] as number);
      q[i] = 0;
    }
    if ((T[i] as number) < 180) T[i] = 180;
    if ((T[i] as number) > 340) T[i] = 340;
    u[i] = uu;
    v[i] = vv;

    /* Ocean mixed layer + ice */
    if ((ocean[i] as number) > 0.5) {
      const Co = C_OCEAN;
      s.Tocean[i] = (s.Tocean[i] as number) + dt * ((T[i] as number) - (s.Tocean[i] as number)) / (Co / C_LAND);
      /* Wind-driven mixed-layer heat transport. Not Navier–Stokes. */
      s.Tocean[i] =
        (s.Tocean[i] as number) -
        dt * (uu * (gT[i * 2] as number) + vv * (gT[i * 2 + 1] as number)) * 0.02;
      if ((s.Tocean[i] as number) < 271.2) ice[i] = Math.min(1, (ice[i] as number) + dt / (30 * 86400));
      else if ((s.Tocean[i] as number) > 273.5) ice[i] = Math.max(0, (ice[i] as number) - dt / (20 * 86400));
    } else {
      ice[i] = (T[i] as number) < 265 ? 0.2 : 0;
    }

    s.precipAcc[i] = (s.precipAcc[i] as number) + (s.precip[i] as number) * dt;
    s.evapAcc[i] = (s.evapAcc[i] as number) + evap * dt;
    s.Tmean[i] = (s.Tmean[i] as number) * 0.999 + (T[i] as number) * 0.001;
    s.precipMean[i] = (s.precipMean[i] as number) * 0.999 + (s.precip[i] as number) * 0.001;

    water += ((q[i] as number) + (s.precipAcc[i] as number) - (s.evapAcc[i] as number) + (ice[i] as number) * 50) * area * RADIUS * RADIUS;
    energy += C * (T[i] as number) * area * RADIUS * RADIUS;
    const w = hypot(uu, vv);
    if (w > maxWind) maxWind = w;
    sumT += T[i] as number;
  }

  s.steps += 1;
  return {
    waterMass: water,
    energy,
    toaIn: toaIn * RADIUS * RADIUS,
    toaOut: toaOut * RADIUS * RADIUS,
    maxWind,
    meanT: sumT / N,
  };
}

function grads(grid: GeodesicGrid, field: Float64Array, out: Float64Array): void {
  /* Spherical gradient in local (east, north), using neighbour chords. */
  for (let i = 0; i < grid.cellCount; i++) {
    const lat = geodesicLat(grid, i);
    const lon = geodesicLon(grid, i);
    const cl = cos(lat);
    const sl = sin(lat);
    const eastX = -sin(lon);
    const eastY = cos(lon);
    const northX = -sl * cos(lon);
    const northY = -sl * sin(lon);
    const northZ = cl;
    let ge = 0;
    let gn = 0;
    let wsum = 0;
    const nc = grid.neighborCount[i] as number;
    const fi = field[i] as number;
    const ix = grid.positions[i * 3] as number;
    const iy = grid.positions[i * 3 + 1] as number;
    const iz = grid.positions[i * 3 + 2] as number;
    for (let k = 0; k < nc; k++) {
      const j = grid.neighbors[i * 6 + k] as number;
      const jx = grid.positions[j * 3] as number;
      const jy = grid.positions[j * 3 + 1] as number;
      const jz = grid.positions[j * 3 + 2] as number;
      const dx = jx - ix;
      const dy = jy - iy;
      const dz = jz - iz;
      const chord2 = dx * dx + dy * dy + dz * dz;
      if (chord2 < 1e-18) continue;
      const w = 1 / chord2;
      const df = (field[j] as number) - fi;
      ge += df * (dx * eastX + dy * eastY) * w;
      gn += df * (dx * northX + dy * northY + dz * northZ) * w;
      wsum += w;
    }
    if (wsum > 0) {
      ge /= wsum;
      gn /= wsum;
    }
    /* Convert dimensionless to 1/m. chord is on the unit sphere. */
    out[i * 2] = ge / RADIUS;
    out[i * 2 + 1] = gn / RADIUS;
  }
}

export function atmosWaterMass(s: ClimateState): number {
  let w = 0;
  for (let i = 0; i < s.grid.cellCount; i++) {
    const area = (s.grid.areas[i] as number) * RADIUS * RADIUS;
    w += ((s.q[i] as number) + (s.precipAcc[i] as number) - (s.evapAcc[i] as number)) * area;
  }
  return w;
}

export function waterMass(s: ClimateState): number {
  let w = 0;
  for (let i = 0; i < s.grid.cellCount; i++) {
    const area = (s.grid.areas[i] as number) * RADIUS * RADIUS;
    w += ((s.q[i] as number) + (s.precipAcc[i] as number) - (s.evapAcc[i] as number) + (s.ice[i] as number) * 50) * area;
  }
  return w;
}

export function quiesceClimate(s: ClimateState): void {
  s.u.fill(0);
  s.v.fill(0);
  /* q is re-seeded from T on resume; T, ice, ocean stay (slow). */
}

export function resumeClimate(s: ClimateState): void {
  for (let i = 0; i < s.grid.cellCount; i++) {
    s.q[i] = qsatOf(s.T[i] as number) * 0.6;
    s.h[i] = H0 * ((s.T[i] as number) / 255);
  }
}

export function zonalMeanU(s: ClimateState, latBands: number = 18): Float64Array {
  const acc = new Float64Array(latBands);
  const w = new Float64Array(latBands);
  for (let i = 0; i < s.grid.cellCount; i++) {
    const lat = geodesicLat(s.grid, i);
    const b = Math.min(latBands - 1, Math.max(0, Math.floor(((lat + STABLE_PI_2) / STABLE_PI) * latBands)));
    acc[b] = (acc[b] as number) + (s.u[i] as number);
    w[b] = (w[b] as number) + 1;
  }
  for (let b = 0; b < latBands; b++) if ((w[b] as number) > 0) acc[b] = (acc[b] as number) / (w[b] as number);
  return acc;
}
