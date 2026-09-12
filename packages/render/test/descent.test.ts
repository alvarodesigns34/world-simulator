import { describe, expect, it } from 'vitest';
import { EARTH_GEOMETRY } from '@ws/data';
import { DESCENT, derive, descentCameraAt, descentSpeedMps } from '@ws/render';

const P = EARTH_GEOMETRY;

describe('deterministic descent path', () => {
  it('is a pure function of t — same t, same camera', () => {
    const a = descentCameraAt(17.25, P);
    const b = descentCameraAt(17.25, P);
    expect(a.position).toEqual(b.position);
    expect(a.orientation).toEqual(b.orientation);
  });

  it('starts in high orbit and ends near the surface', () => {
    const start = derive(descentCameraAt(0, P), P);
    const end = derive(descentCameraAt(DESCENT.durationSeconds, P), P);
    expect(start.altitude).toBeGreaterThan(10_000_000);
    expect(end.altitude).toBeLessThan(10);
    expect(end.altitude).toBeGreaterThan(0.5);
  });

  it('crosses a pole (DEC-029 reason for this path)', () => {
    let maxLat = 0;
    for (let t = 0; t <= 60; t += 0.5) {
      const d = derive(descentCameraAt(t, P), P);
      maxLat = Math.max(maxLat, Math.abs(d.latitude));
    }
    expect(maxLat).toBeGreaterThan(Math.PI / 2 - 0.05);
  });

  it('altitude is monotonically non-increasing along the authored keys', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (const t of [0, 12, 24, 32, 40, 50, 60]) {
      const alt = derive(descentCameraAt(t, P), P).altitude;
      expect(alt).toBeLessThanOrEqual(prev * 1.001);
      prev = alt;
    }
  });

  it('speed is finite everywhere', () => {
    for (let t = 0; t <= 60; t += 2) {
      const v = descentSpeedMps(t, P);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('pins the seed so Astra loads the same path', () => {
    expect(DESCENT.seed).toBe(0x51a51a51);
    expect(DESCENT.durationSeconds).toBe(60);
    expect(DESCENT.patchVerticesPerSide).toBe(33);
  });
});
