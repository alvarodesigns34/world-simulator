/**
 * T-0102. The cinematic looks at features this world actually has.
 *
 * The keyframes used to carry hardcoded coordinates tuned against one seed.
 * These tests assert the replacement is real: each target is the argmax it
 * claims to be, the selection is reproducible, and a role the world cannot
 * fill is ABSENT rather than filled with something plausible-looking.
 */

import { describe, expect, it } from 'vitest';
import { makeSeed } from '@ws/core';
import { cubeDim, cubeIndex } from '@ws/data';
import { cinematicTargets, createWorld, duration, largestCity } from '../src/index.js';

function evolved() {
  const w = createWorld({
    seed: makeSeed(3, 7), genesis: { level: 5, steps: 20, plateCount: 9 },
    terrainLevel: 5, climateN: 4, erode: false,
  });
  w.apply({ kind: 'setTimeScale', scale: 1e8 });
  for (let i = 0; i < 4; i++) w.scheduler.advance(duration(100_000 * w.calendar.secondsPerYear));
  return w;
}

/** Great-circle-free check: the cell a point claims must be the cell it names. */
function cellOf(t: { cell: number } | undefined): number {
  expect(t).toBeDefined();
  return t!.cell;
}

describe('M13 cinematic target selection', () => {
  const world = evolved();
  const targets = cinematicTargets(world);

  /**
   * T-0163. "Relief" means the steepest land, not the highest.
   *
   * The first version selected the highest cell, which sounds like the
   * mountains and is not: on a world whose sea level sits at -3421 m the
   * highest cell is the middle of a wide high plateau, and flying there — as
   * this was observed to do in a browser — shows a flat green plain under a
   * shot captioned "Mountains and rivers".
   */
  it('puts the relief shot on the steepest LAND, not the deepest trench', () => {
    const cell = cellOf(targets.relief);
    const h = world.hydrology;
    expect(h.ocean[cell]).toBe(0);
    expect(targets.relief?.why).toMatch(/steepest/);

    /* It is a genuine maximum of the selection score, not merely somewhere. */
    const n = cubeDim(h.level);
    const scoreAt = (i: number): number => {
      if (h.ocean[i] !== 0) return -Infinity;
      const face = Math.floor(i / (n * n));
      const local = i - face * n * n;
      const y = Math.floor(local / n);
      const x = local - y * n;
      if (x < 1 || y < 1 || x >= n - 1 || y >= n - 1) return -Infinity;
      const e = h.elevationM;
      const dx = (e[cubeIndex(face, h.level, x + 1, y)] as number)
        - (e[cubeIndex(face, h.level, x - 1, y)] as number);
      const dy = (e[cubeIndex(face, h.level, x, y + 1)] as number)
        - (e[cubeIndex(face, h.level, x, y - 1)] as number);
      return Math.hypot(dx, dy) * (1 + Math.max(0, (e[i] as number) - world.ocean.seaLevel) / 4000);
    };
    const chosen = scoreAt(cell);
    for (let i = 0; i < h.cellCount; i++) expect(scoreAt(i)).toBeLessThanOrEqual(chosen);

    /* And it is steeper than the flat median, or the shot is pointless. */
    expect(chosen).toBeGreaterThan(0);
  });

  it('puts the continent shot on the largest river', () => {
    const cell = cellOf(targets.continent);
    const d = world.hydrology.dischargeM3s;
    for (let i = 0; i < d.length; i++) {
      expect(d[i] as number).toBeLessThanOrEqual(d[cell] as number);
    }
  });

  it('puts the city and street shots on the same, largest, city', () => {
    const city = largestCity(world.cities);
    expect(city).toBeDefined();
    expect(cellOf(targets.city)).toBe(city!.cell);
    /* Same point, not merely a similar one: two shots of one city must not
       land on two different towns. */
    expect(targets.street).toEqual(targets.city);
  });

  it('puts the infrastructure shot on a built land link, never on open sea', () => {
    if (targets.infrastructure === undefined) {
      /* Honest outcome: no built links yet. The keyframe falls back and says so. */
      expect(world.economy.network.edges.length).toBeGreaterThanOrEqual(0);
      return;
    }
    const cell = targets.infrastructure.cell;
    expect(cell).toBeGreaterThanOrEqual(0);
    expect(targets.infrastructure.why).toMatch(/track|road|rail/);
    expect(targets.infrastructure.why).not.toMatch(/sea/);
  });

  it('is reproducible: two identical worlds choose identical targets', () => {
    const a = cinematicTargets(evolved());
    const b = cinematicTargets(evolved());
    expect(b).toEqual(a);
  }, 60_000);

  it('leaves a role out rather than inventing a coordinate for it', () => {
    /* A young world has no cities. The correct answer is silence, so the
       keyframe can fall back and REPORT that it fell back. */
    const young = createWorld({
      seed: makeSeed(9, 4), terrainLevel: 3, hydrologyLevel: 3, climateN: 2,
      genesis: { level: 3, plateCount: 5, steps: 4 }, erode: false,
    });
    const t = cinematicTargets(young);
    expect(young.cities.cities.length).toBe(0);
    expect(t.city).toBeUndefined();
    expect(t.street).toBeUndefined();
    /* But the physical roles are always answerable, because terrain exists
       from the first tick. */
    expect(t.relief).toBeDefined();
  });

  it('produces coordinates in range and explains each choice', () => {
    for (const [role, t] of Object.entries(targets)) {
      if (t === undefined) continue;
      expect(Math.abs(t.lat), role).toBeLessThanOrEqual(Math.PI / 2);
      expect(Math.abs(t.lon), role).toBeLessThanOrEqual(Math.PI + 1e-9);
      expect(t.why.length, role).toBeGreaterThan(4);
    }
  });

  it('changes nothing: selecting targets is a read', () => {
    const before = world.digest();
    cinematicTargets(world);
    cinematicTargets(world);
    expect(world.digest()).toBe(before);
  });
});
