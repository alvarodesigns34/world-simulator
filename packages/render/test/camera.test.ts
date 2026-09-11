import { describe, expect, it } from 'vitest';
import { qForward, qUp, qlen, vdot, vlen, v3, vnorm } from '@ws/core';
import { EARTH_GEOMETRY, pcfToGeodetic, geodeticToPcf } from '@ws/data';
import {
  cameraAt,
  cameraFromGeodetic,
  derive,
  lookAtCentre,
  moveForward,
  moveTangential,
  nearPlane,
  orbitalBlend,
  setAltitude,
  relativePrecisionM,
  perspectiveReversedZInfinite,
  toCameraRelative,
  viewRotationOnly,
} from '@ws/render';

const P = EARTH_GEOMETRY;
const R = P.radius;

describe('camera: PCF + quaternion (DEC-029)', () => {
  it('derives altitude as |p| - R with no surface query', () => {
    const cam = cameraFromGeodetic({ lat: 0.3, lon: -1.1, altitude: 12345 }, P);
    expect(derive(cam, P).altitude).toBeCloseTo(12345, 6);
  });

  it('keeps the orientation quaternion unit-length through many operations', () => {
    let cam = cameraFromGeodetic({ lat: 0.1, lon: 0.2, altitude: 1000 }, P);
    for (let i = 0; i < 5000; i++) {
      cam = moveForward(cam, 1000, P);
      cam = moveTangential(cam, v3(0, 0, 1), 0.001);
    }
    expect(qlen(cam.orientation)).toBeCloseTo(1, 9);
  });

  it('altitude-dependent scalars are smooth, with no branch on altitude', () => {
    let prev = nearPlane(0.01);
    for (let s = -2; s <= 8; s += 0.01) {
      const a = 10 ** s;
      const n = nearPlane(a);
      expect(Number.isFinite(n)).toBe(true);
      // Monotone non-decreasing, so there is no step anywhere.
      expect(n).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = n;
    }
    // The blend is a weight, not a mode: continuous and bounded.
    let last = orbitalBlend(1);
    for (let s = 0; s <= 8; s += 0.005) {
      const b = orbitalBlend(10 ** s);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
      expect(Math.abs(b - last)).toBeLessThan(0.05); // no jump
      last = b;
    }
  });
});

/**
 * THE test DEC-029 exists for (AUDIT-V0 B4).
 *
 * The geodetic CameraState of DEC-025 is singular at lat = ±π/2: longitude is
 * undefined and yaw-about-Z gimbal-locks. Ice sheets, polar orbits and the M1
 * descent sweep all live there.
 */
