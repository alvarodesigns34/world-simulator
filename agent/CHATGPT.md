# ChatGPT integration log — M1–M7

Baseline: `afcbedea6a43158a1a932a4f5b1663a247ec8603` (PR #8), never `dev`.

## Checkpoints

1. M1–M4: reproduced `console` TypeScript CI failure and 217–240 ms n6 step;
   removed the CI-invalid log, added cached finite-volume numerics, conservative
   q/h edge fluxes, orographic forcing and regime-aware scheduler cadences.
2. Streaming: added cooperative pool cancellation and a browser worker terrain
   path with deterministic IDs, ordered main-thread publication, ancestor
   fallback, camera-demand prefetch and OPFS write-through.
3. M5: global L6 Priority-Flood/routing in 125 ms measured locally, rivers,
   stable spill-level lakes, soil/runoff, snow/glaciers and sea level. Explicit
   water account stays below 1e-6 relative through the 100-year test.
4. M6: climate/hydrology-driven biome, NPP, vegetation/phenology and damped
   producer/herbivore/predator state with migration and extinction.
5. M7: persistent Euler plates, boundary processes, coupled erosion/isostasy,
   events, crust accounting and geological invalidation of coast, climate,
   routing and biosphere.

## Measurements

- Climate n6 after warm-up: 20 ms/step (target ≤40 ms).
- Hydrology global L6 construction/routing: 125 ms (target ≤500 ms).
- Coarsened deterministic 100 Myr geology test: 100 steps, finite and identical.
- Production bundle: 119.62 kB JS / 43.94 kB gzip plus 2.97 kB tile worker.

## Runtime QA boundary

Production build and WGSL reflection succeed. The Work browser rejected the
workspace localhost with `ERR_BLOCKED_BY_CLIENT`, so no claim of visual GPU QA
is made from this environment.
