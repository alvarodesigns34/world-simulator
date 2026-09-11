/**
 * LOD selection (T-0014, DEC-010, DEC-032, DEC-034).
 *
 * Traverses the cube-sphere quadtree and returns the visible patch set.
 *
 * CULL ORDER IS DELIBERATE: horizon, then frustum, then screen-space error.
 * On a sphere seen from orbit roughly half the surface faces away from the
 * camera and a frustum test does not remove any of it, so the horizon test
 * rejects the most patches for the least arithmetic. DEC-034 puts it in the M1
 * contract for exactly that reason: tuning tau against a patch set twice the
 * real size would mean measuring everything twice.
 *
 * THE BUDGET IS A FUNCTION, NOT A CONSTANT (DEC-032). The selector asks
 * `resolvePatchBudget` what it may spend on this device at this resolution.
 * Architecture v0 shipped `maxVisiblePatches: 1200` and `tau: 2.0px` as if they
 * were one design; at 1440p they differ by ~5x and 65x65 patches at that count
 * would be 0.45 px/triangle.
 */

import { budgets, v3, vdot, vlen, vnorm, vsub, type Vec3 } from '@ws/core';
import { quadkey, type PlanetGeometry, type QuadKey } from '@ws/data';
import type { CameraState } from '../camera/state.js';
import { childNodes, rootNodes, type PatchNode } from './quadtree.js';

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
}

/**
 * Horizon culling (DEC-034 rule 1).
 *
 * The planet is the occluder. For a camera at C (from the planet centre) and a
 * point P, the tangent condition on a sphere of radius R_occ is
 *
 *     visible  <=>  dot(P, C) >= R_occ^2
 *
 * which is exact: at the tangent point |P| = R_occ and dot(P, C) = R_occ^2.
 *
 * For a BOUNDING SPHERE of radius r centred at P, keep it if ANY point in it
 * could be visible. The maximum of dot(Q, C) over that sphere is
 * dot(P, C) + r|C|, so the test relaxes to
 *
 *     visible  <=>  dot(P, C) >= R_occ^2 - r|C|
 *
 * NOTE WHICH TERM GROWS. Tall terrain and the atmosphere shell make the NODE
 * bigger, not the occluder. Inflating R_occ instead would raise the threshold
 * and cull MORE, which is exactly backwards — the planet still occludes at its
 * solid radius however tall its mountains are.
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

/** Conservative frustum test against a bounding sphere, in camera-relative space. */
function inFrustum(
  centre: Vec3,
  radius: number,
  cam: CameraState,
  forward: Vec3,
  aspect: number,
  near: number,
): boolean {
  const rel = vsub(centre, v3(cam.position.x, cam.position.y, cam.position.z));
  const z = vdot(rel, forward);
  if (z + radius < near) return false;

  // Half-angle test, widened by the bounding radius. Cheap and conservative:
  // it may keep a patch that a plane test would reject, never the reverse.
  const dist = vlen(rel);
  if (dist <= radius) return true;
  const halfV = Math.atan(Math.tan(cam.fovY / 2));
  const halfH = Math.atan(Math.tan(cam.fovY / 2) * aspect);
  const maxHalf = Math.max(halfV, halfH);
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

  const budget = budgets.resolvePatchBudget({
    pixelCount: opts.viewportWidth * opts.viewportHeight,
    gpuTier: opts.gpuTier,
    patchVerticesPerSide: opts.patchVerticesPerSide,
    ...(opts.screenSpaceErrorPx !== undefined
      ? { screenSpaceErrorPx: opts.screenSpaceErrorPx }
      : {}),
  });

  const camPos = v3(cam.position.x, cam.position.y, cam.position.z);
  const forward = vnorm(
    v3(
      -(2 * (cam.orientation.x * cam.orientation.z + cam.orientation.w * cam.orientation.y)),
      -(2 * (cam.orientation.y * cam.orientation.z - cam.orientation.w * cam.orientation.x)),
      -(1 - 2 * (cam.orientation.x * cam.orientation.x + cam.orientation.y * cam.orientation.y)),
    ),
  );
  const near = Math.min(1000, Math.max(0.05, Math.abs(vlen(camPos) - planet.radius) * 1e-4));

  // The occluder is the solid planet. Terrain height and the atmosphere shell
  // inflate each NODE's radius instead (see `horizonVisible`).
  const occluderRadius = planet.radius;
  const nodeInflation = maxElev + budgets.QUALITY.horizonCullAtmosphereMarginM;

  const stats: SelectStats = {
    nodesVisited: 0,
    culledHorizon: 0,
    culledFrustum: 0,
    visible: 0,
    triangles: 0,
    maxLevelReached: 0,
    budgetPatches: budget.maxVisiblePatches,
    budgetExhausted: false,
  };

  const visible: PatchNode[] = [];
  const split = new Set<number>();
  const mergeThreshold = budget.screenSpaceErrorPx * budgets.QUALITY.lodHysteresis;

  // Explicit stack, traversed in a fixed order, so the visible set is a pure
  // function of (camera, options) — not of recursion or allocation order.
  const stack: PatchNode[] = [...rootNodes(planet, maxElev)].reverse();

  while (stack.length > 0) {
    const node = stack.pop() as PatchNode;
    stats.nodesVisited++;

    if (
      useHorizon &&
      !horizonVisible(node.centre, node.radius + nodeInflation, camPos, occluderRadius)
    ) {
      stats.culledHorizon++;
      continue;
    }
    if (useFrustum && !inFrustum(node.centre, node.radius, cam, forward, aspect, near)) {
      stats.culledFrustum++;
      continue;
    }

    const dist = Math.max(
      1e-3,
      vlen(vsub(node.centre, camPos)) - node.radius,
    );
    const sse = screenSpaceError(node.geometricError, dist, opts.viewportHeight, cam.fovY);

    // Hysteresis (DEC-034 rule 5): a node already split needs its error to fall
    // below tau/hysteresis before it merges back.
    const wasSplit = opts.previouslySplit?.has(quadkey.packId(node.key)) ?? false;
    const threshold = wasSplit ? budget.screenSpaceErrorPx / budgets.QUALITY.lodHysteresis : budget.screenSpaceErrorPx;

    const canSplit =
      node.key.level < maxLevel && visible.length + stack.length < budget.maxVisiblePatches;

    if (sse > threshold && canSplit) {
      split.add(quadkey.packId(node.key));
      const kids = childNodes(node, planet, maxElev);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as PatchNode);
      continue;
    }

    if (visible.length >= budget.maxVisiblePatches) {
      stats.budgetExhausted = true;
      continue;
    }
    visible.push(node);
    stats.maxLevelReached = Math.max(stats.maxLevelReached, node.key.level);
    void mergeThreshold;
  }

  stats.visible = visible.length;
  stats.triangles = visible.length * budget.trianglesPerPatch;
  return { visible, split, stats };
}

/** Deterministic ordering for the visible set, used by tests and by rendering. */
export function sortVisible(nodes: readonly PatchNode[]): readonly PatchNode[] {
  return [...nodes].sort((a, b) => quadkey.compare(a.key, b.key));
}

export type { QuadKey };
