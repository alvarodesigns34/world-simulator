/**
 * T-0159. Presentation lighting modes.
 *
 * The simulated sun is the right light for a world you are watching and the
 * wrong one for a world you are exploring: half the planet is always dark, so
 * flying to a feature lands in the dark more often than not. These assert that
 * the alternative lights are well-formed, stable, and never mistaken for the
 * simulated one.
 */

import { describe, expect, it } from 'vitest';
import { v3, vdot, vlen } from '@ws/core';
import { SUN_MODE, SUN_MODE_LABEL, presentationSunDirection } from '../src/index.js';

const R = 6_371_000;

describe('presentation sun', () => {
  const simulated = v3(0.3, -0.8, 0.5);

  it('returns the simulated sun unchanged in REAL mode, normalised', () => {
    const d = presentationSunDirection(SUN_MODE.REAL, simulated, v3(R, 0, 0));
    expect(vlen(d)).toBeCloseTo(1, 9);
    /* Same direction, not merely some unit vector. */
    const s = vlen(simulated);
    expect(d.x).toBeCloseTo(simulated.x / s, 9);
    expect(d.y).toBeCloseTo(simulated.y / s, 9);
    expect(d.z).toBeCloseTo(simulated.z / s, 9);
  });

  it('puts the light overhead in NOON mode, wherever the camera is', () => {
    for (const p of [v3(R, 0, 0), v3(0, R, 0), v3(0, 0, R), v3(-R, R, R)]) {
      const d = presentationSunDirection(SUN_MODE.NOON, simulated, p);
      const up = v3(p.x / vlen(p), p.y / vlen(p), p.z / vlen(p));
      expect(vdot(d, up)).toBeCloseTo(1, 6);
    }
  });

  it('puts RAKING light low but above the horizon everywhere', () => {
    for (const p of [v3(R, 0, 0), v3(0, R, 0), v3(0, 0, R), v3(R, R, R), v3(0, 0, -R)]) {
      const d = presentationSunDirection(SUN_MODE.RAKING, simulated, p);
      const up = v3(p.x / vlen(p), p.y / vlen(p), p.z / vlen(p));
      const elevation = vdot(d, up);
      expect(vlen(d)).toBeCloseTo(1, 6);
      /* Above the horizon — an underground sun lights nothing — but low
         enough that slopes separate. */
      expect(elevation).toBeGreaterThan(0.2);
      expect(elevation).toBeLessThan(0.7);
    }
  });

  it('is finite at the pole, where the east tangent degenerates', () => {
    for (const p of [v3(0, 0, R), v3(0, 0, -R), v3(1e-12, 0, R)]) {
      for (const mode of Object.values(SUN_MODE)) {
        const d = presentationSunDirection(mode, simulated, p);
        expect([d.x, d.y, d.z].every(Number.isFinite)).toBe(true);
        expect(vlen(d)).toBeCloseTo(1, 6);
      }
    }
  });

  it('does not swing while the camera orbits at a fixed point', () => {
    /* The bearing is fixed in the local frame, so two nearby camera positions
       give nearly the same light: a light that rotated with the camera would
       make every surface look identically lit and hide the relief it exists
       to reveal. */
    const a = presentationSunDirection(SUN_MODE.RAKING, simulated, v3(R, 0, 0));
    const b = presentationSunDirection(SUN_MODE.RAKING, simulated, v3(R, 1000, 0));
    expect(vdot(a, b)).toBeGreaterThan(0.999);
  });

  it('labels each mode so a study light is never read as the time of day', () => {
    for (const mode of Object.values(SUN_MODE)) {
      expect(SUN_MODE_LABEL[mode].length).toBeGreaterThan(3);
    }
    expect(SUN_MODE_LABEL[SUN_MODE.REAL]).toMatch(/[Ss]imulated/);
  });
});
