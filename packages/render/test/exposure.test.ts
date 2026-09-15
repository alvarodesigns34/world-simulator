/**
 * T-0103. Exposure adaptation, as mathematics rather than as a constant.
 *
 * M13's acceptance says exposure adaptation is "smooth across the full
 * orbit -> surface luminance range". The shader had `rgb = rgb * 1.18`: a fixed
 * gain, no state, no dependence on the scene. These tests assert the properties
 * that make the replacement a real adaptation model — convergence, frame-rate
 * independence, the eye's asymmetry, and boundedness — rather than checking
 * that a number came out.
 */

import { describe, expect, it } from 'vitest';
import { EARTH_GEOMETRY } from '@ws/data';
import {
  adaptExposure,
  createExposureState,
  sceneKeyLuminance,
  snapExposure,
} from '../src/index.js';

const R = EARTH_GEOMETRY.radius;

describe('scene key luminance', () => {
  it('rises monotonically as the sun climbs', () => {
    let previous = -Infinity;
    for (let s = -1; s <= 1.0001; s += 0.05) {
      const l = sceneKeyLuminance(s, 1000, R);
      expect(l).toBeGreaterThan(previous);
      previous = l;
    }
  });

  it('separates night from noon by more than two orders of magnitude', () => {
    const noon = sceneKeyLuminance(1, 1000, R);
    const midnight = sceneKeyLuminance(-1, 1000, R);
    expect(noon / midnight).toBeGreaterThan(100);
  });

  it('is continuous through the terminator', () => {
    /* A hard max(0, dot) snaps here. Sampling either side of the horizon at a
       fine step must not show a jump larger than the local slope. */
    let worst = 0;
    let previous = sceneKeyLuminance(-0.2, 1000, R);
    for (let s = -0.2; s <= 0.2; s += 0.001) {
      const l = sceneKeyLuminance(s, 1000, R);
      worst = Math.max(worst, Math.abs(l - previous));
      previous = l;
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('falls as the planet shrinks in the frame, orbit against surface', () => {
    const street = sceneKeyLuminance(0.8, 350, R);
    const air = sceneKeyLuminance(0.8, 240_000, R);
    const orbit = sceneKeyLuminance(0.8, 26_000_000, R);
    expect(street).toBeGreaterThan(air);
    expect(air).toBeGreaterThan(orbit);
  });

  it('is finite for every input a camera can reach', () => {
    for (const s of [-1, -0.5, 0, 0.5, 1, -1e9, 1e9, Number.EPSILON]) {
      for (const alt of [0, 1, 1e3, 1e7, 1e12]) {
        const l = sceneKeyLuminance(s, alt, R);
        expect(Number.isFinite(l)).toBe(true);
        expect(l).toBeGreaterThan(0);
      }
    }
  });
});

describe('adaptation', () => {
  it('converges to the target and then stays there', () => {
    const state = createExposureState();
    for (let i = 0; i < 400; i++) adaptExposure(state, 0.8, 0.05);
    expect(state.adapted).toBeCloseTo(0.8, 4);
    const settled = state.exposure;
    for (let i = 0; i < 50; i++) adaptExposure(state, 0.8, 0.05);
    expect(state.exposure).toBeCloseTo(settled, 9);
  });

  /**
   * The property a naive `state += (target - state) * k` silently fails.
   *
   * It is the same class of defect as a simulation step whose result depends on
   * how the caller chunked it: correct-looking, and wrong the moment the frame
   * rate changes. Integrating the lag exactly makes one 1 s step and ten 0.1 s
   * steps the same number.
   */
  it('does not depend on frame rate', () => {
    const coarse = createExposureState();
    const fine = createExposureState();
    const finer = createExposureState();
    adaptExposure(coarse, 0.9, 1);
    for (let i = 0; i < 10; i++) adaptExposure(fine, 0.9, 0.1);
    for (let i = 0; i < 1000; i++) adaptExposure(finer, 0.9, 0.001);
    expect(fine.adapted).toBeCloseTo(coarse.adapted, 10);
    expect(finer.adapted).toBeCloseTo(coarse.adapted, 10);
  });

  it('adapts to light faster than to dark, as an eye does', () => {
    const brightening = createExposureState();
    const darkening = createExposureState();
    const start = brightening.adapted;
    /* Symmetric excursions, same duration, from the same starting point. */
    adaptExposure(brightening, start * 4, 0.5);
    adaptExposure(darkening, start / 4, 0.5);
    const towardLight = (brightening.adapted - start) / (start * 4 - start);
    const towardDark = (darkening.adapted - start) / (start / 4 - start);
    expect(towardLight).toBeGreaterThan(towardDark * 2);
  });

  it('never overshoots, however long the step', () => {
    const state = createExposureState();
    const target = 0.9;
    const before = state.adapted;
    adaptExposure(state, target, 1e6);
    expect(state.adapted).toBeLessThanOrEqual(target + 1e-9);
    expect(state.adapted).toBeGreaterThanOrEqual(before);
  });

  it('does nothing on a zero or negative time step', () => {
    const state = createExposureState();
    const before = state.adapted;
    adaptExposure(state, 5, 0);
    adaptExposure(state, 5, -3);
    expect(state.adapted).toBe(before);
  });

  it('stays inside its bounds across the whole orbit-to-street range', () => {
    const state = createExposureState();
    for (const alt of [26_000_000, 3_200_000, 240_000, 45_000, 8_000, 350]) {
      for (const sun of [-1, -0.1, 0, 0.4, 1]) {
        for (let i = 0; i < 200; i++) {
          const e = adaptExposure(state, sceneKeyLuminance(sun, alt, R), 1 / 60);
          expect(e).toBeGreaterThanOrEqual(state.min);
          expect(e).toBeLessThanOrEqual(state.max);
          expect(Number.isFinite(e)).toBe(true);
        }
      }
    }
  });

  it('survives a non-finite target rather than poisoning the state', () => {
    const state = createExposureState();
    const before = state.adapted;
    adaptExposure(state, Number.NaN, 0.1);
    adaptExposure(state, Number.POSITIVE_INFINITY, 0.1);
    expect(state.adapted).toBe(before);
    expect(Number.isFinite(state.exposure)).toBe(true);
  });

  it('is deterministic: the same trajectory gives the same exposure', () => {
    const run = (): number[] => {
      const state = createExposureState();
      const out: number[] = [];
      for (let i = 0; i < 300; i++) {
        const sun = Math.cos(i / 40);
        out.push(adaptExposure(state, sceneKeyLuminance(sun, 5000, R), 1 / 60));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('snaps instantly when a cut makes a lag wrong', () => {
    const state = createExposureState();
    snapExposure(state, 0.02);
    expect(state.adapted).toBeCloseTo(0.02, 12);
  });

  /**
   * A descent has to be SMOOTH, which is the word the acceptance criterion
   * uses. Per-frame exposure change is bounded, so no frame of an orbit ->
   * street flight jumps.
   */
  it('changes smoothly through an orbit-to-street descent', () => {
    const state = createExposureState();
    /* Warm up at orbit so the descent starts from a settled viewer. */
    for (let i = 0; i < 600; i++) adaptExposure(state, sceneKeyLuminance(0.7, 26e6, R), 1 / 60);
    let previous = state.exposure;
    let worst = 0;
    const frames = 180 * 60;
    for (let f = 0; f < frames; f++) {
      /* Log-linear descent from 26,000 km to 350 m over three minutes. */
      const alt = Math.exp(Math.log(26e6) + (Math.log(350) - Math.log(26e6)) * (f / frames));
      const e = adaptExposure(state, sceneKeyLuminance(0.7, alt, R), 1 / 60);
      worst = Math.max(worst, Math.abs(e - previous));
      previous = e;
    }
    /* Well under 1% of the exposure range per frame. */
    expect(worst).toBeLessThan((state.max - state.min) * 0.01);
  });
});
