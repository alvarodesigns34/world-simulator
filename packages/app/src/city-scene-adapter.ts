/**
 * World -> city scene adapter (M13, T-0101).
 *
 * THE COMPOSITION ROOT IS THE ONLY PLACE THIS CAN LIVE. `render` may not import
 * `sim` and `sim` does not know a camera exists (DEC-011), so something has to
 * read M9's city layouts and M10's transport network and hand `render` the flat
 * geometry it draws. That translation is this file, and it is deliberately
 * one-directional: nothing here writes to the world.
 *
 * WHAT IT FIXES. M9 claimed a city that "renders at 60 FPS from street level and
 * orbit" with a "seamless city -> terrain transition", and M13 listed shots that
 * fly into one. What actually existed was a 320x320 2D canvas on the `y` key.
 * The 3D path did not exist, so neither claim was testable and Astra's visual
 * gate would have opened on a missing system rather than an unpolished one.
 *
 * DERIVED, NOT STORED. Everything produced here is regenerable from the world
 * and is thrown away freely: the geometry cache keys on `layoutGeneration` and
 * the corridor cache on `topologyGeneration`, so a stale frame is impossible
 * rather than unlikely. Dropping the whole cache costs time, never state.
 */

import {
  CITY_KIND,
  CITY_TIER,
  buildCityScene,
  cityTierFor,
  type CityGeometry,
  type CityScene,
  type CitySceneStats,
  type InfrastructureLink,
  type SurfaceFrame,
} from '@ws/render';
import { EARTH_GEOMETRY } from '@ws/data';
import {
  CITY_LOD,
  MODE,
  cityLayout,
  cityTerrainSampler,
  localFrameAtCell,
  type CityLayout,
  type CityLod,
  type CityState,
  type createWorld,
} from '@ws/sim';

type World = ReturnType<typeof createWorld>;

/** District tints, indexed by `DISTRICT`. Placeholder values; Astra's to grade. */
const DISTRICT_TINT: readonly (readonly [number, number, number])[] = [
  [0.86, 0.80, 0.62], // core
  [0.80, 0.62, 0.44], // commercial
  [0.62, 0.66, 0.74], // residential
  [0.60, 0.44, 0.44], // industrial
  [0.46, 0.66, 0.72], // port
  [0.56, 0.66, 0.44], // agricultural
  [0.62, 0.60, 0.64], // military
];

interface GeometryEntry {
  readonly generation: number;
  readonly lod: CityLod;
  readonly geometry: CityGeometry;
}

interface CorridorEntry {
  /** Planet-fixed metres, 3 per point. */
  readonly points: Float64Array;
  readonly kind: number;
  /** Bridge sub-spans, as point indices into `points`. */
  readonly bridgeAt: Int32Array;
}

export interface CitySceneOptions {
  /** Planet radius in metres. The world does not carry one; the shell does. */
  readonly radiusM?: number;
  /** Cities considered per frame, by population. The rest are not drawn. */
  readonly maxCities?: number;
  readonly maxBuildings?: number;
  readonly maxInstances?: number;
  /** Corridor points sampled per link. Caps the cost of a long sea-to-sea road. */
  readonly maxCorridorPoints?: number;
}

export interface CitySceneResult {
  readonly scene: CityScene;
  readonly stats: CitySceneStats;
  /** Cities whose full layout was requested from `sim` this frame. */
  readonly detailedCities: number;
  readonly buildMs: number;
}

/**
 * Turns the world into a batch of boxes for `PlanetRenderer.cityScene`.
 *
 * Stateful only in its caches. Two adapters over the same world produce the
 * same scene, which is what makes a frame comparison meaningful.
 */
export class CitySceneAdapter {
  private readonly geometry = new Map<number, GeometryEntry>();
  private readonly corridors: CorridorEntry[] = [];
  private corridorGeneration = -1;
  private ports = new Float64Array(0);
  private buffer: Float32Array = new Float32Array(0);
  private links: InfrastructureLink[] = [];

  constructor(private readonly options: CitySceneOptions = {}) {}

  /** Drop every cache. Correct at any time; the next frame rebuilds. */
  reset(): void {
    this.geometry.clear();
    this.corridors.length = 0;
    this.corridorGeneration = -1;
    this.ports = new Float64Array(0);
  }

