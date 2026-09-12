/**
 * @tier A
 *
 * M6 biosphere driven by the M4/M5 boundary fields. Biomes are diagnoses;
 * vegetation and trophic pools are slow authoritative state. Migration uses
 * conservative pair transfers over the cube topology and cannot populate
 * ocean/ice cells.
 */

import { DIR, cubeDim, cubeIndex, neighbor } from '@ws/data';
import type { HydrologyState } from '../hydrology/system.js';

const DIRS = [DIR.POS_U, DIR.NEG_U, DIR.POS_V, DIR.NEG_V] as const;

export const BIOME = {
  OCEAN: 0,
  ICE: 1,
  TUNDRA: 2,
  BOREAL: 3,
  TEMPERATE_FOREST: 4,
  GRASSLAND: 5,
  DESERT: 6,
  TROPICAL_FOREST: 7,
  ALPINE: 8,
  WETLAND: 9,
} as const;

export interface BiosphereState {
  readonly level: number;
  readonly cellCount: number;
  readonly biome: Uint8Array;
  readonly nppKgM2Yr: Float64Array;
  readonly vegetationDensity: Float64Array;
  readonly biomassKgM2: Float64Array;
  readonly phenology: Float64Array;
  readonly producers: Float64Array;
  readonly herbivores: Float64Array;
  readonly predators: Float64Array;
  readonly populationDensity: Float64Array;
  readonly migrationDelta: Float64Array;
  steps: number;
  extinctions: number;
}

export function initBiosphere(h: HydrologyState): BiosphereState {
  const N = h.cellCount;
  const s: BiosphereState = {
    level: h.level,
    cellCount: N,
    biome: new Uint8Array(N),
    nppKgM2Yr: new Float64Array(N),
    vegetationDensity: new Float64Array(N),
    biomassKgM2: new Float64Array(N),
    phenology: new Float64Array(N),
    producers: new Float64Array(N),
    herbivores: new Float64Array(N),
    predators: new Float64Array(N),
    populationDensity: new Float64Array(N),
    migrationDelta: new Float64Array(N),
    steps: 0,
    extinctions: 0,
  };
  diagnoseBiomes(s, h);
  for (let i = 0; i < N; i++) {
    if (s.biome[i] === BIOME.OCEAN || s.biome[i] === BIOME.ICE) continue;
    const k = carryingCapacity(s, h, i);
    s.vegetationDensity[i] = Math.min(1, k / 6);
    s.biomassKgM2[i] = k;
    s.producers[i] = k;
    s.herbivores[i] = k * 0.08;
    s.predators[i] = k * 0.008;
    s.populationDensity[i] = s.herbivores[i] as number;
  }
  return s;
}

export function stepBiosphere(s: BiosphereState, h: HydrologyState, dtYears: number, season: number): void {
  diagnoseBiomes(s, h);
  const dt = Math.min(20, Math.max(0, dtYears));
  for (let i = 0; i < s.cellCount; i++) {
    const impossible = s.biome[i] === BIOME.OCEAN || s.biome[i] === BIOME.ICE;
    if (impossible) {
      if ((s.populationDensity[i] as number) > 0) s.extinctions++;
      s.vegetationDensity[i] = 0;
      s.biomassKgM2[i] = 0;
      s.producers[i] = 0;
      s.herbivores[i] = 0;
      s.predators[i] = 0;
      s.populationDensity[i] = 0;
      s.phenology[i] = 0;
      continue;
    }
    const T = h.temperatureK[i] as number;
    const water = Math.min(1, (h.soilMoistureM[i] as number) / 0.25);
    const warmth = clamp01((T - 258) / 35) * clamp01((318 - T) / 25);
    const light = clamp01(0.35 + 0.65 * seasonalLight(season, T));
    const nutrient = clamp01(0.45 + 0.35 * water + 0.2 * (1 - Math.min(1, Math.abs(h.elevationM[i] as number) / 5000)));
    const npp = 2.4 * water * warmth * light * nutrient;
    s.nppKgM2Yr[i] = npp;
    const snow = h.snowpackM[i] as number;
    const drought = water < 0.2 ? (0.2 - water) * 2.5 : 0;
    const targetPhenology = snow > 0.05 || T < 270 ? 0.05 : clamp01(light * water * (1 - drought));
    s.phenology[i] = approach(s.phenology[i] as number, targetPhenology, Math.min(1, dt * 0.7));
    const K = carryingCapacity(s, h, i);
    const biomass = s.biomassKgM2[i] as number;
    const growth = npp * (1 - biomass / Math.max(K, 0.05));
    const stress = drought * biomass * 0.4 + (snow > 0.2 ? biomass * 0.2 : 0);
    s.biomassKgM2[i] = Math.max(0, biomass + dt * (growth - stress));
    s.vegetationDensity[i] = clamp01((s.biomassKgM2[i] as number) / Math.max(K, 0.1));

    /* Damped producer/herbivore/predator chain. Semi-implicit losses and
       bounded dt prevent the classic undamped Lotka-Volterra explosion. */
    let P = s.producers[i] as number;
    let H = s.herbivores[i] as number;
    let R = s.predators[i] as number;
    const food = Math.max(0.01, s.biomassKgM2[i] as number);
    P += dt * (0.35 * (food - P) - 0.08 * H * P / (1 + P));
    H += dt * (0.12 * H * P / (1 + P) - 0.08 * H - 0.035 * R * H / (1 + H));
    R += dt * (0.025 * R * H / (1 + H) - 0.035 * R);
    P = bounded(P, 0, Math.max(0.1, K * 2));
    H = bounded(H, 0, Math.max(0.05, K));
    R = bounded(R, 0, Math.max(0.01, K * 0.25));
    if (H < 1e-8) { if ((s.herbivores[i] as number) >= 1e-8) s.extinctions++; H = 0; }
    if (R < 1e-9) { if ((s.predators[i] as number) >= 1e-9) s.extinctions++; R = 0; }
    s.producers[i] = P;
    s.herbivores[i] = H;
    s.predators[i] = R;
    s.populationDensity[i] = H + R;
  }
  migrate(s, h, Math.min(0.15, dt * 0.02));
  s.steps++;
}

