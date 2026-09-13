import { describe, expect, it } from 'vitest';
import { EARTH_GEOMETRY } from '@ws/data';
import {
  CINEMATIC_DURATION_SECONDS,
  CINEMATIC_KEYFRAMES,
  CINEMATIC_ROLE,
  CINEMATIC_TARGET_ROLES,
  aim,
  cinematicFrameAt,
  type CinematicTargets,
} from '../src/index.js';

describe('M13 cinematic camera', () => {
  it('defines the complete reproducible three-minute sequence', () => {
    expect(CINEMATIC_DURATION_SECONDS).toBe(180);
    expect(CINEMATIC_KEYFRAMES).toHaveLength(10);
    expect(CINEMATIC_KEYFRAMES.map((k) => k.shot)).toEqual([
      'Global orbit', 'Daylight limb', 'Continent approach', 'Mountains and rivers',
      'Civilisation layer', 'City approach', 'Street flyover', 'Infrastructure',
      'Scientific transition', 'Era pull-back',
    ]);
  });

  it('is finite, deterministic and remains planet-centred throughout', () => {
    for (let t = 0; t <= 180; t += 0.25) {
      const a = cinematicFrameAt(t);
      const b = cinematicFrameAt(t);
      expect(a).toEqual(b);
      const p = a.camera.position;
      const q = a.camera.orientation;
      expect([p.x, p.y, p.z, q.x, q.y, q.z, q.w].every(Number.isFinite)).toBe(true);
      expect(a.progress).toBeGreaterThanOrEqual(0);
      expect(a.progress).toBeLessThanOrEqual(1);
    }
  });

  /**
   * T-0102. A shot points where the world says, not where the file says.
   *
   * The keyframes' literal coordinates were tuned against one seed. These
   * assert the mechanism that replaced them: give the programme a target and
   * the camera goes there; give it none and it says so.
   */
  it('aims each shot at the target the world supplied', () => {
    const targets: CinematicTargets = {
      [CINEMATIC_ROLE.CITY]: { lat: -0.9, lon: 2.7 },
      [CINEMATIC_ROLE.STREET]: { lat: -0.9, lon: 2.7 },
    };
    /* Just past 98 s, where the City approach keyframe becomes the current
       shot. Exactly at 98 the previous shot is still the one in force. */
    const aimed = cinematicFrameAt(98.001, EARTH_GEOMETRY, targets);
    const fallback = cinematicFrameAt(98.001);
    expect(aimed.fromWorld).toBe(true);
    expect(fallback.fromWorld).toBe(false);
    expect(aimed.camera.position).not.toEqual(fallback.camera.position);

    /* And it goes to the RIGHT place: the camera sits above the target. */
    const p = aimed.camera.position;
    const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    expect(Math.asin(p.z / r)).toBeCloseTo(-0.9, 2);
    expect(Math.atan2(p.y, p.x)).toBeCloseTo(2.7, 2);
  });

  it('reports a fallback as a fallback rather than as a world tour', () => {
    /* Every non-globe shot with no target must admit it. This is the assertion
       that stops a recording being labelled a tour of a planet it never saw. */
    for (const k of CINEMATIC_KEYFRAMES) {
      const f = cinematicFrameAt(k.t);
      expect(f.fromWorld).toBe(false);
    }
    /* The globe shots are never world-aimed BY DESIGN — the planet as a whole
       is not a feature — so supplying every target still leaves them false. */
    const all: CinematicTargets = {};
    for (const role of CINEMATIC_TARGET_ROLES) {
      (all as Record<string, { lat: number; lon: number }>)[role] = { lat: 0.3, lon: 0.4 };
    }
    expect(cinematicFrameAt(0, EARTH_GEOMETRY, all).fromWorld).toBe(false);
    expect(cinematicFrameAt(58, EARTH_GEOMETRY, all).fromWorld).toBe(true);
  });

  it('offsets a shot from its target so two shots are not the same frame', () => {
    const targets: CinematicTargets = { [CINEMATIC_ROLE.STREET]: { lat: 0.2, lon: 0.3 } };
    const street = CINEMATIC_KEYFRAMES.find((k) => k.role === CINEMATIC_ROLE.STREET)!;
    const p = aim(street, targets);
    expect(p.lat).toBeCloseTo(0.2 + (street.dLat ?? 0), 9);
    expect(p.lon).toBeCloseTo(0.3 + (street.dLon ?? 0), 9);
  });

  it('keeps a target near the pole inside the camera domain', () => {
    const targets: CinematicTargets = { [CINEMATIC_ROLE.RELIEF]: { lat: 1.5707, lon: 3.1 } };
    const f = cinematicFrameAt(58, EARTH_GEOMETRY, targets);
    const p = f.camera.position;
    expect([p.x, p.y, p.z].every(Number.isFinite)).toBe(true);
  });

  it('takes the short way round when two targets straddle the seam', () => {
    /* Consecutive world-derived targets can be at +179 and -179 degrees. A
       naive interpolation would sweep the camera 358 degrees across the whole
       planet in the middle of a shot. */
    const targets: CinematicTargets = {
      [CINEMATIC_ROLE.CIVILISATION]: { lat: 0.1, lon: 3.12 },
      [CINEMATIC_ROLE.CITY]: { lat: 0.1, lon: -3.12 },
      [CINEMATIC_ROLE.STREET]: { lat: 0.1, lon: -3.12 },
    };
    let previous = cinematicFrameAt(78, EARTH_GEOMETRY, targets).camera.position;
    let worst = 0;
    for (let t = 78.25; t <= 98; t += 0.25) {
      const p = cinematicFrameAt(t, EARTH_GEOMETRY, targets).camera.position;
      const d = Math.hypot(p.x - previous.x, p.y - previous.y, p.z - previous.z);
      if (d > worst) worst = d;
      previous = p;
    }
    /* The whole traverse is ~0.04 rad of longitude; a wrong-way sweep would be
       two orders of magnitude larger per step. */
    expect(worst).toBeLessThan(EARTH_GEOMETRY.radius * 0.05);
  });
});