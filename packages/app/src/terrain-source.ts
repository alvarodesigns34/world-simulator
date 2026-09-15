/**
 * Render-side terrain height field (T-0151).
 *
 * THE PROBLEM IT SOLVES. The renderer drew each patch from four corner
 * elevations, so a 33x33 vertex grid expressed a bilinear quad and flying
 * closer magnified a smooth surface. The height page pool gives the shader one
 * elevation per vertex; this is what fills those pages.
 *
 * WHAT IS AUTHORITATIVE AND WHAT IS NOT. Both parts are declared:
 *
 *   AUTHORITATIVE. The base is `geology.elevationM` — the plate-tectonic
 *   surface M2/M3 actually computed, at its own grid level. Every mountain
 *   range, every continental margin, every ocean basin comes from there. The
 *   detail octaves use `detailNoise`, the same hash the authoritative tile
 *   baker uses, with the same amplitude ladder, so the roughness this adds is
 *   the roughness the tiles contain.
 *
 *   RENDER-ONLY. How to draw BETWEEN authoritative samples. The tile baker
 *   takes the nearest geology cell (`x >> shift`), which is correct for a
 *   raster but draws a planet of kilometre-wide plateaus with vertical steps
 *   between them. Here the geology field is interpolated bilinearly and each
 *   detail octave is interpolated too, which is a statement about rendering,
 *   not about the world. It invents no landform: at every authoritative sample
 *   point the value is the authoritative one.
 *
 * DETERMINISTIC. Same world, same key, same bytes, on any machine — the pages
 * are a pure function of (geology, seed, key), which is what lets the pool
 * evict freely and what makes a captured frame reproducible.
 *
 * This lives in the application because it is the only place a `sim` world and
 * a `render` pool are both in scope (DEC-011).
 */

import type { Seed } from '@ws/core';
import {
  cubeDim,
  cubeFaceToUnitRaw,
  cubeIndex,
  pcf,
  unitToCubeFace,
  type QuadKey,
} from '@ws/data';
import type {
  BiosphereState, GeologyState, HydrologyState,
} from '@ws/sim';
import { detailNoise } from '@ws/sim';
import { PAGE_STRIDE, packMaterial, type HeightPageSampler } from '@ws/render';

/**
 * Detail amplitude at a level, matching `bake.ts`: 40 m at the geology grid,
 * shrinking 0.55x per level so sub-grid relief can never invent a mountain
 * belt the plates did not produce (DEC-026).
 */
function amplitudeAt(level: number, geologyLevel: number): number {
  let amp = 40;
  for (let l = geologyLevel; l < level; l++) amp *= 0.55;
  return amp;
}

/** Octaves below 0.4 m change nothing anyone can see and cost hashes. */
const MIN_AMPLITUDE_M = 0.4;

/**
 * How much sub-grid roughness the terrain's own steepness implies (T-0161).
 *
 * MEASURED FIRST. On this simulation's L8 geology grid (39 km cells) the
 * gradient of land is: median 1.8e-5, ninetieth percentile 6.4e-3, ninety-ninth
 * 3.8e-2, maximum 6.2e-2. Half the land is flat to within a metre over 39 km.
 * A fixed detail ladder therefore adds the same 40 m ripple to an abyssal plain
 * and to a mountain flank, which is both wrong and useless: too little to see
 * on the flank, and a lie on the plain.
 *
 * Real terrain is self-similar — rough country is rough at every scale and a
 * plain is smooth at every scale — so the octave amplitude is scaled by the
 * LOCAL gradient of the authoritative field. A flat region stays flat, which is
 * what stops this inventing mountains where the plates made none (DEC-026), and
 * a steep one gets sub-grid texture consistent with its own steepness.
 *
 * This is RENDER-ONLY and it is a statement about drawing, not about the world:
 * it changes no authoritative value and appears in no digest.
 */
const ROUGHNESS_REFERENCE_GRADIENT = 0.03;
const ROUGHNESS_MIN = 0.2;
const ROUGHNESS_MAX = 4.5;
/** Hard cap so a very deep patch cannot make a page cost unbounded work. */
const MAX_OCTAVES = 7;

