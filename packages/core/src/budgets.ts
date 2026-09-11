/**
 * Performance budgets — THE single source of truth (DEC-024).
 *
 * The dev HUD reads this, the performance tests read this, and `docs/RENDERING.md`
 * cites it. A budget that exists only in a document is not a budget.
 *
 * STATUS: every number here is an engineering ESTIMATE, not a measurement.
 * They are set by reasoning in `docs/RENDERING.md` §7 and are due to be
 * corrected by measurement at M1. See risk R-12 and task T-0024.
 *
 * AUDIT (Grok, 2026-09-11, docs/AUDIT-V0.md, DEC-032 Proposed):
 *   1000 × 65×65 at 1440p = 0.45 px/triangle; Iris Xe cannot share an RTX 3050
 *   terrain budget; structuredClone(50 MB) ≈ 98 ms. Do not silently edit these
 *   numbers — a budget change is an ADR (PROTOCOL §5.1).
 *
 * Reference hardware: 2021+ laptop (Apple M1 / RTX 3050 / Iris Xe class),
 * Chromium, 1440p, 60 FPS => 16.6 ms/frame.
 */

export interface FrameBudgetMs {
  readonly total: number;
  readonly zones: Readonly<Record<string, number>>;
}

/** Main thread: 6.0 ms of a 16.6 ms frame. The headroom is for GC, compositing
 *  and worker-message handling, all of which are outside our control. */
export const MAIN_THREAD: FrameBudgetMs = {
  total: 6.0,
  zones: {
    input: 0.3,
    simCommit: 2.0,
    lodTraversal: 1.0,
    renderEncode: 2.0,
    ui: 0.7,
  },
};

export const GPU: FrameBudgetMs = {
  total: 10.0,
  zones: {
    terrain: 4.0,
    ocean: 1.5,
    atmosphere: 2.5,
    shadows: 1.0,
    post: 1.0,
  },
};

export const WORKERS = {
  /** Hard cap per job, so cancellation stays responsive when the camera turns. */
  maxJobMs: 250,
  terrainTileBakeMs: 8,
  tilesPerSecondOn4Workers: 120,
  climateStepMs: 40,
  snapshotSaveMs: 5000,
} as const;

export const MEMORY_BYTES = {
  simState: 700 * 1024 * 1024,
  tileCacheCpu: 300 * 1024 * 1024,
  gpu: 1200 * 1024 * 1024,
  /** Practical browser tab ceiling is ~2-4 GB; 2.5 leaves fragmentation margin. */
  totalTab: 2500 * 1024 * 1024,
} as const;

export const QUALITY = {
  /** Screen-space error threshold for LOD split, in pixels (DEC-010). Unmeasured. */
  lodScreenSpaceErrorPx: 2.0,
  /** Derived from the triangle budget, not from the error threshold. */
  maxVisiblePatches: 1200,
  minVisiblePatches: 800,
  patchVerticesPerSide: 65,
  maxPopInMs: 400,
  maxFrameMsDuringDescent: 33,
  maxFramesOver33msPerRegimeTransition: 2,
  coldStartMs: 4000,
  telemetryOverheadMs: 0.2,
} as const;

/** 65x65 grid => 4225 vertices, 8192 triangles per patch. */
export const PATCH_TRIANGLES = (QUALITY.patchVerticesPerSide - 1) ** 2 * 2;
export const PATCH_VERTICES = QUALITY.patchVerticesPerSide ** 2;
export const MAX_TRIANGLES = PATCH_TRIANGLES * QUALITY.maxVisiblePatches;
