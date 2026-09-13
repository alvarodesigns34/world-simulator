/**
 * M13 deterministic three-minute camera programme. Rendering state only.
 *
 * THE SHOTS ARE AIMED BY THE WORLD, NOT BY HAND (T-0102).
 *
 * The first version hardcoded a latitude and longitude per keyframe. Those
 * numbers were chosen for a screenshot of one seed and then frozen: on any
 * other world the "Mountains and rivers" shot looks at open ocean, "City
 * approach" descends onto nothing, and "Infrastructure" frames empty ground.
 * A cinematic that can only be correct for a world nobody is running is not a
 * demonstration of the simulation — it is a video of a coordinate list.
 *
 * So a keyframe now names a ROLE — the highest peak, the largest city, the
 * busiest built link — and the caller supplies the point that plays it, chosen
 * deterministically from the world it is about to show. The literal coordinates
 * remain as a fallback for a caller with no world (the render-only tests, a
 * camera-path demo) and the frame says which it used, so nobody can report a
 * fallback take as a world-derived one.
 *
 * SEPARATION. `render` still imports nothing from `sim`: a target is two
 * numbers. Which cell is the highest peak is the simulation's answer and
 * arrives here already decided.
 */

import { EARTH_GEOMETRY, type PlanetGeometry } from '@ws/data';
import { cameraFromGeodetic, lookAtCentre, type CameraState } from '../camera/state.js';

/**
 * What a shot is ABOUT. The programme is written in these; a world supplies
 * the coordinates.
 */
export const CINEMATIC_ROLE = {
  /** No feature: the planet as a whole. Deliberately not world-derived. */
  GLOBE: 'globe',
  /** A major drainage basin — the largest river the world actually grew. */
  CONTINENT: 'continent',
  /** The highest land the world actually built. */
  RELIEF: 'relief',
  /** Where the people are. */
  CIVILISATION: 'civilisation',
  /** The largest city. */
  CITY: 'city',
  /** The same city, at street height. */
  STREET: 'street',
  /** The busiest BUILT transport link. */
  INFRASTRUCTURE: 'infrastructure',
  /** Where the scientific layer has something to show. */
  SCIENCE: 'science',
} as const;
export type CinematicRole = (typeof CINEMATIC_ROLE)[keyof typeof CINEMATIC_ROLE];

export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

/** Points chosen from a world, by role. A missing role falls back. */
export type CinematicTargets = Partial<Readonly<Record<CinematicRole, GeoPoint>>>;

export interface CinematicKeyframe {
  readonly t: number;
  readonly role: CinematicRole;
  /** Fallback position when the role has no target. */
  readonly lat: number;
  readonly lon: number;
  /** Offset from the target, radians, so successive shots are not identical. */
  readonly dLat?: number;
  readonly dLon?: number;
  readonly altitudeM: number;
  readonly shot: string;
  readonly timeScale: number;
  readonly field?: string;
}

export const CINEMATIC_DURATION_SECONDS = 180;

export const CINEMATIC_KEYFRAMES: readonly CinematicKeyframe[] = [
  { t: 0, role: CINEMATIC_ROLE.GLOBE, lat: 0.15, lon: -2.4, altitudeM: 26_000_000, shot: 'Global orbit', timeScale: 1e5 },
  { t: 18, role: CINEMATIC_ROLE.GLOBE, lat: 0.25, lon: -1.5, altitudeM: 15_000_000, shot: 'Daylight limb', timeScale: 1e5 },
  { t: 38, role: CINEMATIC_ROLE.CONTINENT, lat: 0.48, lon: -0.55, dLat: 0.06, dLon: -0.09, altitudeM: 3_200_000, shot: 'Continent approach', timeScale: 1e7 },
  { t: 58, role: CINEMATIC_ROLE.RELIEF, lat: 0.52, lon: -0.38, altitudeM: 240_000, shot: 'Mountains and rivers', timeScale: 1e7 },
  { t: 78, role: CINEMATIC_ROLE.CIVILISATION, lat: 0.49, lon: -0.32, altitudeM: 45_000, shot: 'Civilisation layer', timeScale: 1e9, field: 'settlementPop' },
  { t: 98, role: CINEMATIC_ROLE.CITY, lat: 0.48, lon: -0.31, altitudeM: 8_000, shot: 'City approach', timeScale: 1e9 },
  { t: 116, role: CINEMATIC_ROLE.STREET, lat: 0.4805, lon: -0.309, dLat: 0.0004, dLon: 0.0006, altitudeM: 350, shot: 'Street flyover', timeScale: 1e7 },
  { t: 132, role: CINEMATIC_ROLE.INFRASTRUCTURE, lat: 0.482, lon: -0.304, altitudeM: 2_500, shot: 'Infrastructure', timeScale: 1e8, field: 'landUse' },
  { t: 150, role: CINEMATIC_ROLE.SCIENCE, lat: 0.50, lon: -0.25, altitudeM: 600_000, shot: 'Scientific transition', timeScale: 1e11, field: 'temperature' },
  { t: 180, role: CINEMATIC_ROLE.GLOBE, lat: 0.22, lon: 0.7, altitudeM: 22_000_000, shot: 'Era pull-back', timeScale: 1e11, field: 'pollution' },
];

