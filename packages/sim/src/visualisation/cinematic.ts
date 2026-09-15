/**
 * @tier B
 *
 * Deterministic selection of the features the M13 cinematic looks at (T-0102).
 *
 * WHAT THIS FIXES. The cinematic's keyframes carried hardcoded latitudes and
 * longitudes. They were chosen against one seed and then frozen, so on any
 * other world "Mountains and rivers" looks at open ocean and "City approach"
 * descends onto empty ground. A three-minute programme that only frames
 * anything on a world nobody runs is not a demonstration of the simulation.
 *
 * The answer is not to make the camera smarter. It is to let the WORLD say
 * where its highest peak, its largest river, its biggest city and its busiest
 * built link are, and to point the existing camera at those. Which is a query,
 * and queries about the world belong here.
 *
 * DERIVED AND READ-ONLY. Nothing here writes to the world, and the result is
 * regenerable at any instant. It is presentation, so it is @tier B: two runs of
 * the same world give the same targets, but no simulation result depends on
 * them.
 *
 * DETERMINISM. Every selection is a maximum over an array scanned in ascending
 * index order with a strict `>`, so the lowest index wins a tie. That is the
 * same tie-break rule the categorical reduction and the overlay lookup use, and
 * it is what makes a recorded cinematic reproducible.
 */

import { EARTH_GEOMETRY, cubeDim, cubeIndex, type PlanetGeometry } from '@ws/data';
import { localFrameAtCell } from '../city/terrain.js';
import { largestCity } from '../city/system.js';
import { CIV } from '../civilisation/system.js';
import { MODE } from '../economy/network.js';
import type { World } from '../world.js';

export interface CinematicTargetPoint {
  readonly lat: number;
  readonly lon: number;
  /** The cube cell the point came from, so a caller can say what it framed. */
  readonly cell: number;
  /** Plain-language description of what was selected and why. Diagnostic. */
  readonly why: string;
}

/**
 * One point per shot role. A role is ABSENT when the world has nothing to put
 * there — no cities yet, no built links yet — rather than being filled with a
 * plausible-looking coordinate. The caller then knowingly falls back.
 */
export interface CinematicTargetSet {
  readonly continent?: CinematicTargetPoint;
  readonly relief?: CinematicTargetPoint;
  readonly civilisation?: CinematicTargetPoint;
  readonly city?: CinematicTargetPoint;
  readonly street?: CinematicTargetPoint;
  readonly infrastructure?: CinematicTargetPoint;
  readonly science?: CinematicTargetPoint;
}

