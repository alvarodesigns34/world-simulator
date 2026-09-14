import { describe, expect, it } from 'vitest';
import { EARTH_GEOMETRY } from '@ws/data';
import {
  NodePool,
  cameraFromGeodetic,
  createSelectWorkspace,
  lookAtCentre,
  selectPatches,
} from '@ws/render';

const P = EARTH_GEOMETRY;

function nowMs(): number {
  return performance.now();
}

function timeMs(fn: () => void, iter: number): number {
  for (let i = 0; i < 3; i++) fn();
  const t0 = nowMs();
  for (let i = 0; i < iter; i++) fn();
  return (nowMs() - t0) / iter;
}

describe('LOD selector regression benchmark', () => {
  const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.31, lon: 0.62, altitude: 50_000 }, P));
  const base = {
    planet: P,
    viewportWidth: 2560,
    viewportHeight: 1440,
    gpuTier: 'discrete' as const,
    patchVerticesPerSide: 33,
    maxLevel: 12,
  };

  it('NodePool preserves exact visible set', () => {
    const pool = new NodePool();
    const a = selectPatches(cam, base);
    const b = selectPatches(cam, { ...base, pool });
    const id = (r: typeof a): number[] =>
      r.visible.map((n) => (n.key.face * 1000 + n.key.level) * 1e6 + n.key.x * 1e3 + n.key.y);
    expect(id(b)).toEqual(id(a));
    expect(b.stats.visible).toBe(a.stats.visible);
    expect(b.stats.culledHorizon).toBe(a.stats.culledHorizon);
    expect(b.stats.culledFrustum).toBe(a.stats.culledFrustum);
  });

  it('workspace reuse preserves exact visible set', () => {
    const pool = new NodePool();
    const ws = createSelectWorkspace();
    const a = selectPatches(cam, { ...base, pool });
    const b = selectPatches(cam, { ...base, pool, workspace: ws });
    expect(b.stats.visible).toBe(a.stats.visible);
    expect(b.stats.nodesVisited).toBe(a.stats.nodesVisited);
    expect(b.visible.map((n) => n.key)).toEqual(a.visible.map((n) => n.key));
  });

  it('cached selection is not slower than cold (and usually much faster)', () => {
    const cold = timeMs(() => {
      selectPatches(cam, base);
    }, 25);
    const pool = new NodePool();
    const ws = createSelectWorkspace();
    selectPatches(cam, { ...base, pool, workspace: ws });
    const hot = timeMs(() => {
      selectPatches(cam, { ...base, pool, workspace: ws });
    }, 40);
    expect(hot).toBeLessThan(cold * 0.95);
    expect(pool.hits).toBeGreaterThan(pool.misses);
  });

  it('records pool hit/miss in stats', () => {
    const pool = new NodePool();
    const first = selectPatches(cam, { ...base, pool });
    expect(first.stats.poolMisses).toBeGreaterThan(0);
    const second = selectPatches(cam, { ...base, pool });
    expect(second.stats.poolHits).toBeGreaterThan(0);
    expect(second.stats.poolMisses).toBe(0);
  });
});
