import { describe, expect, it } from 'vitest';
import { v3, vdot, vlen } from '@ws/core';
import { EARTH_GEOMETRY, FACE, cubeFaceToUnit, quadkey } from '@ws/data';
import {
  bilerpCorners,
  cameraFromGeodetic,
  lookAtCentre,
  packPatchInstance,
  patchCorners,
  patchIndices,
  threeCornerParallelogram,
  FLOATS_PER_INSTANCE,
} from '@ws/render';

const P = EARTH_GEOMETRY;
const R = P.radius;

function finiteDiffOutward(face: number, u: number, v: number): number {
  const eps = 1e-5;
  const p = cubeFaceToUnit({ face, u, v });
  const pu = cubeFaceToUnit({ face, u: Math.min(1, u + eps), v });
  const pv = cubeFaceToUnit({ face, u, v: Math.min(1, v + eps) });
  const tu = v3(pu.x - p.x, pu.y - p.y, pu.z - p.z);
  const tv = v3(pv.x - p.x, pv.y - p.y, pv.z - p.z);
  const cx = tu.y * tv.z - tu.z * tv.y;
  const cy = tu.z * tv.x - tu.x * tv.z;
  const cz = tu.x * tv.y - tu.y * tv.x;
  return cx * p.x + cy * p.y + cz * p.z;
}

function cornersOf(face: number) {
  return patchCorners(quadkey.rootKey(face), 1, { x: 0, y: 0, z: 0 });
}

function sharedCornerCount(a: ReturnType<typeof cornersOf>, b: ReturnType<typeof cornersOf>): number {
  const A = [a.c00, a.c10, a.c01, a.c11];
  const B = [b.c00, b.c10, b.c01, b.c11];
  let n = 0;
  for (const pa of A) {
    for (const pb of B) {
      if (vlen(v3(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z)) < 1e-9) n++;
    }
  }
  return n;
}

