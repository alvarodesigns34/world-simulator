/**
 * LOD selection (T-0014, DEC-010, DEC-032, DEC-034).
 *
 * Traverses the cube-sphere quadtree and returns the visible patch set.
 *
 * CULL ORDER IS DELIBERATE: horizon, then frustum, then screen-space error.
 * On a sphere seen from orbit roughly half the surface faces away from the
 * camera and a frustum test does not remove any of it, so the horizon test
 * rejects the most patches for the least arithmetic.
 *
 * THE BUDGET IS A FUNCTION, NOT A CONSTANT (DEC-032).
 *
 * Allocation: pass a `NodePool` and a `SelectWorkspace` owned by the renderer.
 * Semantics are unchanged: a cached node is bit-identical to a freshly built
 * one because `makeNode` is pure. The workspace reuses the stack / visible
 * array / lod-count buffer; the output `split` set is always a fresh Set so
 * the caller can hold it as `previouslySplit` without it being cleared next
 * frame.
 */

import { budgets, vdot, vlen, type Vec3 } from '@ws/core';
import { quadkey, type PlanetGeometry } from '@ws/data';
import type { CameraState } from '../camera/state.js';
import { childNodes, rootNodes, type NodePool, type PatchNode } from './quadtree.js';

export interface SelectWorkspace {
  stack: PatchNode[];
  visible: PatchNode[];
  lodCounts: number[];
}

export function createSelectWorkspace(): SelectWorkspace {
  return { stack: [], visible: [], lodCounts: [] };
}

export interface SelectOptions {
  readonly planet: PlanetGeometry;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly gpuTier: budgets.GpuTier;
  readonly patchVerticesPerSide: number;
  readonly screenSpaceErrorPx?: number;
  readonly maxTerrainElevation?: number;
  /** Cap traversal depth. M1 does not need L19. */
  readonly maxLevel?: number;
  readonly enableHorizonCull?: boolean;
  readonly enableFrustumCull?: boolean;
  /**
   * Keys visible on the previous frame. Used for hysteresis (DEC-034 rule 5):
   * a node already split stays split until its error falls below tau/hysteresis,
   * so a node sitting on the threshold cannot oscillate.
   */
  readonly previouslySplit?: ReadonlySet<number>;
  /** Optional persistent node cache. Same keys → same nodes, fewer `tan`s. */
  readonly pool?: NodePool;
  /** Optional reused buffers. `visible` is invalidated by the next call. */
  readonly workspace?: SelectWorkspace;
}

export interface SelectResult {
  readonly visible: readonly PatchNode[];
  /** Keys that were split this frame; feed back as `previouslySplit`. */
  readonly split: ReadonlySet<number>;
  readonly stats: SelectStats;
}

export interface SelectStats {
  nodesVisited: number;
  culledHorizon: number;
  culledFrustum: number;
  visible: number;
  triangles: number;
  maxLevelReached: number;
  budgetPatches: number;
  budgetExhausted: boolean;
  /** Count of visible patches at each level. Index = level. */
  lodCounts: readonly number[];
  poolHits: number;
  poolMisses: number;
}

/**
 * Horizon culling (DEC-034 rule 1).
 *
 * The planet is the occluder. For a camera at C (from the planet centre) and a
 * point P, the tangent condition on a sphere of radius R_occ is
 *
 *     visible  <=>  dot(P, C) >= R_occ^2
 *
 * For a BOUNDING SPHERE of radius r centred at P, keep it if ANY point in it
 * could be visible. The maximum of dot(Q, C) over that sphere is
 * dot(P, C) + r|C|, so the test relaxes to
 *
 *     visible  <=>  dot(P, C) >= R_occ^2 - r|C|
 *
 * NOTE WHICH TERM GROWS. Tall terrain and the atmosphere shell make the NODE
 * bigger, not the occluder.
 */
