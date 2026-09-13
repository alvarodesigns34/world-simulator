/** M13 deterministic three-minute camera programme. Rendering state only. */

import { EARTH_GEOMETRY, type PlanetGeometry } from '@ws/data';
import { cameraFromGeodetic, lookAtCentre, type CameraState } from '../camera/state.js';

export interface CinematicKeyframe {
  readonly t: number;
  readonly lat: number;
  readonly lon: number;
  readonly altitudeM: number;
  readonly shot: string;
  readonly timeScale: number;
  readonly field?: string;
}

export const CINEMATIC_DURATION_SECONDS = 180;

export const CINEMATIC_KEYFRAMES: readonly CinematicKeyframe[] = [
  { t: 0, lat: 0.15, lon: -2.4, altitudeM: 26_000_000, shot: 'Global orbit', timeScale: 1e5 },
  { t: 18, lat: 0.25, lon: -1.5, altitudeM: 15_000_000, shot: 'Daylight limb', timeScale: 1e5 },
  { t: 38, lat: 0.48, lon: -0.55, altitudeM: 3_200_000, shot: 'Continent approach', timeScale: 1e7 },
  { t: 58, lat: 0.52, lon: -0.38, altitudeM: 240_000, shot: 'Mountains and rivers', timeScale: 1e7 },
  { t: 78, lat: 0.49, lon: -0.32, altitudeM: 45_000, shot: 'Civilisation layer', timeScale: 1e9, field: 'settlementPop' },
  { t: 98, lat: 0.48, lon: -0.31, altitudeM: 8_000, shot: 'City approach', timeScale: 1e9 },
  { t: 116, lat: 0.4805, lon: -0.309, altitudeM: 350, shot: 'Street flyover', timeScale: 1e7 },
  { t: 132, lat: 0.482, lon: -0.304, altitudeM: 2_500, shot: 'Infrastructure', timeScale: 1e8, field: 'landUse' },
  { t: 150, lat: 0.50, lon: -0.25, altitudeM: 600_000, shot: 'Scientific transition', timeScale: 1e11, field: 'temperature' },
  { t: 180, lat: 0.22, lon: 0.7, altitudeM: 22_000_000, shot: 'Era pull-back', timeScale: 1e11, field: 'pollution' },
];

export interface CinematicFrame {
  readonly camera: CameraState;
  readonly shot: string;
  readonly timeScale: number;
  readonly field?: string;
  readonly progress: number;
}

export function cinematicFrameAt(tSeconds: number, planet: PlanetGeometry = EARTH_GEOMETRY): CinematicFrame {
  const t = clamp(tSeconds, 0, CINEMATIC_DURATION_SECONDS);
  let i = 0;
  while (i + 1 < CINEMATIC_KEYFRAMES.length && t > CINEMATIC_KEYFRAMES[i + 1]!.t) i++;
  const a = CINEMATIC_KEYFRAMES[i]!;
  const b = CINEMATIC_KEYFRAMES[Math.min(CINEMATIC_KEYFRAMES.length - 1, i + 1)]!;
  const before = CINEMATIC_KEYFRAMES[Math.max(0, i - 1)]!;
  const after = CINEMATIC_KEYFRAMES[Math.min(CINEMATIC_KEYFRAMES.length - 1, i + 2)]!;
  const u = b.t === a.t ? 0 : smoother((t - a.t) / (b.t - a.t));
  const lat = catmull(before.lat, a.lat, b.lat, after.lat, u);
  const lon = a.lon + shortestAngle(a.lon, b.lon) * u;
  const logAlt = catmull(Math.log(before.altitudeM), Math.log(a.altitudeM), Math.log(b.altitudeM), Math.log(after.altitudeM), u);
  const camera = lookAtCentre(cameraFromGeodetic({ lat, lon, altitude: Math.exp(logAlt) }, planet));
  return { camera, shot: a.shot, timeScale: a.timeScale,
    ...(a.field === undefined ? {} : { field: a.field }), progress: t / CINEMATIC_DURATION_SECONDS };
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t; const t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function shortestAngle(a: number, b: number): number {
  let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d;
}
function smoother(v: number): number { const t = clamp(v, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
