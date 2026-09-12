/**
 * Tangent-warped cube-sphere (DEC-007).
 *
 * WHY THIS PARAMETERISATION. It is the only candidate where the LOD quadtree,
 * the GPU tile atlas, the chunk seed key and the raster field index are the SAME
 * structure. That unification is worth more than its residual area distortion —
 * and the places that genuinely care about equal area (conservation laws) live on
 * the separate geodesic grid instead (DEC-008).
 *
 * WHY THE TANGENT WARP. Mapping face coordinate s in [-1,1] through
 *
 *     warp(s) = tan(s * PI/4)          (note tan(PI/4) = 1, so the range is kept)
 *
 * before projecting to the sphere reduces cell-area variation between face centre
 * and face corner from ~1.9x (naive) to ~1.3x, for the cost of one tan/atan per
 * conversion. Cheap, and it markedly improves LOD uniformity.
 *
 * ORIENTATION CONTRACT. On every face, the 3-D image of ∂/∂u × ∂/∂v points
 * *outward* (same hemisphere as the face's cube axis). Triangle (0,0)→(1,0)→(0,1)
 * is therefore CCW when viewed from outside, which is what the renderer
 * (`frontFace: 'ccw'`, `cullMode: 'back'`) expects. POS_Y / NEG_Y originally
 * pointed inward; Ampere showed the resulting holes. No persisted world exists
 * yet, so flipping those two faces is free.
 *
 * REFERENCE NUMBERS (R = 6 371 000 m):
 *   face edge arc length = 2*PI*R/4 = 10 007 543 m
 *   cell size at level L = 10 007 543 / 2^L
 *     L10 = 9.8 km   L11 = 4.9 km   L12 = 2.4 km
 *     L16 = 153 m    L20 = 9.5 m    L24 = 0.60 m
 *   cell count = 6 * 4^L
 *     L10 = 6.29e6   L11 = 2.52e7   L12 = 1.01e8
 */

import { assert, assertInRange } from '@ws/core';
import { FACE, pcf, type CubeFace, type PCF, type PlanetGeometry } from './frames.js';

const QUARTER_PI = Math.PI / 4;

/** [-1,1] -> [-1,1], concentrating samples toward the face edges. */
export function warp(s: number): number {
  return Math.tan(s * QUARTER_PI);
}

export function unwarp(w: number): number {
  return Math.atan(w) / QUARTER_PI;
}

/**
 * (face, u, v) -> unit vector in PCF.
 *
 * Face layouts are chosen so each face covers exactly one side of the cube AND
 * so ∂u × ∂v points outward. That orientation is now a contract: the quadtree,
 * the tile atlas, the seam topology and the renderer all depend on it.
 */
export function cubeFaceToUnit(c: CubeFace): PCF {
  assertInRange(c.u, 0, 1, 'CubeFace.u');
  assertInRange(c.v, 0, 1, 'CubeFace.v');

  const a = warp(c.u * 2 - 1);
  const b = warp(c.v * 2 - 1);

  let x: number;
  let y: number;
  let z: number;

  switch (c.face) {
    case FACE.POS_X: x = 1;  y = a;  z = b;  break;          // ∂u=+Y, ∂v=+Z, × = +X
    case FACE.NEG_X: x = -1; y = -a; z = b;  break;          // ∂u=-Y, ∂v=+Z, × = -X
    case FACE.POS_Y: x = a;  y = 1;  z = -b; break;          // ∂u=+X, ∂v=-Z, × = +Y
    case FACE.NEG_Y: x = a;  y = -1; z = b;  break;          // ∂u=+X, ∂v=+Z, × = -Y
    case FACE.POS_Z: x = a;  y = b;  z = 1;  break;          // ∂u=+X, ∂v=+Y, × = +Z
    case FACE.NEG_Z: x = a;  y = -b; z = -1; break;          // ∂u=+X, ∂v=-Y, × = -Z
    default:
      throw new Error(`invalid cube face: ${String(c.face)}`);
  }

  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  return pcf(x * inv, y * inv, z * inv);
}