export function horizonVisible(
  nodeCentre: Vec3,
  nodeRadius: number,
  cameraPos: Vec3,
  occluderRadius: number,
): boolean {
  const camLen = vlen(cameraPos);
  if (camLen <= occluderRadius) return true; // at or below the surface: nothing occludes
  const threshold = occluderRadius * occluderRadius - nodeRadius * camLen;
  return vdot(nodeCentre, cameraPos) >= threshold;
}

/**
 * Screen-space error in pixels.
 *
 * A geometric error of `e` metres at distance `d` subtends `e/d` radians, which
 * covers `(e/d) * (H/2) / tan(fovY/2)` pixels vertically.
 */
export function screenSpaceError(
  geometricError: number,
  distance: number,
  viewportHeight: number,
  fovY: number,
): number {
  if (distance <= 1e-6) return Number.POSITIVE_INFINITY;
  return (geometricError / distance) * (viewportHeight / 2 / Math.tan(fovY / 2));
}

/**
 * Conservative frustum test against a bounding sphere, in camera-relative space.
 * Scalar on purpose: the previous version allocated a `rel` Vec3 per node.
 */
function inFrustum(
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  camX: number,
  camY: number,
  camZ: number,
  fwdX: number,
  fwdY: number,
  fwdZ: number,
  maxHalf: number,
  near: number,
): boolean {
  const rx = cx - camX;
  const ry = cy - camY;
  const rz = cz - camZ;
  const z = rx * fwdX + ry * fwdY + rz * fwdZ;
  if (z + radius < near) return false;
  const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (dist <= radius) return true;
  const angleToCentre = Math.acos(Math.min(1, Math.max(-1, z / dist)));
  const angularRadius = Math.asin(Math.min(1, radius / dist));
  return angleToCentre - angularRadius <= maxHalf + 1e-3;
}

