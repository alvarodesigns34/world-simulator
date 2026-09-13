/**
 * Builds the city and infrastructure instance batch (M13, T-0101).
 *
 * SEPARATION. This lives in `render` and imports nothing from `sim`. It takes a
 * plain description — where the cities are, what their layouts contain, where
 * the infrastructure runs — and turns it into boxes. It decides how a thing is
 * DRAWN; it never decides that a road exists or where it goes. That is M10's
 * answer and arrives here as data.
 *
 * LOD. Selection is by camera altitude relative to a city's own radius, on the
 * same ladder the plan renderer already uses, so flying down fills the city in
 * rather than switching representation abruptly:
 *
 *   far      one AGGREGATE block per city — a lit smudge from orbit
 *   mid      arterials and ring roads: the plan, recognisable from the air
 *   near     the street network
 *   close    buildings, capped, nearest-first
 *
 * BUDGET. A million-person city is ~480,000 buildings. Uploading them all every
 * frame is 38 MB of instance data, so the near tier takes the nearest
 * `maxBuildings` and reports how many it dropped rather than silently drawing a
 * different city. The cap is a render decision; the city is unchanged.
 */

import { CITY_INSTANCE_FLOATS, CITY_KIND, type CityInstanceBatch, type CityKind } from './city-renderer.js';

/** A local frame on the planet surface, in planet-fixed metres. */
export interface SurfaceFrame {
  /** Origin on the surface, planet-centred metres (f64). */
  readonly ox: number; readonly oy: number; readonly oz: number;
  /** Unit east. */
  readonly ex: number; readonly ey: number; readonly ez: number;
  /** Unit north. */
  readonly nx: number; readonly ny: number; readonly nz: number;
  /** Unit up. */
  readonly ux: number; readonly uy: number; readonly uz: number;
}

/** The geometry of one city, in its own local metres. Derived, regenerable. */
export interface CityGeometry {
  readonly frame: SurfaceFrame;
  readonly radiusM: number;
  /**
   * Street graph: node positions (x,y pairs) and edges (node index pairs).
   *
   * `nodeCount` is REQUIRED and is not `nodeZ.length`: a layout's arrays are
   * allocated at capacity, so the tail is unused slots sitting at the origin.
   * Reading the array length instead put thousands of phantom nodes at (0,0) —
   * which both mis-sampled the ground under central buildings and inflated the
   * spatial index until it cost 1.4 us per building.
   */
  readonly nodeXY: Float32Array;
  readonly nodeZ: Float32Array;
  readonly nodeCount: number;
  readonly edges: Int32Array;
  readonly edgeClass: Uint8Array;
  readonly edgeCount: number;
  readonly bridgeEdges: Int32Array;
  readonly bridgeCount: number;
  /** Buildings: x, y, footprint, height — 4 floats each. */
  readonly buildings: Float32Array;
  readonly buildingDistrict: Uint8Array;
  readonly buildingCount: number;
  /** District tints, 3 floats each, indexed by `buildingDistrict`. */
  readonly districtTint: Float32Array;
}

/** One infrastructure link, as a polyline of planet-fixed points. */
export interface InfrastructureLink {
  /** Planet-centred metres, 3 per point (f64). */
  readonly points: Float64Array;
  readonly kind: CityKind;
  /** 0..1 build-out; drives width. */
  readonly quality: number;
  /** Segment indices that cross rivers in the authoritative physical route. */
  readonly bridgeSegments?: Int32Array;
}

export interface CitySceneInput {
  /** Camera position, planet-centred metres (f64). */
  readonly camX: number; readonly camY: number; readonly camZ: number;
  readonly cities: readonly CityGeometry[];
  readonly links: readonly InfrastructureLink[];
  /** Ports, as planet-centred points. */
  readonly ports?: Float64Array;
  readonly maxBuildings?: number;
  readonly maxInstances?: number;
}

export interface CitySceneStats {
  readonly instances: number;
  readonly buildings: number;
  readonly streets: number;
  readonly links: number;
  readonly bridges: number;
  readonly aggregates: number;
  readonly ports: number;
  /** Buildings the cap prevented from being drawn. */
  readonly buildingsDropped: number;
}

export interface CityScene extends CityInstanceBatch {
  readonly stats: CitySceneStats;
}

/** LOD tiers, by camera distance relative to the city's own radius. */
export const CITY_TIER = { AGGREGATE: 0, ARTERIAL: 1, STREET: 2, BUILDING: 3 } as const;
export type CityTier = (typeof CITY_TIER)[keyof typeof CITY_TIER];

