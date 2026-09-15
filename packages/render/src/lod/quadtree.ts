/**
 * Cube-sphere quadtree nodes (T-0014, DEC-007, DEC-010, DEC-034).
 *
 * A node is addressed by its QuadKey, which is simultaneously the LOD identity,
 * the tile cache key, the chunk seed key and the raster index — the unification
 * DEC-007 exists for.
 *
 * Each node caches the three quantities the selector needs: a bounding sphere,
 * a geometric error, and its corner directions. They are derived purely from the
 * QuadKey and the planet, so a node is reconstructible and cache eviction is
 * invisible (DEC-017).
 */

import { v3, vnorm, vscale, type Vec3 } from '@ws/core';
import {
  cellSize,
  cubeFaceToUnit,
  quadkey,
  type PlanetGeometry,
  type QuadKey,
} from '@ws/data';

export interface PatchNode {
  readonly key: QuadKey;
  /** Bounding sphere centre, PCF metres, f64. */
  readonly centre: Vec3;
  readonly radius: number;
  /** Outward unit normal at the node centre. */
  readonly normal: Vec3;
  /**
   * Geometric error in metres: how far this node's RENDERED mesh can deviate
   * from the true surface (DEC-010).
   *
   * This must describe the geometry we actually draw, not an idealised one.
   * The shader bilinearly interpolates the node's four sphere corners, so the
   * drawn surface is a bilinear quad whose worst deviation is at its CENTRE,
   * not at an edge midpoint. See `bilinearSag` for the derivation — it is
   * exactly 2x the arc sagitta, and using the sagitta made every
   * screen-space-error decision optimistic by that factor.
   *
   * A node without a measured error cannot participate in LOD selection,
   * because an unmeasured error is an unbounded screen-space error.
   */
  readonly geometricError: number;
}

/**
 * Build a node from its key. Pure: same key + planet -> same node, on any
 * machine, in any order.
 */
/**
 * How far the terrain a patch DRAWS can still deviate from the terrain that
 * exists, in metres (T-0151).
 *
 * WHY THIS HAD TO EXIST. The geometric error was the sphere's bilinear sag
 * alone — the deviation of a flat quad from a smooth ball. Once a patch's
 * 33x33 grid carries real elevations, that number stops describing the drawn
 * surface: at 1 km altitude the sag of an L12 patch is 0.23 m, which is 0.2
 * screen pixels, so the selector declared the patch good enough and stopped
 * refining while actual topography went unresolved. The planet looked like a
 * stretched texture close up because, by its own error metric, it was finished.
 *
 * A patch with `verticesPerSide` samples resolves detail down to its own grid
 * spacing; what it cannot resolve is everything finer. That residual is the
 * honest error, and it is what keeps the ladder descending.
 */
export type TerrainResidual = (level: number, verticesPerSide: number) => number;

export function makeNode(
  key: QuadKey,
  planet: PlanetGeometry,
  maxTerrainElevation = 0,
  terrainResidual?: TerrainResidual,
  verticesPerSide = 33,
): PatchNode {
  const [u0, v0, u1, v1] = quadkey.bounds(key);

  const p00 = cubeFaceToUnit({ face: key.face, u: u0, v: v0 });
  const p10 = cubeFaceToUnit({ face: key.face, u: u1, v: v0 });
  const p01 = cubeFaceToUnit({ face: key.face, u: u0, v: v1 });
  const p11 = cubeFaceToUnit({ face: key.face, u: u1, v: v1 });

  const c = quadkey.centerCubeFace(key);
  const cu = cubeFaceToUnit(c);
  const normal = v3(cu.x, cu.y, cu.z);

  const surfaceR = planet.radius + maxTerrainElevation;

  const meanDir = vnorm(v3((p00.x + p10.x + p01.x + p11.x) / 4, (p00.y + p10.y + p01.y + p11.y) / 4, (p00.z + p10.z + p01.z + p11.z) / 4));
  const centre = vscale(meanDir, planet.radius);

  const d = (p: { x: number; y: number; z: number }): number => {
    const lx = p.x * surfaceR - centre.x;
    const ly = p.y * surfaceR - centre.y;
    const lz = p.z * surfaceR - centre.z;
    return Math.sqrt(lx * lx + ly * ly + lz * lz);
  };
  const radius = Math.max(d(p00), d(p10), d(p01), d(p11), maxTerrainElevation);

  const error = bilinearSag(key.level, planet);
  const residual = terrainResidual?.(key.level, verticesPerSide) ?? 0;

  return {
    key,
    centre,
    radius,
    normal,
    geometricError: Math.max(error, residual, maxTerrainElevation * 0.5),
  };
}

