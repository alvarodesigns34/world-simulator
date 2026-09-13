import { describe, expect, it } from 'vitest';
import { budgets } from '@ws/core';
import { EARTH_GEOMETRY } from '@ws/data';
import { cameraFromGeodetic, lookAtCentre, selectPatches } from '@ws/render';

/**
 * T-0065 — graceful LOD degradation at the patch cap.
 *
 * Hitting `maxVisiblePatches` currently either (a) refuses to split (the
 * `canSplit` reservation of 4 children) or (b) DROPS leftover leaves
 * (`visible.length >= cap → continue`). (b) punches holes and, as the camera
 * moves, churns a different leftover set each frame.
 *
 * Adaptive τ near the cap (inflate τ when the previous frame was exhausted so
 * the selector splits less and the visible set *fits*) beats truncation. It is
 * NOT implemented here: τ=4.0 does not hit the 900-patch 33×33/1440p cap on
 * the M1 descent, so shipping it now would be a silent behaviour change with
 * no visual gate. Design only.
 *
 * Do not edit `budgets.ts` on the strength of this file.
 */

const P = EARTH_GEOMETRY;

describe('T-0065: patch-cap truncation (design / bench, no budget edit)', () => {
  it('does not silently change QUALITY.lodScreenSpaceErrorPx', () => {
    expect(budgets.QUALITY.lodScreenSpaceErrorPx).toBe(4.0);
    expect(budgets.QUALITY.absoluteMaxVisiblePatches).toBe(2048);
  });

  it('τ=4.0 on the M1 1440p path does not exhaust the 33×33 discrete budget', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.2, lon: 0.4, altitude: 8e6 }, P));
    const r = selectPatches(cam, {
      planet: P,
      viewportWidth: 2560,
      viewportHeight: 1440,
      gpuTier: 'discrete',
      patchVerticesPerSide: 33,
      screenSpaceErrorPx: 4.0,
      maxLevel: 12,
    });
    expect(r.stats.budgetExhausted).toBe(false);
    expect(r.stats.visible).toBeLessThan(r.stats.budgetPatches);
  });

  it('a tiny cap is a hard ceiling — leftover nodes are not emitted', () => {
    // 256×256, 33×33, minPx=2 → ~16-patch cap. Tight τ wants far more leaves.
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.2, lon: 0.4, altitude: 1e6 }, P));
    const tight = selectPatches(cam, {
      planet: P,
      viewportWidth: 256,
      viewportHeight: 256,
      gpuTier: 'discrete',
      patchVerticesPerSide: 33,
      screenSpaceErrorPx: 0.25,
      maxLevel: 12,
    });
    const loose = selectPatches(cam, {
      planet: P,
      viewportWidth: 256,
      viewportHeight: 256,
      gpuTier: 'discrete',
      patchVerticesPerSide: 33,
      screenSpaceErrorPx: 16,
      maxLevel: 12,
    });
    expect(tight.stats.budgetPatches).toBeLessThan(32);
    expect(tight.stats.visible).toBeLessThanOrEqual(tight.stats.budgetPatches);
    expect(loose.stats.visible).toBeLessThanOrEqual(loose.stats.budgetPatches);
    // Tight τ splits deeper against the same cap.
    expect(tight.stats.maxLevelReached).toBeGreaterThanOrEqual(loose.stats.maxLevelReached);
  });
});
