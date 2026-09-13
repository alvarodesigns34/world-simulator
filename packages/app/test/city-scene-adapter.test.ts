/**
 * The world -> 3D city bridge (M13, T-0101).
 *
 * These tests exist because M9 and M13 both asserted a city you can fly into
 * and neither had one: the geometry path stopped at a 2D inspector canvas. The
 * assertions below are about the PATH — a real world, the production layout
 * generator, the real transport network — not about how it looks. What it looks
 * like is Astra's gate; whether it reaches the GPU at all is this one.
 */

import { describe, expect, it } from 'vitest';
import { makeSeed } from '@ws/core';
import { EARTH_GEOMETRY } from '@ws/data';
import { CITY_INSTANCE_FLOATS, CITY_INSTANCE_OFFSET, CITY_KIND } from '@ws/render';
import {
  TimelineNavigator,
  absoluteSeconds,
  createWorld,
  duration,
  largestCity,
  MODE,
} from '@ws/sim';
import { CitySceneAdapter, surfaceFrameAt } from '../src/city-scene-adapter.js';

/** A world small enough to build quickly but large enough to grow cities. */
function urbanWorld() {
  const world = createWorld({
    seed: makeSeed(3, 7), terrainLevel: 5, hydrologyLevel: 5, climateN: 4,
    genesis: { level: 5, plateCount: 9, steps: 20 }, erode: false,
  });
  /* M9 promotes a settlement to a city only past a population threshold, so an
     unadvanced world has none and a test written against one asserts nothing.
     Same run-up the M9 suite uses, so this is the world those tests describe. */
  world.apply({ kind: 'setTimeScale', scale: 1e8 });
  for (let i = 0; i < 4; i++) world.scheduler.advance(duration(100_000 * world.calendar.secondsPerYear));
  return world;
}

const R = EARTH_GEOMETRY.radius;

