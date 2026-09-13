import { describe, expect, it } from 'vitest';
import { DIR, cubeIndex, neighbor } from '@ws/data';
import { findNavigablePort, isCoastalLand, routeLandInfrastructure, seaRoute } from '../src/economy/routing.js';
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
    const port = findNavigablePort(h, inland);
    expect(port).toBeGreaterThanOrEqual(0);
    expect(h.ocean[port]).toBe(0);
    expect(isCoastalLand(h, port)).toBe(true);
    expect(() => seaRoute(h, inland, port, 10)).toThrow(/coastal land ports/);
  });
});
