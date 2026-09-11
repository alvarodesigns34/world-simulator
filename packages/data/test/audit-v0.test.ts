/**
 * Independent Architecture v0 checks (Grok). These are not a restatement of
 * Opus's tests — they pin numbers the original tests left as comments, cover
 * cases those tests claimed but did not construct, and record contradictions
 * between Accepted ADRs and arithmetic.
 */
import { describe, expect, it } from 'vitest';
import {
  EARTH_GEOMETRY,
  FACE,
  cubeFaceToPcf,
  cubeFaceToUnit,
  geodeticToPcf,
  pcfToCubeFace,
  pcfToGeodetic,
  type PCF,
} from '@ws/data';

const R = EARTH_GEOMETRY.radius;

describe('audit: cube-sphere metrics actually produced by the code', () => {
  it('arc ratio centre/corner is ~1.06×, not the 1.27× the test comment claims', () => {
    const eps = 1e-4;
    const arc = (u: number, v: number): number => {
      const a = cubeFaceToUnit({ face: FACE.POS_Z, u, v });
      const b = cubeFaceToUnit({ face: FACE.POS_Z, u: u + eps, v });
      return Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
    };
    const ratio = arc(0.5, 0.5) / arc(0.0, 0.0);
    // Recorded 2026-09-11 against the M0 implementation. If this moves, the
    // "1.27×" prose in DEC-007 / coords.test.ts is what was wrong, not this.
    expect(ratio).toBeGreaterThan(1.04);
    expect(ratio).toBeLessThan(1.08);
  });

  it('area ratio centre/corner of a warped cell is ~1.30× (the 1.3× AREA claim holds)', () => {
    const du = 1 / 256;
    const unit = (u: number, v: number): PCF => cubeFaceToUnit({ face: FACE.POS_Z, u, v });
    const cross = (a: PCF, b: PCF): [number, number, number] => [
      a.y * b.z - a.z * b.y,
      a.z * b.x - a.x * b.z,
      a.x * b.y - a.y * b.x,
    ];
    const ang = (n1: PCF, n2: PCF, n3: PCF): number => {
      const a = cross(n2, n1);
      const b = cross(n2, n3);
      const la = Math.hypot(a[0], a[1], a[2]);
      const lb = Math.hypot(b[0], b[1], b[2]);
      const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
      return Math.acos(Math.min(1, Math.max(-1, d)));
    };
    const tri = (a: PCF, b: PCF, c: PCF): number =>
      ang(c, a, b) + ang(a, b, c) + ang(b, c, a) - Math.PI;
    const cellArea = (u: number, v: number): number => {
      const v00 = unit(u, v);
      const v10 = unit(u + du, v);
      const v11 = unit(u + du, v + du);
      const v01 = unit(u, v + du);
      return tri(v00, v10, v11) + tri(v00, v11, v01);
    };
    const ratio = cellArea(0.5 - du / 2, 0.5 - du / 2) / cellArea(du * 0.5, du * 0.5);
    expect(ratio).toBeGreaterThan(1.25);
    expect(ratio).toBeLessThan(1.35);
  });

  it('round-trip holds at ALL 12 cube-edge midpoints, not the 4 the original test built', () => {
    const edges: PCF[] = [];
    for (const [a, b, c] of [
      [1, 1, 0],
      [1, -1, 0],
      [-1, 1, 0],
      [-1, -1, 0],
      [1, 0, 1],
      [1, 0, -1],
      [-1, 0, 1],
      [-1, 0, -1],
      [0, 1, 1],
      [0, 1, -1],
      [0, -1, 1],
      [0, -1, -1],
    ] as const) {
      const l = Math.SQRT2;
      edges.push({ x: a / l, y: b / l, z: c / l });
    }
    expect(edges.length).toBe(12);
    let worst = 0;
    for (const p of edges) {
      const back = cubeFaceToUnit(pcfToCubeFace(p));
      worst = Math.max(worst, Math.hypot(back.x - p.x, back.y - p.y, back.z - p.z) * R);
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('shared-edge vertices at equal parameter coincide across the two faces (POS_X/POS_Z)', () => {
    // POS_X: x=1, y=a, z=b. POS_Z: x=a, y=b, z=1.
    // Shared cube edge is x=1,z=1, y in [-1,1].
    // POS_X: a = warp(u*2-1)=y, b=warp(v*2-1)=1 → v=1, u varies.
    // POS_Z: a=warp(u*2-1)=1 → u=1, b=warp(v*2-1)=y → v varies.
    let worst = 0;
    for (let i = 0; i <= 64; i++) {
      const t = i / 64;
      const onX = cubeFaceToUnit({ face: FACE.POS_X, u: t, v: 1 });
      const onZ = cubeFaceToUnit({ face: FACE.POS_Z, u: 1, v: t });
      // Parameter t runs along +Y on POS_X (a=y) and along +Y on POS_Z (b=y).
      worst = Math.max(worst, Math.hypot(onX.x - onZ.x, onX.y - onZ.y, onX.z - onZ.z) * R);
    }
    expect(worst).toBeLessThan(1e-6);
  });
});

describe('audit: geodetic poles (DEC-025)', () => {
  it('longitude is lost at the pole — two headings collapse to one PCF', () => {
    const a = geodeticToPcf({ lat: Math.PI / 2, lon: 0, altitude: 2 }, EARTH_GEOMETRY);
    const b = geodeticToPcf({ lat: Math.PI / 2, lon: Math.PI, altitude: 2 }, EARTH_GEOMETRY);
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(1e-6);
    const back = pcfToGeodetic(a, EARTH_GEOMETRY);
    expect(back.lon).toBe(0); // atan2(0,0) convention — heading is gone
  });

  it('CubeFace -> PCF -> CubeFace at a pole-equivalent cube corner stays in range', () => {
    const c = { face: FACE.POS_Z, u: 0, v: 0 };
    const back = pcfToCubeFace(cubeFaceToPcf(c, EARTH_GEOMETRY));
    expect(back.u).toBeGreaterThanOrEqual(0);
    expect(back.u).toBeLessThanOrEqual(1);
    expect(back.v).toBeGreaterThanOrEqual(0);
    expect(back.v).toBeLessThanOrEqual(1);
  });
});

describe('audit: DEC-022 i16 centimetres cannot encode Earth', () => {
  it('Everest and Mariana sit outside the i16-cm range', () => {
    const maxM = 32767 * 0.01;
    const minM = -32768 * 0.01;
    expect(maxM).toBeLessThan(8848);
    expect(minM).toBeGreaterThan(-10994);
    // i16 metres does cover Earth; that is the candidate replacement.
    expect(32767).toBeGreaterThan(8848);
    expect(-32768).toBeLessThan(-10994);
  });
});
