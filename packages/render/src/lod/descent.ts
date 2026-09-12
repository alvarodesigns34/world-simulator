/**
 * Deterministic orbit → surface trajectory (T-0017 / Astra descent trace).
 *
 * Pure function of (t seconds, planet). Same inputs, same cameras, on any
 * machine. Seed is recorded so a later generator-driven path can pin itself
 * to the same identifier; the path itself is authored, not hashed.
 *
 * Prioritises reproducibility over cinematic polish. 60 seconds, 5 segments:
 *   0–12 s   high orbit, equatorial
 *  12–24 s   descend toward the pole
 *  24–36 s   polar pass (the DEC-029 reason this exists)
 *  36–48 s   continental scale, mid-latitude
 *  48–60 s   surface approach to 2 m
 */

import { EARTH_GEOMETRY, type PlanetGeometry } from '@ws/data';
import { cameraFromGeodetic, lookAtCentre, type CameraState } from '../camera/state.js';

export const DESCENT = {
  seed: 0x51a5_1a51,
  durationSeconds: 60,
  sampleHz: 30,
  viewportWidth: 2560,
  viewportHeight: 1440,
  gpuTier: 'discrete' as const,
  patchVerticesPerSide: 33,
  maxLevel: 12,
} as const;

interface Keyframe {
  readonly t: number;
  readonly lat: number;
  readonly lon: number;
  readonly logAlt: number;
}

const KEYFRAMES: readonly Keyframe[] = [
  { t: 0, lat: 0.0, lon: 0.6, logAlt: Math.log(40_000_000) },
  { t: 12, lat: 0.35, lon: 0.85, logAlt: Math.log(8_000_000) },
  { t: 24, lat: 1.2, lon: 0.9, logAlt: Math.log(1_500_000) },
  { t: 32, lat: Math.PI / 2, lon: 0.0, logAlt: Math.log(600_000) },
  { t: 40, lat: 0.7, lon: -0.4, logAlt: Math.log(80_000) },
  { t: 50, lat: 0.48, lon: -0.32, logAlt: Math.log(6_000) },
  { t: 60, lat: 0.48, lon: -0.32, logAlt: Math.log(2) },
];

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-path lerp on a radian angle, wrapping through ±π. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

export function descentCameraAt(tSec: number, planet: PlanetGeometry = EARTH_GEOMETRY): CameraState {
  const t = Math.min(DESCENT.durationSeconds, Math.max(0, tSec));
  let i = 0;
  while (i + 1 < KEYFRAMES.length && t > (KEYFRAMES[i + 1] as Keyframe).t) i++;
  const a = KEYFRAMES[i] as Keyframe;
  const b = KEYFRAMES[Math.min(KEYFRAMES.length - 1, i + 1)] as Keyframe;
  const span = b.t - a.t;
  const u = span <= 0 ? 0 : smooth01((t - a.t) / span);
  const lat = lerp(a.lat, b.lat, u);
  const lon = lerpAngle(a.lon, b.lon, u);
  const altitude = Math.exp(lerp(a.logAlt, b.logAlt, u));
  return lookAtCentre(cameraFromGeodetic({ lat, lon, altitude }, planet));
}

export function descentSpeedMps(
  tSec: number,
  planet: PlanetGeometry = EARTH_GEOMETRY,
  dt = 1 / DESCENT.sampleHz,
): number {
  const a = descentCameraAt(Math.max(0, tSec - dt), planet).position;
  const b = descentCameraAt(tSec, planet).position;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
}

export interface DescentSample {
  readonly t: number;
  readonly altitude: number;
  readonly speed: number;
  readonly lat: number;
  readonly lon: number;
  readonly visible: number;
  readonly visited: number;
  readonly culledHorizon: number;
  readonly culledFrustum: number;
  readonly triangles: number;
  readonly maxLevel: number;
  readonly selectMs: number;
  readonly budgetPatches: number;
  readonly budgetExhausted: boolean;
  readonly lodCounts: readonly number[];
  /** Keys that appeared this sample (not in the previous visible set). */
  readonly appeared: number;
  /** Keys that disappeared this sample. */
  readonly disappeared: number;
  /** Max |Δlevel| of a replaced node, 0 if the set was identical. */
  readonly maxLevelJump: number;
}

/** Integer sample count, including both endpoints. Avoids `t += 1/hz` drift. */
export function sampleCount(hz: number = DESCENT.sampleHz): number {
  return DESCENT.durationSeconds * hz + 1;
}

/** Exact sample times `0, 1/hz, …, duration`. Length = sampleCount(hz). */
export function descentSampleTimes(hz: number = DESCENT.sampleHz): readonly number[] {
  const n = DESCENT.durationSeconds * hz;
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(i / hz);
  return out;
}
