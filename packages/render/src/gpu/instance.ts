/**
 * Patch instance packing (DEC-005, DEC-033).
 *
 * Pure: no GPU types. The renderer uploads the Float32Array this writes.
 * Layout matches `PatchInstance` in planet.wgsl.ts — 4 × vec4 = 16 floats:
 *
 *   c00.xyz  camera-relative sphere corner (u0,v0)   c00.w = lod level
 *   c10.xyz  camera-relative sphere corner (u1,v0)   c10.w = face
 *   c01.xyz  camera-relative sphere corner (u0,v1)   c01.w = 0
 *   c11.xyz  camera-relative sphere corner (u1,v1)   c11.w = 0
 *
 * The f64 → f32 conversion is the subtraction `R * unit - camera` on the CPU.
 * Nothing of magnitude |camera| is stored as a reconstructed world position.
 */

import { v3, type Vec3 } from '@ws/core';
import { cubeFaceToUnit, quadkey, type QuadKey } from '@ws/data';

export const FLOATS_PER_INSTANCE = 20;

export interface CameraPos {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PackedCorners {
  readonly c00: Vec3;
  readonly c10: Vec3;
  readonly c01: Vec3;
  readonly c11: Vec3;
  readonly level: number;
  readonly face: number;
  readonly h00: number;
  readonly h10: number;
  readonly h01: number;
  readonly h11: number;
}

function relCorner(unit: { x: number; y: number; z: number }, radius: number, cam: CameraPos): Vec3 {
  return v3(unit.x * radius - cam.x, unit.y * radius - cam.y, unit.z * radius - cam.z);
}

/** Four camera-relative sphere corners of a quadkey's cell. */
export function patchCorners(key: QuadKey, radius: number, cam: CameraPos): PackedCorners {
  const [u0, v0, u1, v1] = quadkey.bounds(key);
  const face = key.face;
  const p00 = cubeFaceToUnit({ face, u: u0, v: v0 });
  const p10 = cubeFaceToUnit({ face, u: u1, v: v0 });
  const p01 = cubeFaceToUnit({ face, u: u0, v: v1 });
  const p11 = cubeFaceToUnit({ face, u: u1, v: v1 });
  return {
    c00: relCorner(p00, radius, cam),
    c10: relCorner(p10, radius, cam),
    c01: relCorner(p01, radius, cam),
    c11: relCorner(p11, radius, cam),
    level: key.level,
    face,
    h00: 0,
    h10: 0,
    h01: 0,
    h11: 0,
  };
}

export function packPatchInstance(out: Float32Array, at: number, packed: PackedCorners): void {
  let k = at * FLOATS_PER_INSTANCE;
  out[k++] = packed.c00.x;
  out[k++] = packed.c00.y;
  out[k++] = packed.c00.z;
  out[k++] = packed.level;
  out[k++] = packed.c10.x;
  out[k++] = packed.c10.y;
  out[k++] = packed.c10.z;
  out[k++] = packed.face;
  out[k++] = packed.c01.x;
  out[k++] = packed.c01.y;
  out[k++] = packed.c01.z;
  out[k++] = 0;
  out[k++] = packed.c11.x;
  out[k++] = packed.c11.y;
  out[k++] = packed.c11.z;
  out[k++] = 0;
  out[k++] = packed.h00;
  out[k++] = packed.h10;
  out[k++] = packed.h01;
  out[k++] = packed.h11;
}

/**
 * CCW index buffer for an n×n (u,v) grid, paired with `frontFace: 'ccw'`
 * and outward ∂u × ∂v. First quad is (a,b,c)+(b,d,c), NOT the old CW
 * (a,c,b)+(b,c,d) that back-face-culled every outward face.
 */
export function patchIndices(n: number): Uint32Array<ArrayBuffer> {
  const quads = (n - 1) * (n - 1);
  const indices = new Uint32Array(new ArrayBuffer(quads * 6 * 4));
  let k = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = d;
      indices[k++] = c;
    }
  }
  return indices;
}

/** Shader bilinear, in JS, so tests can pin the interpolant without a GPU. */
export function bilerpCorners(p: PackedCorners, u: number, v: number): Vec3 {
  const a = v3(
    p.c00.x + (p.c10.x - p.c00.x) * u,
    p.c00.y + (p.c10.y - p.c00.y) * u,
    p.c00.z + (p.c10.z - p.c00.z) * u,
  );
  const b = v3(
    p.c01.x + (p.c11.x - p.c01.x) * u,
    p.c01.y + (p.c11.y - p.c01.y) * u,
    p.c01.z + (p.c11.z - p.c01.z) * u,
  );
  return v3(a.x + (b.x - a.x) * v, a.y + (b.y - a.y) * v, a.z + (b.z - a.z) * v);
}

/**
 * The interpolation Astra saw: three corners as a parallelogram.
 * `threeCorner(c00,c10,c01,1,1) = c10+c01-c00`, which is not c11 on a sphere.
 */
export function threeCornerParallelogram(p: PackedCorners, u: number, v: number): Vec3 {
  return v3(
    p.c00.x + (p.c10.x - p.c00.x) * u + (p.c01.x - p.c00.x) * v,
    p.c00.y + (p.c10.y - p.c00.y) * u + (p.c01.y - p.c00.y) * v,
    p.c00.z + (p.c10.z - p.c00.z) * u + (p.c01.z - p.c00.z) * v,
  );
}
