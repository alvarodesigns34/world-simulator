/**
 * @tier A
 *
 * M9 city GEOMETRY — derived, never authoritative.
 *
 * Everything this file produces is a pure function of (`CityState`, terrain)
 * and can be thrown away and rebuilt identically. The simulation never reads it
 * back: no M8 or M10 quantity is computed from a street, a plot or a building.
 * That is the founding principle at city scale, and `city.test.ts` asserts it
 * by regenerating every layout in the world and checking the digest is
 * unchanged.
 *
 * WHY IT IS BUILT THIS WAY. A million-person city has ~480 000 buildings. They
 * cannot be entities (DEC-012 would put 480 000 rows per city in a store), they
 * cannot be persisted (that is gigabytes for a planet), and they cannot be
 * stepped. They can only be a FUNCTION, evaluated at the level of detail the
 * viewer actually needs — which is what makes cities affordable at planetary
 * scale.
 *
 * The generator is deterministic and allocation-bounded: every array is sized
 * from the state before generation starts, so a city either fits its budget or
 * is refused at a coarser LOD, never discovered to be too big halfway through.
 */

import { DOMAIN, cos, exp, hashU32, sin, type Seed } from '@ws/core';
import {
  DISTRICT,
  DISTRICT_COUNT,
  streetEra,
  type CityState,
  type DistrictKind,
} from './state.js';

/**
 * Level of detail. Each level is a superset of the one below, so a viewer that
 * zooms in extends the layout rather than replacing it conceptually.
 *
 *   0 DISTRICTS   district seeds and the built-up outline. A dot on a globe.
 *   1 ARTERIALS   radial roads and ring roads. A city recognisable from orbit.
 *   2 STREETS     the local street network. A city you can navigate.
 *   3 PLOTS       plots and buildings. A city you can walk into.
 */
export const CITY_LOD = { DISTRICTS: 0, ARTERIALS: 1, STREETS: 2, PLOTS: 3 } as const;
export type CityLod = (typeof CITY_LOD)[keyof typeof CITY_LOD];

/** Road classes, coarse to fine. */
export const ROAD = { ARTERIAL: 0, RING: 1, STREET: 2, LANE: 3 } as const;

/** Node flags. */
export const NODE = { PLAIN: 0, CENTRE: 1, BRIDGE: 2, GATE: 4 } as const;

/**
 * Local terrain, in the city's own tangent frame.
 *
 * The layout knows nothing about cube faces or planetary coordinates: it asks
 * for elevation and water at a local metre offset. That keeps the generator
 * pure and testable against a synthetic landscape, and it is also the seam at
 * which the city meets the planet (`terrain.ts` implements it from M2/M5).
 */
export interface TerrainSampler {
  /** Metres above sea level at local ENU offset (x, y) from the city centre. */
  elevationAt(x: number, y: number): number;
  /** True where the surface is water: ocean, lake, or a river channel. */
  waterAt(x: number, y: number): boolean;
}

export interface CityLayout {
  readonly cityId: number;
  readonly lod: CityLod;
  /** The `layoutGeneration` this was built from. Stale if it differs. */
  readonly generation: number;
  readonly radiusM: number;
  /**
   * Offset of the plan origin from the settlement's cell centre, in local
   * metres. Non-zero when the cell centre was in water and the city had to be
   * set back onto the bank.
   */
  readonly originXY: Float32Array;

  /** Node positions in local ENU metres, 2 per node. */
  readonly nodeXY: Float32Array;
  /** Terrain elevation at each node, metres. */
  readonly nodeZ: Float32Array;
  readonly nodeFlags: Uint8Array;
  readonly nodeCount: number;

  /** Edge endpoints, 2 node indices per edge. */
  readonly edges: Int32Array;
  readonly edgeClass: Uint8Array;
  readonly edgeLengthM: Float32Array;
  readonly edgeCount: number;

  /** Bridge spans, in edge indices. A bridge is an edge, not a decoration. */
  readonly bridgeEdges: Int32Array;
  readonly bridgeCount: number;