/**
 * Terrain a patch's grid cannot resolve, in metres (T-0151).
 *
 * A patch at `level` with `n` vertices per side samples the world every
 * `level + log2(n-1)` cell. Everything finer is unresolved, and since the
 * octave ladder shrinks geometrically its total is a closed form: the next
 * octave divided by (1 - 0.55). Feeding this to the LOD selector is what makes
 * descending keep refining instead of declaring a smooth sphere finished.
 */
export function createTerrainResidual(geologyLevel: number): (level: number, n: number) => number {
  return (level: number, n: number): number => {
    const fine = level + Math.round(Math.log2(Math.max(1, n - 1)));
    return amplitudeAt(fine + 1, geologyLevel) / (1 - 0.55);
  };
}

export interface TerrainSourceOptions {
  readonly geology: GeologyState;
  readonly seed: Seed;
  /**
   * Surface cover, sampled PER VERTEX (T-0154). Handing the shader one
   * vegetation value per patch is what made the planet a mosaic of flat
   * rectangles; these are the same authoritative fields, read at the
   * resolution the geometry is actually drawn at.
   */
  readonly hydrology?: HydrologyState;
  readonly biosphere?: BiosphereState;
  readonly economy?: { readonly pollution: Float64Array };
}

/**
 * Bilinear sample of a cube-grid field at a unit direction.
 *
 * Cell centres sit at (i + 0.5)/n, so the continuous index is u*n - 0.5, and
 * clamping at the face edge is a half-cell approximation on the seam rather
 * than a wrong face — the seam error is below the detail amplitude there.
 */