/**
 * Worst-case radial deviation of the rendered bilinear patch from the sphere.
 *
 * The four corners lie ON the sphere; everything between them is a bilinear
 * blend of those corners, so the patch interior falls INSIDE the sphere. The
 * deepest point is the centre, at radius R·cos(θu/2)·cos(θv/2), so for a square
 * cell of angular size θ:
 *
 *     deviation = R(1 − cos²(θ/2)) = R·sin²(θ/2)
 *
 * The arc sagitta R(1 − cos(θ/2)) describes the EDGE midpoints and is smaller
 * by a factor of (1 + cos(θ/2)) → 2. Measured against a 64×64 sample of real
 * cells this closed form is accurate to five significant figures
 * (`docs/RENDERING.md` §4.0b).
 *
 * NOTE FOR M2: increasing `patchVerticesPerSide` does NOT reduce this. Every
 * grid vertex lies on the same bilinear quad, so tessellation is currently
 * geometrically inert — accuracy comes only from splitting patches. Spherical
 * interpolation is what makes tessellation pay, and M2 needs it anyway for
 * terrain displacement.
 */
export function bilinearSag(level: number, planet: PlanetGeometry): number {
  const theta = cellSize(level, planet) / planet.radius;
  const s = Math.sin(theta / 2);
  return planet.radius * s * s;
}

/** The arc sagitta — the EDGE-midpoint deviation. Kept for comparison and
 *  documentation; it is not what the renderer draws. */
export function arcSagitta(level: number, planet: PlanetGeometry): number {
  return planet.radius * (1 - Math.cos(cellSize(level, planet) / planet.radius / 2));
}

/**
 * Persistent node cache. `makeNode` is pure but not cheap (four cube-sphere
 * conversions, each a pair of `tan`). The selector visits the same few hundred
 * keys every frame; the pool makes that O(1) after the first look.
 *
 * Not a module-level singleton — the renderer owns one. Protocol §8.
 */
export class NodePool {
  private readonly map = new Map<number, PatchNode>();
  private elev = 0;
  hits = 0;
  misses = 0;

  /**
   * `terrainResidual` makes cached nodes carry a terrain-aware error (T-0151).
   * It belongs to the pool rather than to each call because it must be the
   * same for every node — an error metric that varied per lookup would make
   * split decisions depend on call order.
   */
  constructor(
    private readonly terrainResidual?: TerrainResidual,
    private readonly verticesPerSide = 33,
  ) {}

  get(key: QuadKey, planet: PlanetGeometry, maxTerrainElevation: number): PatchNode {
    if (maxTerrainElevation !== this.elev) {
      this.map.clear();
      this.elev = maxTerrainElevation;
      this.hits = 0;
      this.misses = 0;
    }
    const id = quadkey.packId(key);
    const cached = this.map.get(id);
    if (cached !== undefined) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const node = makeNode(key, planet, maxTerrainElevation, this.terrainResidual, this.verticesPerSide);
    this.map.set(id, node);
    return node;
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/** The six root nodes, one per cube face, in fixed face order. */
export function rootNodes(
  planet: PlanetGeometry,
  maxTerrainElevation = 0,
  pool?: NodePool,
): readonly PatchNode[] {
  const out: PatchNode[] = [];
  for (let face = 0; face < 6; face++) {
    const key = quadkey.rootKey(face);
    out.push(pool ? pool.get(key, planet, maxTerrainElevation) : makeNode(key, planet, maxTerrainElevation));
  }
  return out;
}

export function childNodes(
  node: PatchNode,
  planet: PlanetGeometry,
  maxTerrainElevation = 0,
  pool?: NodePool,
): readonly [PatchNode, PatchNode, PatchNode, PatchNode] {
  const kids = quadkey.children(node.key);
  const get = (k: QuadKey): PatchNode =>
    pool ? pool.get(k, planet, maxTerrainElevation) : makeNode(k, planet, maxTerrainElevation);
  return [get(kids[0]), get(kids[1]), get(kids[2]), get(kids[3])];
}