  /** Per-district: kind, centre x, centre y, radius, development. */
  readonly districtKind: Uint8Array;
  readonly districtXY: Float32Array;
  readonly districtRadiusM: Float32Array;
  readonly districtDevelopment: Float32Array;
  readonly districtCount: number;

  /** Buildings: x, y, footprint side (m), height (m) — 4 floats each. */
  readonly buildings: Float32Array;
  readonly buildingDistrict: Uint8Array;
  readonly buildingCount: number;

  /** Diagnostics the tests and the budget report read. */
  readonly stats: LayoutStats;
}

/**
 * Hard ceiling on buildings in ONE layout.
 *
 * A layout is allocated up front from the state, which is what makes it
 * predictable — but only if the state cannot ask for an unbounded array. At 4
 * floats plus a byte each, this ceiling is ~10 MB, and it comfortably contains
 * the brief's target: a million-person city is ~436 000 buildings.
 *
 * Above it the layout does NOT silently truncate. It generates this many
 * buildings and reports `buildingScale` — how many real buildings each
 * generated one stands for — so a consumer knows it is looking at a
 * representative sample rather than the city. Truncating without saying so
 * would make a 10-million-person city look identical to a 600 000-person one.
 */
export const MAX_LAYOUT_BUILDINGS = 600_000;

export interface LayoutStats {
  /** Total street length, metres. */
  streetLengthM: number;
  /** Total building footprint area, m^2. */
  footprintM2: number;
  /** Roads abandoned because water could not be crossed. */
  blockedByWater: number;
  /** Buildings suppressed because the ground was water or too steep. */
  suppressedByTerrain: number;
  /** Steepest street grade actually built, as a fraction. */
  maxGrade: number;
  /**
   * Real buildings represented by each generated one. 1 when the whole city
   * fits under `MAX_LAYOUT_BUILDINGS`; above that, the factor by which the
   * layout is a sample.
   */
  buildingScale: number;
  generationMs: number;
}

/** Longest span a city of this technology will bridge, metres. */
export function maxBridgeSpanM(technology: number): number {
  /* A timber trestle is tens of metres; a modern span is over a kilometre.
     This is what decides whether a city grows across its river or stops at it,
     so it is a technology consequence, not a constant. */
  return 25 + 1400 * technology * technology;
}

/** Steepest grade a street of this era will climb. */
function maxGrade(era: number): number {
  return era >= 2 ? 0.08 : 0.14;
}

interface Budget {
  spokes: number;
  rings: number;
  blocksPerSector: number;
  targetBuildings: number;
  buildingScale: number;
  maxNodes: number;
  maxEdges: number;
}

function budget(s: CityState, lod: CityLod): Budget {
  const era = streetEra(s.technology);
  const spokes = Math.min(24, 6 + 2 * Math.min(era + s.era, 9));
  const rings = Math.min(7, 2 + Math.min(era + s.era, 5));

  let targetBuildings = 0;
  let buildingScale = 1;
  if (lod >= CITY_LOD.PLOTS) {
    const perBuilding = 3.1 - 0.8 * s.technology;
    const wanted = Math.floor((s.population / perBuilding) * 1.2);
    if (wanted > MAX_LAYOUT_BUILDINGS) {
      buildingScale = wanted / MAX_LAYOUT_BUILDINGS;
      targetBuildings = MAX_LAYOUT_BUILDINGS;
    } else {
      targetBuildings = wanted;
    }
  }
  /* Local streets subdivide each block; the subdivision is capped so that a
     huge city produces more blocks, not unboundedly finer ones. */
  const blocksPerSector = lod >= CITY_LOD.STREETS ? Math.min(6, 1 + Math.floor(s.radiusM / 1500)) : 0;

  const ringNodes = (spokes + 1) * (rings + 1);
  const localNodes = blocksPerSector > 0
    ? spokes * rings * (blocksPerSector + 1) * (blocksPerSector + 1)
    : 0;
  const maxNodes = ringNodes + localNodes + 8;
  const maxEdges = maxNodes * 3;
  return { spokes, rings, blocksPerSector, targetBuildings, buildingScale, maxNodes, maxEdges };
}