export function cityTierFor(distanceM: number, radiusM: number): CityTier {
  const relative = distanceM / Math.max(1, radiusM);
  if (relative > 40) return CITY_TIER.AGGREGATE;
  if (relative > 8) return CITY_TIER.ARTERIAL;
  if (relative > 2) return CITY_TIER.STREET;
  return CITY_TIER.BUILDING;
}

/** Half-width in metres for each road class at full build-out. */
const ROAD_HALF_WIDTH: Readonly<Record<number, number>> = {
  [CITY_KIND.STREET]: 4,
  [CITY_KIND.ARTERIAL]: 11,
  [CITY_KIND.ROAD]: 8,
  [CITY_KIND.RAIL]: 3.5,
  [CITY_KIND.BRIDGE]: 9,
};

const FALLBACK_TINT: readonly [number, number, number] = [0.5, 0.5, 0.5];

const KIND_TINT: Readonly<Record<number, readonly [number, number, number]>> = {
  [CITY_KIND.STREET]: [0.42, 0.44, 0.48],
  [CITY_KIND.ARTERIAL]: [0.60, 0.58, 0.52],
  [CITY_KIND.ROAD]: [0.50, 0.47, 0.42],
  [CITY_KIND.RAIL]: [0.34, 0.30, 0.28],
  [CITY_KIND.BRIDGE]: [0.72, 0.66, 0.58],
  [CITY_KIND.PORT]: [0.45, 0.55, 0.62],
  [CITY_KIND.AGGREGATE]: [0.55, 0.48, 0.40],
};

/**
 * Build the batch.
 *
 * Deterministic in its input: the same scene description always produces the
 * same instances in the same order, so a frame is reproducible and a
 * screenshot comparison means something.
 */
