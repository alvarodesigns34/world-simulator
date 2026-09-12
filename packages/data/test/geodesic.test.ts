import { describe, expect, it } from 'vitest';
import {
  cubeToGeoExtensive,
  geoToCubeExtensive,
  geodesicCellCount,
  geodesicGrid,
  geodesicLat,
  relativeMassError,
  resamplePlan,
} from '@ws/data';

describe('T-0034 geodesic grid', () => {
  it('has exactly 10·4^n+2 cells and 12 pentagons', () => {
    for (const n of [0, 1, 2, 3, 4]) {
      const g = geodesicGrid(n);
      expect(g.cellCount).toBe(geodesicCellCount(n));
      expect(g.cellCount).toBe(10 * 4 ** n + 2);
      let pent = 0;
      for (let i = 0; i < g.cellCount; i++) if (g.neighborCount[i] === 5) pent++;
      expect(pent).toBe(12);
    }
  });

  it('neighbours are mutual and sorted', () => {
    const g = geodesicGrid(3);
    for (let i = 0; i < g.cellCount; i++) {
      const nc = g.neighborCount[i] as number;
      expect(nc === 5 || nc === 6).toBe(true);
      for (let k = 1; k < nc; k++) {
        expect(g.neighbors[i * 6 + k] as number).toBeGreaterThan(g.neighbors[i * 6 + k - 1] as number);
      }
      for (let k = 0; k < nc; k++) {
        const j = g.neighbors[i * 6 + k] as number;
        let back = false;
        const nj = g.neighborCount[j] as number;
        for (let t = 0; t < nj; t++) if (g.neighbors[j * 6 + t] === i) back = true;
        expect(back).toBe(true);
      }
    }
  });

  it('areas partition the sphere to 1e-8 relative', () => {
    const g = geodesicGrid(4);
    let sum = 0;
    for (let i = 0; i < g.cellCount; i++) sum += g.areas[i] as number;
    expect(Math.abs(sum / (4 * Math.PI) - 1)).toBeLessThan(1e-8);
  });

  it('latitudes cover both hemispheres', () => {
    const g = geodesicGrid(3);
    let lo = 1;
    let hi = -1;
    for (let i = 0; i < g.cellCount; i++) {
      const la = geodesicLat(g, i);
      if (la < lo) lo = la;
      if (la > hi) hi = la;
    }
    expect(lo).toBeLessThan(-1);
    expect(hi).toBeGreaterThan(1);
  });
});

describe('T-0034 conservative resampling', () => {
  it('extensive cube→geo→cube conserves mass to 1e-9', () => {
    const plan = resamplePlan(4, 3);
    const cube = new Float64Array(plan.cubeCount);
    for (let i = 0; i < cube.length; i++) cube[i] = 1 + ((i * 17) % 10) * 0.01;
    const geo = new Float64Array(plan.geoCount);
    cubeToGeoExtensive(plan, cube, geo);
    const back = new Float64Array(plan.cubeCount);
    geoToCubeExtensive(plan, geo, back);
    expect(relativeMassError(cube, geo)).toBeLessThan(1e-9);
    expect(relativeMassError(cube, back)).toBeLessThan(1e-9);
  });

  it('a second (level, n) pair also conserves', () => {
    const plan = resamplePlan(5, 4);
    const cube = new Float64Array(plan.cubeCount);
    cube.fill(2.5);
    const geo = new Float64Array(plan.geoCount);
    cubeToGeoExtensive(plan, cube, geo);
    expect(relativeMassError(cube, geo)).toBeLessThan(1e-12);
  });
});
