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

import { couplingScratch, mapCubeToCube, mapGeoToCube } from '../coupling.js';

const RADIUS_M = 6_371_000;

/**
 * Full spreading rate at a mid-ocean ridge, metres per Myr.
 * Earth's global mean is ~50 mm/yr (half-rate ~25 mm/yr on each flank).
 */
const FULL_SPREADING_M_PER_MYR = 5.0e4;

/**
 * Convergence rate at a subducting margin, metres per Myr.
 * Earth's global mean is ~60 mm/yr, faster than spreading because the total
 * subducting margin (~45,000 km) is shorter than the ridge system (~60,000 km).
 */
const CONVERGENCE_M_PER_MYR = 6.0e4;

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
  /** Total spreading-ridge length on the last step, metres. */
  ridgeLengthM: number;
  /** Total subducting-margin length on the last step, metres. */
  trenchLengthM: number;
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
    ridgeLengthM: 0,
    trenchLengthM: 0,
    crustMassRelativeError: 0,
    generation: 0,
  };
}

/** Advance persistent plates and coupled surface processes by geological time. */
/**
 * Climate and hydrology forcing for erosion, WITH the grid each lives on.
 *
 * The grid is not optional metadata. Precipitation is on the geodesic climate
 * grid and runoff on a cube-sphere hydrology level; geology is on the coarser
 * genesis cube level. Passing bare arrays and indexing them proportionally
 * (T-0080) silently erodes the wrong continent.
 */
export interface ErosionForcing {
  /** Annual-mean precipitation on the geodesic grid, refinement level `geodesicN`. */
  readonly precipitationAnnual?: ArrayLike<number>;
  readonly geodesicN?: number;
  /** Runoff on a cube-sphere grid at `runoffLevel` (>= the geology level). */
  readonly runoffMps?: ArrayLike<number>;
  readonly runoffLevel?: number;
}

export function stepDynamicGeology(
  s: DynamicGeologyState,
  dtMyr: number,
  forcing: ErosionForcing = {},
): void {
  if (!(dtMyr > 0) || !Number.isFinite(dtMyr)) return;
  /* One Euler angle unit represents the genesis kernel's 2 Myr step. */
  rotatePlates(s.plates, dtMyr / 2);
  const g = s.coarse;
  assignVoronoi(s.units, s.plates, g.plateId);
  classifyBoundary(g.level, g.plateId, s.plates, s.units, g.boundaryType);
  diagnose(g.plateId, s.plates, g.boundaryType, g.crustAgeMyr, g.crustThicknessKm,
    g.upliftM, g.crustType, g.elevationM, dtMyr);

  /* Resample the forcing onto the geology grid ONCE, coordinate-aware, so a
     cell's rainfall is its own rainfall (T-0080). */
  let rainOnGeology: Float64Array | null = null;
  if (forcing.precipitationAnnual !== undefined && forcing.geodesicN !== undefined) {
    rainOnGeology = couplingScratch(g.cellCount);
    mapGeoToCube(forcing.precipitationAnnual, forcing.geodesicN, g.level, rainOnGeology);
  }
  let runoffOnGeology: Float64Array | null = null;
  if (forcing.runoffMps !== undefined && forcing.runoffLevel !== undefined) {
    runoffOnGeology = new Float64Array(g.cellCount);
    mapCubeToCube(forcing.runoffMps, forcing.runoffLevel, g.level, runoffOnGeology);
  }

  /* Boundary LENGTH, not boundary-band area, is what sets crust flux: a ridge
     produces (length x spreading rate) of new floor per unit time. A cell that
     carries a boundary contributes roughly one cell-width of that length, and
     cell width is sqrt(cell area), so the estimate converges as the grid is
     refined instead of scaling with resolution the way a raw area sum would. */
  let ridgeCells = 0;
  let trenchCells = 0;
  let subductingLengthM = 0;
  let riftingLengthM = 0;
  const areaM2 = cellAreasM2(g.level);
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
        /* Oceanic lithosphere at a convergent boundary is what actually
           subducts. Continental crust there thickens instead (above), so it
           must not count toward consumption. */
        trenchCells++;
        subductingLengthM += Math.sqrt(areaM2[i] as number);
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
        /* New oceanic floor is created at a spreading ridge. */
        riftingLengthM += Math.sqrt(areaM2[i] as number);
        g.crustAgeMyr[i] = 0;
        g.elevationM[i] = Math.max(-2700, g.elevationM[i] as number);
      }
    } else if (b === BND_TRANSFORM) {
      stress += 0.011 * dtMyr;
    } else {
      stress *= 0.997;
    }

    /* Climate/runoff-coupled erosion and a reduced Airy response. Both forcings
       were resampled onto THIS grid above, so index i is this cell's own. */
    const rain = rainOnGeology !== null ? Math.max(0, rainOnGeology[i] as number) : 1e-5;
    const runoff = runoffOnGeology !== null ? Math.max(0, runoffOnGeology[i] as number) : 0;
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

  /* CRUST ACCOUNTING (T-0081).
   *
   * Creation and consumption are now derived INDEPENDENTLY, each from its own
   * kinematics and with a real rate attached:
   *
   *   created  = ridge length   x full spreading rate x dt
   *   consumed = trench length  x convergence rate    x dt
   *
   * The previous model wrote `consumed = created` whenever any trench existed,
   * which made the residual identically zero by construction. That is not a
   * diagnostic, it is an assertion wearing a diagnostic's clothes: a plate
   * configuration with runaway spreading and almost no subduction capacity
   * would still have reported perfect balance.
   *
   * The residual now measures whether this reduced model's plate kinematics
   * actually close. It is NOT expected to be zero, and it should not be
   * asserted to zero. Earth's own budget does not close to better than ~10%
   * from these two mean rates, so a residual of that order is the model
   * behaving; a residual near 1 (one side an order of magnitude off, or one
   * side absent entirely) is the model telling us the plate configuration has
   * degenerated. That distinction is the only thing the number is good for,
   * and it is exactly the thing the old version destroyed.
   */
  const created = riftingLengthM * FULL_SPREADING_M_PER_MYR * dtMyr;
  const consumed = subductingLengthM * CONVERGENCE_M_PER_MYR * dtMyr;
  s.createdCrustM2 += created;
  s.consumedCrustM2 += consumed;
  s.ridgeLengthM = riftingLengthM;
  s.trenchLengthM = subductingLengthM;
  const total = s.createdCrustM2 + s.consumedCrustM2;
  /* Symmetric relative residual: 0 when balanced, 2 when one side is absent,
     and independent of which side is larger. */
  s.crustMassRelativeError = total > 0
    ? Math.abs(s.createdCrustM2 - s.consumedCrustM2) / (0.5 * total)
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

/**
 * Per-cell area in m^2, cached per level. Tangent-warped cube cells differ in
 * area by ~1.3x between face centre and corner (DEC-007), so a single mean
 * area would mis-weight ridge and trench cells by that factor depending on
 * where the plate boundaries happen to sit.
 */
const CELL_AREAS = new Map<number, Float64Array>();

export function cellAreasM2(level: number): Float64Array {
  const hit = CELL_AREAS.get(level);
  if (hit !== undefined) return hit;
  const n = cubeDim(level);
  const out = new Float64Array(6 * n * n);
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      out[face * n * n + y * n + x] = cubeCellSteradians({ face, x, y }, level) * RADIUS_M * RADIUS_M;
    }
  }
  CELL_AREAS.set(level, out);
  return out;
}