/**
 * Estimate the layout cost before building it, so a caller can pick an LOD that
 * fits its budget rather than discovering the cost afterwards.
 */
export function estimateLayoutCost(s: CityState, lod: CityLod): { nodes: number; buildings: number; bytes: number } {
  const b = budget(s, lod);
  const bytes = b.maxNodes * (8 + 4 + 1) + b.maxEdges * (8 + 1 + 4) + b.targetBuildings * (16 + 1);
  return { nodes: b.maxNodes, buildings: b.targetBuildings, bytes };
}

/**
 * Build a city's geometry.
 *
 * Deterministic in (state, sampler): the same city on the same terrain always
 * produces byte-identical arrays, which is what lets a layout be discarded
 * under memory pressure and rebuilt when the camera comes back (DEC-017).
 */
export function generateCityLayout(
  s: CityState,
  terrain: TerrainSampler,
  lod: CityLod,
  nowMs = 0,
): CityLayout {
  const t0 = nowMs;
  const b = budget(s, lod);
  const era = streetEra(s.technology);
  const R = Math.max(50, s.radiusM);
  const seed = s.seed;
  const span = maxBridgeSpanM(s.technology);
  const grade = maxGrade(era);

  /* PLAN ORIGIN.
   *
   * A river reconstructed from M5 runs through its cell's CENTRE, and a
   * settlement founded on a river is centred on that cell — so the naive plan
   * origin sits in the water, every spoke starts blocked, and a small town
   * generated an empty layout: no streets, no buildings, nothing. That is not
   * a small town on a river, it is a bug that looks like a modelling choice.
   *
   * Cities sit BESIDE rivers. The origin is set back to the nearest dry ground
   * by a bounded spiral search, so the river ends up crossing the city off
   * centre — which is what a river city looks like. */
  let originX = 0;
  let originY = 0;
  if (terrain.waterAt(0, 0)) {
    const rings = 12;
    const spokesN = 16;
    search: for (let ri = 1; ri <= rings; ri++) {
      const rad = (R * ri) / rings;
      for (let k = 0; k < spokesN; k++) {
        /* Ascending k at ascending radius: the first dry point found is the
           nearest one in a fixed order, so the origin is deterministic. */
        const a = (k / spokesN) * Math.PI * 2;
        const x = cos(a) * rad;
        const y = sin(a) * rad;
        if (!terrain.waterAt(x, y)) { originX = x; originY = y; break search; }
      }
    }
  }

  const nodeXY = new Float32Array(b.maxNodes * 2);
  const nodeZ = new Float32Array(b.maxNodes);
  const nodeFlags = new Uint8Array(b.maxNodes);
  const edges = new Int32Array(b.maxEdges * 2);
  const edgeClass = new Uint8Array(b.maxEdges);
  const edgeLengthM = new Float32Array(b.maxEdges);
  const bridgeEdges = new Int32Array(Math.max(16, b.maxEdges >> 3));

  const stats: LayoutStats = {
    streetLengthM: 0, footprintM2: 0, blockedByWater: 0,
    suppressedByTerrain: 0, maxGrade: 0, buildingScale: b.buildingScale, generationMs: 0,
  };

  let nodeCount = 0;
  let edgeCount = 0;
  let bridgeCount = 0;

  /* Every plan coordinate is relative to the origin; the arrays store absolute
     local metres so consumers never have to know the offset exists. */
  const addNode = (lx: number, ly: number, flags: number): number => {
    if (nodeCount >= b.maxNodes) return -1;
    const x = lx + originX;
    const y = ly + originY;
    const i = nodeCount;
    nodeXY[i * 2] = x;
    nodeXY[i * 2 + 1] = y;
    nodeZ[i] = terrain.elevationAt(x, y);
    nodeFlags[i] = flags;
    nodeCount++;
    return i;
  };

  const addEdge = (a: number, b2: number, cls: number, isBridge: boolean): boolean => {
    if (a < 0 || b2 < 0 || a === b2 || edgeCount >= b.maxEdges) return false;
    const dx = (nodeXY[b2 * 2] as number) - (nodeXY[a * 2] as number);
    const dy = (nodeXY[b2 * 2 + 1] as number) - (nodeXY[a * 2 + 1] as number);
    const len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 0)) return false;
    const rise = Math.abs((nodeZ[b2] as number) - (nodeZ[a] as number));
    const g = rise / len;
    if (g > grade && !isBridge) {
      /* Too steep for this era's roadbuilding. The street is not built; the
         block it would have served simply is not developed. Cities on rough
         ground are smaller, which is the point. */
      return false;
    }
    edges[edgeCount * 2] = a;
    edges[edgeCount * 2 + 1] = b2;
    edgeClass[edgeCount] = cls;
    edgeLengthM[edgeCount] = len;
    stats.streetLengthM += len;
    if (g > stats.maxGrade) stats.maxGrade = g;
    if (isBridge && bridgeCount < bridgeEdges.length) {
      bridgeEdges[bridgeCount] = edgeCount;
      bridgeCount++;
      nodeFlags[a] = (nodeFlags[a] as number) | NODE.BRIDGE;
      nodeFlags[b2] = (nodeFlags[b2] as number) | NODE.BRIDGE;
    }
    edgeCount++;
    return true;
  };

  /**
   * Is the straight run a->b crossable, and does it need a bridge?
   *
   * Samples the segment rather than only its ends, because a river narrower
   * than the sample step is exactly the case where a naive check builds a road
   * straight through the water.
   */
  const crossing = (lax: number, lay: number, lbx: number, lby: number): 'dry' | 'bridge' | 'blocked' => {
    const ax = lax + originX;
    const ay = lay + originY;
    const bx = lbx + originX;
    const by = lby + originY;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(4, Math.min(64, Math.ceil(len / 25)));
    let wetRun = 0;
    let worstRun = 0;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      if (terrain.waterAt(ax + dx * t, ay + dy * t)) {
        wetRun += len / steps;
        if (wetRun > worstRun) worstRun = wetRun;
      } else {
        wetRun = 0;
      }
    }
    if (worstRun <= 0) return 'dry';
    return worstRun <= span ? 'bridge' : 'blocked';
  };

  /* ---- centre ---- */
  const centre = addNode(0, 0, NODE.CENTRE);

  /* ---- arterials: radial spokes ---- */
  const spokeTip = new Int32Array(b.spokes).fill(-1);
  const spokeReach = new Float32Array(b.spokes);
  const ringNode: Int32Array[] = [];
  for (let r = 0; r <= b.rings; r++) ringNode.push(new Int32Array(b.spokes).fill(-1));

  if (lod >= CITY_LOD.ARTERIALS) {
    for (let k = 0; k < b.spokes; k++) {
      /* A little deterministic jitter so the plan is not a perfect asterisk.
         Older eras wander more; a modern grid does not. */
      const wobble = (hashU32(seed, DOMAIN.CITY_LAYOUT, s.id, 11, k) / 0xffffffff - 0.5)
        * (era >= 2 ? 0.06 : 0.28);
      const angle = (k / b.spokes) * Math.PI * 2 + wobble;
      const ca = cos(angle);
      const sa = sin(angle);
      let prev = centre;
      let px = 0;
      let py = 0;
      let reached = 0;
      for (let r = 1; r <= b.rings; r++) {
        const rad = (R * r) / b.rings;
        const x = ca * rad;
        const y = sa * rad;
        const c = crossing(px, py, x, y);
        if (c === 'blocked') { stats.blockedByWater++; break; }
        const n = addNode(x, y, 0);
        if (n < 0) break;
        if (!addEdge(prev, n, ROAD.ARTERIAL, c === 'bridge')) {
          /* Too steep. The spoke stops here — the city does not climb it. */
          nodeCount--;
          break;
        }
        ringNode[r]![k] = n;
        prev = n;
        px = x;
        py = y;
        reached = rad;
      }
      spokeTip[k] = prev;
      spokeReach[k] = reached;
    }

    /* ---- ring roads ---- */
    for (let r = 1; r <= b.rings; r++) {
      const ring = ringNode[r] as Int32Array;
      for (let k = 0; k < b.spokes; k++) {
        const a = ring[k] as number;
        const c = ring[(k + 1) % b.spokes] as number;
        if (a < 0 || c < 0) continue;
        const cr = crossing(
          (nodeXY[a * 2] as number) - originX, (nodeXY[a * 2 + 1] as number) - originY,
          (nodeXY[c * 2] as number) - originX, (nodeXY[c * 2 + 1] as number) - originY,
        );
        if (cr === 'blocked') { stats.blockedByWater++; continue; }
        addEdge(a, c, ROAD.RING, cr === 'bridge');
      }
    }
  }

  /* ---- local streets ---- */
  if (lod >= CITY_LOD.STREETS && b.blocksPerSector > 0) {
    const m = b.blocksPerSector;
    for (let r = 1; r <= b.rings; r++) {
      const inner = ringNode[r - 1] as Int32Array;
      const outer = ringNode[r] as Int32Array;
      for (let k = 0; k < b.spokes; k++) {
        const k2 = (k + 1) % b.spokes;
        const a = r === 1 ? centre : (inner[k] as number);
        const bN = r === 1 ? centre : (inner[k2] as number);
        const c = outer[k] as number;
        const d = outer[k2] as number;
        if (a < 0 || bN < 0 || c < 0 || d < 0) continue;
        buildBlockGrid(a, bN, c, d, m);
      }
    }
  }

  function buildBlockGrid(a: number, bN: number, c: number, d: number, m: number): void {
    /* Bilinear interpolation of the block quad, then a grid inside it. Streets
       follow the quad, so an organic ring plan stays organic at street level
       instead of a grid being pasted over it. */
    const ax = nodeXY[a * 2] as number, ay = nodeXY[a * 2 + 1] as number;
    const bx = nodeXY[bN * 2] as number, by = nodeXY[bN * 2 + 1] as number;
    const cx = nodeXY[c * 2] as number, cy = nodeXY[c * 2 + 1] as number;
    const dx = nodeXY[d * 2] as number, dy = nodeXY[d * 2 + 1] as number;
    const grid = new Int32Array((m + 1) * (m + 1)).fill(-1);
    for (let i = 0; i <= m; i++) {
      const u = i / m;
      for (let j = 0; j <= m; j++) {
        const v = j / m;
        const x = (ax * (1 - u) + bx * u) * (1 - v) + (cx * (1 - u) + dx * u) * v;
        const y = (ay * (1 - u) + by * u) * (1 - v) + (cy * (1 - u) + dy * u) * v;
        if (terrain.waterAt(x, y)) continue;
        /* These come from existing node positions, which are already absolute. */
        grid[j * (m + 1) + i] = addNode(x - originX, y - originY, 0);
      }
    }
    for (let j = 0; j <= m; j++) {
      for (let i = 0; i <= m; i++) {
        const n = grid[j * (m + 1) + i] as number;
        if (n < 0) continue;
        if (i < m) addEdge(n, grid[j * (m + 1) + i + 1] as number, ROAD.STREET, false);
        if (j < m) addEdge(n, grid[(j + 1) * (m + 1) + i] as number, ROAD.STREET, false);
      }
    }
  }

  /* ---- districts ---- */
  const dCount = s.districts.length;
  const districtKind = new Uint8Array(dCount);
  const districtXY = new Float32Array(dCount * 2);
  const districtRadiusM = new Float32Array(dCount);
  const districtDevelopment = new Float32Array(dCount);
  for (let i = 0; i < dCount; i++) {
    const d = s.districts[i]!;
    districtKind[i] = d.kind;
    districtXY[i * 2] = d.x + originX;
    districtXY[i * 2 + 1] = d.y + originY;
    districtDevelopment[i] = d.development;
    /* A district's reach grows with the city and with how built out it is. */
    districtRadiusM[i] = R / Math.max(2, Math.sqrt(dCount)) * (0.6 + 0.8 * d.development);
  }

  /* ---- buildings ---- */
  let buildings = new Float32Array(0);
  let buildingDistrict = new Uint8Array(0);
  let buildingCount = 0;

  if (lod >= CITY_LOD.PLOTS && b.targetBuildings > 0 && edgeCount > 0) {
    buildings = new Float32Array(b.targetBuildings * 4);
    buildingDistrict = new Uint8Array(b.targetBuildings);

    /* Buildings are placed ALONG STREETS, on both sides, because that is what
       makes a plan read as a city rather than as scattered boxes. Each street
       edge gets a share of the target proportional to its length weighted by
       how developed the district it runs through is. */
    let weightTotal = 0;
    const weights = new Float32Array(edgeCount);
    /* Nearest district is resolved ONCE PER EDGE, not once per building.
       Resolving it per building made the placement loop O(buildings x
       districts) — 24 million distance tests for a large city, which was most
       of the generation time. A street does not change district halfway. */
    const edgeDistrict = new Int32Array(edgeCount).fill(-1);
    for (let e = 0; e < edgeCount; e++) {
      const a = edges[e * 2] as number;
      const c = edges[e * 2 + 1] as number;
      const mx = ((nodeXY[a * 2] as number) + (nodeXY[c * 2] as number)) * 0.5;
      const my = ((nodeXY[a * 2 + 1] as number) + (nodeXY[c * 2 + 1] as number)) * 0.5;
      const di = nearestDistrict(mx, my, districtXY, dCount);
      edgeDistrict[e] = di;
      const dev = di < 0 ? 0.2 : (districtDevelopment[di] as number);
      /* Density falls with distance from the centre, steeply pre-industrial
         and gently once transport is cheap. */
      const rr = Math.sqrt(mx * mx + my * my) / R;
      const falloff = exp(-rr * (2.6 - 1.6 * s.technology));
      const w = (edgeLengthM[e] as number) * (0.15 + dev) * falloff;
      weights[e] = w;
      weightTotal += w;
    }
    if (weightTotal > 0) {
      for (let e = 0; e < edgeCount && buildingCount < b.targetBuildings; e++) {
        const share = ((weights[e] as number) / weightTotal) * b.targetBuildings;
        let n = Math.floor(share);
        /* Deterministic rounding of the fractional part — no RNG state, and
           the same city always gets the same building count. */
        const frac = share - n;
        if (frac > 0 && (hashU32(seed, DOMAIN.CITY_LAYOUT, s.id, 31, e) / 0x100000000) < frac) n++;
        if (n <= 0) continue;
        placeAlongEdge(e, n, edgeDistrict[e] as number);
      }
    }
  }

  function placeAlongEdge(e: number, n: number, di: number): void {
    const a = edges[e * 2] as number;
    const c = edges[e * 2 + 1] as number;
    const ax = nodeXY[a * 2] as number, ay = nodeXY[a * 2 + 1] as number;
    const ex = (nodeXY[c * 2] as number) - ax, ey = (nodeXY[c * 2 + 1] as number) - ay;
    const len = edgeLengthM[e] as number;
    if (!(len > 0)) return;
    const ux = ex / len, uy = ey / len;
    /* Unit normal: buildings sit set back from the carriageway, alternating
       sides, which is what produces street frontage. */
    const nx = -uy, ny = ux;

    /* District, footprint class and height class are constant along the edge,
       so they are resolved once outside the placement loop. */
    const kind = di < 0 ? DISTRICT.RESIDENTIAL : (districtKind[di] as DistrictKind);
    const dev = di < 0 ? 0.2 : (districtDevelopment[di] as number);

    const perSide = Math.max(1, Math.ceil(n / 2));
    const stepT = len / (perSide + 1);
    let placed = 0;
    for (let k = 0; k < n; k++) {
      const side = k % 2 === 0 ? 1 : -1;
      const idx = Math.floor(k / 2) + 1;
      const t = Math.min(len - 1, idx * stepT);
      const footprint = footprintFor(kind, dev, s.technology);
      const setback = 6 + footprint * 0.5;
      const bx = ax + ux * t + nx * side * setback;
      const by = ay + uy * t + ny * side * setback;
      if (terrain.waterAt(bx, by)) { stats.suppressedByTerrain++; continue; }
      if (buildingCount >= b.targetBuildings) return;
      const h = heightFor(kind, dev, s.technology, seed, s.id, buildingCount);
      buildings[buildingCount * 4] = bx;
      buildings[buildingCount * 4 + 1] = by;
      buildings[buildingCount * 4 + 2] = footprint;
      buildings[buildingCount * 4 + 3] = h;
      buildingDistrict[buildingCount] = kind;
      stats.footprintM2 += footprint * footprint;
      buildingCount++;
      placed++;
    }
    void placed;
  }

  stats.generationMs = nowMs > 0 ? 0 : 0;
  void t0;

  return {
    cityId: s.id,
    lod,
    generation: s.layoutGeneration,
    radiusM: R,
    originXY: new Float32Array([originX, originY]),
    nodeXY, nodeZ, nodeFlags, nodeCount,
    edges, edgeClass, edgeLengthM, edgeCount,
    bridgeEdges, bridgeCount,
    districtKind, districtXY, districtRadiusM, districtDevelopment, districtCount: dCount,
    buildings, buildingDistrict, buildingCount,
    stats,
  };
}