function bilinearField(
  field: ArrayLike<number>, level: number, x: number, y: number, z: number,
): number {
  const c = unitToCubeFace(pcf(x, y, z));
  const n = cubeDim(level);
  const fx = c.u * n - 0.5;
  const fy = c.v * n - 0.5;
  const x0 = Math.max(0, Math.min(n - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(n - 1, Math.floor(fy)));
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const f = c.face;
  const v00 = field[cubeIndex(f, level, x0, y0)] as number;
  const v10 = field[cubeIndex(f, level, x1, y0)] as number;
  const v01 = field[cubeIndex(f, level, x0, y1)] as number;
  const v11 = field[cubeIndex(f, level, x1, y1)] as number;
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

/** One interpolated octave of the authoritative sub-grid hash at `level`. */
function octaveAt(
  seed: Seed, level: number, amplitude: number, x: number, y: number, z: number,
): number {
  const c = unitToCubeFace(pcf(x, y, z));
  const n = cubeDim(level);
  const fx = c.u * n - 0.5;
  const fy = c.v * n - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  /* Smoothstep, not linear: the derivative is continuous at cell boundaries,
     so the gradient the shader differentiates does not show a grid. */
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const cl = (v: number): number => (v < 0 ? 0 : v >= n ? n - 1 : v);
  const h = (ix: number, iy: number): number =>
    detailNoise(seed, c.face, cl(ix), cl(iy), amplitude);
  const v00 = h(x0, y0);
  const v10 = h(x0 + 1, y0);
  const v01 = h(x0, y0 + 1);
  const v11 = h(x0 + 1, y0 + 1);
  return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
}

/**
 * Build the sampler the height pool calls.
 *
 * Captures the geology state BY REFERENCE, so a world whose tectonics moved
 * produces new pages as soon as the pool is invalidated — which is what
 * `dynamicGeology.generation` already drives for the tile cache.
 */
export function createHeightPageSampler(options: TerrainSourceOptions): HeightPageSampler {
  const { geology, seed, hydrology, biosphere, economy } = options;
  const geoLevel = geology.level;

  /**
   * Vegetation, snow/glacier cover and inland water at a direction, packed.
   *
   * All three are authoritative fields (M6 vegetation, M5 snowpack, glacier,
   * discharge and lake fill). The only choices made here are how a depth in
   * metres becomes a cover fraction, which is a rendering question: 5 cm of
   * water equivalent hides the ground, 20 m of ice is opaque, and a river
   * reads as water once it carries a few thousand cubic metres a second.
   */
  const material = (x: number, y: number, z: number): number => {
    if (hydrology === undefined) return packMaterial(0, 0, 0, 0);
    const h = hydrology;
    const veg = biosphere === undefined ? 0
      : bilinearField(biosphere.vegetationDensity, h.level, x, y, z);
    /*
     * Snow COVER from water equivalent.
     *
     * The first threshold divided by 0.05 m, and M5 initialises every cell to
     * exactly 0.05 m of snow water equivalent — so a newly created world came
     * out uniformly white, and every continent rendered as a pale washed sheet
     * whatever its climate. Thin snow is patchy, not opaque: the ramp starts at
     * 2 cm and only reaches full cover at 30 cm.
     */
    const swe = bilinearField(h.snowpackM, h.level, x, y, z);
    const snow = Math.min(1, Math.max(0, (swe - 0.02) / 0.28));
    const glacier = Math.min(1, bilinearField(h.glacierM, h.level, x, y, z) / 20);
    const river = bilinearField(h.dischargeM3s, h.level, x, y, z) / 4000;
    const lakeDepth = bilinearField(h.filledM, h.level, x, y, z)
      - bilinearField(h.elevationM, h.level, x, y, z);
    const lake = lakeDepth > 0.5 ? Math.min(1, lakeDepth / 4) : 0;
    /* Presentation forcing, and exclusively from authoritative simulated
       weather and pollution — never decorative noise. */
    const runoff = bilinearField(h.runoffMps, h.level, x, y, z) / 3e-7;
    const pollution = economy === undefined ? 0
      : bilinearField(economy.pollution, h.level, x, y, z) / 2e7;
    const weather = Math.min(1, Math.min(1, runoff) * 0.7 + Math.min(1, pollution) * 0.3);
    return packMaterial(veg, Math.max(snow, glacier), Math.max(river, lake), weather);
  };

  /**
   * Local steepness of the authoritative field, as a multiplier on the detail
   * ladder. One central difference over half a geology cell.
   */
  const geoStep = 0.5 / 2 ** geoLevel;
  const cellM = ((2 * Math.PI * 6_371_000) / 4) / 2 ** geoLevel;
  const roughnessAt = (u: number, v: number, face: number): number => {
    const at = (du: number, dv: number): number => {
      const p = cubeFaceToUnitRaw(face, u + du, v + dv);
      return bilinearField(geology.elevationM, geoLevel, p.x, p.y, p.z);
    };
    const gx = (at(geoStep, 0) - at(-geoStep, 0)) / (2 * geoStep * cellM * 2 ** geoLevel);
    const gy = (at(0, geoStep) - at(0, -geoStep)) / (2 * geoStep * cellM * 2 ** geoLevel);
    const grade = Math.hypot(gx, gy) / ROUGHNESS_REFERENCE_GRADIENT;
    return ROUGHNESS_MIN + (ROUGHNESS_MAX - ROUGHNESS_MIN) * Math.min(1, grade);
  };

  return (key: QuadKey, n: number, out: Float32Array): void => {
    const side = n + 2;
    const scale = 1 / 2 ** key.level;
    const step = scale / (n - 1);
    /*
     * Which octaves this page can actually resolve. A patch whose samples are
     * 9 km apart cannot show a 40 m bump at 40 m spacing, and evaluating it
     * would be pure cost. The finest level the page resolves is the level
     * whose cell is one sample wide.
     */
    const fineLevel = key.level + Math.round(Math.log2(Math.max(1, n - 1)));
    const octaves: { level: number; amplitude: number }[] = [];
    for (let l = geoLevel + 1; l <= fineLevel && octaves.length < MAX_OCTAVES; l++) {
      const amplitude = amplitudeAt(l, geoLevel);
      if (amplitude < MIN_AMPLITUDE_M) break;
      octaves.push({ level: l, amplitude });
    }

    for (let j = -1; j <= n; j++) {
      const v = key.y * scale + j * step;
      for (let i = -1; i <= n; i++) {
        const u = key.x * scale + i * step;
        /* The patch's own face parametrisation, extrapolated by at most one
           sample beyond the face for the border ring. */
        const d = cubeFaceToUnitRaw(key.face, u, v);
        let h = bilinearField(geology.elevationM, geoLevel, d.x, d.y, d.z);
        if (octaves.length > 0) {
          const rough = roughnessAt(u, v, key.face);
          for (const o of octaves) {
            h += octaveAt(seed, o.level, o.amplitude * rough, d.x, d.y, d.z);
          }
        }
        const at = ((j + 1) * side + (i + 1)) * PAGE_STRIDE;
        out[at] = h;
        out[at + 1] = material(d.x, d.y, d.z);
      }
    }
  };
}
