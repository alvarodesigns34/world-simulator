/**
 * The city plan renderer, tested headless.
 *
 * M9's claim is that a city is a small state plus a generator, and the way a
 * person checks that claim is by LOOKING at the plan. These tests check the
 * things a person would look for — is there a bridge, does it sit over the
 * water, is the core distinguishable from the fields — as pixel assertions, so
 * "it renders" is not confused with "it renders the right thing".
 */

import { describe, expect, it } from 'vitest';
import { renderCityPlan, type CityPlanInput } from '@ws/render';

const W = 128;
const H = 128;

/** A minimal plan: one east-west arterial across a north-south river. */
function crossingPlan(): CityPlanInput {
  return {
    radiusM: 1000,
    nodeXY: new Float32Array([-900, 0, 0, 0, 900, 0]),
    nodeCount: 3,
    edges: new Int32Array([0, 1, 1, 2]),
    edgeClass: new Uint8Array([0, 0]),
    edgeCount: 2,
    bridgeEdges: new Int32Array([0]),
    bridgeCount: 1,
    districtKind: new Uint8Array([0]),
    districtXY: new Float32Array([0, 0]),
    districtRadiusM: new Float32Array([300]),
    districtCount: 1,
    buildings: new Float32Array([400, 300, 40, 90]),
    buildingDistrict: new Uint8Array([0]),
    buildingCount: 1,
  };
}

function pixel(rgba: Uint8ClampedArray, x: number, y: number): [number, number, number] {
  const o = (Math.round(y) * W + Math.round(x)) * 4;
  return [rgba[o] as number, rgba[o + 1] as number, rgba[o + 2] as number];
}

describe('city plan renderer', () => {
  it('fills every pixel — no transparent holes', () => {
    const { rgba } = renderCityPlan(crossingPlan(), { width: W, height: H });
    for (let i = 3; i < rgba.length; i += 4) expect(rgba[i]).toBe(255);
  });

  it('draws water where the backdrop says water is', () => {
    const backdrop = {
      waterAt: (x: number) => Math.abs(x) < 150,
      elevationAt: () => 100,
    };
    const { rgba, metresPerPixel, centreX, centreY } = renderCityPlan(
      crossingPlan(), { width: W, height: H }, backdrop);
    /* A point in the channel but well away from the road. */
    const wet = pixel(rgba, centreX, centreY + 600 / metresPerPixel);
    /* A point on dry ground at the same distance. */
    const dry = pixel(rgba, centreX + 800 / metresPerPixel, centreY + 600 / metresPerPixel);
    expect(wet[2]).toBeGreaterThan(wet[0]);
    expect(wet[2]).toBeGreaterThan(dry[2]);
  });

  it('marks a bridge distinctly from an ordinary road', () => {
    /* Whether a city bridged its river or stopped at it is the single most
       informative thing about how it met the water, so it has to be legible. */
    const plan = crossingPlan();
    const { rgba, centreX, centreY, metresPerPixel } = renderCityPlan(plan, { width: W, height: H });
    const onBridge = pixel(rgba, centreX - 450 / metresPerPixel, centreY);
    const onPlainRoad = pixel(rgba, centreX + 450 / metresPerPixel, centreY);
    expect(onBridge).not.toEqual(onPlainRoad);
    /* The bridge is the red-dominant one. */
    expect(onBridge[0]).toBeGreaterThan(onBridge[2]);
    expect(onPlainRoad[0]).toBeGreaterThan(100);
  });

  it('shades taller buildings brighter than short ones', () => {
    const short = crossingPlan();
    short.buildings[3] = 6;
    const tall = crossingPlan();
    tall.buildings[3] = 200;
    const a = renderCityPlan(short, { width: W, height: H });
    const b = renderCityPlan(tall, { width: W, height: H });
    const at = (r: ReturnType<typeof renderCityPlan>): number => {
      const p = pixel(r.rgba, r.centreX + 400 / r.metresPerPixel, r.centreY - 300 / r.metresPerPixel);
      return p[0] + p[1] + p[2];
    };
    expect(at(b)).toBeGreaterThan(at(a));
  });

  it('is deterministic: the same plan renders the same pixels', () => {
    const a = renderCityPlan(crossingPlan(), { width: W, height: H });
    const b = renderCityPlan(crossingPlan(), { width: W, height: H });
    expect(Array.from(a.rgba)).toEqual(Array.from(b.rgba));
  });

  it('scales to fit the city rather than clipping it', () => {
    const small = renderCityPlan(crossingPlan(), { width: W, height: H });
    const big = { ...crossingPlan(), radiusM: 50_000 };
    const large = renderCityPlan(big, { width: W, height: H });
    expect(large.metresPerPixel).toBeGreaterThan(small.metresPerPixel);
    /* The arterial tips are inside the frame at both scales. */
    for (const r of [small, large]) {
      const tip = r.centreX + 900 / r.metresPerPixel;
      expect(tip).toBeLessThan(W);
      expect(tip).toBeGreaterThan(0);
    }
  });

  it('renders an empty plan without throwing', () => {
    const empty: CityPlanInput = {
      radiusM: 0,
      nodeXY: new Float32Array(0), nodeCount: 0,
      edges: new Int32Array(0), edgeClass: new Uint8Array(0), edgeCount: 0,
      bridgeEdges: new Int32Array(0), bridgeCount: 0,
      districtKind: new Uint8Array(0), districtXY: new Float32Array(0),
      districtRadiusM: new Float32Array(0), districtCount: 0,
      buildings: new Float32Array(0), buildingDistrict: new Uint8Array(0), buildingCount: 0,
    };
    const { rgba } = renderCityPlan(empty, { width: 16, height: 16 });
    expect(rgba.length).toBe(16 * 16 * 4);
  });
});
