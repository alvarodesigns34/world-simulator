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
   * REQUIRED (T-0041, AUDIT-V0 M2). With this optional, `{x,y,z}` was assignable
   * to both PCF and PCI and DEC-006's "compile error rather than a mysteriously
   * tilted continent" did not exist. Construct through `pcf()`, never a literal.
   */
  readonly __frame: 'PCF';
}

/**
 * Planet-Centred Inertial. Same origin and axes at epoch, does not rotate.
 * `PCF = Rz(theta(t)) * PCI`. Sun direction, star field, orbit, axial tilt.
 */
export interface PCI {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly __frame: 'PCI';
}

/**
 * Camera-relative render space (DEC-006). Metres, conceptually `f32`, +Y up.
 * GPU only: never persisted, never read by `sim`. Branded so it cannot be
 * mistaken for a world position — which is exactly the mistake DEC-033 bans in
 * shaders.
 */
export interface RenderSpace {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly __frame: 'Render';
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
  return { x, y, z, __frame: 'PCF' };
}

export function pci(x: number, y: number, z: number): PCI {
  return { x, y, z, __frame: 'PCI' };
}

export function renderSpace(x: number, y: number, z: number): RenderSpace {
  return { x, y, z, __frame: 'Render' };
}

/** Read-only 3-component view shared by every frame, for frame-agnostic maths. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function length(p: Vec3Like): number {
  return Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
}

export function dot(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function normalizeVec(p: PCF): PCF {
  const l = length(p);
  return pcf(p.x / l, p.y / l, p.z / l);
}

export function sub(a: PCF, b: PCF): PCF {
  return pcf(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function add(a: PCF, b: PCF): PCF {
  return pcf(a.x + b.x, a.y + b.y, a.z + b.z);
}

export function scale(a: PCF, s: number): PCF {
  return pcf(a.x * s, a.y * s, a.z * s);
}

export function cross(a: PCF, b: PCF): PCF {
  return pcf(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

/**
 * PCF -> PCI. `theta` is the planet's rotation angle at the instant in question.
 * `PCF = Rz(theta) * PCI`, so the inverse rotates by -theta.
 */
export function pcfToPci(p: PCF, theta: number): PCI {
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  return pci(c * p.x + sn * p.y, -sn * p.x + c * p.y, p.z);
}

export function pciToPcf(p: PCI, theta: number): PCF {
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  return pcf(c * p.x - sn * p.y, sn * p.x + c * p.y, p.z);
}