/** Unit vector in PCF -> (face, u, v). Inverse of `cubeFaceToUnit`. */
export function unitToCubeFace(p: PCF): CubeFace {
  const ax = Math.abs(p.x);
  const ay = Math.abs(p.y);
  const az = Math.abs(p.z);

  let face: number;
  let a: number;
  let b: number;

  if (ax >= ay && ax >= az) {
    if (p.x > 0) {
      face = FACE.POS_X;
      a = p.y / ax;
      b = p.z / ax;
    } else {
      face = FACE.NEG_X;
      a = -p.y / ax;
      b = p.z / ax;
    }
  } else if (ay >= az) {
    if (p.y > 0) {
      face = FACE.POS_Y;
      a = p.x / ay;
      b = -p.z / ay;
    } else {
      face = FACE.NEG_Y;
      a = p.x / ay;
      b = p.z / ay;
    }
  } else {
    if (p.z > 0) {
      face = FACE.POS_Z;
      a = p.x / az;
      b = p.y / az;
    } else {
      face = FACE.NEG_Z;
      a = p.x / az;
      b = -p.y / az;
    }
  }

  // Clamp: a/b can land a few ulp outside [-1,1] for points exactly on an edge.
  const u = (unwarp(Math.min(1, Math.max(-1, a))) + 1) * 0.5;
  const v = (unwarp(Math.min(1, Math.max(-1, b))) + 1) * 0.5;
  return { face, u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) };
}

export function cubeFaceToPcf(c: CubeFace, planet: PlanetGeometry, altitude = 0): PCF {
  const n = cubeFaceToUnit(c);
  const r = planet.radius + altitude;
  return pcf(n.x * r, n.y * r, n.z * r);
}

export function pcfToCubeFace(p: PCF): CubeFace {
  const l = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  assert(l > 0, 'pcfToCubeFace: zero-length vector');
  return unitToCubeFace(pcf(p.x / l, p.y / l, p.z / l));
}

/** Arc length of one cube-face edge on the sphere: a quarter of a great circle. */
export function faceEdgeArcLength(planet: PlanetGeometry): number {
  return (Math.PI * planet.radius) / 2;
}

/** Mean cell size at a quadtree level, metres. */
export function cellSize(level: number, planet: PlanetGeometry): number {
  return faceEdgeArcLength(planet) / 2 ** level;
}

/** Total cells across all six faces at a level: 6 * 4^L. */
export function cellCount(level: number): number {
  return 6 * 4 ** level;
}

/** Cells along one face edge at a level. */
export function cubeDim(level: number): number {
  return 2 ** level;
}

/**
 * Raster index of (face, x, y) at a level. Face-major, then row (v/y), then
 * column (u/x). This is the FieldStore cell index for a cubesphere field.
 */
export function cubeIndex(face: number, level: number, x: number, y: number): number {
  const n = 2 ** level;
  return (face * n + y) * n + x;
}

export function cubeDecode(index: number, level: number): { face: number; x: number; y: number } {
  const n = 2 ** level;
  const n2 = n * n;
  const face = Math.floor(index / n2);
  const rem = index - face * n2;
  const y = Math.floor(rem / n);
  const x = rem - y * n;
  return { face, x, y };
}

/**
 * Like `cubeFaceToUnit` but permits u,v slightly outside [0, 1] so a step off
 * a face still produces a 3-D direction. Used only by seam topology.
 */
export function cubeFaceToUnitRaw(face: number, u: number, v: number): PCF {
  const a = warp(u * 2 - 1);
  const b = warp(v * 2 - 1);
  let x: number;
  let y: number;
  let z: number;
  switch (face) {
    case FACE.POS_X: x = 1; y = a; z = b; break;
    case FACE.NEG_X: x = -1; y = -a; z = b; break;
    case FACE.POS_Y: x = a; y = 1; z = -b; break;
    case FACE.NEG_Y: x = a; y = -1; z = b; break;
    case FACE.POS_Z: x = a; y = b; z = 1; break;
    case FACE.NEG_Z: x = a; y = -b; z = -1; break;
    default:
      throw new Error(`invalid cube face: ${String(face)}`);
  }
  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  return pcf(x * inv, y * inv, z * inv);
}

/** Bytes for a single-component raster at this level. Sizing arithmetic only —
 *  a real field's footprint comes from its descriptor (`fields/descriptor.ts`). */
export function rasterBytes(level: number, bytesPerCell: number): number {
  return cellCount(level) * bytesPerCell;
}