export function buildCityScene(input: CitySceneInput, out?: Float32Array): CityScene {
  const maxInstances = input.maxInstances ?? 1 << 16;
  const maxBuildings = input.maxBuildings ?? 40_000;
  const data = out !== undefined && out.length >= maxInstances * CITY_INSTANCE_FLOATS
    ? out
    : new Float32Array(maxInstances * CITY_INSTANCE_FLOATS);

  let n = 0;
  let buildings = 0;
  let streets = 0;
  let bridges = 0;
  let aggregates = 0;
  let links = 0;
  let portNodes = 0;
  let buildingsDropped = 0;

  /*
   * Scalar, not tuples.
   *
   * The first version passed axes as `[x, y, z]` arrays. At 54,000 instances
   * that is a quarter of a million short-lived arrays per frame, and the
   * benchmark showed the allocation and collection of them costing more than
   * the arithmetic. Nothing here allocates.
   */
  const push = (
    cx: number, cy: number, cz: number, kind: number,
    xx: number, xy: number, xz: number, hx: number,
    yx: number, yy: number, yz: number, hy: number,
    zx: number, zy: number, zz: number, hz: number,
    tr: number, tg: number, tb: number, emissive: number,
  ): boolean => {
    if (n >= maxInstances) return false;
    const o = n * CITY_INSTANCE_FLOATS;
    data[o] = cx; data[o + 1] = cy; data[o + 2] = cz; data[o + 3] = kind;
    data[o + 4] = xx; data[o + 5] = xy; data[o + 6] = xz; data[o + 7] = hx;
    data[o + 8] = yx; data[o + 9] = yy; data[o + 10] = yz; data[o + 11] = hy;
    data[o + 12] = zx; data[o + 13] = zy; data[o + 14] = zz; data[o + 15] = hz;
    data[o + 16] = tr; data[o + 17] = tg; data[o + 18] = tb; data[o + 19] = emissive;
    n++;
    return true;
  };

  /* --- cities --- */
  for (const city of input.cities) {
    const f = city.frame;
    /* Camera-relative in f64, downcast once (DEC-005). */
    const rx = f.ox - input.camX;
    const ry = f.oy - input.camY;
    const rz = f.oz - input.camZ;
    const distance = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const tier = cityTierFor(distance, city.radiusM);

    if (tier === CITY_TIER.AGGREGATE) {
      /* One block for the whole city. Its height is a legibility choice, not a
         claim about buildings: from orbit this is a marker. */
      const r = Math.max(300, city.radiusM);
      const lift = r * 0.06;
      const t = KIND_TINT[CITY_KIND.AGGREGATE] as readonly [number, number, number];
      if (push(
        rx + f.ux * lift, ry + f.uy * lift, rz + f.uz * lift, CITY_KIND.AGGREGATE,
        f.ex, f.ey, f.ez, r * 0.8,
        f.nx, f.ny, f.nz, r * 0.8,
        f.ux, f.uy, f.uz, lift,
        t[0], t[1], t[2], 0.55,
      )) aggregates++;
      continue;
    }

    /* Streets. At the arterial tier only the coarse classes are drawn. */
    const wantClasses = tier === CITY_TIER.ARTERIAL ? 2 : 4;
    /* One pass over the bridge list instead of a scan of it per edge: at 14k
       edges and a few hundred spans the scan was a measurable share of the
       frame. */
    const bridgeSet = city.bridgeCount > 0 ? new Set<number>() : null;
    for (let k = 0; k < city.bridgeCount; k++) bridgeSet?.add(city.bridgeEdges[k] as number);

    let full = false;
    for (let e = 0; e < city.edgeCount; e++) {
      const cls = city.edgeClass[e] as number;
      if (cls >= wantClasses) continue;
      const a = city.edges[e * 2] as number;
      const b = city.edges[e * 2 + 1] as number;
      const ax = city.nodeXY[a * 2] as number;
      const ay = city.nodeXY[a * 2 + 1] as number;
      const az = city.nodeZ[a] as number;
      const bx = city.nodeXY[b * 2] as number;
      const by = city.nodeXY[b * 2 + 1] as number;
      const bz = city.nodeZ[b] as number;
      const isBridge = bridgeSet !== null && bridgeSet.has(e);
      const kind: CityKind = isBridge ? CITY_KIND.BRIDGE
        : cls === 0 || cls === 1 ? CITY_KIND.ARTERIAL : CITY_KIND.STREET;

      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (!(len > 0)) continue;
      const ux = dx / len;
      const uy = dy / len;
      /* Along and across, expressed in the surface frame. */
      const alx = f.ex * ux + f.nx * uy;
      const aly = f.ey * ux + f.ny * uy;
      const alz = f.ez * ux + f.nz * uy;
      const acx = f.ex * -uy + f.nx * ux;
      const acy = f.ey * -uy + f.ny * ux;
      const acz = f.ez * -uy + f.nz * ux;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const mz = (az + bz) / 2 + 0.6;
      const t = KIND_TINT[kind] as readonly [number, number, number];
      if (!push(
        rx + f.ex * mx + f.nx * my + f.ux * mz,
        ry + f.ey * mx + f.ny * my + f.uy * mz,
        rz + f.ez * mx + f.nz * my + f.uz * mz,
        kind,
        alx, aly, alz, len / 2,
        acx, acy, acz, ROAD_HALF_WIDTH[kind] ?? 4,
        f.ux, f.uy, f.uz, 0.5,
        t[0], t[1], t[2], 0.1,
      )) { full = true; break; }
      streets++;
      if (isBridge) bridges++;
    }

    if (full || tier !== CITY_TIER.BUILDING) continue;

    /* Buildings, nearest first so a cap removes the least visible. */
    const grid = buildNodeGrid(city);
    const order = buildingOrder(city, maxBuildings);
    for (let k = 0; k < order.length; k++) {
      const bi = order[k] as number;
      const bx = city.buildings[bi * 4] as number;
      const by = city.buildings[bi * 4 + 1] as number;
      const foot = city.buildings[bi * 4 + 2] as number;
      const height = city.buildings[bi * 4 + 3] as number;
      const district = city.buildingDistrict[bi] as number;
      const ground = sampleGround(grid, bx, by);
      const bz = ground + height / 2;
      if (!push(
        rx + f.ex * bx + f.nx * by + f.ux * bz,
        ry + f.ey * bx + f.ny * by + f.uy * bz,
        rz + f.ez * bx + f.nz * by + f.uz * bz,
        CITY_KIND.BUILDING,
        f.ex, f.ey, f.ez, foot / 2,
        f.nx, f.ny, f.nz, foot / 2,
        f.ux, f.uy, f.uz, height / 2,
        city.districtTint[district * 3] ?? 0.6,
        city.districtTint[district * 3 + 1] ?? 0.6,
        city.districtTint[district * 3 + 2] ?? 0.6,
        0.35,
      )) break;
      buildings++;
    }
    buildingsDropped += Math.max(0, city.buildingCount - order.length);
  }

  /* --- infrastructure --- */
  for (const link of input.links) {
    const points = link.points;
    const count = points.length / 3;
    if (count < 2) continue;
    const builtScale = 0.35 + 0.65 * link.quality;
    let bridgeCursor = 0;
    let drew = false;
    for (let i = 0; i + 1 < count; i++) {
      while ((link.bridgeSegments?.[bridgeCursor] ?? Number.POSITIVE_INFINITY) < i) bridgeCursor++;
      const isBridge = link.bridgeSegments?.[bridgeCursor] === i;
      const kind = isBridge ? CITY_KIND.BRIDGE : link.kind;
      const halfWidth = (ROAD_HALF_WIDTH[kind] ?? 6) * builtScale;
      const t = KIND_TINT[kind] ?? FALLBACK_TINT;
      const ax = (points[i * 3] as number) - input.camX;
      const ay = (points[i * 3 + 1] as number) - input.camY;
      const az = (points[i * 3 + 2] as number) - input.camZ;
      const bx = (points[(i + 1) * 3] as number) - input.camX;
      const by = (points[(i + 1) * 3 + 1] as number) - input.camY;
      const bz = (points[(i + 1) * 3 + 2] as number) - input.camZ;
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(len > 0)) continue;
      const lx = dx / len;
      const ly = dy / len;
      const lz = dz / len;
      /* Local radial at the segment midpoint — the same up the ports use.
         `along × world-Z` is a flat-map ribbon: at the pole it is a wall. */
      const mx = (ax + bx) * 0.5 + input.camX;
      const my = (ay + by) * 0.5 + input.camY;
      const mz = (az + bz) * 0.5 + input.camZ;
      let upx = mx;
      let upy = my;
      let upz = mz;
      const um = Math.sqrt(upx * upx + upy * upy + upz * upz) || 1;
      upx /= um; upy /= um; upz /= um;
      let rx = ly * upz - lz * upy;
      let ry = lz * upx - lx * upz;
      let rz = lx * upy - ly * upx;
      const rm = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (rm > 1e-6) {
        rx /= rm; ry /= rm; rz /= rm;
        upx = ry * lz - rz * ly;
        upy = rz * lx - rx * lz;
        upz = rx * ly - ry * lx;
      } else if (Math.abs(lx) < 0.9) { rx = 1; ry = 0; rz = 0; }
      else { rx = 0; ry = 1; rz = 0; }
      if (!push(
        (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, kind,
        lx, ly, lz, len / 2,
        rx, ry, rz, halfWidth,
        upx, upy, upz, 1.2,
        t[0], t[1], t[2], 0.05,
      )) break;
      if (isBridge) bridges++;
      drew = true;
    }
    if (drew) links++;
  }

  /* --- ports --- */
  const ports = input.ports;
  if (ports !== undefined) {
    const t = KIND_TINT[CITY_KIND.PORT] as readonly [number, number, number];
    for (let i = 0; i + 2 < ports.length; i += 3) {
      const wx = ports[i] as number;
      const wy = ports[i + 1] as number;
      const wz = ports[i + 2] as number;
      const m = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
      const ux = wx / m; const uy = wy / m; const uz = wz / m;
      /* Two tangents, from a helper axis that is never parallel to up. */
      const hx = Math.abs(uz) < 0.9 ? 0 : 1;
      const hz = Math.abs(uz) < 0.9 ? 1 : 0;
      let ex = hx * 0 - hz * uy;
      let ey = hz * ux - hx * uz;
      let ez = hx * uy - 0 * ux;
      const em = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
      ex /= em; ey /= em; ez /= em;
      if (!push(
        wx - input.camX, wy - input.camY, wz - input.camZ, CITY_KIND.PORT,
        ex, ey, ez, 900,
        uy * ez - uz * ey, uz * ex - ux * ez, ux * ey - uy * ex, 900,
        ux, uy, uz, 120,
        t[0], t[1], t[2], 0.4,
      )) break;
      portNodes++;
    }
  }

  return {
    data,
    count: n,
    stats: { instances: n, buildings, streets, links, bridges, aggregates, ports: portNodes, buildingsDropped },
  };
}

