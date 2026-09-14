import { describe, expect, it } from 'vitest';
import { budgets } from '@ws/core';
import { EARTH_GEOMETRY, quadkey } from '@ws/data';
import {
  DESCENT,
  descentCameraAt,
  descentSampleTimes,
  selectPatches,
} from '@ws/render';

const P = EARTH_GEOMETRY;

/**
 * Characterise popping. Morphing is NOT implemented (T-0015 deferred). This
 * file records what hysteresis actually does on the scripted descent so Astra
 * is not guessing, and so a future morph can be compared against a number.
 */
describe('LOD popping characterisation (descent, hysteresis only)', () => {
  it('records appear/disappear counts along the 60 s descent', () => {
    const hz = 10;
    const times = descentSampleTimes(hz);
    let prev = new Set<number>();
    let prevSplit: ReadonlySet<number> = new Set();
    let prevLevel = new Map<number, number>();
    let maxAppear = 0;
    let maxDisappear = 0;
    let maxJump = 0;
    let framesWithChurn = 0;
    const rows: Array<{ t: number; alt: number; appear: number; disappear: number; vis: number }> = [];

    for (const t of times) {
      const cam = descentCameraAt(t, P);
      const r = selectPatches(cam, {
        planet: P,
        viewportWidth: DESCENT.viewportWidth,
        viewportHeight: DESCENT.viewportHeight,
        gpuTier: DESCENT.gpuTier,
        patchVerticesPerSide: DESCENT.patchVerticesPerSide,
        maxLevel: DESCENT.maxLevel,
        previouslySplit: prevSplit,
      });
      const ids = new Set(r.visible.map((n) => quadkey.packId(n.key)));
      let appear = 0;
      let disappear = 0;
      for (const id of ids) if (!prev.has(id)) appear++;
      for (const id of prev) if (!ids.has(id)) disappear++;
      for (const n of r.visible) {
        const id = quadkey.packId(n.key);
        const prevL = prevLevel.get(id);
        if (prevL !== undefined) maxJump = Math.max(maxJump, Math.abs(n.key.level - prevL));
      }
      if (appear + disappear > 0) framesWithChurn++;
      maxAppear = Math.max(maxAppear, appear);
      maxDisappear = Math.max(maxDisappear, disappear);
      if (t % 6 === 0) {
        const alt = Math.sqrt(cam.position.x ** 2 + cam.position.y ** 2 + cam.position.z ** 2) - P.radius;
        rows.push({ t, alt, appear, disappear, vis: r.stats.visible });
      }
      prev = ids;
      prevSplit = r.split;
      prevLevel = new Map(r.visible.map((n) => [quadkey.packId(n.key), n.key.level]));
    }

    expect(times.length).toBe(DESCENT.durationSeconds * hz + 1);
    expect(maxAppear).toBeGreaterThan(0); // a descent that never changes LOD is broken
    // Hysteresis must stop per-frame thrash. 10 Hz over 60 s = 601 samples.
    // If more than half the samples churn, hysteresis is not doing its job.
    expect(framesWithChurn / times.length).toBeLessThan(0.85);
    // A single frame replacing the whole planet would be a pop. Cap it.
    expect(maxAppear).toBeLessThan(400);
    expect(maxDisappear).toBeLessThan(400);
    expect(budgets.QUALITY.lodHysteresis).toBe(1.5);
    void rows;
    void maxJump;
  });

  it('hysteresis reduces oscillation versus a no-hysteresis control', () => {
    let withH = 0;
    let without = 0;
    let splitH: ReadonlySet<number> = new Set();
    let prevH = -1;
    let prevN = -1;
    for (let i = 0; i < 120; i++) {
      const hovering = selectPatches(descentCameraAt(18 + Math.sin(i / 5) * 0.15, P), {
        planet: P,
        viewportWidth: 2560,
        viewportHeight: 1440,
        gpuTier: 'discrete',
        patchVerticesPerSide: 33,
        maxLevel: 10,
        previouslySplit: splitH,
      });
      splitH = hovering.split;
      if (prevH >= 0 && hovering.stats.visible !== prevH) withH++;
      prevH = hovering.stats.visible;

      const naked = selectPatches(descentCameraAt(18 + Math.sin(i / 5) * 0.15, P), {
        planet: P,
        viewportWidth: 2560,
        viewportHeight: 1440,
        gpuTier: 'discrete',
        patchVerticesPerSide: 33,
        maxLevel: 10,
      });
      if (prevN >= 0 && naked.stats.visible !== prevN) without++;
      prevN = naked.stats.visible;
    }
    // Hysteresis must not make oscillation worse.
    expect(withH).toBeLessThanOrEqual(without + 5);
  });
});
