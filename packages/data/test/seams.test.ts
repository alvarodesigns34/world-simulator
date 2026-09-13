import { describe, expect, it } from 'vitest';
import {
  DIR,
  DIR_COUNT,
  EARTH_GEOMETRY,
  cubeFaceToUnitRaw,
  cubeIndex,
  cubeDecode,
  cubeDim,
  cellCount,
  edgeAdjacencies,
  neighbor,
  valence3Corners,
  cellCenterUnit,
  cubeCellSteradians,
  type CubeCell,
} from '@ws/data';

const R = EARTH_GEOMETRY.radius;

function distM(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * R;
}

describe('cube raster index', () => {
  it('round-trips at L6 and L8', () => {
    for (const level of [0, 3, 6, 8]) {
      const n = cubeDim(level);
      expect(cellCount(level)).toBe(6 * n * n);
      const last = cubeIndex(5, level, n - 1, n - 1);
      expect(last).toBe(cellCount(level) - 1);
      const d = cubeDecode(last, level);
      expect(d).toEqual({ face: 5, x: n - 1, y: n - 1 });
      expect(cubeDecode(0, level)).toEqual({ face: 0, x: 0, y: 0 });
    }
  });
});

describe('T-0020 cube-face seam topology', () => {
  it('has 24 directed edge adjacencies (6 faces × 4 edges)', () => {
    expect(edgeAdjacencies(4)).toHaveLength(24);
    expect(DIR_COUNT).toBe(4);
  });

  it('a 4-connected step off an edge lands on a different face whose 3-D image matches', () => {
    const level = 5;
    const n = cubeDim(level);
    let checked = 0;
    for (let face = 0; face < 6; face++) {
      const edgeCells: { cell: CubeCell; dir: 0 | 1 | 2 | 3 }[] = [
        { cell: { face, x: n - 1, y: 3 }, dir: DIR.POS_U },
        { cell: { face, x: 0, y: 7 }, dir: DIR.NEG_U },
        { cell: { face, x: 4, y: n - 1 }, dir: DIR.POS_V },
        { cell: { face, x: 9, y: 0 }, dir: DIR.NEG_V },
      ];
      for (const { cell, dir } of edgeCells) {
        const nb = neighbor(cell, level, dir);
        expect(nb.face).not.toBe(face);
        /* Shared edge: the leaving cell's edge-midpoint and the arriving
           cell's facing edge-midpoint must be the same 3-D point. */
        const fromUv = edgeUv(cell, level, dir);
        const toUv = edgeUv(nb, level, opposite(dir, cell, nb, level));
        const a = cubeFaceToUnitRaw(cell.face, fromUv.u, fromUv.v);
        const b = cubeFaceToUnitRaw(nb.face, toUv.u, toUv.v);
        expect(distM(a, b)).toBeLessThan(1); /* 1 m — identification, not interpolation */
        checked++;
      }
    }
    expect(checked).toBe(24);
  });

  it('on-face neighbours stay on the face', () => {
    const nb = neighbor({ face: 2, x: 3, y: 5 }, 4, DIR.POS_U);
    expect(nb).toEqual({ face: 2, x: 4, y: 5 });
  });

  it('every interior cell has 4 neighbours and stepping forth-and-back returns', () => {
    const level = 4;
    const n = cubeDim(level);
    for (let face = 0; face < 6; face++) {
      for (let x = 1; x < n - 1; x++) {
        for (let y = 1; y < n - 1; y++) {
          const c: CubeCell = { face, x, y };
          const fwd = neighbor(c, level, DIR.POS_U);
          const back = neighbor(fwd, level, DIR.NEG_U);
          expect(back).toEqual(c);
        }
      }
    }
  });

  it('valence-3: 8 corners, 3 cells each, sharing one 3-D point', () => {
    const level = 6;
    const corners = valence3Corners(level);
    expect(corners).toHaveLength(8);
    const seen = new Set<string>();
    for (const triple of corners) {
      expect(triple).toHaveLength(3);
      const faces = new Set(triple.map((c) => c.face));
      expect(faces.size).toBe(3);
      const pts = triple.map((c) => {
        const u = c.x === 0 ? 0 : 1;
        const v = c.y === 0 ? 0 : 1;
        return cubeFaceToUnitRaw(c.face, u, v);
      });
      expect(distM(pts[0]!, pts[1]!)).toBeLessThan(1e-3);
      expect(distM(pts[1]!, pts[2]!)).toBeLessThan(1e-3);
      const key = `${triple[0].face}:${triple[1].face}:${triple[2].face}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('cell areas partition the sphere to ~1e-4 relative (warp residual)', () => {
    const level = 4;
    const n = cubeDim(level);
    let sum = 0;
    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          sum += cubeCellSteradians({ face, x, y }, level);
        }
      }
    }
    const sphere = 4 * Math.PI;
    expect(Math.abs(sum / sphere - 1)).toBeLessThan(1e-4);
  });

  it('cell centres are unit length', () => {
    const p = cellCenterUnit({ face: 0, x: 0, y: 0 }, 3);
    expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 12);
  });
});

function edgeUv(cell: CubeCell, level: number, dir: 0 | 1 | 2 | 3): { u: number; v: number } {
  const n = cubeDim(level);
  const u0 = cell.x / n;
  const v0 = cell.y / n;
  const u1 = (cell.x + 1) / n;
  const v1 = (cell.y + 1) / n;
  if (dir === DIR.POS_U) return { u: u1, v: (v0 + v1) / 2 };
  if (dir === DIR.NEG_U) return { u: u0, v: (v0 + v1) / 2 };
  if (dir === DIR.POS_V) return { u: (u0 + u1) / 2, v: v1 };
  return { u: (u0 + u1) / 2, v: v0 };
}

function opposite(
  dir: 0 | 1 | 2 | 3,
  from: CubeCell,
  to: CubeCell,
  level: number,
): 0 | 1 | 2 | 3 {
  /* The arriving direction is whichever of the 4 makes a step back to `from`. */
  for (const d of [DIR.POS_U, DIR.NEG_U, DIR.POS_V, DIR.NEG_V] as const) {
    const back = neighbor(to, level, d);
    if (back.face === from.face && back.x === from.x && back.y === from.y) return d;
  }
  void dir;
  return DIR.NEG_U;
}
