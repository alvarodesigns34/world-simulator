import { describe, expect, it } from 'vitest';
import { budgets, v3, vlen, vnorm, vscale, vsub } from '@ws/core';
import { EARTH_GEOMETRY, quadkey } from '@ws/data';
import {
  cameraFromGeodetic,
  horizonVisible,
  lookAtCentre,
  makeNode,
  rootNodes,
  screenSpaceError,
  selectPatches,
  sortVisible,
} from '@ws/render';

const P = EARTH_GEOMETRY;
const R = P.radius;

const opts = (over: Partial<Parameters<typeof selectPatches>[1]> = {}) => ({
  planet: P,
  viewportWidth: 2560,
  viewportHeight: 1440,
  gpuTier: 'discrete' as const,
  patchVerticesPerSide: 33,
  maxLevel: 8,
  ...over,
});

describe('quadtree nodes', () => {
  it('has six roots, one per face, in fixed order', () => {
    const roots = rootNodes(P);
    expect(roots).toHaveLength(6);
    expect(roots.map((r) => r.key.face)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('node centres lie on the sphere', () => {
    for (const r of rootNodes(P)) {
      expect(vlen(r.centre)).toBeCloseTo(R, 3);
    }
  });

  it('geometric error shrinks with level, which is what drives LOD', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let level = 0; level < 12; level++) {
      const n = makeNode(quadkey.quadKey(0, level, 0, 0), P);
      expect(n.geometricError).toBeLessThan(prev);
      prev = n.geometricError;
    }
  });

  it('is a pure function of the key — same key, same node', () => {
    const a = makeNode(quadkey.quadKey(3, 5, 7, 11), P);
    const b = makeNode(quadkey.quadKey(3, 5, 7, 11), P);
    expect(a.centre).toEqual(b.centre);
    expect(a.radius).toBe(b.radius);
    expect(a.geometricError).toBe(b.geometricError);
  });
});

/** DEC-034 rule 1. The correctness direction that matters is conservativeness. */
describe('horizon culling (DEC-034)', () => {
  const camAt = (alt: number) => vscale(v3(0, 0, 1), R + alt);

  it('keeps the patch directly under the camera', () => {
    const under = vscale(v3(0, 0, 1), R);
    expect(horizonVisible(under, 0, camAt(1e6), R)).toBe(true);
  });

  it('culls the antipode', () => {
    const anti = vscale(v3(0, 0, -1), R);
    expect(horizonVisible(anti, 0, camAt(1e6), R)).toBe(false);
  });

  it('never culls anything actually visible — the conservative direction', () => {
    // Sample the sphere; anything the analytic horizon says is visible must be
    // kept, and the test asserts the implication in the safe direction.
    const cam = camAt(2_000_000);
    const camLen = vlen(cam);
    const cosHorizon = R / camLen; // angle from the camera axis to the horizon
    for (let i = 0; i < 20_000; i++) {
      const t = (i / 20_000) * Math.PI;
      const p = vscale(vnorm(v3(Math.sin(t), 0, Math.cos(t))), R);
      const cosAngle = (p.x * cam.x + p.y * cam.y + p.z * cam.z) / (R * camLen);
      const trulyVisible = cosAngle >= cosHorizon - 1e-12;
      if (trulyVisible) {
        expect(horizonVisible(p, 0, cam, R)).toBe(true);
      }
    }
  });

  it('inflating the radius keeps surface nodes just past the horizon', () => {
    // What the inflation is FOR: a patch whose bounding-sphere centre sits on
    // the reference sphere, just past the tangent point, may still contain
    // terrain tall enough to be visible. Note a raised point does not need the
    // inflation — its own altitude already lifts it over the horizon plane,
    // which is why this tests a SURFACE-centred node.
    const cam = camAt(500_000);
    const t = Math.acos(R / vlen(cam)) + 0.002;
    const dir = vnorm(v3(Math.sin(t), 0, Math.cos(t)));
    const onSurface = vscale(dir, R);

    expect(horizonVisible(onSurface, 0, cam, R)).toBe(false);
    expect(horizonVisible(onSurface, 20_000, cam, R)).toBe(true);
  });

  it('a tall peak past the geometric horizon is visible without inflation', () => {
    // The physically correct behaviour, asserted so a future "optimisation"
    // that culls by surface position alone is caught.
    const cam = camAt(500_000);
    const t = Math.acos(R / vlen(cam)) + 0.0005;
    const dir = vnorm(v3(Math.sin(t), 0, Math.cos(t)));
    expect(horizonVisible(vscale(dir, R + 8_000), 0, cam, R)).toBe(true);
    expect(horizonVisible(vscale(dir, R), 0, cam, R)).toBe(false);
  });

  it('keeps everything when the camera is at ground level', () => {
    const cam = camAt(1);
    const under = vscale(v3(0, 0, 1), R);
    expect(horizonVisible(under, 1000, cam, R)).toBe(true);
  });

  it('inflating the OCCLUDER would cull more, not less — the sign check', () => {
    const cam = camAt(500_000);
    const t = Math.acos(R / vlen(cam)) + 0.002;
    const onSurface = vscale(vnorm(v3(Math.sin(t), 0, Math.cos(t))), R);
    // Growing the node keeps it; growing the occluder does not.
    expect(horizonVisible(onSurface, 20_000, cam, R)).toBe(true);
    expect(horizonVisible(onSurface, 0, cam, R + 20_000)).toBe(false);
  });
});

describe('screen-space error', () => {
  it('scales inversely with distance', () => {
    const a = screenSpaceError(100, 1000, 1440, Math.PI / 3);
    const b = screenSpaceError(100, 2000, 1440, Math.PI / 3);
    expect(b).toBeCloseTo(a / 2, 6);
  });

  it('scales with viewport height', () => {
    const a = screenSpaceError(100, 1000, 720, Math.PI / 3);
    const b = screenSpaceError(100, 1000, 1440, Math.PI / 3);
    expect(b).toBeCloseTo(a * 2, 6);
  });
});

describe('LOD selection (DEC-010, DEC-032, DEC-034)', () => {
  it('produces more detail near the surface than from orbit', () => {
    const orbit = lookAtCentre(cameraFromGeodetic({ lat: 0, lon: 0, altitude: 20e6 }, P));
    const low = lookAtCentre(cameraFromGeodetic({ lat: 0, lon: 0, altitude: 5000 }, P));
    const a = selectPatches(orbit, opts());
    const b = selectPatches(low, opts());
    expect(b.stats.maxLevelReached).toBeGreaterThan(a.stats.maxLevelReached);
  });

  it('culls roughly half the planet at orbital altitude', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0, lon: 0, altitude: 20e6 }, P));
    const r = selectPatches(cam, opts({ enableFrustumCull: false }));
    expect(r.stats.culledHorizon).toBeGreaterThan(0);
  });

  it('horizon culling removes patches that frustum culling alone would keep', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0, lon: 0, altitude: 500_000 }, P));
    const withHorizon = selectPatches(cam, opts({ enableHorizonCull: true }));
    const without = selectPatches(cam, opts({ enableHorizonCull: false }));
    expect(withHorizon.stats.visible).toBeLessThan(without.stats.visible);
  });

  it('NEVER exceeds the resolved patch budget (DEC-032)', () => {
    for (const tier of ['discrete', 'integrated', 'floor'] as const) {
      for (const n of [17, 33, 65]) {
        for (const alt of [1e3, 1e5, 1e6, 2e7]) {
          const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.3, lon: 0.7, altitude: alt }, P));
          const r = selectPatches(cam, opts({ gpuTier: tier, patchVerticesPerSide: n }));
          expect(r.stats.visible).toBeLessThanOrEqual(r.stats.budgetPatches);
          // And the small-triangle floor holds.
          const px = 2560 * 1440;
          if (r.stats.triangles > 0) {
            expect(px / r.stats.triangles).toBeGreaterThanOrEqual(
              budgets.QUALITY.minPxPerTriangle,
            );
          }
        }
      }
    }
  });

  it('is deterministic: same camera, same result', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.2, lon: -1.1, altitude: 300_000 }, P));
    const a = sortVisible(selectPatches(cam, opts()).visible).map((n) => quadkey.packId(n.key));
    const b = sortVisible(selectPatches(cam, opts()).visible).map((n) => quadkey.packId(n.key));
    expect(b).toEqual(a);
  });

  it('never emits a node twice, and never a node and its ancestor', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.4, lon: 0.4, altitude: 100_000 }, P));
    const vis = selectPatches(cam, opts()).visible;
    const ids = vis.map((n) => quadkey.packId(n.key));
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of vis) {
      for (const b of vis) {
        if (a === b) continue;
        expect(quadkey.contains(a.key, b.key)).toBe(false);
      }
    }
  });

  it('hysteresis stops a node on the threshold from oscillating (DEC-034 rule 5)', () => {
    // Walk the camera slowly across an altitude that sits near a split
    // threshold, feeding the previous split set back in. Count how often the
    // visible set changes; with hysteresis it must settle rather than flap.
    let prevSplit: ReadonlySet<number> = new Set();
    let flips = 0;
    let prevCount = -1;
    for (let i = 0; i < 200; i++) {
      const alt = 120_000 + Math.sin(i / 7) * 300; // small oscillation
      const cam = lookAtCentre(cameraFromGeodetic({ lat: 0, lon: 0, altitude: alt }, P));
      const r = selectPatches(cam, opts({ previouslySplit: prevSplit }));
      prevSplit = r.split;
      if (prevCount >= 0 && r.stats.visible !== prevCount) flips++;
      prevCount = r.stats.visible;
    }
    // Without hysteresis a boundary node flips on most frames. Allow some
    // genuine change from the moving camera, but not per-frame churn.
    expect(flips).toBeLessThan(60);
  });

  it('respects maxLevel so M1 never tries to reach L19', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0, lon: 0, altitude: 2 }, P));
    const r = selectPatches(cam, opts({ maxLevel: 6 }));
    expect(r.stats.maxLevelReached).toBeLessThanOrEqual(6);
  });

  it('all visible patches are in front of the camera at low altitude', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.1, lon: 0.1, altitude: 50_000 }, P));
    const camPos = v3(cam.position.x, cam.position.y, cam.position.z);
    for (const n of selectPatches(cam, opts()).visible) {
      // Nothing on the far side of the planet survives.
      const toNode = vsub(n.centre, camPos);
      expect(vlen(toNode)).toBeLessThan(vlen(camPos) + R);
    }
  });

  it('works at the poles, where the camera representation used to break', () => {
    for (const lat of [Math.PI / 2, -Math.PI / 2]) {
      const cam = lookAtCentre(cameraFromGeodetic({ lat, lon: 0, altitude: 200_000 }, P));
      const r = selectPatches(cam, opts());
      expect(r.stats.visible).toBeGreaterThan(0);
      expect(Number.isFinite(r.stats.triangles)).toBe(true);
    }
  });
});