/**
 * A uniform bucket grid over the street nodes, CSR-packed.
 *
 * WHY. Ground height under a building comes from the nearest street node, and
 * the first version scanned a stride of the node list for every building:
 * 40,000 buildings against a strided 4,096 nodes is 164 million distance
 * computations, and `tools/bench/m13-city-scene.mjs` measured it at 400 ms per
 * frame — a system that exists but cannot be looked at, which is exactly the
 * failure this work is meant to close. Bucketing makes it O(nodes + buildings).
 *
 * Rebuilt per call rather than cached on the geometry: it is O(nodes), it is
 * derived, and a cache keyed on a caller-owned object is how stale geometry
 * gets drawn.
 */
interface NodeGrid {
  readonly minX: number; readonly minY: number;
  readonly cell: number;
  readonly nx: number; readonly ny: number;
  readonly start: Int32Array;
  readonly index: Int32Array;
  /** Ground height at each bucket CENTRE, from the nearest street node. */
  readonly height: Float32Array;
}

function buildNodeGrid(city: CityGeometry): NodeGrid | null {
  const nodes = city.nodeCount;
  if (nodes === 0) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let i = 0; i < nodes; i++) {
    const x = city.nodeXY[i * 2] as number;
    const y = city.nodeXY[i * 2 + 1] as number;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = Math.max(1, maxX - minX);
  const hgt = Math.max(1, maxY - minY);
  /* Aim at a handful of nodes per bucket: enough that a 3x3 neighbourhood
     almost always contains one, few enough that scanning it is trivial. */
  const cell = Math.max(1, Math.sqrt((w * hgt) / Math.max(1, nodes)) * 2);
  const nx = Math.max(1, Math.min(2048, Math.ceil(w / cell) + 1));
  const ny = Math.max(1, Math.min(2048, Math.ceil(hgt / cell) + 1));
  const buckets = nx * ny;
  const start = new Int32Array(buckets + 1);
  const bucketOf = (x: number, y: number): number => {
    const ix = Math.min(nx - 1, Math.max(0, Math.floor((x - minX) / cell)));
    const iy = Math.min(ny - 1, Math.max(0, Math.floor((y - minY) / cell)));
    return iy * nx + ix;
  };
  for (let i = 0; i < nodes; i++) {
    const b = bucketOf(city.nodeXY[i * 2] as number, city.nodeXY[i * 2 + 1] as number);
    start[b + 1] = (start[b + 1] as number) + 1;
  }
  for (let b = 0; b < buckets; b++) start[b + 1] = (start[b + 1] as number) + (start[b] as number);
  const cursor = start.slice(0, buckets);
  const index = new Int32Array(nodes);
  for (let i = 0; i < nodes; i++) {
    const b = bucketOf(city.nodeXY[i * 2] as number, city.nodeXY[i * 2 + 1] as number);
    index[cursor[b] as number] = i;
    cursor[b] = (cursor[b] as number) + 1;
  }
  const grid: NodeGrid = { minX, minY, cell, nx, ny, start, index, height: new Float32Array(buckets) };
  /*
   * Solve the nearest-node search ONCE PER BUCKET rather than once per
   * building. There are ~2,000 buckets and up to 40,000 drawn buildings, so
   * this is the difference between a 60 ms frame and a 5 ms one, and the
   * error it costs is bounded by how much the ground moves across one bucket
   * (a few hundred metres) — sampled bilinearly below, so a slope stays a
   * slope rather than becoming a staircase.
   */
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      grid.height[gy * nx + gx] = nearestNodeZ(city, grid, gx, gy);
    }
  }
  return grid;
}