describe('cube-face orientation: ∂u × ∂v is outward on all six faces', () => {
  it('holds at the face centre', () => {
    for (let face = 0; face < 6; face++) {
      expect(finiteDiffOutward(face, 0.5, 0.5)).toBeGreaterThan(0);
    }
  });

  it('holds on a 5×5 interior grid per face', () => {
    for (let face = 0; face < 6; face++) {
      for (let i = 1; i <= 5; i++) {
        for (let j = 1; j <= 5; j++) {
          expect(finiteDiffOutward(face, i / 6, j / 6)).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('patch indices: CCW in (u,v), not the old CW winding', () => {
  it('first quad is (a,b,c)+(b,d,c)', () => {
    const idx = patchIndices(3);
    expect(Array.from(idx.slice(0, 6))).toEqual([0, 1, 3, 1, 4, 3]);
  });

  it('is not the Ampere-era CW (a,c,b)+(b,c,d)', () => {
    const idx = patchIndices(3);
    expect(Array.from(idx.slice(0, 6))).not.toEqual([0, 3, 1, 1, 3, 4]);
  });

  it('covers every quad of an n×n grid', () => {
    const n = 33;
    const idx = patchIndices(n);
    expect(idx.length).toBe((n - 1) * (n - 1) * 6);
    expect(Math.max(...idx)).toBe(n * n - 1);
    expect(Math.min(...idx)).toBe(0);
  });
});

describe('cube-face transitions: adjacent L0 faces share exactly two corners', () => {
  const ADJACENT: readonly [number, number][] = [
    [FACE.POS_X, FACE.POS_Y],
    [FACE.POS_X, FACE.NEG_Y],
    [FACE.POS_X, FACE.POS_Z],
    [FACE.POS_X, FACE.NEG_Z],
    [FACE.NEG_X, FACE.POS_Y],
    [FACE.NEG_X, FACE.NEG_Y],
    [FACE.NEG_X, FACE.POS_Z],
    [FACE.NEG_X, FACE.NEG_Z],
    [FACE.POS_Y, FACE.POS_Z],
    [FACE.POS_Y, FACE.NEG_Z],
    [FACE.NEG_Y, FACE.POS_Z],
    [FACE.NEG_Y, FACE.NEG_Z],
  ];

  it('all 12 cube edges weld at two vertices', () => {
    for (const [a, b] of ADJACENT) {
      expect(sharedCornerCount(cornersOf(a), cornersOf(b))).toBe(2);
    }
  });

  it('opposite faces share no vertices', () => {
    expect(sharedCornerCount(cornersOf(FACE.POS_X), cornersOf(FACE.NEG_X))).toBe(0);
    expect(sharedCornerCount(cornersOf(FACE.POS_Y), cornersOf(FACE.NEG_Y))).toBe(0);
    expect(sharedCornerCount(cornersOf(FACE.POS_Z), cornersOf(FACE.NEG_Z))).toBe(0);
  });
});

describe('patch interpolation: four corners, not a parallelogram', () => {
  it('three-corner (1,1) misses c11 by kilometres on a coarse cell (the hole)', () => {
    const key = quadkey.quadKey(FACE.POS_Z, 1, 0, 0);
    const cam = { x: 0, y: 0, z: 0 };
    const p = patchCorners(key, R, cam);
    const fake = threeCornerParallelogram(p, 1, 1);
    const gap = vlen(v3(fake.x - p.c11.x, fake.y - p.c11.y, fake.z - p.c11.z));
    // A cube-face parallelogram's fourth vertex is nowhere near the sphere
    // corner. This is the crack Astra saw.
    expect(gap).toBeGreaterThan(1_000_000);
  });

  it('bilinear (1,1) is exactly c11', () => {
    const key = quadkey.quadKey(FACE.NEG_Y, 3, 2, 5);
    const p = patchCorners(key, R, { x: 0, y: 0, z: 0 });
    const q = bilerpCorners(p, 1, 1);
    expect(q.x).toBeCloseTo(p.c11.x, 12);
    expect(q.y).toBeCloseTo(p.c11.y, 12);
    expect(q.z).toBeCloseTo(p.c11.z, 12);
  });

  it('adjacent patches agree on the shared edge (no crack)', () => {
    // Two L2 children that share a u-edge: (0,0) and (1,0) of the same parent.
    const a = quadkey.quadKey(FACE.POS_X, 2, 0, 0);
    const b = quadkey.quadKey(FACE.POS_X, 2, 1, 0);
    const cam = { x: 0, y: 0, z: 0 };
    const pa = patchCorners(a, R, cam);
    const pb = patchCorners(b, R, cam);
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const ea = bilerpCorners(pa, 1, t);
      const eb = bilerpCorners(pb, 0, t);
      const d = vlen(v3(ea.x - eb.x, ea.y - eb.y, ea.z - eb.z));
      expect(d).toBeLessThan(1e-6);
    }
  });

  it('three-corner interpolants of the same shared edge do NOT agree', () => {
    const a = quadkey.quadKey(FACE.POS_Z, 1, 0, 0);
    const b = quadkey.quadKey(FACE.POS_Z, 1, 1, 0);
    const cam = { x: 0, y: 0, z: 0 };
    const pa = patchCorners(a, R, cam);
    const pb = patchCorners(b, R, cam);
    let worst = 0;
    for (let i = 1; i < 8; i++) {
      const t = i / 8;
      const ea = threeCornerParallelogram(pa, 1, t);
      const eb = threeCornerParallelogram(pb, 0, t);
      worst = Math.max(worst, vlen(v3(ea.x - eb.x, ea.y - eb.y, ea.z - eb.z)));
    }
    expect(worst).toBeGreaterThan(1000);
  });
});

describe('instance packing: camera-relative, no world-position .w', () => {
  it('near-surface corners are small, not planet-radius', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0, lon: 0, altitude: 2 }, P));
    const key = quadkey.fromCubeFace(
      { face: FACE.POS_X, u: 0.5, v: 0.5 },
      10,
    );
    const p = patchCorners(key, R, cam.position);
    const d00 = vlen(p.c00);
    expect(d00).toBeLessThan(50_000);
    expect(d00).toBeGreaterThan(0);
  });

  it('packed .w channels are level/face, not -camera (the old leak)', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.4, lon: -0.2, altitude: 12_000_000 }, P));
    const key = quadkey.rootKey(FACE.POS_Y);
    const buf = new Float32Array(FLOATS_PER_INSTANCE);
    packPatchInstance(buf, 0, patchCorners(key, R, cam.position));
    expect(buf[3]).toBe(key.level);
    expect(buf[7]).toBe(key.face);
    expect(Math.abs(buf[3] as number)).toBeLessThan(32);
    expect(Math.abs(buf[7] as number)).toBeLessThan(6);
    // The previous layout stored -cam.{z,x,y} in .w, magnitude ~R+alt.
    const camMag = vlen(v3(cam.position.x, cam.position.y, cam.position.z));
    expect(Math.abs(buf[3] as number)).toBeLessThan(camMag / 1000);
  });

  it('cross(c10-c00, c01-c00) points outward in camera-relative space', () => {
    const cam = { x: 0, y: 0, z: 0 };
    for (let face = 0; face < 6; face++) {
      const p = patchCorners(quadkey.rootKey(face), R, cam);
      const tu = v3(p.c10.x - p.c00.x, p.c10.y - p.c00.y, p.c10.z - p.c00.z);
      const tv = v3(p.c01.x - p.c00.x, p.c01.y - p.c00.y, p.c01.z - p.c00.z);
      const n = v3(
        tu.y * tv.z - tu.z * tv.y,
        tu.z * tv.x - tu.x * tv.z,
        tu.x * tv.y - tu.y * tv.x,
      );
      // Corners are R*unit - 0, so c00 is a planet-centred position here
      // (cam at origin) and should have positive dot with the winding normal.
      expect(vdot(n, p.c00)).toBeGreaterThan(0);
    }
  });
});
