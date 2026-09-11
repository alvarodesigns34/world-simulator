/**
 * Coordinate frames (DEC-006).
 *
 * Exactly these frames exist. Each is a branded type so that mixing two of them
 * is a compile error rather than a mysteriously tilted continent. All conversions
 * live in this directory and nowhere else.
 *
 * Conventions, everywhere: SI units (metres, seconds, kelvin), radians in code,
 * degrees only at the UI edge.
 */

/**
 * Planet-Centred Fixed. The canonical frame; all persisted geometry is in PCF.
 * Origin at the planet centre, +Z along the rotation axis (north), +X through
 * the prime meridian, right-handed. Rotates with the planet. Metres, f64.
 */
export interface PCF {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /**
   * Optional in M0 — and that is a bug against DEC-006.
   * `{x,y,z}` is assignable to both PCF and PCI, so a frame mismatch is NOT a
   * compile error. Architecture v1 must make `__frame` required (T-0041).
   */
  readonly __frame?: 'PCF';
}

/**
 * Planet-Centred Inertial. Same origin and axes at epoch, does not rotate.
 * `PCF = Rz(theta(t)) * PCI`. Sun direction, star field, orbit, axial tilt.
 */
export interface PCI {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly __frame?: 'PCI';
}

/**
 * Geodetic. Latitude/longitude in radians, altitude in metres above the
 * reference surface. Camera state, UI, data import/export.
 *
 * NOTE: spherical, not ellipsoidal. An oblate reference surface is a future
 * change and will need its own ADR — it changes the meaning of `altitude`.
 */
export interface Geodetic {
  readonly lat: number;
  readonly lon: number;
  readonly altitude: number;
}

/**
 * A point on the tangent-warped cube-sphere (DEC-007).
 * `face` in 0..5, `u` and `v` in [0, 1].
 */
export interface CubeFace {
  readonly face: number;
  readonly u: number;
  readonly v: number;
}

/** Cube face indices. The six axis directions. */
export const FACE = {
  POS_X: 0,
  NEG_X: 1,
  POS_Y: 2,
  NEG_Y: 3,
  POS_Z: 4,
  NEG_Z: 5,
} as const;

export const FACE_COUNT = 6;

/** Planet parameters that the coordinate conversions need. */
export interface PlanetGeometry {
  /** Reference sphere radius, metres. */
  readonly radius: number;
}

export const EARTH_GEOMETRY: PlanetGeometry = { radius: 6_371_000 };

export function pcf(x: number, y: number, z: number): PCF {
  return { x, y, z };
}

export function length(p: PCF): number {
  return Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
}

export function normalizeVec(p: PCF): PCF {
  const l = length(p);
  return { x: p.x / l, y: p.y / l, z: p.z / l };
}

export function sub(a: PCF, b: PCF): PCF {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: PCF, s: number): PCF {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
