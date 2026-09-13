import { describe, expect, it } from 'vitest';
import { DIR, cubeIndex, neighbor } from '@ws/data';
import {
  findCoastalOutlet,
  isCoastalLand,
  oceanBasinLabels,
  portsShareOcean,
  routeLandInfrastructure,
  seaRoute,
} from '../src/economy/routing.js';
import type { HydrologyState } from '../src/hydrology/system.js';

function corridor(): HydrologyState {
  const level = 3;
  const n = 1 << level;
  const count = 6 * n * n;
  const ocean = new Uint8Array(count).fill(1);
  const elevationM = new Float64Array(count).fill(-1000);
  const dischargeM3s = new Float64Array(count);
  const areaM2 = new Float64Array(count).fill(8e11);
  for (let x = 1; x <= 6; x++) {
    for (const y of [2, 3]) {
      const i = cubeIndex(0, level, x, y);
      ocean[i] = 0;
      elevationM[i] = y === 3 && x === 3 ? 1e7 : 100;
    }
  }
  dischargeM3s[cubeIndex(0, level, 4, 2)] = 500;
  return { level, cellCount: count, ocean, elevationM, dischargeM3s, areaM2 } as unknown as HydrologyState;
}

/** Face 0 entirely land with one enclosed pond; every other face ocean. */
function enclosedSea(): HydrologyState {
  const level = 3;
  const n = 1 << level;
  const count = 6 * n * n;
  const ocean = new Uint8Array(count).fill(1);
  const elevationM = new Float64Array(count).fill(-1000);
  const dischargeM3s = new Float64Array(count);
  const areaM2 = new Float64Array(count).fill(8e11);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const i = cubeIndex(0, level, x, y);
      ocean[i] = 0;
      elevationM[i] = 200;
    }
  }
  const pond = cubeIndex(0, level, 4, 4);
  ocean[pond] = 1;
  elevationM[pond] = -50;
  return { level, cellCount: count, ocean, elevationM, dischargeM3s, areaM2 } as unknown as HydrologyState;
}

describe('M10 physical infrastructure routing', () => {
  it('avoids ocean and an impassable mountain barrier, records bridges, and is deterministic', () => {
    const h = corridor();
    const start = cubeIndex(0, h.level, 1, 3);
    const goal = cubeIndex(0, h.level, 6, 3);
    const a = routeLandInfrastructure(h, start, goal);
    const b = routeLandInfrastructure(h, start, goal);
    expect([...a.cells]).toEqual([...b.cells]);
    expect([...a.cells].every((cell) => h.ocean[cell] === 0)).toBe(true);
    expect([...a.cells]).not.toContain(cubeIndex(0, h.level, 3, 3));
    expect([...a.bridgeCells]).toContain(cubeIndex(0, h.level, 4, 2));
    expect(a.maxGradient).toBeLessThanOrEqual(0.45);
  });

  it('selects a real coastal-land port and refuses an inland sea endpoint', () => {
    const h = corridor();
    const inland = cubeIndex(0, h.level, 3, 2);
    for (const direction of [DIR.POS_U, DIR.NEG_U, DIR.POS_V, DIR.NEG_V]) {
      const p = neighbor({ face: 0, x: 3, y: 2 }, h.level, direction);
      h.ocean[cubeIndex(p.face, h.level, p.x, p.y)] = 0;
    }
    const port = findCoastalOutlet(h, inland);
    expect(port).toBeGreaterThanOrEqual(0);
    expect(h.ocean[port]).toBe(0);
    expect(isCoastalLand(h, port)).toBe(true);
    expect(() => seaRoute(h, inland, port, 10)).toThrow(/coastal land outlets/);
  });

  /**
   * T-0105. A coast at both ends is not a sea route.
   *
   * `findNavigablePort` said "navigable" while doing a land walk to the nearest
   * shore. Two settlements on opposite shores of a LANDLOCKED sea each got a
   * port, and the network then gave them a sea lane priced at the great-circle
   * distance — goods moving along a route no ship could take, at the cheapest
   * rate in the model.
   */
  it('does not connect two coasts that share no water', () => {
    const h = enclosedSea();
    const pond = cubeIndex(0, h.level, 4, 4);
    const labels = oceanBasinLabels(h);
    expect(labels[pond]).toBeGreaterThanOrEqual(0);

    /* Two distinct bodies of water: the enclosed pond and the world ocean. */
    const open = cubeIndex(1, h.level, 0, 0);
    expect(h.ocean[open]).toBe(1);
    expect(labels[open]).not.toBe(labels[pond]);

    /* A cell on the pond's shore and a cell on the ocean's shore. */
    const pondShore = cubeIndex(0, h.level, 3, 4);
    const oceanShore = cubeIndex(0, h.level, 0, 0);
    expect(isCoastalLand(h, pondShore)).toBe(true);
    expect(isCoastalLand(h, oceanShore)).toBe(true);
    expect(portsShareOcean(h, labels, pondShore, oceanShore)).toBe(false);

    /* Both, however, would have been given a "navigable port" by the old
       land-walk search — which is exactly how the false lane arose. */
    expect(findCoastalOutlet(h, pondShore)).toBeGreaterThanOrEqual(0);
    expect(findCoastalOutlet(h, oceanShore)).toBeGreaterThanOrEqual(0);
  });

  it('connects two coasts that do share water', () => {
    const h = corridor();
    const labels = oceanBasinLabels(h);
    const a = cubeIndex(0, h.level, 1, 3);
    const b = cubeIndex(0, h.level, 6, 3);
    expect(isCoastalLand(h, a)).toBe(true);
    expect(isCoastalLand(h, b)).toBe(true);
    expect(portsShareOcean(h, labels, a, b)).toBe(true);
  });

  it('labels the ocean deterministically', () => {
    const h = corridor();
    expect(Array.from(oceanBasinLabels(h))).toEqual(Array.from(oceanBasinLabels(h)));
    /* Land is never given a basin. */
    const labels = oceanBasinLabels(h);
    for (let i = 0; i < h.cellCount; i++) {
      if (h.ocean[i] === 0) expect(labels[i]).toBe(-1);
      else expect(labels[i]).toBeGreaterThanOrEqual(0);
    }
  });
});