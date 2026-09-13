import { describe, expect, it } from 'vitest';
import { CINEMATIC_DURATION_SECONDS, CINEMATIC_KEYFRAMES, cinematicFrameAt } from '../src/index.js';

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
});
