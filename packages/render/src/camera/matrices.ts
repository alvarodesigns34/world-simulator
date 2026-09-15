/**
 * Camera matrices (DEC-005, DEC-033).
 *
 * THE f64 -> f32 BOUNDARY IS HERE AND NOWHERE ELSE — plus the per-patch
 * corner subtract in `gpu/instance.ts`, which is the same operation.
 *
 * =============================================================================
 * MATRIX CONVENTION  (one, explicit, the whole renderer)
 * =============================================================================
 *
 * Storage:    column-major Float32Array[16], matching WGSL `mat4x4<f32>`
 *             and WebGPU uniform layout. Index `c*4 + r` is row r, column c.
 *
 * Vectors:    column vectors. GPU and CPU both compute `M * v`.
 *             WGSL: `u.viewProj * vec4(surface, 1.0)`.
 *
 * Product:    `clip = proj * view * pos`. `multiply(a, b)` is a × b, so
 *             `multiply(proj, view)` is the uploaded viewProj.
 *
 * View:       CAMERA-RELATIVE, rotation only, camera at the origin.
 *             Camera local: +X right, +Y up, LOOKS DOWN LOCAL −Z.
 *             `view` maps camera-relative PCF → camera local.
 *             `view * forward = (0,0,-1)`, `view * right = (1,0,0)`,
 *             `view * up = (0,1,0)`.
 *             Built as R^T where R is camera-local → PCF (the quaternion).
 *             Rows of `view` are the camera axes expressed in PCF.
 *
 * Projection: reversed-Z, infinite far. near → 1, infinity → 0.
 *             No far term. GreaterEqual, clear 0.0.
 *
 * The previous `viewRotationOnly` wrote the camera-space images of the world
 * axes as *rows* while claiming they were *columns* — the matrix was the
 * transpose of the convention above. Astra saw the planet rotated 90°.
 */

import { qForward, qRight, qUp, v3, type Vec3 } from '@ws/core';
import type { PCF } from '@ws/data';
import type { CameraState } from './state.js';

/** Column-major 4x4, as WebGPU wants it. */
export type Mat4 = Float32Array;

/**
 * Infinite-far reversed-Z perspective projection.
 *
 *     zClip = near,  wClip = -z    =>   zNdc = near / -z
 *
 * A point at the near plane (camera-local z = -near) maps to 1; infinity to 0.
 */
export function perspectiveReversedZInfinite(fovY: number, aspect: number, near: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = 0;
  m[11] = -1;
  m[14] = near;
  m[15] = 0;
  return m;
}

/**
 * View matrix in CAMERA-RELATIVE space: camera at the origin, no translation.
 *
 * Rows are the camera axes in PCF (view = R_camToWorld^T). Column-major
 * storage: row 0 lives at m[0], m[4], m[8].
 */
export function viewRotationOnly(cam: CameraState): Mat4 {
  const right = qRight(cam.orientation);
  const up = qUp(cam.orientation);
  const fwd = qForward(cam.orientation);

  const m = new Float32Array(16);
  m[0] = right.x;
  m[4] = right.y;
  m[8] = right.z;
  m[12] = 0;
  m[1] = up.x;
  m[5] = up.y;
  m[9] = up.z;
  m[13] = 0;
  m[2] = -fwd.x;
  m[6] = -fwd.y;
  m[10] = -fwd.z;
  m[14] = 0;
  m[3] = 0;
  m[7] = 0;
  m[11] = 0;
  m[15] = 1;
  return m;
}

/** Column-major a × b. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      m[c * 4 + r] = s;
    }
  }
  return m;
}

/** `M * (x,y,z, 0)` — directions, no translation. */
export function transformDir(m: Mat4, v: Vec3): Vec3 {
  return v3(
    (m[0] as number) * v.x + (m[4] as number) * v.y + (m[8] as number) * v.z,
    (m[1] as number) * v.x + (m[5] as number) * v.y + (m[9] as number) * v.z,
    (m[2] as number) * v.x + (m[6] as number) * v.y + (m[10] as number) * v.z,
  );
}

/** `M * (x,y,z, 1)` — points. */
export function transformPos(m: Mat4, v: Vec3): Vec3 {
  return v3(
    (m[0] as number) * v.x + (m[4] as number) * v.y + (m[8] as number) * v.z + (m[12] as number),
    (m[1] as number) * v.x + (m[5] as number) * v.y + (m[9] as number) * v.z + (m[13] as number),
    (m[2] as number) * v.x + (m[6] as number) * v.y + (m[10] as number) * v.z + (m[14] as number),
  );
}

/**
 * THE conversion point (DEC-005 rule 2).
 *
 * Takes an f64 world position and the f64 camera position, differences them in
 * f64, and returns an f32-safe relative offset. Within 100 km of the camera one
 * f32 ulp is 7.8 mm; within 1 km it is 61 µm.
 */
export function toCameraRelative(world: PCF, cam: CameraState): Vec3 {
  return v3(world.x - cam.position.x, world.y - cam.position.y, world.z - cam.position.z);
}

/**
 * Worst-case f32 representation error, in metres, for a point at `distance`
 * metres from the camera. Used by tests and by the HUD to show the precision
 * headroom at the current altitude.
 */
export function relativePrecisionM(distance: number): number {
  if (distance === 0) return 0;
  const exponent = Math.floor(Math.log2(Math.abs(distance)));
  return 2 ** (exponent - 23);
}