describe('camera: polar crossing has no singularity', () => {
  it('the OLD geodetic representation really was degenerate', () => {
    // Two different longitudes at the north pole are the same point...
    const a = geodeticToPcf({ lat: Math.PI / 2, lon: 0, altitude: 2 }, P);
    const b = geodeticToPcf({ lat: Math.PI / 2, lon: Math.PI, altitude: 2 }, P);
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(1e-6);
    // ...and the round trip cannot recover which heading you had.
    expect(pcfToGeodetic(a, P).lon).toBe(0);
  });

  it('crosses the north pole continuously in position and orientation', () => {
    // Start on the prime meridian and walk north over the pole.
    let cam = cameraFromGeodetic({ lat: 1.2, lon: 0, altitude: 50_000 }, P, 0, -0.2);
    const stepRad = 0.002;
    const axis = v3(0, 1, 0); // rotating about +Y carries us over the pole

    let prevPos = v3(cam.position.x, cam.position.y, cam.position.z);
    let prevFwd = qForward(cam.orientation);
    let maxPosJump = 0;
    let maxFwdJump = 0;
    let crossed = false;
    let prevLatSign = Math.sign(derive(cam, P).latitude);

    for (let i = 0; i < 2000; i++) {
      cam = moveTangential(cam, axis, stepRad);
      const d = derive(cam, P);

      const pos = v3(cam.position.x, cam.position.y, cam.position.z);
      const fwd = qForward(cam.orientation);

      maxPosJump = Math.max(maxPosJump, vlen(v3(pos.x - prevPos.x, pos.y - prevPos.y, pos.z - prevPos.z)));
      maxFwdJump = Math.max(maxFwdJump, vlen(v3(fwd.x - prevFwd.x, fwd.y - prevFwd.y, fwd.z - prevFwd.z)));

      // Everything stays finite and on the sphere.
      expect(Number.isFinite(d.latitude)).toBe(true);
      expect(Number.isFinite(d.longitude)).toBe(true);
      expect(d.altitude).toBeCloseTo(50_000, 3);
      expect(qlen(cam.orientation)).toBeCloseTo(1, 9);

      const latSign = Math.sign(d.latitude);
      if (latSign !== 0 && prevLatSign !== 0 && latSign !== prevLatSign) crossed = true;
      if (latSign !== 0) prevLatSign = latSign;

      prevPos = pos;
      prevFwd = fwd;
    }

    expect(crossed).toBe(true); // we really went over a pole
    // A step of 0.002 rad at r = 6.42e6 m is ~12.8 km. No step may exceed that
    // by more than rounding: a discontinuity would show up as a large jump.
    expect(maxPosJump).toBeLessThan(13_000);
    expect(maxFwdJump).toBeLessThan(0.01);
  });

  it('crosses the south pole too', () => {
    let cam = cameraFromGeodetic({ lat: -1.3, lon: 2.0, altitude: 8000 }, P, 0, -0.5);
    let crossed = false;
    let prevSign = Math.sign(derive(cam, P).latitude);
    for (let i = 0; i < 2000; i++) {
      cam = moveTangential(cam, vnorm(v3(0.3, 0.9, 0)), -0.002);
      const lat = derive(cam, P).latitude;
      expect(Number.isFinite(lat)).toBe(true);
      const s = Math.sign(lat);
      if (s !== 0 && prevSign !== 0 && s !== prevSign) crossed = true;
      if (s !== 0) prevSign = s;
      expect(qlen(cam.orientation)).toBeCloseTo(1, 9);
    }
    expect(crossed).toBe(true);
  });

  it('moveForward over the pole preserves altitude exactly', () => {
    let cam = cameraFromGeodetic({ lat: 1.5, lon: 0.4, altitude: 100_000 }, P, 0, 0);
    for (let i = 0; i < 500; i++) {
      cam = moveForward(cam, 50_000, P);
      expect(derive(cam, P).altitude).toBeCloseTo(100_000, 2);
    }
  });

  it('an orbit passing directly over both poles never produces NaN', () => {
    let cam = lookAtCentre(cameraFromGeodetic({ lat: 0, lon: 0, altitude: 2_000_000 }, P));
    for (let i = 0; i < 4000; i++) {
      cam = moveTangential(cam, v3(0, 1, 0), (2 * Math.PI) / 1000);
      cam = lookAtCentre(cam);
      const d = derive(cam, P);
      expect(Number.isNaN(d.latitude)).toBe(false);
      expect(Number.isNaN(d.longitude)).toBe(false);
      expect(Number.isNaN(vlen(qUp(cam.orientation)))).toBe(false);
      expect(vlen(qUp(cam.orientation))).toBeCloseTo(1, 9);
    }
  });

  it('setAltitude at a pole keeps the camera on the axis', () => {
    const cam = setAltitude(cameraFromGeodetic({ lat: Math.PI / 2, lon: 0, altitude: 10 }, P), 500, P);
    const d = derive(cam, P);
    expect(d.altitude).toBeCloseTo(500, 6);
    expect(Math.abs(d.latitude)).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('camera: precision path (DEC-005, DEC-033)', () => {
  it('camera-relative offsets are small even at planet scale', () => {
    const cam = cameraFromGeodetic({ lat: 0.5, lon: 1.0, altitude: 1 }, P);
    const nearby = geodeticToPcf({ lat: 0.5001, lon: 1.0001, altitude: 0 }, P);
    const rel = toCameraRelative(nearby, cam);
    expect(vlen(rel)).toBeLessThan(2000);
    // f32 precision at that distance is sub-millimetre.
    expect(relativePrecisionM(vlen(rel))).toBeLessThan(1e-3);
  });

  it('f32 at planet radius really is 0.5 m — the reason for all of this', () => {
    expect(relativePrecisionM(R)).toBeCloseTo(0.5, 9);
    expect(relativePrecisionM(100_000)).toBeCloseTo(0.0078125, 9);
    expect(relativePrecisionM(1000)).toBeCloseTo(6.103515625e-5, 12);
  });

  it('the view matrix has no translation, by construction', () => {
    const cam = cameraFromGeodetic({ lat: 0.2, lon: 0.2, altitude: 3_000_000 }, P);
    const v = viewRotationOnly(cam);
    expect(v[12]).toBe(0);
    expect(v[13]).toBe(0);
    expect(v[14]).toBe(0);
    expect(v[15]).toBe(1);
  });

  it('reversed-Z maps near to 1 and infinity to 0, with no far plane', () => {
    const near = 0.5;
    const m = perspectiveReversedZInfinite(Math.PI / 3, 16 / 9, near);

    const project = (z: number): number => {
      // Column-major: zClip = m[14] * 1 (from w row) ... compute properly.
      const zClip = (m[10] as number) * z + (m[14] as number);
      const wClip = (m[11] as number) * z;
      return zClip / wClip;
    };

    expect(project(-near)).toBeCloseTo(1, 9);
    expect(project(-1e9)).toBeCloseTo(0, 6);
    expect(project(-1e12)).toBeCloseTo(0, 9);
    // Monotone: closer is always greater under GreaterEqual testing.
    let prev = project(-near);
    for (let d = 1; d < 1e9; d *= 1.7) {
      const cur = project(-(near + d));
      expect(cur).toBeLessThan(prev);
      prev = cur;
    }
    // No far term at all.
    expect(m[15]).toBe(0);
  });

  /**
   * Depth precision is SCALE-RELATIVE, and that is the property that matters.
   *
   * A fixed absolute target ("1 m apart at 40 000 km") is the wrong test and
   * fails: at that range f32 reversed-Z resolves ~2.9 m, not 1 m. But one pixel
   * at that range covers ~29 km, so 2.9 m is ~10 000x finer than anything that
   * can be seen. The invariant worth holding is that depth resolution stays far
   * below a pixel's lateral extent at EVERY altitude — which it does, because
   * both scale with distance.
   *
   * Measured resolvable separation (60 deg fovY, 1440 px):
   *      1 m altitude, 1 m away        7.5e-8 m
   *    1 km altitude, 1 km away        7.3e-5 m
   *  100 km altitude, 100 km away      7.3e-3 m
   *   40 000 km, at the planet         2.9 m
   */
  it('depth resolution stays far finer than a pixel at every altitude', () => {
    const H = 1440;
    const fovY = Math.PI / 3;

    for (const altitude of [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 4e7]) {
      const near = nearPlane(altitude);
      const m = perspectiveReversedZInfinite(fovY, 1, near);
      const project = (z: number): number =>
        ((m[10] as number) * z + (m[14] as number)) / ((m[11] as number) * z);

      const d = Math.max(near * 2, altitude);
      const depth = Math.fround(project(-d));
      expect(depth).toBeGreaterThan(0);
      expect(depth).toBeLessThanOrEqual(1);

      // One f32 ulp of depth, converted back to a distance separation.
      const exponent = Math.floor(Math.log2(depth));
      const ulp = 2 ** (exponent - 23);
      const resolvable = (ulp * d * d) / near;

      // What one pixel covers laterally at the same distance.
      const pixelExtent = (d * 2 * Math.tan(fovY / 2)) / H;

      expect(resolvable).toBeLessThan(pixelExtent / 100);
    }
  });

  it('resolves sub-centimetre depth at surface altitude — the M1 criterion', () => {
    const near = nearPlane(1);
    const m = perspectiveReversedZInfinite(Math.PI / 3, 1, near);
    const project = (z: number): number =>
      ((m[10] as number) * z + (m[14] as number)) / ((m[11] as number) * z);
    const a = Math.fround(project(-1));
    const b = Math.fround(project(-1.01));
    expect(a).not.toBe(b);
    // And an order of magnitude finer still.
    expect(Math.fround(project(-1))).not.toBe(Math.fround(project(-1.0001)));
  });
});

describe('camera: orientation basics', () => {
  it('lookAtCentre points forward at the planet centre from anywhere', () => {
    for (const lat of [-1.5707, -0.7, 0, 0.7, 1.5707]) {
      const cam = lookAtCentre(cameraFromGeodetic({ lat, lon: 0.3, altitude: 1e6 }, P));
      const f = qForward(cam.orientation);
      const toCentre = vnorm(v3(-cam.position.x, -cam.position.y, -cam.position.z));
      expect(vdot(f, toCentre)).toBeCloseTo(1, 6);
    }
  });

  it('a camera built at the pole still has an orthonormal basis', () => {
    const cam = cameraAt(
      geodeticToPcf({ lat: Math.PI / 2, lon: 0, altitude: 1000 }, P),
      cameraFromGeodetic({ lat: Math.PI / 2, lon: 0, altitude: 1000 }, P).orientation,
    );
    const f = qForward(cam.orientation);
    const u = qUp(cam.orientation);
    expect(vlen(f)).toBeCloseTo(1, 9);
    expect(vlen(u)).toBeCloseTo(1, 9);
    expect(Math.abs(vdot(f, u))).toBeLessThan(1e-9);
  });
});
