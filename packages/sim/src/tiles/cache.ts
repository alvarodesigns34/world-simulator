/**
 * LRU tile cache + ancestor fallback + chain prefetch (T-0052, DEC-034).
 *
 * The quadtree exists at every level; data does not. A descending camera that
 * asks for L16 before L11 is baked gets the ancestor, never a hole.
 *
 * Cancellation is cooperative: a cancelled prefetch stops between tiles.
 * Application of baked tiles is in quadkey order, never completion order.
 */

import { invariant, type Seed } from '@ws/core';
import { quadkey, type QuadKey } from '@ws/data';
import type { GeologyState } from '../geology/plates.js';
import { createCancelToken, type CancelToken } from '../workers/pool.js';
import { AUTH_TILE_MAX, AUTH_TILE_MIN, ancestorAt, bakeTile } from './bake.js';
import { MemoryTileStore, tileId, type TileRecord, type TileStorage } from './storage.js';

export interface TileCacheOptions {
  readonly capacity?: number;
  readonly storage?: TileStorage;
}

export class TileCache {
  readonly storage: TileStorage;
  readonly capacity: number;
  private readonly lru: string[] = [];
  private readonly cancel: CancelToken = createCancelToken();
  hits = 0;
  misses = 0;
  bakes = 0;

  constructor(opts?: TileCacheOptions) {
    this.storage = opts?.storage ?? new MemoryTileStore();
    this.capacity = opts?.capacity ?? 2048;
  }

  cancelAll(): void {
    this.cancel.cancelled = true;
  }

  resetCancellation(): void {
    this.cancel.cancelled = false;
  }

  get cancelled(): boolean {
    return this.cancel.cancelled;
  }

  /** Non-blocking cache read used by the renderer streaming path. */
  lookup(key: QuadKey, fallback = true): TileRecord | undefined {
    const id = tileId(key);
    const exact = this.storage.get(id);
    if (exact) { this.touch(id); this.hits++; return exact; }
    this.misses++;
    if (!fallback) return undefined;
    for (let l = key.level - 1; l >= AUTH_TILE_MIN; l--) {
      const ancestor = this.storage.get(tileId(ancestorAt(key, l)));
      if (ancestor) { this.touch(ancestor.id); this.hits++; return ancestor; }
    }
    return undefined;
  }

  /** Main-thread publication boundary for a worker-produced tile. */
  put(tile: TileRecord): void { this.insert(tile); }

  /** Geological generations invalidate derived tile content and persistence. */
  invalidateAll(): void {
    for (const id of this.lru) this.storage.delete(id);
    this.lru.length = 0;
    this.cancel.cancelled = false;
  }

  /**
   * Return the tile for `key`, baking on miss. If a coarser ancestor is the
   * best we have and `fallback` is true, return that rather than blocking.
   */
  get(
    key: QuadKey,
    geology: GeologyState,
    seed: Seed,
    seaLevel: number,
    fallback = true,
  ): TileRecord {
    const id = tileId(key);
    const hit = this.storage.get(id);
    if (hit) {
      this.touch(id);
      this.hits += 1;
      return hit;
    }
    this.misses += 1;
    if (fallback) {
      for (let l = key.level - 1; l >= AUTH_TILE_MIN && l >= geology.level; l--) {
        const anc = this.storage.get(tileId(ancestorAt(key, l)));
        if (anc) {
          this.hits += 1;
          return anc;
        }
      }
    }
    const baked = bakeTile({ seed, key, geology, seaLevel });
    this.insert(baked);
    this.bakes += 1;
    return baked;
  }

  /**
   * Prefetch the ancestor chain coarse → fine (DEC-034 rule 4), then the four
   * children if `key.level` is below the authoritative ceiling.
   */
  prefetchChain(
    key: QuadKey,
    geology: GeologyState,
    seed: Seed,
    seaLevel: number,
  ): void {
    const chain: QuadKey[] = [];
    for (let l = Math.max(AUTH_TILE_MIN, geology.level); l <= key.level && l <= AUTH_TILE_MAX; l++) {
      chain.push(ancestorAt(key, l));
    }
    if (key.level < AUTH_TILE_MAX) {
      const kids = quadkey.children(key);
      for (let i = 0; i < 4; i++) chain.push(kids[i] as QuadKey);
    }
    chain.sort((a, b) => a.level - b.level || a.face - b.face || a.x - b.x || a.y - b.y);
    for (const k of chain) {
      if (this.cancel.cancelled) return;
      this.get(k, geology, seed, seaLevel, false);
    }
  }

  private insert(tile: TileRecord): void {
    if (this.storage.get(tile.id)) {
      this.touch(tile.id);
      this.storage.set(tile);
      return;
    }
    while (this.lru.length >= this.capacity) {
      const victim = this.lru.shift();
      if (victim !== undefined) this.storage.delete(victim);
    }
    this.storage.set(tile);
    this.lru.push(tile.id);
  }

  private touch(id: string): void {
    const i = this.lru.indexOf(id);
    if (i >= 0) this.lru.splice(i, 1);
    this.lru.push(id);
  }
}

export function assertAuthLevel(level: number): void {
  invariant(
    level >= AUTH_TILE_MIN && level <= AUTH_TILE_MAX,
    `authoritative tiles are L${String(AUTH_TILE_MIN)}–L${String(AUTH_TILE_MAX)}`,
  );
}
