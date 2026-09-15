/**
 * T-0100. The equirectangular overlay's pixel -> geodesic-cell index.
 *
 * The original was an exhaustive scan — every pixel against every cell — which
 * at the application's default `climateN: 4` is 51,200 x 2,562 = 131 million
 * dot products, measured at 305 ms of main thread the first time a user selects
 * a geodesic field. M12 budgets 0.5 ms.
 *
 * The replacement is an EXACT acceleration, not an approximation, so the first
 * and most important test is that it returns the identical table.
 */

import { describe, expect, it } from 'vitest';
import { geodesicGrid } from '@ws/data';
import { buildGeodesicLookup } from '@ws/render';

/** The original exhaustive scan, kept as the reference oracle. */
function referenceLookup(positions: Float64Array, width: number, height: number, count: number): Int32Array {
  const lookup = new Int32Array(width * height);
  for (let py = 0; py < height; py++) {
    const lat = Math.PI / 2 - ((py + 0.5) / height) * Math.PI;
    const z = Math.sin(lat);
    const radius = Math.cos(lat);
    for (let px = 0; px < width; px++) {
      const lon = ((px + 0.5) / width) * 2 * Math.PI - Math.PI;
      const x = radius * Math.cos(lon);
      const y = radius * Math.sin(lon);
      let best = 0;
      let bestDot = -2;
      for (let i = 0; i < count; i++) {
        const dot = x * (positions[i * 3] as number) + y * (positions[i * 3 + 1] as number) + z * (positions[i * 3 + 2] as number);
        if (dot > bestDot) { bestDot = dot; best = i; }
      }
      lookup[py * width + px] = best;
    }
  }
  return lookup;
}

describe('T-0100 the accelerated lookup is exact', () => {
  it('matches the exhaustive scan pixel for pixel', () => {
    /* Several grid resolutions and several raster shapes, including
       non-square and very thin ones, because the banding is over latitude and a
       degenerate height is where an off-by-one would show. */
    for (const n of [2, 3, 4]) {
      const g = geodesicGrid(n);
      for (const [w, h] of [[320, 160], [64, 32], [17, 5], [8, 1]] as const) {
        const fast = buildGeodesicLookup(g.positions, w, h, g.cellCount);
        const slow = referenceLookup(g.positions, w, h, g.cellCount);
        expect(Array.from(fast), `n=${n} ${w}x${h}`).toEqual(Array.from(slow));
      }
    }
  }, 300000);

  it('resolves the poles to a genuinely polar cell', () => {
    /* Latitude banding has no pole singularity, unlike longitude banding — this
       is the test that would catch it if that ever changed. */
    const g = geodesicGrid(3);
    const w = 64;
    const h = 32;
    const lookup = buildGeodesicLookup(g.positions, w, h, g.cellCount);
    for (const row of [0, h - 1]) {
      const wantNorth = row === 0;
      for (let px = 0; px < w; px++) {
        const cell = lookup[row * w + px] as number;
        const z = g.positions[cell * 3 + 2] as number;
        expect(wantNorth ? z : -z, `row ${row} px ${px} resolved away from the pole`)
          .toBeGreaterThan(0.7);
      }
    }
  }, 120000);

  it('covers every pixel with a valid cell index', () => {
    const g = geodesicGrid(4);
    const lookup = buildGeodesicLookup(g.positions, 320, 160, g.cellCount);
    expect(lookup.length).toBe(320 * 160);
    for (let i = 0; i < lookup.length; i++) {
      const c = lookup[i] as number;
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(g.cellCount);
    }
  }, 120000);
});

describe('T-0100 the lookup build fits a sane budget', () => {
  it('builds the default-configuration lookup in a small fraction of the old cost', () => {
    /* The app default is climateN: 4 at 320x160. The exhaustive scan took
       305 ms here; the budget below is ~10x clear of the accelerated cost and
       ~10x inside the old one, so it cannot pass by accident. */
    const g = geodesicGrid(4);
    const t0 = Date.now();
    buildGeodesicLookup(g.positions, 320, 160, g.cellCount);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(30);
  }, 120000);

  it('scales to resolutions the exhaustive scan could not reach', () => {
    /* n=6 took 4.7 s and n=7 took 18.8 s with the scan. Both are configurations
       a user can select. */
    const g = geodesicGrid(6);
    const t0 = Date.now();
    buildGeodesicLookup(g.positions, 320, 160, g.cellCount);
    expect(Date.now() - t0).toBeLessThan(400);
  }, 180000);
});
