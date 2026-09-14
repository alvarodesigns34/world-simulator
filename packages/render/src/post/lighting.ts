/**
 * Presentation lighting modes (T-0159).
 *
 * WHY THIS EXISTS. The sun's position is simulation state: M3 computes it from
 * the orbit and the calendar, and it is the right light for a world you are
 * watching run. It is the wrong light for a world you are EXPLORING. Half the
 * planet is always in darkness, so flying to the highest mountain, the largest
 * river or the biggest city lands you in the dark rather more than half the
 * time — and "I flew to the feature and saw nothing" is indistinguishable from
 * "the feature is not there".
 *
 * So the viewer can choose where the light comes from. This changes NOTHING
 * about the world: the simulated sun still drives insolation, climate and the
 * day/night cycle, and `REAL` is the default. The other modes are a lamp the
 * viewer is holding, and they are labelled as such in the interface so nobody
 * mistakes a study light for the time of day.
 */

import { vnorm, v3, type Vec3 } from '@ws/core';

export const SUN_MODE = {
  /** The world's own sun, from M3's orbit and calendar. The default. */
  REAL: 'real',
  /** Straight down onto whatever the camera is looking at. Flat but certain. */
  NOON: 'noon',
  /** Low and to the side: the light that makes topography readable. */
  RAKING: 'raking',
} as const;
export type SunMode = (typeof SUN_MODE)[keyof typeof SUN_MODE];

export const SUN_MODE_LABEL: Readonly<Record<SunMode, string>> = {
  [SUN_MODE.REAL]: 'Simulated sun',
  [SUN_MODE.NOON]: 'Overhead light',
  [SUN_MODE.RAKING]: 'Raking light',
};

/**
 * The direction to light from, given the mode.
 *
 * RAKING is the interesting one: the sun is placed about 22 degrees above the
 * local horizon, offset around the camera's own up axis. That is the angle at
 * which slopes separate — high sun flattens a landscape into a map, and a
 * raking sun is why aerial photographs of terrain are taken in the morning.
 */
export function presentationSunDirection(
  mode: SunMode, simulatedSun: Vec3, cameraPosition: Vec3,
): Vec3 {
  if (mode === SUN_MODE.REAL) return vnorm(simulatedSun);
  const up = vnorm(cameraPosition);
  if (mode === SUN_MODE.NOON) return up;

  /* A stable tangent at the camera: the world axis, projected off `up`. Near
     the poles that degenerates, so fall back to another axis rather than
     producing a zero vector. */
  let ax = -up.y;
  let ay = up.x;
  let az = 0;
  let m = Math.hypot(ax, ay, az);
  if (!(m > 1e-6)) { ax = 1; ay = 0; az = 0; m = 1; }
  const east = v3(ax / m, ay / m, az / m);
  const north = v3(
    up.y * east.z - up.z * east.y,
    up.z * east.x - up.x * east.z,
    up.x * east.y - up.y * east.x,
  );
  const elevation = 0.38;   // ~22 degrees
  const bearing = 2.3;      // fixed, so the light does not swing while orbiting
  const c = Math.cos(elevation);
  const s = Math.sin(elevation);
  return vnorm(v3(
    up.x * s + (east.x * Math.cos(bearing) + north.x * Math.sin(bearing)) * c,
    up.y * s + (east.y * Math.cos(bearing) + north.y * Math.sin(bearing)) * c,
    up.z * s + (east.z * Math.cos(bearing) + north.z * Math.sin(bearing)) * c,
  ));
}
