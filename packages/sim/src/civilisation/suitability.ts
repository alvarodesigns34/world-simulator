/**
 * @tier A
 *
 * M8 habitability: geography -> where people can live.
 *
 * This is the single place where the founding principle gets its teeth for
 * civilisation. Settlements are not scattered by a noise function and then
 * decorated with plausible reasons; every term below reads authoritative M2-M7
 * state, so moving a mountain range, shifting a monsoon or draining a river
 * changes where people are. That causal direction is the whole point of M8, and
 * it is testable: perturb the geography, re-evaluate, see the map move.
 *
 * Suitability is a DIAGNOSIS, not stored state (DEC-030): it is a pure function
 * of the fields it reads, recomputed when they change, never integrated.
 */

import { pow } from '@ws/core';
import { DIR, cubeDim, cubeIndex, neighbor } from '@ws/data';
import { BIOME, type BiosphereState } from '../biosphere/system.js';
import { isWaterCell, type HydrologyState } from '../hydrology/system.js';

const DIRS = [DIR.POS_U, DIR.NEG_U, DIR.POS_V, DIR.NEG_V] as const;

export interface HabitabilityState {
  readonly level: number;
  readonly cellCount: number;
  /** 0..1 composite. 0 means uninhabitable, not merely poor. */
  readonly suitability: Float32Array;
  /** Sustainable food yield, people per m^2 at technology 0. */
  readonly baseFoodDensity: Float32Array;
  /** 1 if the cell touches ocean, 2 if it also has a navigable river mouth. */
  readonly coastal: Uint8Array;
  /** 1 if discharge supports a settlement, 2 if it is a major river. */
  readonly riverine: Uint8Array;
  /** Terrain roughness proxy, metres of relief to the steepest neighbour. */
  readonly reliefM: Float32Array;
  /**
   * Cells with suitability > 0, updated by every refresh.
   *
   * The founding site index is an O(cells log cells) sort, so it cannot be
   * rebuilt every tick. This count is the cheap change detector that decides
   * when it must be: it is computed in the same pass that produces the
   * suitability, so it costs nothing extra.
   */
  suitableCount: number;
}

export function initHabitability(h: HydrologyState): HabitabilityState {
  const N = h.cellCount;
  return {
    level: h.level,
    cellCount: N,
    suitability: new Float32Array(N),
    baseFoodDensity: new Float32Array(N),
    coastal: new Uint8Array(N),
    riverine: new Uint8Array(N),
    reliefM: new Float32Array(N),
    suitableCount: 0,
  };
}

/**
 * Recompute habitability from current M5/M6 state.
 *
 * O(cells). Called when geology or the hydrological routing changes, not every
 * tick: the inputs are slow state (DEC-030).
 */
export function refreshHabitability(
  s: HabitabilityState,
  h: HydrologyState,
  b: BiosphereState,
): void {
  const n = cubeDim(s.level);
  let suitable = 0;
  for (let i = 0; i < s.cellCount; i++) {
    if (isWaterCell(h, i)) {
      s.suitability[i] = 0;
      s.baseFoodDensity[i] = 0;
      s.coastal[i] = 0;
      s.riverine[i] = 0;
      s.reliefM[i] = 0;
      continue;
    }

    const face = Math.floor(i / (n * n));
    const local = i - face * n * n;
    const y = Math.floor(local / n);
    const x = local - y * n;
    const elev = h.elevationM[i] as number;

    let touchesOcean = 0;
    let relief = 0;
    for (const d of DIRS) {
      const c = neighbor({ face, x, y }, s.level, d);
      const j = cubeIndex(c.face, s.level, c.x, c.y);
      if (h.ocean[j] !== 0) touchesOcean = 1;
      relief = Math.max(relief, Math.abs((h.elevationM[j] as number) - elev));
    }
    s.reliefM[i] = relief;

    const discharge = h.dischargeM3s[i] as number;
    /* Thresholds are the classic settlement-geography ones: ~10 m^3/s carries a
       town's water and waste, ~1000 m^3/s is a navigable trunk river. */
    s.riverine[i] = discharge > 1000 ? 2 : discharge > 10 ? 1 : 0;
    s.coastal[i] = touchesOcean === 1 ? (discharge > 200 ? 2 : 1) : 0;

    const biome = b.biome[i] as number;
    if (biome === BIOME.ICE || biome === BIOME.OCEAN) {
      s.suitability[i] = 0;
      s.baseFoodDensity[i] = 0;
      continue;
    }

    /* --- the terms, each reading a different upstream subsystem --- */

    /* M6: primary productivity is what agriculture ultimately converts. */
    const npp = b.nppKgM2Yr[i] as number;
    const productivity = clamp01(npp / 1.8);

    /* M4/M5: temperature. Habitability falls off either side of ~288 K, and
       hard-stops where the growing season cannot exist. */
    const T = h.temperatureK[i] as number;
    const thermal = clamp01((T - 258) / 18) * clamp01((312 - T) / 14);

    /* M5: fresh water. Soil moisture feeds crops; river/coast access feeds
       trade and fishing and is worth as much again. */
    const moisture = clamp01((h.soilMoistureM[i] as number) / 0.18);
    const water = clamp01(moisture * 0.7 + (s.riverine[i] as number) * 0.25 + (s.coastal[i] as number) * 0.15);

    /* M2/M7: terrain. Altitude costs oxygen and growing season; relief costs
       everything — building, farming, moving. */
    const altitude = clamp01((4200 - elev) / 1400) * (elev < -50 ? 0 : 1);
    const flatness = clamp01((900 - relief) / 700);

    /* M6: standing snow and ice are a seasonal tax, not a veto. */
    const winter = clamp01(1 - (h.snowpackM[i] as number) / 3) * clamp01(1 - (h.glacierM[i] as number));

    /* GEOMETRIC MEAN of the six limiting factors.
     *
     * Multiplicative, not additive, because these are limits: abundant food
     * does not compensate for no water, and a river does not compensate for a
     * cliff. A weighted sum would let one strong term carry an uninhabitable
     * cell, which is the failure mode that produces cities on glaciers.
     *
     * But the RAW product of six sub-unit factors is not a suitability, it is
     * an artefact of how many factors were listed: six terms at 0.5 each give
     * 0.016, and adding a seventh reasonable term would halve it again. The
     * geometric mean keeps every property that matters — any zero factor
     * zeroes the result, a weak factor drags the whole down superlinearly —
     * while leaving the output on a scale where 0.5 means "half as good as
     * perfect land" rather than "arbitrarily small". */
    const product = productivity * thermal * water * altitude * flatness * winter;
    const suit = product > 0 ? pow(product, 1 / 6) : 0;
    s.suitability[i] = suit;
    if (suit > 0) suitable++;

    /* People per m^2 that the land feeds unaided. 0.02/km^2 for marginal land
       up to ~40/km^2 for the best pre-industrial farmland, which is the right
       order for river-valley agriculture. */
    s.baseFoodDensity[i] = suit * 4.0e-5;
  }
  s.suitableCount = suitable;
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
