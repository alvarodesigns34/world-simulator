/**
 * Tile bake (T-0052, DEC-019, DEC-034).
 *
 * Authoritative CPU tiles are L11–L18. Each tile is a pure function of
 * (seed, quadkey, ancestor geology). Streaming order and worker count cannot
 * change the bytes (DEC-017).
 *
 * A tile at level L covers one cube-sphere cell of that level and stores a
 * `size×size` elevation raster (default 8, so L11 tile ≈ 64 cells of L14).
 * Decorative L19+ is not produced here.
 */

import { type Seed } from '@ws/core';
import { cubeDim, cubeIndex, quadkey, type QuadKey } from '@ws/data';
import type { GeologyState } from '../geology/plates.js';
import { detailNoise } from '../terrain/erosion.js';
import { tileId, type TileRecord } from './storage.js';

export const AUTH_TILE_MIN = 11;
export const AUTH_TILE_MAX = 18;
export const DEFAULT_TILE_SIZE = 8;

export interface BakeInput {
  readonly seed: Seed;
  readonly key: QuadKey;
  readonly geology: GeologyState;
  readonly size?: number;
  readonly seaLevel: number;
}

/**
 * Sample the ancestor geology at a fine (face, x, y) by right-shift, then add
 * hashed sub-grid relief whose amplitude shrinks with level so it cannot invent
 * mountain belts the plates did not produce.
 */
export function sampleElevation(
  geology: GeologyState,
  seed: Seed,
  face: number,
  level: number,
  x: number,
  y: number,
): number {
  const shift = level - geology.level;
  const gx = shift >= 0 ? x >> shift : x << -shift;
  const gy = shift >= 0 ? y >> shift : y << -shift;
  const dim = cubeDim(geology.level);
  const cx = gx < 0 ? 0 : gx >= dim ? dim - 1 : gx;
  const cy = gy < 0 ? 0 : gy >= dim ? dim - 1 : gy;
  const base = geology.elevationM[cubeIndex(face, geology.level, cx, cy)] as number;
  let amp = 40;
  for (let l = geology.level; l < level; l++) amp *= 0.55;
  return base + detailNoise(seed, face, x, y, amp);
}

export function bakeTile(input: BakeInput): TileRecord {
  const size = input.size ?? DEFAULT_TILE_SIZE;
  const key = input.key;
  const elev = new Int16Array(size * size);
  const nFine = size;
  /* The tile covers one parent cell; sample a size×size grid inside it. */
  const parentDim = 2 ** key.level;
  void parentDim;
  for (let ty = 0; ty < nFine; ty++) {
    for (let tx = 0; tx < nFine; tx++) {
      const x = key.x * nFine + tx;
      const y = key.y * nFine + ty;
      let sampleShift = 0;
      for (let n = nFine; n > 1; n >>= 1) sampleShift++;
      const sampleLevel = key.level + sampleShift;
      const h = sampleElevation(input.geology, input.seed, key.face, sampleLevel, x, y);
      const q = Math.round(h);
      elev[ty * nFine + tx] = q < -32768 ? -32768 : q > 32767 ? 32767 : q;
    }
  }
  return {
    id: tileId(key),
    face: key.face,
    level: key.level,
    x: key.x,
    y: key.y,
    elevation: elev,
    size: nFine,
  };
}

/** Ancestor of `key` at `atLevel` (coarser). */
export function ancestorAt(key: QuadKey, atLevel: number): QuadKey {
  if (atLevel >= key.level) return key;
  const shift = key.level - atLevel;
  return quadkey.quadKey(key.face, atLevel, key.x >> shift, key.y >> shift);
}
