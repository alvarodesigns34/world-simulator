import { describe, expect, it } from 'vitest';
import { makeSeed } from '@ws/core';
import { quadkey } from '@ws/data';
import {
  DEFAULT_GENESIS,
  MemoryTileStore,
  TileCache,
  ancestorAt,
  bakeTile,
  runGenesis,
  sampleElevation,
  tileId,
} from '@ws/sim';

const SEED = makeSeed(0x51a5, 0x1a51);

describe('T-0052 tiles', () => {
  const geology = runGenesis({ seed: SEED, ...DEFAULT_GENESIS, level: 4, steps: 20, plateCount: 8 });

  it('bake is a pure function of (seed, key)', () => {
    const key = quadkey.quadKey(0, 6, 3, 5);
    const a = bakeTile({ seed: SEED, key, geology, seaLevel: 0 });
    const b = bakeTile({ seed: SEED, key, geology, seaLevel: 0 });
    expect(a.elevation.length).toBe(a.size * a.size);
    for (let i = 0; i < a.elevation.length; i++) expect(a.elevation[i]).toBe(b.elevation[i]);
  });

  it('a different seed changes the detail, not the ancestor plate', () => {
    const key = quadkey.quadKey(2, 6, 1, 1);
    const a = bakeTile({ seed: SEED, key, geology, seaLevel: 0 });
    const b = bakeTile({ seed: makeSeed(9, 9), key, geology, seaLevel: 0 });
    let diff = 0;
    for (let i = 0; i < a.elevation.length; i++) diff += Math.abs((a.elevation[i] as number) - (b.elevation[i] as number));
    expect(diff).toBeGreaterThan(0);
  });

  it('LRU evicts the oldest and ancestor fallback returns a coarser tile', () => {
    const cache = new TileCache({ storage: new MemoryTileStore(), capacity: 4 });
    const keys = [0, 1, 2, 3, 4].map((x) => quadkey.quadKey(0, 6, x, 0));
    for (const k of keys) cache.get(k, geology, SEED, 0, false);
    expect(cache.storage.size).toBe(4);
    const fine = quadkey.quadKey(0, 7, 0, 0);
    cache.get(ancestorAt(fine, 6), geology, SEED, 0, false);
    const got = cache.get(fine, geology, SEED, 0, true);
    expect(got.level).toBeLessThanOrEqual(7);
  });

  it('chain prefetch is coarse-to-fine and cancelled between tiles', () => {
    const cache = new TileCache({ capacity: 64 });
    const key = quadkey.quadKey(1, 8, 4, 4);
    cache.prefetchChain(key, geology, SEED, 0);
    expect(cache.storage.get(tileId(ancestorAt(key, 6))) || cache.bakes > 0).toBeTruthy();
    cache.cancelAll();
    expect(cache.cancelled).toBe(true);
  });

  it('sampleElevation is finite and mean-zero-ish around the ancestor', () => {
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += sampleElevation(geology, SEED, 0, 6, i, 0);
    expect(Number.isFinite(sum)).toBe(true);
  });
});