export function diagnoseBiomes(s: BiosphereState, h: HydrologyState): void {
  for (let i = 0; i < s.cellCount; i++) {
    if (h.ocean[i] !== 0) { s.biome[i] = BIOME.OCEAN; continue; }
    const T = h.temperatureK[i] as number;
    const water = h.soilMoistureM[i] as number;
    const elev = h.elevationM[i] as number;
    if ((h.glacierM[i] as number) > 1 || T < 255) s.biome[i] = BIOME.ICE;
    else if (elev > 3200) s.biome[i] = BIOME.ALPINE;
    else if (T < 268) s.biome[i] = BIOME.TUNDRA;
    else if (T < 278) s.biome[i] = water > 0.12 ? BIOME.BOREAL : BIOME.GRASSLAND;
    else if (water < 0.035) s.biome[i] = BIOME.DESERT;
    else if (water > 0.3) s.biome[i] = BIOME.WETLAND;
    else if (T > 294 && water > 0.16) s.biome[i] = BIOME.TROPICAL_FOREST;
    else if (water > 0.12) s.biome[i] = BIOME.TEMPERATE_FOREST;
    else s.biome[i] = BIOME.GRASSLAND;
  }
}

function carryingCapacity(s: BiosphereState, h: HydrologyState, i: number): number {
  if (h.ocean[i] !== 0 || s.biome[i] === BIOME.ICE) return 0;
  const water = clamp01((h.soilMoistureM[i] as number) / 0.25);
  const temp = clamp01(((h.temperatureK[i] as number) - 255) / 40) * clamp01((320 - (h.temperatureK[i] as number)) / 30);
  return Math.max(0.02, 8 * water * temp + (s.nppKgM2Yr[i] as number) * 2);
}

function migrate(s: BiosphereState, h: HydrologyState, fraction: number): void {
  s.migrationDelta.fill(0);
  const n = cubeDim(s.level);
  for (let i = 0; i < s.cellCount; i++) {
    const pop = s.populationDensity[i] as number;
    if (!(pop > 0) || h.ocean[i] !== 0 || s.biome[i] === BIOME.ICE) continue;
    const face = Math.floor(i / (n * n));
    const local = i - face * n * n;
    const y = Math.floor(local / n);
    const x = local - y * n;
    let best = i;
    let bestScore = suitability(s, h, i);
    for (const d of DIRS) {
      const c = neighbor({ face, x, y }, s.level, d);
      const j = cubeIndex(c.face, s.level, c.x, c.y);
      const score = suitability(s, h, j);
      if (score > bestScore || (score === bestScore && j < best)) { best = j; bestScore = score; }
    }
    if (best !== i && bestScore > 0) {
      const moved = pop * fraction;
      s.migrationDelta[i] = (s.migrationDelta[i] as number) - moved;
      s.migrationDelta[best] = (s.migrationDelta[best] as number) + moved;
    }
  }
  for (let i = 0; i < s.cellCount; i++) {
    const next = Math.max(0, (s.populationDensity[i] as number) + (s.migrationDelta[i] as number));
    const ratio = (s.populationDensity[i] as number) > 0 ? next / (s.populationDensity[i] as number) : 1;
    s.herbivores[i] = (s.herbivores[i] as number) * ratio;
    s.predators[i] = (s.predators[i] as number) * ratio;
    s.populationDensity[i] = next;
  }
}

function suitability(s: BiosphereState, h: HydrologyState, i: number): number {
  if (h.ocean[i] !== 0 || s.biome[i] === BIOME.ICE) return -1;
  return (s.nppKgM2Yr[i] as number) + (h.soilMoistureM[i] as number) * 2 - Math.max(0, Math.abs((h.temperatureK[i] as number) - 288) - 18) * 0.03;
}

function seasonalLight(season: number, T: number): number {
  const triangular = 1 - Math.abs((season - Math.floor(season)) * 2 - 1);
  return T > 285 ? 0.75 + 0.25 * triangular : 0.35 + 0.65 * triangular;
}

function approach(a: number, b: number, f: number): number { return a + (b - a) * f; }
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function bounded(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }
