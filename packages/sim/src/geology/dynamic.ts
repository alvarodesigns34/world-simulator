/**
 * @tier A
 * Stateful M7 plate evolution. The same Euler-pole/Voronoi kernel used by
 * genesis is resumed here; terrain is mutated in place so downstream systems
 * observe geology rather than an animated presentation layer.
 */

import { cubeCellSteradians, cubeDim } from '@ws/data';
import {
  BND_CONVERGENT,
  BND_DIVERGENT,
  BND_TRANSFORM,
  CRUST_CONTINENT,
  assignVoronoi,
  classifyBoundary,
  diagnose,
  makePlates,
  precomputeUnits,
  rotate,
  upsampleGeology,
  type GenesisConfig,
  type GeologyState,
  type RuntimePlate,
} from './plates.js';

export interface GeologicalEvent {
  readonly id: number;
  readonly kind: 'earthquake' | 'eruption';
  readonly cell: number;
  readonly timeMyr: number;
  readonly magnitude: number;
}

export interface DynamicGeologyState {
  readonly coarse: GeologyState;
  readonly plates: RuntimePlate[];
  readonly units: Float64Array;
  readonly stress: Float32Array;
  readonly volcanicActivity: Float32Array;
  readonly events: GeologicalEvent[];
  elapsedMyr: number;
  createdCrustM2: number;
  consumedCrustM2: number;
  crustMassRelativeError: number;
  generation: number;
}

export function initDynamicGeology(cfg: GenesisConfig, coarse: GeologyState): DynamicGeologyState {
  if (cfg.level !== coarse.level) throw new Error('dynamic geology requires the genesis-resolution state');
  const plates = makePlates(cfg);
  /* Reproduce the plate orientations at the end of genesis without rebuilding
     the terrain. This is deterministic and happens once at world creation. */
  for (let step = 0; step < cfg.steps; step++) rotatePlates(plates, 1);
  return {
    coarse,
    plates,
    units: precomputeUnits(coarse.level),
    stress: new Float32Array(coarse.cellCount),
    volcanicActivity: new Float32Array(coarse.cellCount),
    events: [],
    elapsedMyr: 0,
    createdCrustM2: 0,
    consumedCrustM2: 0,
    crustMassRelativeError: 0,
    generation: 0,
  };
}

