/**
 * @tier A
 *
 * Instantaneous and daily-mean insolation. Analytic daily-mean (M3: ≤ 2 %):
 *
 *   Q = (S0/π) [ h sinφ sinδ + cosφ cosδ sin h ]
 *   cos h0 = −tanφ tanδ,  h0 = hour-angle of sunset ∈ [0, π]
 *
 * Evaluated as cos h0 = −sinφ sinδ / (cosφ cosδ) so the pole (where tan φ
 * diverges and tanφ·tanδ is Inf·0 = NaN at equinox) is a regular polar-night
 * / polar-day / Q=0 case.
 */

import { cos, sin, acos, STABLE_PI, STABLE_PI_2 } from '@ws/core';
import type { OrbitParams } from './orbit.js';
import { EARTH_ORBIT } from './orbit.js';

export function hourAngleSunset(lat: number, decl: number): number {
  const phi = lat < -STABLE_PI_2 ? -STABLE_PI_2 : lat > STABLE_PI_2 ? STABLE_PI_2 : lat;
  const slat = sin(phi);
  const clat = cos(phi);
  const sdec = sin(decl);
  const cdec = cos(decl);
  const x = -slat * sdec;
  const y = clat * cdec;
  /* |cos h0| ≥ 1, or the pole (y ≈ 0): polar night / polar day / equinox-Q=0. */
  if (!(y > 0) || Math.abs(x) >= y) {
    if (x < 0) return STABLE_PI;
    return 0;
  }
  return acos(x / y);
}

/** Instantaneous TOA insolation, W/m². `ha` = hour angle from noon. */
export function instantInsolation(lat: number, decl: number, ha: number, orbit: OrbitParams = EARTH_ORBIT): number {
  const mu = sin(lat) * sin(decl) + cos(lat) * cos(decl) * cos(ha);
  return mu > 0 ? orbit.solarConstant * mu : 0;
}

/** Daily-mean TOA insolation, W/m². */
export function dailyMeanInsolation(lat: number, decl: number, orbit: OrbitParams = EARTH_ORBIT): number {
  const h0 = hourAngleSunset(lat, decl);
  if (h0 === 0) return 0;
  const q =
    (orbit.solarConstant / STABLE_PI) * (h0 * sin(lat) * sin(decl) + cos(lat) * cos(decl) * sin(h0));
  if (!Number.isFinite(q) || q < 0) return 0;
  return q;
}

/**
 * Analytic reference used by the M3 acceptance test: daily-mean at a given
 * latitude and day-of-year fraction, Earth orbit.
 */
export function analyticDailyMean(lat: number, yearFraction: number, orbit: OrbitParams = EARTH_ORBIT): number {
  const anomaly = yearFraction * 2 * STABLE_PI;
  const decl = orbit.axialTilt * sin(anomaly);
  return dailyMeanInsolation(lat, decl, orbit);
}