/**
 * Height of the nearest street node to a bucket centre.
 *
 * Rings outward and stops as soon as the next ring cannot beat what has been
 * found — the same exact-prune shape as the geodesic overlay lookup, so the
 * answer is the true nearest node, not an approximation that happens to be
 * close.
 */
function nearestNodeZ(city: CityGeometry, grid: NodeGrid, ix: number, iy: number): number {
  const x = grid.minX + (ix + 0.5) * grid.cell;
  const y = grid.minY + (iy + 0.5) * grid.cell;
  let best = 0;
  let bestD = Infinity;
  const maxRing = grid.nx + grid.ny;
  for (let ring = 0; ring <= maxRing; ring++) {
    if (bestD < Infinity) {
      /* Any node in this ring is at least (ring-1) cells away. */
      const floor = (ring - 1) * grid.cell;
      if (floor > 0 && floor * floor > bestD) break;
    }
    const x0 = ix - ring; const x1 = ix + ring;
    const y0 = iy - ring; const y1 = iy + ring;
    if (x1 < 0 || y1 < 0 || x0 >= grid.nx || y0 >= grid.ny) {
      if (bestD < Infinity) break;
      continue;
    }
    for (let gy = y0; gy <= y1; gy++) {
      if (gy < 0 || gy >= grid.ny) continue;
      const edgeRow = gy === y0 || gy === y1;
      const step = edgeRow ? 1 : Math.max(1, x1 - x0);
      for (let gx = Math.max(x0, 0); gx <= x1; gx += (edgeRow ? 1 : step)) {
        if (gx >= grid.nx) break;
        /* Only the ring boundary; the interior was covered by earlier rings. */
        if (!edgeRow && gx !== x0 && gx !== x1) continue;
        const b = gy * grid.nx + gx;
        const lo = grid.start[b] as number;
        const hi = grid.start[b + 1] as number;
        for (let k = lo; k < hi; k++) {
          const i = grid.index[k] as number;
          const dx = (city.nodeXY[i * 2] as number) - x;
          const dy = (city.nodeXY[i * 2 + 1] as number) - y;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = city.nodeZ[i] as number; }
        }
      }
    }
  }
  return best;
}

