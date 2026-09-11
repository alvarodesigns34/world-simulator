/**
 * Camera matrices (DEC-005, DEC-033).
 *
 * THE f64 -> f32 BOUNDARY IS HERE AND NOWHERE ELSE.
 *
 * At Earth radius one f32 ulp is 0.5 m, so a planet-centred position in f32
 * quantises the surface to half-metre steps. The fix is not more bits, it is
 * subtracting first: `patchOrigin - cameraPosition` is computed in f64 on the
 * CPU, and only the small difference reaches the GPU.
 *
 * DEC-033 rule 1 then forbids the shader from undoing that by adding the camera
 * position back. There is deliberately NO camera-PCF uniform in the standard
 * bind group; the absence is the enforcement.
 *
 * REVERSED-Z WITH AN INFINITE FAR PLANE.
 * Near maps to 1.0, far to 0.0, clear to 0.0, test GreaterEqual. Float depth has
 * its precision concentrated near zero, and reversed-Z puts the far plane there,
 * which is what lets a single depth buffer span orbit to centimetres without
 * splitting the frustum.
 */

import { qconj, qrotate, v3, type Vec3 } from '@ws/core';
import type { PCF } from '@ws/data';
import type { CameraState } from './state.js';

/** Column-major 4x4, as WebGPU wants it. */
export type Mat4 = Float32Array;

/**
 * Infinite-far reversed-Z perspective projection.
 *
 * Standard finite projection maps z to [-1,1] or [0,1] with far at the far end.
 * Taking the limit as far -> infinity and flipping gives:
 *
 *     zClip = near,  wClip = -z    =>   zNdc = near / -z
 *
 * so a point at the near plane maps to 1 and a point at infinity maps to 0.
 * No far term appears, so nothing is ever clipped for being too distant.
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
 * View matrix in CAMERA-RELATIVE space: the camera sits at the origin, so the
 * translation column is zero by construction. A rotation-only view matrix is
 * exactly what makes the precision strategy work — there is no large translation
 * left to lose bits to.
 */
export function viewRotationOnly(cam: CameraState): Mat4 {
  const inv = qconj(cam.orientation);
  const x = qrotate(inv, v3(1, 0, 0));
  const y = qrotate(inv, v3(0, 1, 0));
  const z = qrotate(inv, v3(0, 0, 1));

  const m = new Float32Array(16);
  // Column-major: columns are the images of the basis vectors.
  m[0] = x.x; m[4] = x.y; m[8] = x.z; m[12] = 0;
  m[1] = y.x; m[5] = y.y; m[9] = y.z; m[13] = 0;
  m[2] = z.x; m[6] = z.y; m[10] = z.z; m[14] = 0;
  m[3] = 0;   m[7] = 0;   m[11] = 0;  m[15] = 1;
  return m;
}

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
