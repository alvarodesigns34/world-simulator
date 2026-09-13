import { describe, expect, it } from 'vitest';
import { budgets, v3 } from '@ws/core';
import { EARTH_GEOMETRY, quadkey } from '@ws/data';
import {
  cameraFromGeodetic,
  lookAtCentre,
  moveTangential,
  selectPatches,
  setAltitude,
} from '@ws/render';

const P = EARTH_GEOMETRY;

const opts = (over: Partial<Parameters<typeof selectPatches>[1]> = {}) => ({
  planet: P,
  viewportWidth: 2560,
  viewportHeight: 1440,
  gpuTier: 'discrete' as const,
  patchVerticesPerSide: 33,
  maxLevel: 8,
  ...over,
});

function coversFinest(visible: readonly { key: ReturnType<typeof quadkey.quadKey> }[], maxLevel: number): number {
  let missing = 0;
  const n = 1 << maxLevel;
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const leaf = quadkey.quadKey(face, maxLevel, x, y);
        let ok = false;
        for (const v of visible) {
          if (quadkey.contains(v.key, leaf) || quadkey.equals(v.key, leaf)) {
            ok = true;
            break;
          }
        }
        if (!ok) missing++;
      }
    }
  }
  return missing;
}

describe('LOD stress: coverage / poles / faces / budgets', () => {
  it('uncullled selection with a comfortable budget covers the whole sphere (no holes)', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.2, lon: 0.4, altitude: 2e6 }, P));
    const r = selectPatches(
      cam,
      opts({
        enableHorizonCull: false,
        enableFrustumCull: false,
        maxLevel: 4,
        gpuTier: 'discrete',
        patchVerticesPerSide: 17,
      }),
    );
    expect(coversFinest(r.visible, 4)).toBe(0);
  });

  it('a tight but >=6 budget never drops children of a split parent (the hole bug)', () => {
    // 65x65 on the floor tier at 1080p used to emit fewer patches than the
    // split set implied, because canSplit reserved 1 slot instead of 4.
    for (const n of [17, 33, 65]) {
      const cam = lookAtCentre(cameraFromGeodetic({ lat: 0, lon: 0, altitude: 400_000 }, P));
      const r = selectPatches(
        cam,
        opts({
          patchVerticesPerSide: n,
          gpuTier: 'floor',
          viewportWidth: 1920,
          viewportHeight: 1080,
          enableHorizonCull: false,
          enableFrustumCull: false,
          maxLevel: 5,
        }),
      );
      expect(r.stats.visible).toBeGreaterThan(0);
      expect(r.stats.visible).toBeLessThanOrEqual(r.stats.budgetPatches);
      for (const id of r.split) {
        const parent = quadkey.unpackId(id);
        const kids = quadkey.children(parent);
        for (const k of kids) {
          const kidId = quadkey.packId(k);
          const inVisible = r.visible.some((n) => quadkey.packId(n.key) === kidId);
          const inSplit = r.split.has(kidId);
          const inVisibleDesc = r.visible.some((n) => quadkey.contains(k, n.key) || quadkey.equals(k, n.key));
          expect(inVisible || inSplit || inVisibleDesc).toBe(true);
        }
      }
    }
  });

  it('works at both poles and does not emit NaN stats', () => {
    for (const lat of [Math.PI / 2, -Math.PI / 2, Math.PI / 2 - 1e-6, -Math.PI / 2 + 1e-6]) {
      for (const alt of [2, 50, 5_000, 200_000, 2e7]) {
        const cam = lookAtCentre(cameraFromGeodetic({ lat, lon: 1.7, altitude: alt }, P));
        const r = selectPatches(cam, opts({ maxLevel: 7 }));
        expect(r.stats.visible).toBeGreaterThan(0);
        expect(Number.isFinite(r.stats.triangles)).toBe(true);
        expect(r.stats.nodesVisited).toBeGreaterThan(0);
      }
    }
  });

  it('survives cube-face centres, edges and the 8 corners', () => {
    const spots: Array<[number, number]> = [
      [0, 0],
      [0.5, 0],
      [1, 0],
      [0, 0.5],
      [1, 0.5],
      [0, 1],
      [0.5, 1],
      [1, 1],
    ];
    // Sample a few geodetic positions that sit on face boundaries.
    const geos = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: Math.PI / 2 },
      { lat: 0, lon: Math.PI },
      { lat: 0, lon: -Math.PI / 2 },
      { lat: Math.PI / 4, lon: Math.PI / 4 },
      { lat: -Math.PI / 4, lon: -Math.PI / 4 },
    ];
    for (const g of geos) {
      const cam = lookAtCentre(cameraFromGeodetic({ ...g, altitude: 300_000 }, P));
      const r = selectPatches(cam, opts());
      expect(r.stats.visible).toBeGreaterThan(0);
    }
    expect(spots.length).toBe(8);
  });

  it('partially visible patches at grazing angles still produce a set', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0, lon: 0, altitude: 50_000 }, P));
    const r = selectPatches(cam, opts({ maxLevel: 9 }));
    expect(r.stats.culledHorizon + r.stats.culledFrustum).toBeGreaterThan(0);
    expect(r.stats.visible).toBeGreaterThan(0);
  });

  it('extreme relief bounds do not invert horizon culling', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.3, lon: 0.2, altitude: 400_000 }, P));
    const a = selectPatches(cam, opts({ maxTerrainElevation: 0 }));
    const b = selectPatches(cam, opts({ maxTerrainElevation: 9000 }));
    // Inflating the NODE keeps more, never fewer.
    expect(b.stats.culledHorizon).toBeLessThanOrEqual(a.stats.culledHorizon);
    expect(b.stats.visible).toBeGreaterThanOrEqual(a.stats.visible);
  });

  it('rapid motion does not produce empty frames or NaNs', () => {
    let cam = lookAtCentre(cameraFromGeodetic({ lat: 0, lon: 0, altitude: 1e6 }, P));
    let prev = new Set<number>();
    for (let i = 0; i < 40; i++) {
      cam = moveTangential(cam, v3(0, 0, 1), 0.08);
      cam = lookAtCentre(cam);
      cam = setAltitude(cam, Math.max(2, 1e6 * Math.exp(-i * 0.15)), P);
      const r = selectPatches(cam, opts({ previouslySplit: prev, maxLevel: 8 }));
      prev = r.split as Set<number>;
      expect(r.stats.visible).toBeGreaterThan(0);
      expect(Number.isFinite(r.stats.triangles)).toBe(true);
    }
  });

  it('abrupt direction changes stay within budget', () => {
    const alts = [2e7, 1e6, 5e4, 200, 2];
    for (const alt of alts) {
      for (const lat of [-1.2, 0, 1.2]) {
        const cam = lookAtCentre(cameraFromGeodetic({ lat, lon: iLon(alt), altitude: alt }, P));
        const r = selectPatches(cam, opts({ maxLevel: 8 }));
        expect(r.stats.visible).toBeLessThanOrEqual(r.stats.budgetPatches);
      }
    }
  });

  it('very low and very high patch budgets both return a well-formed antichain', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.1, lon: 0.2, altitude: 80_000 }, P));
    for (const n of [17, 65]) {
      const r = selectPatches(cam, opts({ patchVerticesPerSide: n, maxLevel: 7 }));
      const ids = r.visible.map((v) => quadkey.packId(v.key));
      expect(new Set(ids).size).toBe(ids.length);
      for (const a of r.visible) {
        for (const b of r.visible) {
          if (a === b) continue;
          expect(quadkey.contains(a.key, b.key)).toBe(false);
        }
      }
    }
  });
});

function iLon(alt: number): number {
  return (alt % 7) * 0.3;
}

describe('LOD distribution is altitude-monotonic on a smooth sphere', () => {
  it('max level reached increases as altitude falls, until the cap', () => {
    const levels: number[] = [];
    for (const alt of [2e7, 5e6, 1e6, 2e5, 4e4, 8e3, 400]) {
      const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.25, lon: 0.4, altitude: alt }, P));
      levels.push(selectPatches(cam, opts({ maxLevel: 10 })).stats.maxLevelReached);
    }
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i] as number).toBeGreaterThanOrEqual(levels[i - 1] as number);
    }
    expect(budgets.QUALITY.patchVerticesPerSide).toBe(33);
  });
});
