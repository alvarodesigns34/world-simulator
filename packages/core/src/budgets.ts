/**
 * Performance budgets — THE single source of truth (DEC-024, restated by DEC-032).
 *
 * The dev HUD reads this, the LOD selector reads this, the performance tests read
 * this, and `docs/RENDERING.md` cites it. A budget that exists only in a document
 * is not a budget.
 *
 * WHAT CHANGED IN ARCHITECTURE v1 (DEC-032, from AUDIT-V0 B5).
 * M0 published `maxVisiblePatches: 1200` and `lodScreenSpaceErrorPx: 2.0` as if
 * they were one design. They were two independent guesses and they are not
 * simultaneously satisfiable:
 *
 *   65x65 patch          = 8192 triangles
 *   1000 patches @1440p  = 0.450 px/triangle      <- small-triangle cliff
 *   tau = 2.0 px         => patch spans ~128 px
 *                        => a full 1440p screen holds ~225 patches, not 1200
 *
 * GPU rasterisers shade 2x2 quads, so a sub-pixel triangle still costs a whole
 * quad. 8.2 M triangles was not "ambitious", it was a different design from the
 * one tau describes.
 *
 * So the budget is now a FUNCTION of the device and the settings, not a constant
 * that a selector reads directly. Constants read directly are how the
 * 1200-vs-2.0 contradiction survived a review.
 *
 * STATUS: the scalars below remain engineering ESTIMATES. E1 (patch-size sweep on
 * real GPUs) and E2 (reversed-Z vertex swim) have not run. See risk R-12.
 */

export type GpuTier = 'discrete' | 'integrated' | 'floor';

export interface HardwareTier {
  readonly id: GpuTier;
  readonly description: string;
  /** Approximate FP32 throughput, TFLOPS. Used only to document the span. */
  readonly tflops: number;
  readonly targetPixels: number;
  readonly targetFrameMs: number;
}

/**
 * Three tiers, not one sentence. M0 grouped Iris Xe (~1.5-2 TFLOPS), Apple M1
 * (~2.6) and RTX 3050 (~5-8) as "reference hardware", a 3-5x span that made
 * "60 FPS on reference hardware" unfalsifiable.
 */
export const TIERS: Readonly<Record<GpuTier, HardwareTier>> = {
  discrete: {
    id: 'discrete',
    description: 'RTX 3050 / RX 6600 class or better',
    tflops: 6,
    targetPixels: 2560 * 1440,
    targetFrameMs: 16.6,
  },
  integrated: {
    id: 'integrated',
    description: 'Apple M1 / M2 class',
    tflops: 2.6,
    targetPixels: 2560 * 1440,
    targetFrameMs: 16.6,
  },
  floor: {
    id: 'floor',
    description: 'Intel Iris Xe 96EU class — reduced settings are acceptable',
    tflops: 1.7,
    targetPixels: 1920 * 1080,
    targetFrameMs: 33.3,
  },
};

export interface FrameBudgetMs {
  readonly total: number;
  readonly zones: Readonly<Record<string, number>>;
}

/**
 * Main thread: 6.0 ms of a 16.6 ms frame. The headroom is for GC, browser
 * compositing and worker-message handling, none of which we control.
 */
export const MAIN_THREAD: FrameBudgetMs = {
  total: 6.0,
  zones: { input: 0.3, simCommit: 2.0, lodTraversal: 1.0, renderEncode: 2.0, ui: 0.7 },
};

export const GPU: FrameBudgetMs = {
  total: 10.0,
  zones: { terrain: 4.0, ocean: 1.5, atmosphere: 2.5, shadows: 1.0, post: 1.0 },
};

export const WORKERS = {
  /** Wall-clock cap per job, so cancellation stays responsive when the camera turns. */
  maxJobMs: 250,
  /**
   * Sim-time cap per job (DEC-030 Amendment 3, DEC-032 Amendment 3). A wall-clock
   * cap is not a cap once timeScale is 1e13: at the T4 rate DEC-015 names
   * (1 Myr per real second) a 250 ms job is ~250 000 simulated years of
   * committed-state lag. Paleo regimes must be cheap in sim time, not just fast.
   */
  maxJobSimYears: 5000,
  terrainTileBakeMs: 8,
  tilesPerSecondOn4Workers: 120,
  climateStepMs: 40,
  snapshotSaveMs: 5000,
  /**
   * Measured (AUDIT-V0 M3): structuredClone(50 MB) = 98 ms, transfer round-trip
   * = 34 ms. Both exceed a frame. Transfer is for TILE-sized payloads; SAB is
   * required for in-place L11 field updates.
   */
  maxTransferBytes: 1 * 1024 * 1024,
} as const;

export const MEMORY_BYTES = {
  simState: 700 * 1024 * 1024,
  tileCacheCpu: 300 * 1024 * 1024,
  gpu: 1200 * 1024 * 1024,
  /** Practical browser tab ceiling is ~2-4 GB; 2.5 leaves fragmentation margin. */
  totalTab: 2500 * 1024 * 1024,
} as const;

