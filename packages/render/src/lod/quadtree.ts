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

import { v3, vlen, vnorm, vscale, type Vec3 } from '@ws/core';
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

  // Corners plus centre, on the unit sphere.
  const corners: Vec3[] = [];
  for (const [u, v] of [
    [u0, v0],
    [u1, v0],
    [u0, v1],
    [u1, v1],
  ] as const) {
    const p = cubeFaceToUnit({ face: key.face, u, v });
    corners.push(v3(p.x, p.y, p.z));
  }
  const c = quadkey.centerCubeFace(key);
  const cu = cubeFaceToUnit(c);
  const normal = v3(cu.x, cu.y, cu.z);

  const surfaceR = planet.radius + maxTerrainElevation;

  // Bounding sphere: centred on the mean of the corner points lifted to the
  // surface, radius = max corner distance. Conservative, cheap, and exact enough
  // for culling.
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (const p of corners) {
    mx += p.x;
    my += p.y;
    mz += p.z;
  }
  const meanDir = vnorm(v3(mx / 4, my / 4, mz / 4));
  const centre = vscale(meanDir, planet.radius);

  let radius = 0;
  for (const p of corners) {
    const lifted = vscale(p, surfaceR);
    radius = Math.max(radius, vlen(v3(lifted.x - centre.x, lifted.y - centre.y, lifted.z - centre.z)));
  }
  // Also account for elevation directly under the centre.
  radius = Math.max(radius, maxTerrainElevation);

  // Sagitta of the node's arc: R * (1 - cos(theta/2)), theta = arc / R.
  const arc = cellSize(key.level, planet) * 1.0;
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

/** The six root nodes, one per cube face, in fixed face order. */
export function rootNodes(planet: PlanetGeometry, maxTerrainElevation = 0): readonly PatchNode[] {
  const out: PatchNode[] = [];
  for (let face = 0; face < 6; face++) {
    out.push(makeNode(quadkey.rootKey(face), planet, maxTerrainElevation));
  }
  return out;
}

export function childNodes(
  node: PatchNode,
  planet: PlanetGeometry,
  maxTerrainElevation = 0,
): readonly PatchNode[] {
  return quadkey
    .children(node.key)
    .map((k) => makeNode(k, planet, maxTerrainElevation));
}