  build(world: World, cam: { x: number; y: number; z: number }): CitySceneResult {
    const started = nowMs();
    const maxCities = this.options.maxCities ?? 192;
    const maxInstances = this.options.maxInstances ?? 1 << 16;
    if (this.buffer.length < maxInstances * 20) this.buffer = new Float32Array(maxInstances * 20);

    const radius = this.options.radiusM ?? EARTH_GEOMETRY.radius;
    const h = world.hydrology;

    /* Largest first: from orbit the cap should drop hamlets, not capitals. */
    const candidates = [...world.cities.cities]
      .sort((a, b) => b.population - a.population || a.id - b.id)
      .slice(0, maxCities);

    const geometries: CityGeometry[] = [];
    let detailed = 0;
    for (const city of candidates) {
      if (city.cell < 0 || city.cell >= h.cellCount) continue;
      const sampler = cityTerrainSampler(h, city.cell);
      const baseZ = Math.max(sampler.elevationAt(0, 0), h.seaLevelM);
      const frame = surfaceFrameAt(city.cell, h.level, radius + baseZ);
      const dx = frame.ox - cam.x;
      const dy = frame.oy - cam.y;
      const dz = frame.oz - cam.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const tier = cityTierFor(distance, Math.max(1, city.radiusM));

      if (tier === CITY_TIER.AGGREGATE) {
        geometries.push(aggregateGeometry(frame, Math.max(1, city.radiusM)));
        continue;
      }
      /* Only now is a layout worth asking for. Requesting PLOTS for a city
         that is one pixel wide is how the M9 cache budget gets spent on
         geometry nobody can see. */
      const lod: CityLod = tier === CITY_TIER.ARTERIAL ? CITY_LOD.ARTERIALS
        : tier === CITY_TIER.STREET ? CITY_LOD.STREETS : CITY_LOD.PLOTS;
      geometries.push(this.geometryFor(world, city, lod, frame, baseZ));
      detailed++;
    }

    const links = this.infrastructure(world);
    const scene = buildCityScene({
      camX: cam.x, camY: cam.y, camZ: cam.z,
      cities: geometries,
      links,
      ports: this.ports,
      maxInstances,
      ...(this.options.maxBuildings === undefined ? {} : { maxBuildings: this.options.maxBuildings }),
    }, this.buffer);

    return { scene, stats: scene.stats, detailedCities: detailed, buildMs: nowMs() - started };
  }

  private geometryFor(
    world: World, city: CityState, lod: CityLod, frame: SurfaceFrame, baseZ: number,
  ): CityGeometry {
    const hit = this.geometry.get(city.id);
    /* A cached layout at a HIGHER lod satisfies a lower request, matching the
       rule `cityLayout` itself uses, so backing away from a city does not throw
       its streets away and then rebuild them on the way back in. */
    if (hit !== undefined && hit.generation === city.layoutGeneration && hit.lod >= lod) {
      return { ...hit.geometry, frame };
    }
    const layout = cityLayout(world.cities, city, world.hydrology, lod);
    const geometry = geometryFromLayout(layout, frame, baseZ);
    this.geometry.set(city.id, { generation: city.layoutGeneration, lod, geometry });
    if (this.geometry.size > 256) {
      /* Bounded. The layouts themselves are budgeted by M9's own cache; this
         map only holds the render-side view of them. */
      const oldest = this.geometry.keys().next();
      if (!oldest.done) this.geometry.delete(oldest.value);
    }
    return geometry;
  }

  /**
   * Physical corridors for the transport network.
   *
   * SEA AND RIVER LINKS ARE NOT DRAWN. A sea lane is a route, not a built
   * thing: drawing a box along it would assert an installation that does not
   * exist. Ports are drawn, because a port IS built, and M10 decided where.
   */
  private infrastructure(world: World): readonly InfrastructureLink[] {
    const net = world.economy.network;
    const h = world.hydrology;
    const radius = this.options.radiusM ?? EARTH_GEOMETRY.radius;
    if (net.topologyGeneration !== this.corridorGeneration) {
      this.corridors.length = 0;
      const maxPoints = this.options.maxCorridorPoints ?? 96;
      const portCells = new Set<number>();
      for (const edge of net.edges) {
        if (edge.mode === MODE.SEA || edge.mode === MODE.RIVER) {
          if (edge.route.portA >= 0) portCells.add(edge.route.portA);
          if (edge.route.portB >= 0) portCells.add(edge.route.portB);
          continue;
        }
        const cells = edge.route.cells;
        if (cells.length < 2) continue;
        const stride = Math.max(1, Math.ceil(cells.length / maxPoints));
        const kept: number[] = [];
        for (let i = 0; i < cells.length; i += stride) kept.push(cells[i] as number);
        const last = cells[cells.length - 1] as number;
        if (kept[kept.length - 1] !== last) kept.push(last);
        const points = new Float64Array(kept.length * 3);
        for (let i = 0; i < kept.length; i++) {
          const cell = kept[i] as number;
          const u = unitAtCell(cell, h.level);
          const r = radius + Math.max(h.elevationM[cell] as number, h.seaLevelM) + 4;
          points[i * 3] = u[0] * r;
          points[i * 3 + 1] = u[1] * r;
          points[i * 3 + 2] = u[2] * r;
        }
        const bridgeSet = new Set<number>(Array.from(edge.route.bridgeCells));
        const bridgeAt: number[] = [];
        for (let i = 0; i < kept.length; i++) if (bridgeSet.has(kept[i] as number)) bridgeAt.push(i);
        this.corridors.push({
          points,
          kind: edge.mode === MODE.RAIL ? CITY_KIND.RAIL : CITY_KIND.ROAD,
          bridgeAt: Int32Array.from(bridgeAt),
        });
      }
      const ports = new Float64Array(portCells.size * 3);
      let p = 0;
      for (const cell of [...portCells].sort((a, b) => a - b)) {
        const u = unitAtCell(cell, h.level);
        const r = radius + Math.max(h.elevationM[cell] as number, h.seaLevelM);
        ports[p++] = u[0] * r;
        ports[p++] = u[1] * r;
        ports[p++] = u[2] * r;
      }
      this.ports = ports;
      this.corridorGeneration = net.topologyGeneration;
      this.links = [];
    }

    /* Quality changes every tick while the corridor does not, so widths are
       refreshed per frame over the cached geometry. */
    const out: InfrastructureLink[] = this.links.length === this.corridors.length ? this.links : [];
    if (out.length === 0) {
      for (let i = 0; i < this.corridors.length; i++) {
        const c = this.corridors[i] as CorridorEntry;
        const edge = net.edges[i];
        out.push({ points: c.points, kind: c.kind as InfrastructureLink['kind'],
          quality: edge?.quality ?? 0.5 });
      }
      this.links = out;
      return out;
    }
    for (let i = 0; i < out.length; i++) {
      const edge = net.edges[i];
      if (edge !== undefined && out[i]!.quality !== edge.quality) {
        out[i] = { points: out[i]!.points, kind: out[i]!.kind, quality: edge.quality };
      }
    }
    return out;
  }
}

