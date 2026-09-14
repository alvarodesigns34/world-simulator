/**
 * Point inspection of the world (T-0162).
 *
 * Answers "what is here?" for a geodetic position: the authoritative values at
 * that place, read and never written. It is the data source for the inspector
 * panel, for feature navigation's own reporting, and for visual QA — when a
 * frame looks wrong, this says whether the renderer is drawing the wrong thing
 * or the world really is like that.
 *
 * Lives in the application because it is the only place a `sim` world and a
 * camera are both in scope (DEC-011).
 */

import {
  cubeDim,
  cubeIndex,
  geodeticToPcf,
  pcf,
  unitToCubeFace,
  type PlanetGeometry,
} from '@ws/data';
import { largestCity, type createWorld } from '@ws/sim';

type World = ReturnType<typeof createWorld>;

export interface ProbeResult {
  readonly lat: number;
  readonly lon: number;
  readonly elevationM: number;
  readonly isOcean: boolean;
  readonly seaLevelM: number;
  readonly depthM: number | null;
  readonly temperatureK: number | null;
  readonly precipitation: number | null;
  readonly vegetation: number | null;
  readonly biome: number | null;
  readonly soilMoistureM: number | null;
  readonly snowpackM: number | null;
  readonly glacierM: number | null;
  readonly riverDischargeM3s: number | null;
  readonly lakeDepthM: number | null;
  readonly pollution: number | null;
  readonly settlementIndex: number | null;
  readonly settlementPopulation: number | null;
  readonly nearestCity: {
    readonly id: number; readonly population: number; readonly distanceKm: number;
  } | null;
}

/** Cube cell index at this direction, on a grid of `level`. */
function cellAt(level: number, x: number, y: number, z: number): number {
  const c = unitToCubeFace(pcf(x, y, z));
  const n = cubeDim(level);
  const ix = Math.max(0, Math.min(n - 1, Math.floor(c.u * n)));
  const iy = Math.max(0, Math.min(n - 1, Math.floor(c.v * n)));
  return cubeIndex(c.face, level, ix, iy);
}

function at(field: ArrayLike<number> | undefined, index: number): number | null {
  if (field === undefined || index < 0 || index >= field.length) return null;
  const v = field[index] as number;
  return Number.isFinite(v) ? v : null;
}

export function probeWorld(
  world: World, lat: number, lon: number, planet: PlanetGeometry,
): ProbeResult {
  const p = geodeticToPcf({ lat, lon, altitude: 0 }, planet);
  const m = Math.hypot(p.x, p.y, p.z) || 1;
  const x = p.x / m;
  const y = p.y / m;
  const z = p.z / m;

  const h = world.hydrology;
  const hCell = cellAt(h.level, x, y, z);
  const gCell = cellAt(world.geology.level, x, y, z);
  const eCell = cellAt(world.economy.level, x, y, z);

  const elevation = (world.geology.elevationM[gCell] as number) ?? 0;
  const seaLevel = world.ocean.seaLevel;
  const isOcean = h.ocean[hCell] !== 0;
  const filled = at(h.filledM, hCell);
  const hElev = at(h.elevationM, hCell);
  const lakeDepth = filled !== null && hElev !== null && filled - hElev > 0.5 ? filled - hElev : null;

  /* Climate lives on the geodesic grid; the nearest cell by dot product is the
     honest lookup and there are only a few thousand of them. */
  let climateCell = -1;
  let best = -Infinity;
  const pos = world.climate.grid?.positions as Float64Array | undefined;
  if (pos !== undefined) {
    for (let i = 0; i < pos.length / 3; i++) {
      const d = x * (pos[i * 3] as number) + y * (pos[i * 3 + 1] as number) + z * (pos[i * 3 + 2] as number);
      if (d > best) { best = d; climateCell = i; }
    }
  }

  const civ = world.civilisation;
  let settlement: number | null = null;
  const claim = civ.claim as Int32Array | undefined;
  if (claim !== undefined) {
    const cCell = cellAt(civ.level, x, y, z);
    const owner = claim[cCell] as number;
    if (owner >= 0 && civ.store.aliveAt(owner)) settlement = owner;
  }

  let nearestCity: ProbeResult['nearestCity'] = null;
  const big = largestCity(world.cities);
  if (big !== undefined) {
    let bestCity = big;
    let bestDot = -Infinity;
    for (const c of world.cities.cities) {
      const cc = cellAt(h.level, x, y, z);
      void cc;
      const dir = cellDirection(c.cell, h.level);
      const d = x * dir[0] + y * dir[1] + z * dir[2];
      if (d > bestDot) { bestDot = d; bestCity = c; }
    }
    nearestCity = {
      id: bestCity.id,
      population: bestCity.population,
      distanceKm: (planet.radius * Math.acos(Math.max(-1, Math.min(1, bestDot)))) / 1000,
    };
  }

  return {
    lat, lon,
    elevationM: elevation,
    isOcean,
    seaLevelM: seaLevel,
    depthM: isOcean ? Math.max(0, seaLevel - elevation) : null,
    temperatureK: climateCell >= 0 ? at(world.climate.T, climateCell) : null,
    precipitation: climateCell >= 0 ? at(world.climate.precip, climateCell) : null,
    vegetation: at(world.biosphere.vegetationDensity, hCell),
    biome: at(world.biosphere.biome, hCell),
    soilMoistureM: at(h.soilMoistureM, hCell),
    snowpackM: at(h.snowpackM, hCell),
    glacierM: at(h.glacierM, hCell),
    riverDischargeM3s: at(h.dischargeM3s, hCell),
    lakeDepthM: lakeDepth,
    pollution: at(world.economy.pollution, eCell),
    settlementIndex: settlement,
    settlementPopulation: null,
    nearestCity,
  };
}

/** Unit direction of a cube cell centre. */
function cellDirection(cell: number, level: number): readonly [number, number, number] {
  const n = cubeDim(level);
  const face = Math.floor(cell / (n * n));
  const local = cell - face * n * n;
  const iy = Math.floor(local / n);
  const ix = local - iy * n;
  const u = (ix + 0.5) / n;
  const v = (iy + 0.5) / n;
  /* Inline the raw face-to-unit map to avoid importing a warped variant. */
  const a = Math.tan((u - 0.5) * (Math.PI / 2));
  const b = Math.tan((v - 0.5) * (Math.PI / 2));
  const dirs: readonly (readonly [number, number, number])[] = [
    [1, a, b], [-1, -a, b], [a, 1, b], [-a, -1, b], [a, b, 1], [-a, b, -1],
  ];
  const d = dirs[face] ?? [1, 0, 0];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / len, d[1] / len, d[2] / len];
}