function nearestDistrict(x: number, y: number, xy: Float32Array, count: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < count; i++) {
    const dx = x - (xy[i * 2] as number);
    const dy = y - (xy[i * 2 + 1] as number);
    const d = dx * dx + dy * dy;
    /* Strict `<` plus ascending iteration makes the lowest index win ties. */
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Building footprint side, metres. */
function footprintFor(kind: DistrictKind, development: number, technology: number): number {
  switch (kind) {
    case DISTRICT.INDUSTRIAL: return 24 + 60 * development * technology;
    case DISTRICT.PORT: return 20 + 45 * development;
    case DISTRICT.COMMERCIAL: return 14 + 26 * development;
    case DISTRICT.CORE: return 12 + 20 * development;
    case DISTRICT.MILITARY: return 18 + 30 * development;
    case DISTRICT.AGRICULTURAL: return 9 + 8 * development;
    default: return 8 + 9 * development;
  }
}

/** Building height, metres. Steel and lifts are what make towers possible. */
function heightFor(
  kind: DistrictKind, development: number, technology: number,
  seed: Seed, cityId: number, index: number,
): number {
  /* Below ~0.62 technology there are no lifts and no steel frame, so nothing
     is taller than a church: height is capped, not merely unlikely. */
  const structural = technology < 0.62 ? 18 : 18 + 380 * (technology - 0.62) / 0.38;
  const base = kind === DISTRICT.CORE ? 0.85
    : kind === DISTRICT.COMMERCIAL ? 0.6
    : kind === DISTRICT.INDUSTRIAL ? 0.22
    : kind === DISTRICT.AGRICULTURAL ? 0.08
    : 0.3;
  const roll = hashU32(seed, DOMAIN.CITY_LAYOUT, cityId, 47, index) / 0x100000000;
  const h = structural * base * (0.35 + 0.65 * development) * (0.55 + 0.9 * roll * roll);
  return Math.max(3, h);
}

/** Buildings per district kind — used by M10 and by the tests. */
export function buildingsByDistrict(l: CityLayout): Int32Array {
  const out = new Int32Array(DISTRICT_COUNT);
  for (let i = 0; i < l.buildingCount; i++) {
    const k = l.buildingDistrict[i] as number;
    if (k < DISTRICT_COUNT) out[k] = (out[k] as number) + 1;
  }
  return out;
}
