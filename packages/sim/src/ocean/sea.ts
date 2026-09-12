/**
 * Sea level, ocean mask, water depth, shoreline (M3).
 *
 * The coast is a derived view of elevation vs a single global sea level.
 * There is no second coastline dataset.
 */

import { cubeDim, cubeIndex } from '@ws/data';
import type { GeologyState } from '../geology/plates.js';
import { chooseSeaLevel } from '../terrain/hypsometry.js';

export interface OceanState {
  readonly seaLevel: number;
  readonly mask: Uint8Array;
  readonly depthM: Float32Array;
  readonly oceanFraction: number;
}

export function deriveOcean(geology: GeologyState, seaLevel?: number): OceanState {
  const sl = seaLevel ?? chooseSeaLevel(geology.elevationM, 0.71);
  const n = geology.cellCount;
  const mask = new Uint8Array(n);
  const depth = new Float32Array(n);
  let ocean = 0;
  for (let i = 0; i < n; i++) {
    const h = geology.elevationM[i] as number;
    if (h < sl) {
      mask[i] = 1;
      depth[i] = sl - h;
      ocean++;
    } else {
      mask[i] = 0;
      depth[i] = 0;
    }
  }
  return { seaLevel: sl, mask, depthM: depth, oceanFraction: ocean / n };
}

/** 4-connected land/ocean transition count — a shoreline length proxy. */
export function shorelineCells(mask: Uint8Array, level: number): number {
  const n = cubeDim(level);
  let c = 0;
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = cubeIndex(face, level, x, y);
        if (mask[i] === 0) continue;
        const left = x > 0 ? (mask[cubeIndex(face, level, x - 1, y)] as number) : 1;
        const right = x + 1 < n ? (mask[cubeIndex(face, level, x + 1, y)] as number) : 1;
        const down = y > 0 ? (mask[cubeIndex(face, level, x, y - 1)] as number) : 1;
        const up = y + 1 < n ? (mask[cubeIndex(face, level, x, y + 1)] as number) : 1;
        if (left === 0 || right === 0 || down === 0 || up === 0) c++;
      }
    }
  }
  return c;
}