export function selectPatches(cam: CameraState, opts: SelectOptions): SelectResult {
  const planet = opts.planet;
  const maxElev = opts.maxTerrainElevation ?? 0;
  const maxLevel = opts.maxLevel ?? 12;
  const aspect = opts.viewportWidth / opts.viewportHeight;
  const useHorizon = opts.enableHorizonCull ?? true;
  const useFrustum = opts.enableFrustumCull ?? true;
  const pool = opts.pool;
  const ws = opts.workspace;

  const budget = budgets.resolvePatchBudget({
    pixelCount: opts.viewportWidth * opts.viewportHeight,
    gpuTier: opts.gpuTier,
    patchVerticesPerSide: opts.patchVerticesPerSide,
    ...(opts.screenSpaceErrorPx !== undefined
      ? { screenSpaceErrorPx: opts.screenSpaceErrorPx }
      : {}),
  });

  const camX = cam.position.x;
  const camY = cam.position.y;
  const camZ = cam.position.z;
  const ox = cam.orientation.x;
  const oy = cam.orientation.y;
  const oz = cam.orientation.z;
  const ow = cam.orientation.w;
  // Camera looks down local -Z.
  let fwdX = -(2 * (ox * oz + ow * oy));
  let fwdY = -(2 * (oy * oz - ow * ox));
  let fwdZ = -(1 - 2 * (ox * ox + oy * oy));
  const fwdLen = Math.sqrt(fwdX * fwdX + fwdY * fwdY + fwdZ * fwdZ) || 1;
  fwdX /= fwdLen;
  fwdY /= fwdLen;
  fwdZ /= fwdLen;

  const camLen = Math.sqrt(camX * camX + camY * camY + camZ * camZ);
  const near = Math.min(1000, Math.max(0.05, Math.abs(camLen - planet.radius) * 1e-4));
  const halfV = cam.fovY / 2;
  const halfH = Math.atan(Math.tan(cam.fovY / 2) * aspect);
  const maxHalf = Math.max(halfV, halfH);
  const sseScale = opts.viewportHeight / 2 / Math.tan(cam.fovY / 2);

  const occluderRadius = planet.radius;
  const nodeInflation = maxElev + budgets.QUALITY.horizonCullAtmosphereMarginM;
  const occ2 = occluderRadius * occluderRadius;

  const lodCounts = ws ? ws.lodCounts : [];
  lodCounts.length = maxLevel + 1;
  for (let i = 0; i <= maxLevel; i++) lodCounts[i] = 0;

  const stats: SelectStats = {
    nodesVisited: 0,
    culledHorizon: 0,
    culledFrustum: 0,
    visible: 0,
    triangles: 0,
    maxLevelReached: 0,
    budgetPatches: budget.maxVisiblePatches,
    budgetExhausted: false,
    lodCounts,
    poolHits: 0,
    poolMisses: 0,
  };

  const visible = ws ? ws.visible : [];
  visible.length = 0;
  const split = new Set<number>();
  const hysteresis = budgets.QUALITY.lodHysteresis;
  const tau = budget.screenSpaceErrorPx;
  const cap = budget.maxVisiblePatches;

  const stack = ws ? ws.stack : [];
  stack.length = 0;
  const roots = rootNodes(planet, maxElev, pool);
  for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i] as PatchNode);

  const hitsBefore = pool?.hits ?? 0;
  const missesBefore = pool?.misses ?? 0;

  while (stack.length > 0) {
    const node = stack.pop() as PatchNode;
    stats.nodesVisited++;

    const nx = node.centre.x;
    const ny = node.centre.y;
    const nz = node.centre.z;
    const nr = node.radius + nodeInflation;

    if (useHorizon && camLen > occluderRadius) {
      const threshold = occ2 - nr * camLen;
      if (nx * camX + ny * camY + nz * camZ < threshold) {
        stats.culledHorizon++;
        continue;
      }
    }
    if (
      useFrustum &&
      !inFrustum(nx, ny, nz, node.radius, camX, camY, camZ, fwdX, fwdY, fwdZ, maxHalf, near)
    ) {
      stats.culledFrustum++;
      continue;
    }

    const dx = nx - camX;
    const dy = ny - camY;
    const dz = nz - camZ;
    const dist = Math.max(1e-3, Math.sqrt(dx * dx + dy * dy + dz * dz) - node.radius);
    const sse = (node.geometricError / dist) * sseScale;

    const wasSplit = opts.previouslySplit?.has(quadkey.packId(node.key)) ?? false;
    const threshold = wasSplit ? tau / hysteresis : tau;

    // Reserve room for all four children as leaves. Splitting when only one
    // slot remains, then dropping the extra children, punched holes in the
    // mesh (parent already discarded, children not emitted).
    const canSplit =
      node.key.level < maxLevel && visible.length + stack.length + 4 <= cap;

    if (sse > threshold && canSplit) {
      split.add(quadkey.packId(node.key));
      const kids = childNodes(node, planet, maxElev, pool);
      stack.push(kids[3], kids[2], kids[1], kids[0]);
      continue;
    }

    if (visible.length >= cap) {
      stats.budgetExhausted = true;
      continue;
    }
    visible.push(node);
    stats.maxLevelReached = Math.max(stats.maxLevelReached, node.key.level);
    lodCounts[node.key.level] = (lodCounts[node.key.level] as number) + 1;
  }

  if (visible.length >= cap) stats.budgetExhausted = true;
  stats.visible = visible.length;
  stats.triangles = visible.length * budget.trianglesPerPatch;
  stats.poolHits = (pool?.hits ?? 0) - hitsBefore;
  stats.poolMisses = (pool?.misses ?? 0) - missesBefore;
  stats.lodCounts = lodCounts;
  return { visible, split, stats };
}

/** Deterministic ordering for the visible set, used by tests and by rendering. */
export function sortVisible(nodes: readonly PatchNode[]): readonly PatchNode[] {
  return [...nodes].sort((a, b) => quadkey.compare(a.key, b.key));
}

/** In-place variant: no copy. The renderer owns the array. */
export function sortVisibleInPlace(nodes: PatchNode[]): PatchNode[] {
  nodes.sort((a, b) => quadkey.compare(a.key, b.key));
  return nodes;
}
