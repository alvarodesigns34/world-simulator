import { describe, expect, it } from 'vitest';
import { DOMAIN, hashFloat01, makeSeed } from '@ws/core';
import {
  EARTH_GEOMETRY,
  FACE,
  cellCount,
  cellSize,
  cubeFaceToPcf,
  cubeFaceToUnit,
  pcf,
  faceEdgeArcLength,
  geodeticToPcf,
  pcfToCubeFace,
  pcfToGeodetic,
  quadkey,
  surfaceDistance,
  unitToCubeFace,
  type PCF,
} from '@ws/data';

const R = EARTH_GEOMETRY.radius;
const SEED = makeSeed(1, 2);

/** Deterministic points on the unit sphere — no Math.random anywhere. */
function samplePoints(n: number): PCF[] {
  const out: PCF[] = [];
  for (let i = 0; i < n; i++) {
    const z = hashFloat01(SEED, DOMAIN.TEST, i, 0) * 2 - 1;
    const phi = hashFloat01(SEED, DOMAIN.TEST, i, 1) * 2 * Math.PI;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.push(pcf(r * Math.cos(phi), r * Math.sin(phi), z));
  }
  return out;
}

describe('cube-sphere round-trip (DEC-007)', () => {
  it('PCF -> CubeFace -> PCF stays within 1 mm at planet radius', () => {
    let worst = 0;
    for (const p of samplePoints(20_000)) {
      const back = cubeFaceToUnit(pcfToCubeFace(p));
      const err =
        Math.hypot(back.x - p.x, back.y - p.y, back.z - p.z) * R;
      worst = Math.max(worst, err);
    }
    expect(worst).toBeLessThan(1e-3); // 1 mm
  });

  it('holds at face corners, where three cells meet', () => {
    // The 8 cube corners PLUS all 12 cube-edge midpoints (M0 built only 4; Grok audit).
    const corners: PCF[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const l = Math.sqrt(3);
      corners.push(pcf(sx / l, sy / l, sz / l));
    }
    for (const [a, b, c] of [
      [1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0],
      [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1],
      [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1],
    ] as const) {
      const l = Math.SQRT2;
      corners.push(pcf(a / l, b / l, c / l));
    }
    expect(corners).toHaveLength(20);

    let worst = 0;
    for (const p of corners) {
      const back = cubeFaceToUnit(pcfToCubeFace(p));
      worst = Math.max(worst, Math.hypot(back.x - p.x, back.y - p.y, back.z - p.z) * R);
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('CubeFace -> PCF -> CubeFace preserves (face, u, v)', () => {
    for (let face = 0; face < 6; face++) {
      for (let i = 0; i <= 8; i++) {
        for (let j = 0; j <= 8; j++) {
          const c = { face, u: i / 8, v: j / 8 };
          const back = pcfToCubeFace(cubeFaceToPcf(c, EARTH_GEOMETRY));
          // On a shared edge the point legitimately belongs to two faces, so
          // only interior points are required to keep their face index.
          if (i > 0 && i < 8 && j > 0 && j < 8) {
            expect(back.face).toBe(face);
            expect(back.u).toBeCloseTo(c.u, 10);
            expect(back.v).toBeCloseTo(c.v, 10);
          }
        }
      }
    }
  });

  it('covers the whole sphere: every sample lands on exactly one face', () => {
    const hits = new Array<number>(6).fill(0);
    for (const p of samplePoints(60_000)) {
      const c = unitToCubeFace(p);
      expect(c.face).toBeGreaterThanOrEqual(0);
      expect(c.face).toBeLessThan(6);
      hits[c.face] = (hits[c.face] ?? 0) + 1;
    }
    // Each face should take roughly a sixth. Generous bound — the point is that
    // no face is starved or doing double duty.
    for (const h of hits) {
      expect(h).toBeGreaterThan(60_000 / 6 * 0.85);
      expect(h).toBeLessThan(60_000 / 6 * 1.15);
    }
  });

  it('the tangent warp reduces area distortion versus the naive mapping', () => {
    // Compare the arc subtended by a small du at face centre vs near the corner.
    const eps = 1e-4;
    const arc = (u: number, v: number): number => {
      const a = cubeFaceToUnit({ face: FACE.POS_Z, u, v });
      const b = cubeFaceToUnit({ face: FACE.POS_Z, u: u + eps, v });
      return Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
    };
    const ratio = arc(0.5, 0.5) / arc(0.0, 0.0);
    // ARC ratio, not area. Grok audit: warped arc ≈ 1.06×, warped AREA ≈ 1.30×,
    // naive area ≈ 5.1×. The "1.27×" figure was never asserted. Bound kept loose.
    expect(ratio).toBeGreaterThan(1.0);
    expect(ratio).toBeLessThan(1.5);
  });
});

describe('geodetic (DEC-006)', () => {
  it('round-trips through PCF', () => {
    for (let i = 0; i < 5000; i++) {
      const lat = (hashFloat01(SEED, DOMAIN.TEST, i, 3) - 0.5) * Math.PI * 0.999;
      const lon = (hashFloat01(SEED, DOMAIN.TEST, i, 4) - 0.5) * 2 * Math.PI;
      const altitude = hashFloat01(SEED, DOMAIN.TEST, i, 5) * 1e7;
      const g = pcfToGeodetic(geodeticToPcf({ lat, lon, altitude }, EARTH_GEOMETRY), EARTH_GEOMETRY);
      expect(g.lat).toBeCloseTo(lat, 12);
      expect(g.lon).toBeCloseTo(lon, 12);
      expect(Math.abs(g.altitude - altitude)).toBeLessThan(1e-6);
    }
  });

  it('places the axes where DEC-006 says they are', () => {
    const northPole = geodeticToPcf({ lat: Math.PI / 2, lon: 0, altitude: 0 }, EARTH_GEOMETRY);
    expect(northPole.z).toBeCloseTo(R, 6);   // +Z is the rotation axis
    const primeMeridian = geodeticToPcf({ lat: 0, lon: 0, altitude: 0 }, EARTH_GEOMETRY);
    expect(primeMeridian.x).toBeCloseTo(R, 6); // +X pierces the prime meridian
  });

  it('computes plausible great-circle distances', () => {
    const quarter = surfaceDistance(
      { lat: 0, lon: 0, altitude: 0 },
      { lat: Math.PI / 2, lon: 0, altitude: 0 },
      EARTH_GEOMETRY,
    );
    expect(quarter).toBeCloseTo((Math.PI * R) / 2, 3);
  });
});

describe('grid reference numbers (DEC-007, DEC-019)', () => {
  it('matches the face edge arc length cited in the docs', () => {
    expect(faceEdgeArcLength(EARTH_GEOMETRY)).toBeCloseTo(10_007_543, 0);
  });

  it('matches the cell sizes cited in the docs', () => {
    expect(cellSize(10, EARTH_GEOMETRY)).toBeCloseTo(9772.99, 2);  // ~9.8 km
    expect(cellSize(11, EARTH_GEOMETRY)).toBeCloseTo(4886.50, 2);  // ~4.9 km
    expect(cellSize(16, EARTH_GEOMETRY)).toBeCloseTo(152.70, 2);   // ~153 m
    expect(cellSize(20, EARTH_GEOMETRY)).toBeCloseTo(9.5439, 4);   // ~9.5 m
  });

  it('matches the cell counts and field sizes that force DEC-019', () => {
    expect(cellCount(10)).toBe(6_291_456);
    expect(cellCount(11)).toBe(25_165_824);
    // The 50 MB figure in DEC-019 for a global i16 elevation field at L11.
    expect((cellCount(11) * 2) / 1024 / 1024).toBeCloseTo(48, 0);
  });
});

describe('quadkey (DEC-006)', () => {
  it('parent and children are inverse', () => {
    const k = quadkey.quadKey(FACE.POS_Z, 5, 13, 27);
    for (const c of quadkey.children(k)) {
      expect(quadkey.equals(quadkey.parent(c), k)).toBe(true);
    }
  });

  it('children are returned in a fixed order', () => {
    const c = quadkey.children(quadkey.quadKey(0, 0, 0, 0));
    expect(c.map((k) => [k.x, k.y])).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
  });

  it('contains is transitive down the tree', () => {
    const root = quadkey.rootKey(FACE.NEG_Y);
    let k = root;
    for (let i = 0; i < 10; i++) {
      k = quadkey.children(k)[2];
      expect(quadkey.contains(root, k)).toBe(true);
      expect(quadkey.contains(k, root)).toBe(false);
    }
  });

  it('packId and unpackId round-trip up to the packable level', () => {
    for (let level = 0; level <= quadkey.MAX_PACKABLE_LEVEL; level++) {
      const n = 2 ** level;
      for (const [x, y] of [[0, 0], [n - 1, n - 1], [n >> 1, 0], [0, n >> 1]]) {
        const k = quadkey.quadKey(3, level, x as number, y as number);
        const id = quadkey.packId(k);
        expect(Number.isSafeInteger(id)).toBe(true);
        expect(quadkey.unpackId(id)).toEqual(k);
      }
    }
  });

  it('refuses to pack beyond the safe-integer level', () => {
    expect(() =>
      quadkey.packId({ face: 0, level: quadkey.MAX_PACKABLE_LEVEL + 1, x: 0, y: 0 }),
    ).toThrow();
  });

  it('fromCubeFace lands inside the node it reports', () => {
    for (const p of samplePoints(2000)) {
      const c = pcfToCubeFace(p);
      const k = quadkey.fromCubeFace(c, 8);
      const [u0, v0, u1, v1] = quadkey.bounds(k);
      expect(c.u).toBeGreaterThanOrEqual(u0);
      expect(c.u).toBeLessThanOrEqual(u1);
      expect(c.v).toBeGreaterThanOrEqual(v0);
      expect(c.v).toBeLessThanOrEqual(v1);
    }
  });

  it('compare is a total order (required by DEC-017)', () => {
    const keys = [
      quadkey.quadKey(1, 2, 0, 1),
      quadkey.quadKey(0, 2, 3, 3),
      quadkey.quadKey(1, 1, 1, 1),
      quadkey.quadKey(1, 2, 1, 1),
    ];
    const a = [...keys].sort(quadkey.compare);
    const b = [...keys].reverse().sort(quadkey.compare);
    expect(a.map(quadkey.toString)).toEqual(b.map(quadkey.toString));
  });
});