export function cinematicTargets(
  world: World, planet: PlanetGeometry = EARTH_GEOMETRY,
): CinematicTargetSet {
  void planet;
  const h = world.hydrology;
  const out: {
    -readonly [K in keyof CinematicTargetSet]: CinematicTargetSet[K];
  } = {};

  /*
   * Relief: the STEEPEST land, not the highest (T-0163).
   *
   * "Highest cell" sounds like the mountains and is not. On a world whose sea
   * level sits well below zero, the highest cell is often the middle of a wide
   * high plateau — flying there shows a flat green plain, which is exactly
   * what a shot called "Mountains and rivers" must not show. What makes
   * terrain read as mountains is its GRADIENT, so that is what is selected,
   * weighted a little by height so a steep sea cliff does not beat a range.
   */
  const gradient = (i: number): number => {
    if (h.ocean[i] !== 0) return -Infinity;
    const n = cubeDim(h.level);
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
    const relief = Math.hypot(dx, dy);
    const lift = 1 + Math.max(0, (e[i] as number) - world.ocean.seaLevel) / 4000;
    return relief * lift;
  };
  const steepest = argMax(h.cellCount, gradient);
  if (steepest >= 0 && Number.isFinite(gradient(steepest))) {
    out.relief = point(steepest, h.level,
      `steepest land, ${Math.round(h.elevationM[steepest] as number)} m`);
  }

  /* Continent: the largest river mouth. Discharge is the one field that says
     "a continent drains here", which is what the approach shot is about. */
  const river = argMax(h.cellCount, (i) => h.dischargeM3s[i] as number);
  if (river >= 0 && (h.dischargeM3s[river] as number) > 0) {
    out.continent = point(river, h.level,
      `largest discharge, ${Math.round(h.dischargeM3s[river] as number)} m3/s`);
  }

  /* Civilisation: the most populous settlement. This is M8's answer, read from
     the entity store rather than recomputed. */
  const store = world.civilisation.store;
  const popCol = store.column(CIV.population);
  const cellCol = store.column(CIV.cell);
  let bestSettlement = -1;
  let bestPop = 0;
  for (let i = 0; i < store.bound; i++) {
    if (!store.aliveAt(i)) continue;
    const p = popCol[i] as number;
    if (p > bestPop) { bestPop = p; bestSettlement = i; }
  }
  if (bestSettlement >= 0) {
    const cell = cellCol[bestSettlement] as number;
    if (cell >= 0 && cell < h.cellCount) {
      out.civilisation = point(cell, h.level,
        `largest settlement, ${Math.round(bestPop).toLocaleString('en-US')} people`);
    }
  }

  /* City and street: the same city, framed twice. M9 already answers "which
     city is the largest"; asking a second way would let the two shots disagree
     and land the street pass over a different town. */
  const city = largestCity(world.cities);
  if (city !== undefined && city.cell >= 0 && city.cell < h.cellCount) {
    const p = point(city.cell, h.level,
      `largest city #${String(city.id)}, ${Math.round(city.population).toLocaleString('en-US')} people`);
    out.city = p;
    out.street = p;
  }

  /* Infrastructure: the busiest BUILT land link, framed at its midpoint. A sea
     lane is excluded because it is a route, not an installation, and framing
     open water while the shot is called "Infrastructure" is the same kind of
     nominal claim this work exists to remove. */
  const edges = world.economy.network.edges;
  let bestEdge = -1;
  let bestFlow = 0;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (e.mode === MODE.SEA || e.mode === MODE.RIVER) continue;
    if (e.route.cells.length < 2) continue;
    const flow = e.capacity * e.quality;
    if (flow > bestFlow) { bestFlow = flow; bestEdge = i; }
  }
  if (bestEdge >= 0) {
    const e = edges[bestEdge]!;
    const cells = e.route.cells;
    const mid = cells[cells.length >> 1] as number;
    if (mid >= 0 && mid < h.cellCount) {
      out.infrastructure = point(mid, h.level,
        `busiest built link (${['track', 'road', 'river', 'sea', 'rail'][e.mode] ?? 'link'}), ` +
        `quality ${e.quality.toFixed(2)}`);
    }
  }

  /* Science: where the scientific layer has the most to show. Pollution is the
     field the pull-back shot ends on and the one that concentrates most
     sharply, so a maximum there is a real feature rather than a flat plain. */
  const pollution = world.economy.pollution;
  const hotspot = argMax(pollution.length, (i) => pollution[i] as number);
  if (hotspot >= 0 && (pollution[hotspot] as number) > 0) {
    out.science = point(hotspot, world.economy.level,
      `pollution maximum, ${(pollution[hotspot] as number).toExponential(2)}`);
  } else {
    /* Nothing industrial yet: fall back to the coldest place, which is a real
       feature of the climate and is honestly labelled as the substitute. */
    const cold = argMin(h.cellCount, (i) => h.elevationM[i] as number);
    if (cold >= 0) out.science = point(cold, h.level, 'no pollution yet; deepest basin');
  }

  return out;
}

/** Cell centre as geodetic radians. The cube frame already gives the unit. */
function point(cell: number, level: number, why: string): CinematicTargetPoint {
  const f = localFrameAtCell(cell, level);
  return {
    lat: Math.asin(Math.min(1, Math.max(-1, f.oz))),
    lon: Math.atan2(f.oy, f.ox),
    cell,
    why,
  };
}

/** Ascending scan with strict `>`: the lowest index wins a tie. */
function argMax(count: number, valueAt: (i: number) => number): number {
  let best = -1;
  let bestValue = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = valueAt(i);
    if (v > bestValue) { bestValue = v; best = i; }
  }
  return best;
}

function argMin(count: number, valueAt: (i: number) => number): number {
  let best = -1;
  let bestValue = Infinity;
  for (let i = 0; i < count; i++) {
    const v = valueAt(i);
    if (v < bestValue) { bestValue = v; best = i; }
  }
  return best;
}
