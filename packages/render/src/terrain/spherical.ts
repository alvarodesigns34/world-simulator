/**
 * Spherical patch interpolation (T-0064, RENDERING.md §4.0b).
 *
 * Bilinear of four sphere corners sags inside the sphere by R sin²(θ/2).
 * Terrain displacement along that sag is not terrain on a sphere.
 *
 * Closed form, camera-relative, no planet-centre reconstruction:
 *
 *   1 − |Bd|² = ½ Σᵢ Σₖ wᵢ wₖ |dᵢ − dₖ|²     (unit-corner differences)
 *   k = (1 − |Bd|) / |Bd|
 *   surface = B / |Bd| + k · C
 *
 * C is multiplied only by k (~ sag/R), so passing it in f32 is the exception
 * DEC-033 draws, not the reconstruction it forbids.
 *
 * Displacement of height h along the outward unit:
 *
 *   pos = surface · (1 + h/R) + C · (h/R)
 *
 * C·(h/R) is O(h), never O(R).
 */

import { v3, type Vec3 } from '@ws/core';

export interface Corner {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function bilinearW(s: number, t: number): readonly [number, number, number, number] {
  const ms = 1 - s;
  const mt = 1 - t;
  return [ms * mt, s * mt, ms * t, s * t];
}

/** 1 − |Bd|² from the four unit corners and bilinear weights. */
export function oneMinusBd2(
  w: readonly [number, number, number, number],
  d00: Corner,
  d10: Corner,
  d01: Corner,
  d11: Corner,
): number {
  const ds = [d00, d10, d01, d11];
  let acc = 0;
  for (let i = 0; i < 4; i++) {
    const di = ds[i] as Corner;
    const wi = w[i] as number;
    for (let k = 0; k < 4; k++) {
      const dk = ds[k] as Corner;
      const wk = w[k] as number;
      const dx = di.x - dk.x;
      const dy = di.y - dk.y;
      const dz = di.z - dk.z;
      acc += wi * wk * (dx * dx + dy * dy + dz * dz);
    }
  }
  return 0.5 * acc;
}

export function spherify(
  s: number,
  t: number,
  c00: Corner,
  c10: Corner,
  c01: Corner,
  c11: Corner,
  d00: Corner,
  d10: Corner,
  d01: Corner,
  d11: Corner,
  cam: Corner,
): Vec3 {
  const w = bilinearW(s, t);
  const Bx = w[0] * c00.x + w[1] * c10.x + w[2] * c01.x + w[3] * c11.x;
  const By = w[0] * c00.y + w[1] * c10.y + w[2] * c01.y + w[3] * c11.y;
  const Bz = w[0] * c00.z + w[1] * c10.z + w[2] * c01.z + w[3] * c11.z;
  const om = oneMinusBd2(w, d00, d10, d01, d11);
  const bd2 = 1 - om;
  const bd = Math.sqrt(bd2 < 1e-18 ? 1e-18 : bd2);
  const k = (1 - bd) / bd;
  return v3(Bx / bd + k * cam.x, By / bd + k * cam.y, Bz / bd + k * cam.z);
}

export function displace(surface: Vec3, h: number, radius: number, cam: Corner): Vec3 {
  const s = 1 + h / radius;
  const t = h / radius;
  return v3(surface.x * s + cam.x * t, surface.y * s + cam.y * t, surface.z * s + cam.z * t);
}

/** Bilinear height from four corner elevations. */
export function bilinearHeight(s: number, t: number, h00: number, h10: number, h01: number, h11: number): number {
  const w = bilinearW(s, t);
  return w[0] * h00 + w[1] * h10 + w[2] * h01 + w[3] * h11;
}
