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
   * Geometric error in metres: how far this node's mesh can deviate from the
   * true surface. For a smooth sphere it is the sagitta of the node's arc; with
   * real terrain a tile's measured error replaces it (DEC-010).
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
export function makeNode(
  key: QuadKey,
  planet: PlanetGeometry,
  maxTerrainElevation = 0,
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

  // Sagitta of the node's arc: R * (1 - cos(theta/2)), theta = arc / R.
  const arc = cellSize(key.level, planet);
  const theta = arc / planet.radius;
  const sagitta = planet.radius * (1 - Math.cos(theta / 2));

  return {
    key,
    centre,
    radius,
    normal,
    geometricError: Math.max(sagitta, maxTerrainElevation * 0.5),
  };
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
    const node = makeNode(key, planet, maxTerrainElevation);
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