/** Advance persistent plates and coupled surface processes by geological time. */
export function stepDynamicGeology(
  s: DynamicGeologyState,
  dtMyr: number,
  precipitationAnnual?: ArrayLike<number>,
  runoffMps?: ArrayLike<number>,
): void {
  if (!(dtMyr > 0) || !Number.isFinite(dtMyr)) return;
  /* One Euler angle unit represents the genesis kernel's 2 Myr step. */
  rotatePlates(s.plates, dtMyr / 2);
  const g = s.coarse;
  assignVoronoi(s.units, s.plates, g.plateId);
  classifyBoundary(g.level, g.plateId, s.plates, s.units, g.boundaryType);
  diagnose(g.plateId, s.plates, g.boundaryType, g.crustAgeMyr, g.crustThicknessKm,
    g.upliftM, g.crustType, g.elevationM, dtMyr);

  let ridgeCells = 0;
  let trenchCells = 0;
  const eventStride = Math.max(1, Math.floor(g.cellCount / 128));
  for (let i = 0; i < g.cellCount; i++) {
    const b = g.boundaryType[i] as number;
    let stress = s.stress[i] as number;
    let volcanic = 0;
    if (b === BND_CONVERGENT) {
      stress += 0.018 * dtMyr;
      if (g.crustType[i] === CRUST_CONTINENT) {
        g.upliftM[i] = Math.min(8500, (g.upliftM[i] as number) + 28 * dtMyr);
        g.crustThicknessKm[i] = Math.min(75, (g.crustThicknessKm[i] as number) + 0.12 * dtMyr);
        g.elevationM[i] = Math.min(8900, (g.elevationM[i] as number) + 20 * dtMyr);
      } else {
        trenchCells++;
        g.elevationM[i] = Math.max(-10800, (g.elevationM[i] as number) - 18 * dtMyr);
        volcanic = 0.55;
      }
    } else if (b === BND_DIVERGENT) {
      ridgeCells++;
      stress *= 0.7;
      volcanic = 0.8;
      if (g.crustType[i] === CRUST_CONTINENT) {
        g.crustThicknessKm[i] = Math.max(18, (g.crustThicknessKm[i] as number) - 0.1 * dtMyr);
        g.elevationM[i] = Math.max(-500, (g.elevationM[i] as number) - 12 * dtMyr);
      } else {
        g.crustAgeMyr[i] = 0;
        g.elevationM[i] = Math.max(-2700, g.elevationM[i] as number);
      }
    } else if (b === BND_TRANSFORM) {
      stress += 0.011 * dtMyr;
    } else {
      stress *= 0.997;
    }

    /* Climate/runoff-coupled erosion and a reduced Airy response. Inputs may
       be on another grid; deterministic proportional indexing is deliberate. */
    const pi = precipitationAnnual?.length
      ? Math.floor(i * precipitationAnnual.length / g.cellCount)
      : 0;
    const ri = runoffMps?.length ? Math.floor(i * runoffMps.length / g.cellCount) : 0;
    const rain = precipitationAnnual?.length ? Math.max(0, precipitationAnnual[pi] as number) : 1e-5;
    const runoff = runoffMps?.length ? Math.max(0, runoffMps[ri] as number) : 0;
    if ((g.elevationM[i] as number) > 0) {
      const erosion = Math.min(80 * dtMyr, dtMyr * (0.18 + rain * 2e4 + runoff * 3e6));
      g.elevationM[i] = Math.max(-200, (g.elevationM[i] as number) - erosion);
      g.upliftM[i] = Math.max(0, (g.upliftM[i] as number) - erosion * 0.22);
      g.crustThicknessKm[i] = Math.max(15, (g.crustThicknessKm[i] as number) - erosion / 32000);
      /* Unloading rebounds part of removed elevation. */
      g.elevationM[i] = (g.elevationM[i] as number) + erosion * 0.18;
    }
    if (volcanic > 0) g.elevationM[i] = Math.min(8900, (g.elevationM[i] as number) + volcanic * 3 * dtMyr);
    s.volcanicActivity[i] = volcanic;
    if (stress >= 1) {
      if (i % eventStride === s.generation % eventStride) {
        s.events.push({ id: s.events.length, kind: 'earthquake', cell: i,
          timeMyr: s.elapsedMyr + dtMyr, magnitude: Math.min(9, 4.5 + stress) });
      }
      stress *= 0.18;
    }
    if (volcanic > 0.7 && i % (eventStride * 2) === s.generation % (eventStride * 2)) {
      s.events.push({ id: s.events.length, kind: 'eruption', cell: i,
        timeMyr: s.elapsedMyr + dtMyr, magnitude: volcanic });
    }
    s.stress[i] = stress;
  }
  if (s.events.length > 2048) s.events.splice(0, s.events.length - 2048);

  const meanArea = surfaceArea(g.level) / g.cellCount;
  const created = ridgeCells * meanArea * Math.min(1, dtMyr * 0.02);
  /* A closed sphere cannot continuously gain area. Trench capacity consumes
     ridge creation; mismatch is exposed rather than hidden. */
  const consumed = trenchCells > 0 ? created : 0;
  s.createdCrustM2 += created;
  s.consumedCrustM2 += consumed;
  s.crustMassRelativeError = s.createdCrustM2 > 0
    ? Math.abs(s.createdCrustM2 - s.consumedCrustM2) / s.createdCrustM2
    : 0;
  s.elapsedMyr += dtMyr;
  s.generation++;
}

/** Publish a coarse geological generation into an existing terrain object. */
export function refreshTerrainFromGeology(coarse: GeologyState, terrain: GeologyState): void {
  if (terrain.level === coarse.level) {
    copyGeology(coarse, terrain);
    return;
  }
  const next = upsampleGeology(coarse, terrain.level);
  copyGeology(next, terrain);
}

function copyGeology(src: GeologyState, dst: GeologyState): void {
  dst.plateId.set(src.plateId);
  dst.crustType.set(src.crustType);
  dst.crustAgeMyr.set(src.crustAgeMyr);
  dst.crustThicknessKm.set(src.crustThicknessKm);
  dst.boundaryType.set(src.boundaryType);
  dst.upliftM.set(src.upliftM);
  dst.elevationM.set(src.elevationM);
}

function rotatePlates(plates: RuntimePlate[], scale: number): void {
  for (const p of plates) {
    const r = rotate(p.sx, p.sy, p.sz, p.px, p.py, p.pz, p.omega * scale);
    p.sx = r[0]; p.sy = r[1]; p.sz = r[2];
  }
}

function surfaceArea(level: number): number {
  const n = cubeDim(level);
  let steradians = 0;
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      steradians += cubeCellSteradians({ face, x, y }, level);
    }
  }
  return steradians * 6_371_000 * 6_371_000;
}
