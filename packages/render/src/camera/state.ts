/**
 * Camera (T-0016, DEC-029, and the policy half of DEC-025).
 *
 * CANONICAL STATE IS PCF + QUATERNION. Geodetic is derived.
 *
 * DEC-025 stored `{lat, lon, altitude, yaw, pitch, roll}` and DEC-029 replaced
 * it, because at `lat = ±π/2` longitude is undefined and yaw-about-Z gimbal-
 * locks — and the poles are where ice sheets are, where polar orbits go, and
 * where the M1 descent sweep must survive.
 *
 * WHAT SURVIVES FROM DEC-025, UNCHANGED:
 *   - there are no modes; "orbital" is just a large altitude;
 *   - control mapping blends continuously on `s = log10(altitude)`;
 *   - near plane scales with altitude;
 *   - **a `switch` on altitude is a bug**.
 *
 * This module is the single place where an f64 world position becomes an f32
 * render position (DEC-005). Everything the GPU sees is camera-relative.
 */

import {
  qForward,
  qLookRotation,
  qUp,
  qnorm,
  qrotate,
  v3,
  vadd,
  vcross,
  vlen,
  vnorm,
  vscale,
  vsub,
  type Quat,
  type Vec3,
} from '@ws/core';
import { pcf, type Geodetic, type PCF, type PlanetGeometry } from '@ws/data';

export interface CameraState {
  /** Planet-centred, metres, f64. */
  readonly position: PCF;
  /** Unit quaternion in the PCF basis. Camera looks down local -Z, up is +Y. */
  readonly orientation: Quat;
  readonly fovY: number;
}

export interface CameraDerived {
  /** Altitude above the REFERENCE SPHERE: |p| - R. No surface query needed —
   *  which is the fact DEC-025's rejection of Cartesian PCF got wrong. */
  readonly altitude: number;
  readonly latitude: number;
  readonly longitude: number;
  /** log10(max(altitude, 1)) — the continuous control-blend parameter. */
  readonly s: number;
  readonly forward: Vec3;
  readonly up: Vec3;
  /** Local geodetic up at the camera's position. Degenerate nowhere. */
  readonly surfaceNormal: Vec3;
  readonly cameraNear: number;
}

export const DEFAULT_FOV_Y = (60 * Math.PI) / 180;

export function cameraAt(position: PCF, orientation: Quat, fovY = DEFAULT_FOV_Y): CameraState {
  return { position, orientation: qnorm(orientation), fovY };
}

/**
 * Build a camera from a geodetic description. This is a CONVENIENCE for
 * authoring and for tests, not the canonical representation: it converts once
 * and then the quaternion carries the orientation.
 */
export function cameraFromGeodetic(
  g: Geodetic,
  planet: PlanetGeometry,
  headingRad = 0,
  pitchRad = -Math.PI / 2,
  fovY = DEFAULT_FOV_Y,
): CameraState {
  const r = planet.radius + g.altitude;
  const cosLat = Math.cos(g.lat);
  const position = pcf(
    r * cosLat * Math.cos(g.lon),
    r * cosLat * Math.sin(g.lon),
    r * Math.sin(g.lat),
  );

  const up = vnorm(v3(position.x, position.y, position.z));
  // East/north basis. At a pole these degenerate, so fall back to a fixed axis
  // deterministically — the camera still gets a valid frame, which is the whole
  // point of not storing lat/lon.
  let east = vcross(v3(0, 0, 1), up);
  if (vlen(east) < 1e-9) east = v3(1, 0, 0);
  east = vnorm(east);
  const north = vnorm(vcross(up, east));

  const horizontal = vadd(vscale(north, Math.cos(headingRad)), vscale(east, Math.sin(headingRad)));
  const forward = vnorm(
    vadd(vscale(horizontal, Math.cos(pitchRad)), vscale(up, Math.sin(pitchRad))),
  );

  return cameraAt(position, qLookRotation(forward, up), fovY);
}

export function derive(cam: CameraState, planet: PlanetGeometry): CameraDerived {
  const p = v3(cam.position.x, cam.position.y, cam.position.z);
  const r = vlen(p);
  const altitude = r - planet.radius;
  const n = r === 0 ? v3(0, 0, 1) : vscale(p, 1 / r);

  return {
    altitude,
    latitude: Math.asin(Math.min(1, Math.max(-1, n.z))),
    longitude: Math.atan2(n.y, n.x),
    s: Math.log10(Math.max(altitude, 1)),
    forward: qForward(cam.orientation),
    up: qUp(cam.orientation),
    surfaceNormal: n,
    cameraNear: nearPlane(altitude),
  };
}