export interface CinematicFrame {
  readonly camera: CameraState;
  readonly shot: string;
  readonly timeScale: number;
  readonly field?: string;
  readonly progress: number;
  /**
   * Whether the shot this frame belongs to was aimed by the world. False means
   * the fallback coordinates were used — a camera path, not a tour of anything.
   */
  readonly fromWorld: boolean;
}

export function cinematicFrameAt(
  tSeconds: number,
  planet: PlanetGeometry = EARTH_GEOMETRY,
  targets: CinematicTargets = {},
): CinematicFrame {
  const t = clamp(tSeconds, 0, CINEMATIC_DURATION_SECONDS);
  let i = 0;
  while (i + 1 < CINEMATIC_KEYFRAMES.length && t > CINEMATIC_KEYFRAMES[i + 1]!.t) i++;
  const a = CINEMATIC_KEYFRAMES[i]!;
  const b = CINEMATIC_KEYFRAMES[Math.min(CINEMATIC_KEYFRAMES.length - 1, i + 1)]!;
  const before = CINEMATIC_KEYFRAMES[Math.max(0, i - 1)]!;
  const after = CINEMATIC_KEYFRAMES[Math.min(CINEMATIC_KEYFRAMES.length - 1, i + 2)]!;

  const pa = aim(a, targets);
  const pb = aim(b, targets);
  const p0 = aim(before, targets);
  const p3 = aim(after, targets);

  const u = b.t === a.t ? 0 : smoother((t - a.t) / (b.t - a.t));
  /*
   * Latitude through a Catmull-Rom over the four surrounding keyframes;
   * longitude as a shortest-arc step, because world-derived targets can be on
   * opposite sides of the planet and a spline through raw longitudes would
   * take the long way round or wind through the seam.
   */
  const lat = catmull(p0.lat, pa.lat, pb.lat, p3.lat, u);
  const lon = pa.lon + shortestAngle(pa.lon, pb.lon) * u;
  const logAlt = catmull(Math.log(before.altitudeM), Math.log(a.altitudeM), Math.log(b.altitudeM), Math.log(after.altitudeM), u);
  const camera = lookAtCentre(cameraFromGeodetic({ lat, lon, altitude: Math.exp(logAlt) }, planet));
  return {
    camera, shot: a.shot, timeScale: a.timeScale,
    ...(a.field === undefined ? {} : { field: a.field }),
    progress: t / CINEMATIC_DURATION_SECONDS,
    fromWorld: a.role !== CINEMATIC_ROLE.GLOBE && targets[a.role] !== undefined,
  };
}

/** Where a keyframe actually looks, given what the world supplied. */
export function aim(k: CinematicKeyframe, targets: CinematicTargets): GeoPoint {
  const target = targets[k.role];
  if (target === undefined) return { lat: k.lat, lon: k.lon };
  const lat = clamp(target.lat + (k.dLat ?? 0), -1.5533, 1.5533);
  return { lat, lon: wrapLon(target.lon + (k.dLon ?? 0)) };
}

/** Roles a caller is expected to supply. `globe` is deliberately absent. */
export const CINEMATIC_TARGET_ROLES: readonly CinematicRole[] = [
  CINEMATIC_ROLE.CONTINENT, CINEMATIC_ROLE.RELIEF, CINEMATIC_ROLE.CIVILISATION,
  CINEMATIC_ROLE.CITY, CINEMATIC_ROLE.STREET, CINEMATIC_ROLE.INFRASTRUCTURE,
  CINEMATIC_ROLE.SCIENCE,
];

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t; const t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function shortestAngle(a: number, b: number): number {
  let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d;
}
function wrapLon(a: number): number {
  let v = a; while (v > Math.PI) v -= 2 * Math.PI; while (v < -Math.PI) v += 2 * Math.PI; return v;
}
function smoother(v: number): number { const t = clamp(v, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