/** Ground height under a local point, bilinear over the bucket height field. */
function sampleGround(grid: NodeGrid | null, x: number, y: number): number {
  if (grid === null) return 0;
  const fx = (x - grid.minX) / grid.cell - 0.5;
  const fy = (y - grid.minY) / grid.cell - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const at = (gx: number, gy: number): number => {
    const cx = gx < 0 ? 0 : gx >= grid.nx ? grid.nx - 1 : gx;
    const cy = gy < 0 ? 0 : gy >= grid.ny ? grid.ny - 1 : gy;
    return grid.height[cy * grid.nx + cx] as number;
  };
  const h00 = at(ix, iy);
  const h10 = at(ix + 1, iy);
  const h01 = at(ix, iy + 1);
  const h11 = at(ix + 1, iy + 1);
  return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
}

/*
 * Building selection.
 *
 * Two linear passes and no allocation. The first version stored every squared
 * radius in a Float64Array so the scale could come from the observed maximum;
 * for an 8-million-person city that is 4.8 MB written and read back every
 * frame. The city's own radius is already a bound, so the scale is known up
 * front and the radius can simply be recomputed in the second pass — two
 * multiplications against a 4.8 MB round trip.
 */
const BUILDING_BUCKETS = 256;
const bucketHist = new Int32Array(BUILDING_BUCKETS);
let orderScratch = new Int32Array(0);

/**
 * Buildings nearest the city centre first, capped.
 *
 * Returns a view of shared scratch: valid until the next call, which is all
 * the caller needs and is what keeps a steady state allocation-free.
 */
function buildingOrder(city: CityGeometry, cap: number): Int32Array {
  const count = city.buildingCount;
  const want = Math.min(count, cap);
  if (orderScratch.length < want) orderScratch = new Int32Array(want);
  if (count <= cap) {
    for (let i = 0; i < count; i++) orderScratch[i] = i;
    return orderScratch.subarray(0, count);
  }
  /* A full sort of 480k entries per frame would cost more than the draw; this
     takes the nearest `cap` with a histogram over squared radius. Buildings
     beyond the city radius land in the last bucket, which is correct: they are
     the last to be kept. */
  const span = Math.max(1, city.radiusM) * 1.5;
  const scale = BUILDING_BUCKETS / (span * span);
  bucketHist.fill(0);
  for (let i = 0; i < count; i++) {
    const x = city.buildings[i * 4] as number;
    const y = city.buildings[i * 4 + 1] as number;
    const b = Math.min(BUILDING_BUCKETS - 1, (x * x + y * y) * scale | 0);
    bucketHist[b] = (bucketHist[b] as number) + 1;
  }
  let cutoff = BUILDING_BUCKETS - 1;
  let acc = 0;
  for (let b = 0; b < BUILDING_BUCKETS; b++) {
    acc += bucketHist[b] as number;
    if (acc >= cap) { cutoff = b; break; }
  }
  const out = orderScratch;
  let k = 0;
  for (let i = 0; i < count && k < cap; i++) {
    const x = city.buildings[i * 4] as number;
    const y = city.buildings[i * 4 + 1] as number;
    if (Math.min(BUILDING_BUCKETS - 1, (x * x + y * y) * scale | 0) <= cutoff) {
      out[k] = i;
      k++;
    }
  }
  return out.subarray(0, k);
}
