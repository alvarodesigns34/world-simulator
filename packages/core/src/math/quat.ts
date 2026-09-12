/**
 * Unit quaternions and f64 vectors (DEC-029).
 *
 * The camera's orientation is a quaternion rather than Euler angles because
 * Euler angles gimbal-lock, and the place they lock — the pole — is exactly
 * where the cryosphere is and where the M1 descent sweep goes (AUDIT-V0 B4).
 */

import { assertFinite } from '../assert.js';

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const V3_ZERO: Vec3 = v3(0, 0, 0);

export const vadd = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const vsub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const vscale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
export const vdot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const vlen = (a: Vec3): number => Math.sqrt(vdot(a, a));

export const vcross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export function vnorm(a: Vec3): Vec3 {
  const l = vlen(a);
  assertFinite(l, 'vnorm length');
  if (l === 0) return V3_ZERO;
  return vscale(a, 1 / l);
}

export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export const QUAT_IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

export function quat(x: number, y: number, z: number, w: number): Quat {
  return { x, y, z, w };
}

export function qmul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function qconj(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function qlen(q: Quat): number {
  return Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
}

/**
 * Renormalise. Called after every accumulation: repeated multiplication drifts
 * off the unit sphere, and a non-unit quaternion scales the scene.
 */
export function qnorm(q: Quat): Quat {
  const l = qlen(q);
  if (l === 0) return QUAT_IDENTITY;
  const s = 1 / l;
  return { x: q.x * s, y: q.y * s, z: q.z * s, w: q.w * s };
}

/** Rotate a vector by a unit quaternion: v' = q v q*. */
export function qrotate(q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return v3(
    v.x + q.w * tx + (q.y * tz - q.z * ty),
    v.y + q.w * ty + (q.z * tx - q.x * tz),
    v.z + q.w * tz + (q.x * ty - q.y * tx),
  );
}

export function qFromAxisAngle(axis: Vec3, angle: number): Quat {
  const a = vnorm(axis);
  const h = angle * 0.5;
  const s = Math.sin(h);
  return { x: a.x * s, y: a.y * s, z: a.z * s, w: Math.cos(h) };
}

/**
 * Orientation from a forward and an up hint, right-handed, with the convention
 * that the camera looks down its local -Z and its local +Y is up.
 *
 * `up` is a HINT: it is re-orthogonalised against `forward`. When the two are
 * parallel — looking straight down at a pole, the case that breaks naive
 * implementations — a fallback axis is chosen deterministically, so the result
 * is always a valid orientation rather than a NaN.
 */
export function qLookRotation(forward: Vec3, upHint: Vec3): Quat {
  const f = vnorm(forward);
  let u = upHint;

  let right = vcross(f, u);
  if (vlen(right) < 1e-9) {
    const alt = Math.abs(f.z) < 0.9 ? v3(0, 0, 1) : v3(1, 0, 0);
    right = vcross(f, alt);
  }
  right = vnorm(right);
  u = vcross(right, f);

  // Basis columns: X = right, Y = up, Z = -forward (camera looks down -Z).
  const m00 = right.x, m01 = u.x, m02 = -f.x;
  const m10 = right.y, m11 = u.y, m12 = -f.y;
  const m20 = right.z, m21 = u.z, m22 = -f.z;

  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return qnorm(quat((m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s));
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return qnorm(quat(0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s));
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return qnorm(quat((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s));
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return qnorm(quat((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s));
}

export const qForward = (q: Quat): Vec3 => qrotate(q, v3(0, 0, -1));
export const qUp = (q: Quat): Vec3 => qrotate(q, v3(0, 1, 0));
export const qRight = (q: Quat): Vec3 => qrotate(q, v3(1, 0, 0));

/** Shortest-arc spherical interpolation, for cinematic keyframes (M13). */
export function qslerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let end = b;
  if (cos < 0) {
    cos = -cos;
    end = quat(-b.x, -b.y, -b.z, -b.w);
  }
  if (cos > 0.9995) {
    return qnorm(
      quat(
        a.x + (end.x - a.x) * t,
        a.y + (end.y - a.y) * t,
        a.z + (end.z - a.z) * t,
        a.w + (end.w - a.w) * t,
      ),
    );
  }
  const theta = Math.acos(cos);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return qnorm(
    quat(a.x * wa + end.x * wb, a.y * wa + end.y * wb, a.z * wa + end.z * wb, a.w * wa + end.w * wb),
  );
}