/** A planet-fixed frame at a cell centre, lifted to `radius` metres. */
export function surfaceFrameAt(cell: number, level: number, radius: number): SurfaceFrame {
  const f = localFrameAtCell(cell, level);
  return {
    ox: f.ox * radius, oy: f.oy * radius, oz: f.oz * radius,
    ex: f.ex, ey: f.ey, ez: f.ez,
    nx: f.nx, ny: f.ny, nz: f.nz,
    ux: f.ox, uy: f.oy, uz: f.oz,
  };
}

function unitAtCell(cell: number, level: number): readonly [number, number, number] {
  const f = localFrameAtCell(cell, level);
  return [f.ox, f.oy, f.oz];
}

const EMPTY_F32 = new Float32Array(0);
const EMPTY_I32 = new Int32Array(0);
const EMPTY_U8 = new Uint8Array(0);

/** A city with no drawable detail: from orbit, one block is the whole claim. */
function aggregateGeometry(frame: SurfaceFrame, radiusM: number): CityGeometry {
  return {
    frame, radiusM,
    nodeXY: EMPTY_F32, nodeZ: EMPTY_F32, nodeCount: 0,
    edges: EMPTY_I32, edgeClass: EMPTY_U8, edgeCount: 0,
    bridgeEdges: EMPTY_I32, bridgeCount: 0,
    buildings: EMPTY_F32, buildingDistrict: EMPTY_U8, buildingCount: 0,
    districtTint: EMPTY_F32,
  };
}

/**
 * Translate an M9 layout into render geometry.
 *
 * The only real transform is the vertical datum: a layout's `nodeZ` is absolute
 * terrain elevation, while the surface frame sits at the city's own base
 * height, so heights are re-expressed relative to that origin. Getting this
 * wrong buries a mountain city or floats a coastal one.
 */
export function geometryFromLayout(
  layout: CityLayout, frame: SurfaceFrame, baseZ: number,
): CityGeometry {
  const nodeZ = new Float32Array(layout.nodeCount);
  for (let i = 0; i < layout.nodeCount; i++) nodeZ[i] = (layout.nodeZ[i] as number) - baseZ;

  const tint = new Float32Array(Math.max(1, layout.districtCount) * 3);
  for (let i = 0; i < layout.districtCount; i++) {
    const kind = layout.districtKind[i] as number;
    const c = DISTRICT_TINT[kind] ?? DISTRICT_TINT[2] as readonly [number, number, number];
    /* Development darkens nothing and brightens nothing dramatic; it just makes
       a half-built quarter read as one. */
    const d = 0.55 + 0.45 * (layout.districtDevelopment[i] as number);
    tint[i * 3] = c[0] * d;
    tint[i * 3 + 1] = c[1] * d;
    tint[i * 3 + 2] = c[2] * d;
  }

  return {
    frame,
    radiusM: layout.radiusM,
    nodeXY: layout.nodeXY,
    nodeZ,
    nodeCount: layout.nodeCount,
    edges: layout.edges,
    edgeClass: layout.edgeClass,
    edgeCount: layout.edgeCount,
    bridgeEdges: layout.bridgeEdges,
    bridgeCount: layout.bridgeCount,
    buildings: layout.buildings,
    buildingDistrict: layout.buildingDistrict,
    buildingCount: layout.buildingCount,
    districtTint: tint,
  };
}

/** Wall-clock only; never reaches simulation state (DEC-017). */
function nowMs(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p === undefined ? 0 : p.now();
}