describe('T-0101 city scene adapter', () => {
  const world = urbanWorld();

  it('grows cities in the default-shaped world, so the rest of this means something', () => {
    expect(world.cities.cities.length).toBeGreaterThan(0);
    expect(largestCity(world.cities)?.population).toBeGreaterThan(0);
  });

  it('produces drawable instances from orbit', () => {
    const adapter = new CitySceneAdapter({ radiusM: R });
    /* 2000 km up: every city is far beyond 40x its own radius. */
    const built = adapter.build(world, { x: 0, y: 0, z: R + 2_000_000 });
    expect(built.stats.instances).toBeGreaterThan(0);
    expect(built.stats.aggregates).toBeGreaterThan(0);
    /* No layout should have been generated: from orbit a city is one block. */
    expect(built.detailedCities).toBe(0);
    expect(built.stats.buildings).toBe(0);
  });

  it('fills in streets and buildings on approach, without a second canvas', () => {
    const city = largestCity(world.cities);
    expect(city).toBeDefined();
    const frame = surfaceFrameAt(city!.cell, world.hydrology.level, R);
    const adapter = new CitySceneAdapter({ radiusM: R });

    const ladder = [40, 8, 2, 0.5].map((k) => {
      const d = Math.max(2000, city!.radiusM * k * 1.05);
      const cam = {
        x: frame.ox + frame.ux * d,
        y: frame.oy + frame.uy * d,
        z: frame.oz + frame.uz * d,
      };
      return adapter.build(world, cam).stats;
    });

    /* Orbit -> arterial -> street -> building. Each rung adds detail; none of
       them switches representation. */
    expect(ladder[0]!.aggregates).toBeGreaterThan(0);
    expect(ladder[2]!.streets).toBeGreaterThan(ladder[1]!.streets);
    expect(ladder[3]!.buildings).toBeGreaterThan(0);
    expect(ladder[2]!.buildings).toBe(0);
  });

  it('keeps city geometry camera-relative, so f32 never sees a planet radius', () => {
    const city = largestCity(world.cities)!;
    const frame = surfaceFrameAt(city.cell, world.hydrology.level, R);
    const d = Math.max(1500, city.radiusM);
    /* One city, the one under the camera. Other cities and the trade network
       are legitimately thousands of kilometres away, and their camera-relative
       coordinates are correctly large — this test is about the near scene,
       where an absolute coordinate would destroy the geometry. */
    const adapter = new CitySceneAdapter({ radiusM: R, maxCities: 1 });
    const built = adapter.build(world, {
      x: frame.ox + frame.ux * d, y: frame.oy + frame.uy * d, z: frame.oz + frame.uz * d,
    });
    expect(built.stats.buildings + built.stats.streets).toBeGreaterThan(0);

    const local = new Set<number>([
      /* BRIDGE is deliberately excluded: physical-network bridge spans can be
         continents away, whereas these three kinds belong only to this city. */
      CITY_KIND.BUILDING, CITY_KIND.STREET, CITY_KIND.ARTERIAL,
    ]);
    let worst = 0;
    let checked = 0;
    for (let i = 0; i < built.scene.count; i++) {
      const o = i * CITY_INSTANCE_FLOATS + CITY_INSTANCE_OFFSET.centre;
      if (!local.has(built.scene.data[o + 3] as number)) continue;
      checked++;
      for (let k = 0; k < 3; k++) {
        const v = Math.abs(built.scene.data[o + k] as number);
        expect(Number.isFinite(v)).toBe(true);
        if (v > worst) worst = v;
      }
    }
    expect(checked).toBeGreaterThan(0);
    /* An f32 ulp at 6.37e6 m is 0.5 m — larger than a building (DEC-005). A
       planet-centred coordinate would land near 6.4e6 here; camera-relative
       city geometry stays within a few city radii of zero. The bound is
       expressed in the city's own radius so it stays a precision assertion
       rather than an accidental assertion about how big cities grow. */
    expect(worst).toBeLessThan(6 * Math.max(2000, city.radiusM));
    expect(worst).toBeLessThan(R / 8);
  });

  it('shifts with the camera rather than carrying an absolute position', () => {
    const city = largestCity(world.cities)!;
    const frame = surfaceFrameAt(city.cell, world.hydrology.level, R);
    const d = Math.max(1500, city.radiusM);
    const base = {
      x: frame.ox + frame.ux * d, y: frame.oy + frame.uy * d, z: frame.oz + frame.uz * d,
    };
    /* Sideways, so the distance to the city — and therefore the LOD tier and
       the instance list — is unchanged to well within a tier boundary. */
    const step = 512;
    const moved = { x: base.x + frame.ex * step, y: base.y + frame.ey * step, z: base.z + frame.ez * step };
    const opts = { radiusM: R, maxCities: 1 };
    const a = new CitySceneAdapter(opts).build(world, base);
    const b = new CitySceneAdapter(opts).build(world, moved);
    expect(b.scene.count).toBe(a.scene.count);

    let sampled = 0;
    for (let i = 0; i < a.scene.count; i++) {
      const o = i * CITY_INSTANCE_FLOATS + CITY_INSTANCE_OFFSET.centre;
      if ((a.scene.data[o + 3] as number) !== CITY_KIND.BUILDING) continue;
      const dx = (b.scene.data[o] as number) - (a.scene.data[o] as number);
      const dy = (b.scene.data[o + 1] as number) - (a.scene.data[o + 1] as number);
      const dz = (b.scene.data[o + 2] as number) - (a.scene.data[o + 2] as number);
      const shift = Math.sqrt(dx * dx + dy * dy + dz * dz);
      expect(Math.abs(shift - step)).toBeLessThan(1);
      sampled++;
      if (sampled > 200) break;
    }
    expect(sampled).toBeGreaterThan(0);
  });

  it('is deterministic: the same world and camera give the same bytes', () => {
    const cam = { x: 0, y: 0, z: R + 900_000 };
    const a = new CitySceneAdapter({ radiusM: R }).build(world, cam);
    const b = new CitySceneAdapter({ radiusM: R }).build(world, cam);
    expect(b.scene.count).toBe(a.scene.count);
    const n = a.scene.count * CITY_INSTANCE_FLOATS;
    expect(Array.from(b.scene.data.subarray(0, n)))
      .toEqual(Array.from(a.scene.data.subarray(0, n)));
  });

  it('reuses its caches instead of regenerating layouts every frame', () => {
    const city = largestCity(world.cities)!;
    const frame = surfaceFrameAt(city.cell, world.hydrology.level, R);
    const d = Math.max(1200, city.radiusM * 0.6);
    const cam = {
      x: frame.ox + frame.ux * d, y: frame.oy + frame.uy * d, z: frame.oz + frame.uz * d,
    };
    const adapter = new CitySceneAdapter({ radiusM: R });
    adapter.build(world, cam);
    const before = world.cities.generatedTotal;
    for (let i = 0; i < 8; i++) adapter.build(world, cam);
    expect(world.cities.generatedTotal).toBe(before);
  });

  it('draws no box along a sea lane, because a sea lane is not built', () => {
    const adapter = new CitySceneAdapter({ radiusM: R });
    const built = adapter.build(world, { x: 0, y: 0, z: R + 400_000 });
    for (let i = 0; i < built.scene.count; i++) {
      const kind = built.scene.data[i * CITY_INSTANCE_FLOATS + CITY_INSTANCE_OFFSET.centre + 3];
      /* Only kinds the renderer knows; nothing invented for water. */
      expect(Object.values(CITY_KIND) as number[]).toContain(kind);
    }
  });

  it('keeps land-link quality aligned when water links are omitted from the scene', () => {
    const mixed = urbanWorld();
    const net = mixed.economy.network;
    const land = net.edges.find((edge) => edge.mode !== MODE.SEA
      && edge.mode !== MODE.RIVER && edge.route.cells.length > 1);
    expect(land).toBeDefined();

    /* A sea edge precedes the land edge in the authoritative graph. The renderer
       intentionally omits that sea corridor, but must not shift quality indices
       and use the sea edge's zero build-out for the road/rail that follows. */
    const renderedLand = {
      ...land!,
      quality: 1,
      route: {
        ...land!.route,
        bridgeCells: Int32Array.of(land!.route.cells[1]!),
      },
    };
    const water = {
      ...renderedLand,
      mode: MODE.SEA,
      quality: 0,
      route: { ...renderedLand.route, bridgeCells: new Int32Array(0), portA: -1, portB: -1 },
    };
    net.edges = [water, renderedLand];
    net.topologyGeneration++;

    const mixedAdapter = new CitySceneAdapter({ radiusM: R, maxCities: 0 });
    const built = mixedAdapter.build(mixed, { x: 0, y: 0, z: R + 400_000 });
    const kind = renderedLand.mode === MODE.RAIL ? CITY_KIND.RAIL : CITY_KIND.ROAD;
    const baseHalfWidth = kind === CITY_KIND.RAIL ? 3.5 : 8;
    let checked = 0;
    for (let i = 0; i < built.scene.count; i++) {
      const o = i * CITY_INSTANCE_FLOATS;
      if (built.scene.data[o + CITY_INSTANCE_OFFSET.centre + 3] !== kind) continue;
      expect(built.scene.data[o + CITY_INSTANCE_OFFSET.axisY + 3]).toBeCloseTo(baseHalfWidth, 5);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(built.stats.bridges).toBeGreaterThan(0);

    /* Investment may upgrade a road to rail without rebuilding topology: the
       cached geometry remains valid, but its presentation kind must refresh. */
    renderedLand.mode = kind === CITY_KIND.RAIL ? MODE.ROAD : MODE.RAIL;
    const upgraded = mixedAdapter.build(mixed, { x: 0, y: 0, z: R + 400_000 });
    const upgradedKind = renderedLand.mode === MODE.RAIL ? CITY_KIND.RAIL : CITY_KIND.ROAD;
    expect(Array.from({ length: upgraded.scene.count }, (_, i) =>
      upgraded.scene.data[i * CITY_INSTANCE_FLOATS + CITY_INSTANCE_OFFSET.centre + 3]))
      .toContain(upgradedKind);
  });

  it('rebuilds derived city geometry after a timeline rewind and live restore', () => {
    const historical = urbanWorld();
    const nav = new TimelineNavigator(historical, { maxCheckpoints: 8 });
    nav.record();
    const pastAt = absoluteSeconds(historical.scheduler.time, historical.calendar.secondsPerYear);
    const city = largestCity(historical.cities)!;
    const frame = surfaceFrameAt(city.cell, historical.hydrology.level, R);
    const distance = Math.max(1500, city.radiusM * 0.8);
    const cam = {
      x: frame.ox + frame.ux * distance,
      y: frame.oy + frame.uy * distance,
      z: frame.oz + frame.uz * distance,
    };
    const adapter = new CitySceneAdapter({ radiusM: R, maxCities: 1 });
    const past = adapter.build(historical, cam);
    const pastBytes = Array.from(past.scene.data.subarray(0, past.scene.count * CITY_INSTANCE_FLOATS));

    historical.advance(100_000 * historical.calendar.secondsPerYear);
    nav.record();
    const live = adapter.build(historical, cam);
    const liveBytes = Array.from(live.scene.data.subarray(0, live.scene.count * CITY_INSTANCE_FLOATS));

    nav.scrubTo(pastAt);
    const rewound = adapter.build(historical, cam);
    expect(Array.from(rewound.scene.data.subarray(0, rewound.scene.count * CITY_INSTANCE_FLOATS)))
      .toEqual(pastBytes);

    nav.returnToLive();
    const restored = adapter.build(historical, cam);
    expect(Array.from(restored.scene.data.subarray(0, restored.scene.count * CITY_INSTANCE_FLOATS)))
      .toEqual(liveBytes);
  }, 120_000);

  it('survives a world with no cities at all', () => {
    const empty = createWorld({
      seed: makeSeed(1, 2), terrainLevel: 3, hydrologyLevel: 3, climateN: 2,
      genesis: { level: 3, plateCount: 5, steps: 4 }, erode: false,
    });
    const built = new CitySceneAdapter({ radiusM: R })
      .build(empty, { x: 0, y: 0, z: R + 1e6 });
    expect(built.stats.buildings).toBe(0);
    expect(Number.isFinite(built.buildMs)).toBe(true);
  });
});