/**
 * Projection near plane (DEC-033 rule 3 — `cameraNear`, distinct from the
 * reversed-Z depth range). A smooth function of altitude, with no branch on it.
 */
export function nearPlane(altitude: number): number {
  return Math.min(1000, Math.max(0.05, Math.abs(altitude) * 1e-4));
}

/**
 * Continuous blend weight between "orbital" and "surface" control mappings.
 *
 * Returns 0 below 10 km and 1 above 100 km, smoothstepped between. It is a
 * WEIGHT, not a mode: controllers interpolate their behaviour by it, so there is
 * no altitude at which anything switches.
 */
export function orbitalBlend(altitude: number): number {
  const s = Math.log10(Math.max(altitude, 1));
  const t = Math.min(1, Math.max(0, (s - 4) / (5 - 4)));
  return t * t * (3 - 2 * t);
}

/**
 * Move the camera along the surface while keeping its height and its local
 * frame: rotate BOTH position and orientation by the same rotation about the
 * planet centre.
 *
 * This is what makes polar crossing work. There is no latitude clamp, no
 * pole special case, and no place where longitude has to be defined — the
 * camera simply rotates through the pole and comes out the other side, because
 * a rotation about an axis through the centre has no singularity anywhere.
 */
export function moveTangential(cam: CameraState, axis: Vec3, angle: number): CameraState {
  const a = vnorm(axis);
  const half = angle * 0.5;
  const sn = Math.sin(half);
  const rot: Quat = { x: a.x * sn, y: a.y * sn, z: a.z * sn, w: Math.cos(half) };

  const p = qrotate(rot, v3(cam.position.x, cam.position.y, cam.position.z));
  // Compose rotations: world-space rotation pre-multiplies.
  const o = qnorm({
    x: rot.w * cam.orientation.x + rot.x * cam.orientation.w + rot.y * cam.orientation.z - rot.z * cam.orientation.y,
    y: rot.w * cam.orientation.y - rot.x * cam.orientation.z + rot.y * cam.orientation.w + rot.z * cam.orientation.x,
    z: rot.w * cam.orientation.z + rot.x * cam.orientation.y - rot.y * cam.orientation.x + rot.z * cam.orientation.w,
    w: rot.w * cam.orientation.w - rot.x * cam.orientation.x - rot.y * cam.orientation.y - rot.z * cam.orientation.z,
  });

  return { position: pcf(p.x, p.y, p.z), orientation: o, fovY: cam.fovY };
}

/**
 * Move forward along the camera's own heading, over the sphere. `metres` is arc
 * length at the current radius. Crossing a pole is not a special case.
 */
export function moveForward(cam: CameraState, metres: number, planet: PlanetGeometry): CameraState {
  const p = v3(cam.position.x, cam.position.y, cam.position.z);
  const r = vlen(p);
  const up = vscale(p, 1 / r);
  const fwd = qForward(cam.orientation);

  // Tangential component of the heading; if looking straight down, use local
  // "north" so the motion is still well defined.
  let tangent = vsub(fwd, vscale(up, fwd.x * up.x + fwd.y * up.y + fwd.z * up.z));
  if (vlen(tangent) < 1e-12) {
    let east = vcross(v3(0, 0, 1), up);
    if (vlen(east) < 1e-9) east = v3(1, 0, 0);
    tangent = vcross(up, vnorm(east));
  }
  tangent = vnorm(tangent);

  const axis = vcross(up, tangent); // rotate about this to advance along tangent
  void planet;
  return moveTangential(cam, axis, -metres / r);
}

/** Change altitude, keeping the ground track and orientation. */
export function setAltitude(
  cam: CameraState,
  altitude: number,
  planet: PlanetGeometry,
): CameraState {
  const p = v3(cam.position.x, cam.position.y, cam.position.z);
  const n = vnorm(p);
  const q = vscale(n, planet.radius + altitude);
  return { position: pcf(q.x, q.y, q.z), orientation: cam.orientation, fovY: cam.fovY };
}

/** Point the camera at the planet centre, keeping a stable roll. */
export function lookAtCentre(cam: CameraState): CameraState {
  const p = v3(cam.position.x, cam.position.y, cam.position.z);
  const forward = vscale(vnorm(p), -1);
  const upHint = Math.abs(vnorm(p).z) > 0.99 ? v3(1, 0, 0) : v3(0, 0, 1);
  return { position: cam.position, orientation: qLookRotation(forward, upHint), fovY: cam.fovY };
}
