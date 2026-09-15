/**
 * Tile persistence port (T-0052, M2).
 *
 * OPFS is a browser API, so it must not live in `sim` (DEC-011 purity).
 * This module is the port: a synchronous memory store for tests and genesis,
 * plus the interface `app` implements with OPFS.
 *
 * Tiles are identified by a packed quadkey. Regeneration from (seed, key) is
 * bit-identical, so a cache miss is never a correctness miss.
 */

import { invariant } from '@ws/core';
import type { QuadKey } from '@ws/data';

export function packTileId(k: QuadKey): number {
  /* 3 face + 5 level + 20 x + 20 y = 48 bits, fits in f64-safe int. */
  invariant(k.level >= 0 && k.level <= 20, 'tile level 0..20');
  return (k.face + ((k.level + (k.x + k.y * 0x100000) * 32) * 6));
}

export function tileId(k: QuadKey): string {
  return `${k.face.toString(10)}/${k.level.toString(10)}/${k.x.toString(10)}/${k.y.toString(10)}`;
}

export interface TileRecord {
  readonly id: string;
  readonly face: number;
  readonly level: number;
  readonly x: number;
  readonly y: number;
  /** Cell elevations, row-major, `size * size`. i16 metres. */
  readonly elevation: Int16Array;
  readonly size: number;
}

export interface TileStorage {
  get(id: string): TileRecord | undefined;
  set(tile: TileRecord): void;
  delete(id: string): void;
  readonly size: number;
}

/** In-memory store. Deterministic. Used by tests and as the OPFS write-through L1. */
export class MemoryTileStore implements TileStorage {
  private readonly map = new Map<string, TileRecord>();

  get(id: string): TileRecord | undefined {
    return this.map.get(id);
  }

  set(tile: TileRecord): void {
    this.map.set(tile.id, tile);
  }

  delete(id: string): void {
    this.map.delete(id);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
