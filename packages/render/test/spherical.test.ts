import { describe, expect, it } from 'vitest';
import { bilinearHeight, bilinearW, oneMinusBd2, spherify } from '../src/terrain/spherical.js';

function nrm(x: number, y: number, z: number): { x: number; y: number; z: number } {
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
}

describe('T-0064 spherical interpolation', () => {
  const d00 = nrm(1, 0, 0);
  const d10 = nrm(1, 0.1, 0);
  const d01 = nrm(1, 0, 0.1);
  const d11 = nrm(1, 0.1, 0.1);
  const R = 6_371_000;
  const cam = { x: R + 1000, y: 0, z: 0 };
  const c00 = { x: d00.x * R - cam.x, y: d00.y * R - cam.y, z: d00.z * R - cam.z };
  const c10 = { x: d10.x * R - cam.x, y: d10.y * R - cam.y, z: d10.z * R - cam.z };
  const c01 = { x: d01.x * R - cam.x, y: d01.y * R - cam.y, z: d01.z * R - cam.z };
  const c11 = { x: d11.x * R - cam.x, y: d11.y * R - cam.y, z: d11.z * R - cam.z };

  it('closed-form 1-|Bd|² matches the direct length of bilinear units', () => {
    const s = 0.4;
    const t = 0.3;
    const w = bilinearW(s, t);
    const bx = w[0] * d00.x + w[1] * d10.x + w[2] * d01.x + w[3] * d11.x;
    const by = w[0] * d00.y + w[1] * d10.y + w[2] * d01.y + w[3] * d11.y;
    const bz = w[0] * d00.z + w[1] * d10.z + w[2] * d01.z + w[3] * d11.z;
    const bd2 = bx * bx + by * by + bz * bz;
    const om = oneMinusBd2(w, d00, d10, d01, d11);
    expect(Math.abs(om - (1 - bd2))).toBeLessThan(1e-12);
  });

  it('spherify lands on the sphere to relative 1e-8 (camera-relative)', () => {
    const s = 0.5;
    const t = 0.5;
    const p = spherify(s, t, c00, c10, c01, c11, d00, d10, d01, d11, cam);
    const wx = p.x + cam.x;
    const wy = p.y + cam.y;
    const wz = p.z + cam.z;
    const r = Math.hypot(wx, wy, wz);
    expect(Math.abs(r / R - 1)).toBeLessThan(1e-8);
  });

  it('bilinear height is exact at corners', () => {
    expect(bilinearHeight(0, 0, 1, 2, 3, 4)).toBe(1);
    expect(bilinearHeight(1, 0, 1, 2, 3, 4)).toBe(2);
    expect(bilinearHeight(0, 1, 1, 2, 3, 4)).toBe(3);
    expect(bilinearHeight(1, 1, 1, 2, 3, 4)).toBe(4);
  });
});