export const QUALITY = {
  /**
   * Screen-space error threshold for LOD split, in pixels (DEC-010).
   *
   * RAISED 2.0 -> 4.0 on 2026-09-12. This does NOT lower the delivered quality;
   * it stops the number from lying.
   *
   * The node error model reported the arc sagitta while the renderer draws a
   * bilinear quad whose true deviation is exactly 2x that (T-0063). A nominal
   * tau of 2.0 px was therefore delivering ~4.0 px of real deviation all along.
   * With the model corrected, 4.0 px means 4.0 px, and the descent reproduces
   * its previous behaviour almost exactly:
   *
   *              peak visible   maxDisappear   maxAppear   >1ms   exhausted
   *   before          -              57            48       24        0
   *   tau 2.0 fixed  900*           211           212       51       15   <- saturated
   *   tau 4.0        759             56            48        8        0
   *
   * Setting tau to 2.0 with the truthful model saturates the 900-patch cap at
   * ~2.2e6 m and the truncation causes 200-patch churn per frame, which is far
   * worse than the sag it was trying to remove.
   *
   * Nobody has judged 4 px by eye. That is Astra's call, and it is now an
   * honest question rather than a number that meant something else.
   *
   * NOTE FOR E1 (T-0050): because tessellation is geometrically inert while the
   * shader interpolates only four corners, patch COUNT alone sets accuracy. At
   * equal tau, 17x17 gives the same geometry as 33x33 for ~3.75x fewer
   * triangles (0.49 M vs 1.84 M at 8000 km) and has a 2048-patch budget instead
   * of 900, so it does not saturate at all. That inverts the CPU-only
   * "keep 33x33" conclusion — but only until M2 puts real displacement on those
   * vertices. Decide it with the GPU column, not from here.
   */
  lodScreenSpaceErrorPx: 4.0,
  /** Merge at split * this, so a node on the threshold cannot oscillate (DEC-034). */
  lodHysteresis: 1.5,
  /**
   * The small-triangle floor (DEC-032). Mean triangle area must not fall below
   * this, whatever tau and the patch size would otherwise allow.
   */
  minPxPerTriangle: 2.0,
  /** Default patch size. A KNOB, not an architectural truth — E1 decides. */
  patchVerticesPerSide: 33,
  /** Hard ceiling regardless of what the tau-derived budget says. */
  absoluteMaxVisiblePatches: 2048,
  maxPopInMs: 400,
  maxFrameMsDuringDescent: 33,
  maxFramesOver33msPerRegimeTransition: 2,
  coldStartMs: 4000,
  telemetryOverheadMs: 0.2,
  /** Atmosphere shell added to the horizon-cull radius so the limb is not clipped. */
  horizonCullAtmosphereMarginM: 100_000,
} as const;

export function patchTriangles(verticesPerSide: number): number {
  return (verticesPerSide - 1) ** 2 * 2;
}

export function patchVertices(verticesPerSide: number): number {
  return verticesPerSide ** 2;
}

export interface PatchBudgetRequest {
  readonly pixelCount: number;
  readonly gpuTier: GpuTier;
  readonly patchVerticesPerSide: number;
  /** Screen-space error target in pixels; defaults to QUALITY.lodScreenSpaceErrorPx. */
  readonly screenSpaceErrorPx?: number;
}

export interface PatchBudget {
  readonly maxVisiblePatches: number;
  readonly screenSpaceErrorPx: number;
  readonly trianglesPerPatch: number;
  readonly maxTriangles: number;
  readonly pxPerTriangle: number;
  /** Which constraint actually bound the result. Shown in the HUD. */
  readonly limitedBy: 'pixel-area' | 'tier' | 'absolute-cap';
}

/**
 * Resolve the admissible patch budget for a device (DEC-032 Amendment 1).
 *
 * Everything that wants to know "how many patches may be visible" calls this —
 * the LOD selector, the HUD and the perf tests — so a non-reference device gets a
 * budget rather than a failure, and so the numbers can never disagree with each
 * other again.
 */
export function resolvePatchBudget(req: PatchBudgetRequest): PatchBudget {
  const tris = patchTriangles(req.patchVerticesPerSide);
  const tau = req.screenSpaceErrorPx ?? QUALITY.lodScreenSpaceErrorPx;

  // 1. The small-triangle floor: mean triangle area >= minPxPerTriangle.
  const byPixelArea = Math.floor(req.pixelCount / (QUALITY.minPxPerTriangle * tris));

  // 2. Tier scaling. The floor tier gets a smaller share of its own pixels,
  //    because it has less of everything else too.
  const tierScale = req.gpuTier === 'discrete' ? 1.0 : req.gpuTier === 'integrated' ? 0.7 : 0.45;
  const byTier = Math.floor(byPixelArea * tierScale);

  // 3. The absolute cap, which exists so a huge viewport cannot produce a
  //    traversal cost the CPU budget cannot pay.
  const capped = Math.min(byTier, QUALITY.absoluteMaxVisiblePatches);

  const limitedBy: PatchBudget['limitedBy'] =
    capped === QUALITY.absoluteMaxVisiblePatches
      ? 'absolute-cap'
      : tierScale < 1.0
        ? 'tier'
        : 'pixel-area';

  const maxVisiblePatches = Math.max(1, capped);
  const maxTriangles = maxVisiblePatches * tris;

  return {
    maxVisiblePatches,
    screenSpaceErrorPx: tau,
    trianglesPerPatch: tris,
    maxTriangles,
    pxPerTriangle: req.pixelCount / maxTriangles,
    limitedBy,
  };
}
