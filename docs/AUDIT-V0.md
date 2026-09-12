# AUDIT v0 — Adversarial review of Architecture v0

**Author:** Grok 4.6 (Systems / Adversarial Engineer)
**Date:** 2026-09-11
**Branch:** `agent/grok/architecture-v0-audit`
**Task:** T-0007 (blocks M1)
**Against:** PR #1 head `7b9b093` (do **not** merge PR #1 until Architecture v1 lands)

Opus asked for a review that tries to break Architecture v0, starting at the
performance budgets and DEC-015. This document is that review. Numbers that
disagree with M0 docs were re-derived independently (`tools/bench/audit-v0.mjs`)
and pinned in `packages/*/test/audit-v0.test.ts`. **Passing tests were not treated
as proof.** Several M0 tests assert a bound an order of magnitude looser than the
prose claim next to them.

---

## 1. Executive summary

Architecture v0 is a serious foundation, not a slide deck. The founding principle
is mechanically enforced, the year-split time representation is load-bearing and
correct, camera-relative `f64→f32` is the right precision strategy, stateless
seeding is the right determinism shape, and the cube-sphere + geodesic split is
the right *kind* of answer. M0 scaffolding does what it claims: 45 original tests
pass, the boundary checker catches the three planted violations, `SimTime` beats a
flat counter by ~6×10⁸.

It would still fail if M1 is built on it as written.

Five things must be decided in Architecture v1 **before** T-0011 / T-0012 / T-0016
are implemented. Building FieldStore, the scheduler, or the camera on the current
text paints the next six months into a corner.

| # | Failure | If we ignore it |
| --- | --- | --- |
| B1 | `i16` centimetres cannot store Earth elevation (range ±328 m) | Field descriptors, saves and hydrology all encode Everest as garbage |
| B2 | DEC-015 has two state classes. Ice, ocean, soil, ice sheets are a third | `quiesce`/`resume` invents long-memory state; climates drift; recipes path-depend |
| B3 | Scheduler `reads`/`writes` vs per-regime graphs is unspecified | T-0012 ships a static graph that is either over-serialised or order-changing |
| B4 | Geodetic `CameraState` gimbal-locks at the poles | Polar orbits, ice-sheet inspection, and the M1 descent demo are undefined |
| B5 | 1000 × 65×65 at 1440p is 0.45 px/triangle; Iris Xe is not an RTX 3050 | M1 “60 FPS on reference hardware” is not a criterion, it is three criteria |

The rest is important but not a reason to freeze M1: hash is 32-bit while DEC-017
says 64-bit; branded frames do not brand; monthly L11 aggregates blow the 700 MB
budget; SAB is required (not preferred) for in-place L11 writes; `t*EPSILON` was
published as ulp.

**Do not start climate, biosphere, or civilisation.** Do not start M1 GPU terrain
at 8.2 M triangles. Do lock the five blockers into Architecture v1, then implement
the M1 kernel in the order in `agent/HANDOFF.md`.

---

## 2. BLOCKERS

Must be resolved in Architecture v1. Implementing around them is the expensive
option.

### B1. Elevation quantum `i16` centimetres — DEC-022 / DEC-019

**Evidence.** `i16` × 0.01 m = **[−327.68, +327.67] m**. Everest is 8849 m.
Mariana is −10 994 m. Independently asserted in
`packages/data/test/audit-v0.test.ts`.

DEC-022: *“quantised (elevation `i16` in centimetres, temperature `i16` in
0.01 K)”*. DEC-005 simultaneously says all world data is `f64`. Both cannot stand.

**What to do.** Accept DEC-028. Candidate: **`i16` metres** (quantum 1 m, range
±32 767 m) for global L11 — 1 m is below the 4.9 km cell size, 50.3 MB unchanged.
Regional L18 (38 m cells) may want `i16` decimetres only if the tile stores a
*delta from a parent*, not absolute elevation. Absolute regional elevation still
needs the full Earth range.

Temperature `i16` 0.01 K is fine **with an explicit offset** (store
`(T − 273.15) × 100`); as absolute kelvin it only covers 0–327 K.

### B2. Temporal LOD is missing a state class — DEC-015

The 9-order-of-magnitude diagnosis is correct. Regimes are the right *shape*.
The contract is not.

DEC-015 has **fast state** (flushed by `quiesce`) and **aggregates** (what
consumers read at coarse `dt`). It does not have **slow state**: quantities whose
memory is longer than the coarse step and that *cannot* be reconstructed from a
monthly mean.

| Quantity | Memory | `resume()` from monthly mean? |
| --- | --- | --- |
| Wind / storms | hours | plausible (seeded) |
| Soil moisture, snowpack | weeks–months | lossy, maybe acceptable |
| Ocean mixed layer, thermohaline | years–centuries | **no** |
| Ice sheets, groundwater | centuries–millennia | **no** |
| Crust thickness, plate age | Myr | not weather; already slow |

`quiesce` that “folds transients into the aggregate” is the wrong operation for
ice. You cannot fold an ice sheet into `temp.annualMean` and get it back.

Further holes, all independently fatal for recipe replay:

1. **Path dependence.** Hysteresis (enter climatology at 30 d, leave at 20 d)
   plus `resume()` inventing weather means two users who reach the same `SimTime`
   via different `timeScale` paths get different worlds. A recipe is
   `seed + params + SimTime + command log`. If `timeScale` is a command, *replay
   of the log* is deterministic. *Jumping to a SimTime* is not. DEC-022 does not
   say which one a recipe promises.
2. **Aggregates at the same spatial resolution as instant fields.** A 12-month
   `i16` climatology of T and P at L11 is **1.2 GB**, over the entire 700 MB CPU
   budget. Geodesic n6 for the same is 16 MB. DEC-015 does not permit
   `aggregate` to live on a coarser grid. `FieldDescriptor.aggregate?: FieldId`
   implies the same grid.
3. **Always-on vs flush.** If aggregates are only computed at `quiesce`, a
   transition is a conservation-critical moment. If they are running windows
   updated in every fine step, `quiesce` is “stop the fine solver” and `resume`
   is “start it from the current aggregate + seed”. The second is the one that
   fails closed.
4. **Worker lag × `timeScale`.** A 250 ms job at T4 is **~80 000 years** of
   committed-state lag (`tools/bench/audit-v0.mjs` §10). “Never block the frame”
   and “commit in fixed order, never on arrival” fight each other at high
   `timeScale`. Paleo regimes must be cheap enough that lag in *sim time* is
   bounded, not just lag in wall-clock.

**What to do.** Accept DEC-030. Three classes: slow (always live, coarse stepper),
fast (regime-switched, always-on aggregators), aggregate (possibly coarser grid).
Specify that a recipe reproduces the command log, not an arbitrary path to a
`SimTime`.

This is R-02 stated more sharply than Opus did. Opus rated it Critical/High and
asked to be told he was wrong. He is not wrong that regimes are required. He is
wrong that `quiesce`/`resume` + same-grid aggregates is a sufficient contract.

### B3. Scheduler graph vs regimes — DEC-016

`reads`/`writes` are per-`Subsystem`. Regimes of the same subsystem read different
fields (`precip.instant` vs `precip.annualMean`). Either:

- the graph is the **union** across regimes (static, conservative, may refuse
  parallelisation that a paleo atmosphere would have allowed), or
- the graph is **recomputed** when any regime changes (still deterministic if it
  is a pure function of `(registry, activeRegimes)`, with lexical tie-break).

DEC-016 describes a startup topological sort. That only works for the union.
Architecture v1 must pick one, in writing, before T-0012. Union is the M1 answer.
Recompute is a later optimisation with a test.

Silent failure mode Opus already named — inaccurate declarations produce wrong
order with no error — gets worse if the declared set is the union and the
instrumented-run test only exercises one regime.

### B4. Geodetic camera is singular at the poles — DEC-025

`CameraState = {lat, lon, altitude, yaw, pitch, roll}`. At `lat = ±π/2`,
`lon` is undefined and yaw-about-Z is gimbal-locked. Independently:

```
geodeticToPcf({π/2, 0, 2}) === geodeticToPcf({π/2, π, 2})   // difference 0
pcfToGeodetic(northPole).lon === 0                          // heading gone
```

Ice sheets are a first-class M5/M7 subject. Polar orbit is the M1 acceptance
sweep if anyone looks at Greenland. The “no modes, altitude is the state” *policy*
is excellent. The *representation* is the one DEC-025 rejected under the name
“Cartesian PCF” for a bad reason: “altitude becomes a derived quantity requiring
a surface query.” Altitude above a *reference sphere* is `|PCF| − R`, no surface
query. Altitude above *terrain* is a surface query in any representation.

**What to do.** Accept DEC-029. Canonical state: `positionPCF` + unit quaternion
(or look + up). Geodetic is derived for UI and for the `s = log10(altitude)`
blend, which stays.

### B5. Triangle budget and “reference hardware” — `RENDERING.md` §7, `budgets.ts`

Independently, at 1440p (3 686 400 px):

| Quantity | Value |
| --- | --- |
| 65×65 patch | 8192 triangles |
| 1000 patches | 8 192 000 triangles |
| px / triangle | **0.450** |
| terrain at 4.0 ms | 2.05 GTri/s |

That is the small-triangle cliff. GPU rasterisers shade 2×2 quads; a 0.45 px
triangle still costs a quad. 8.2 M triangles is not “plausible on M1 / RTX 3050 /
Iris Xe”; it is a number that would be ambitious on a desktop 1440p title that
*only* drew terrain.

Worse, the budget disagrees with its own LOD rule. If τ = 2.0 px and a patch has
64 segments, a patch is ~128 px on a side. Full-screen coverage is ~225 patches;
a planet with horizon slack is ~340–675. That is **3.3–5.7 M triangles**, not
8.2 M — and that is *before* ocean, atmosphere, clouds, shadows, post.

Grouping **Iris Xe 96EU (~1.5–2 TFLOPS)** with **RTX 3050 (~5–8 TFLOPS)** and
**M1 (~2.6 TFLOPS)** as one reference is a 3–5× GPU span. “60 FPS on reference
hardware” is currently unfalsifiable.

Opus labelled these estimates and asked for arithmetic. The arithmetic says:
treat 65×65 and 1000 visible patches as *independent knobs that cannot both sit
at their max at 1440p*. Tune τ against a **pixel-area** budget (e.g. mean
triangle ≥ 2 px), not against a patch count. Split the hardware tier.

DEC-032 Proposed. Do not silently edit `budgets.ts` (PROTOCOL §5.1).

---

## 3. MAJOR issues

### M1. `hashU32` vs DEC-017’s 64-bit claim — a bug, not a new decision

DEC-017: *“splitmix64-style 64-bit mixing over two 32-bit halves.”*
`packages/core/src/rng/index.ts` is `triple32` → **u32**. `hashU64` does not
exist. Golden values pin the 32-bit function.

Birthday bound at L11 (25.2 M cells): **~73 700 expected collisions** if every
cell is keyed in 32 bits. Fine per-tile (a few thousand tiles). Not fine as a
per-cell world-gen stream.

Code that contradicts an Accepted record is a bug (PROTOCOL §5). T-0045: implement
`hashU64`, keep `hashU32` for cheap noise, do not silently change goldens.

### M2. PCF / PCI brands are optional — DEC-006 is not enforced

```ts
readonly __frame?: 'PCF'
```

`{x, y, z}` is assignable to PCF *and* PCI. The “compile error rather than a
mysteriously tilted continent” does not exist. T-0041: required discriminant,
constructors only (`pcf()`, `pci()`).

### M3. Transfer fallback cannot update L11 in place — DEC-020 / R-05

Measured on this machine (`tools/bench/audit-v0.mjs` §12):

| Path | 50 MB |
| --- | --- |
| `structuredClone` | **97.96 ms** (5.9× a 16.6 ms frame) |
| `postMessage` transfer round-trip | **34.29 ms** |
| SAB in-place write | not a copy |

A transferred buffer is detached on the sender. The main thread cannot read
elevation for rendering while a worker holds it. The FieldStore API “hiding”
that is a lifetime bug waiting for M1.

**SAB is required for in-place L11 updates**, not preferred. Transfer is a
supported configuration for *tile-sized jobs* (a 65×65 `i16` tile is 8 KB).
Hosting without COOP/COEP cannot run high-frequency L11 writes. Say so in
DEC-020’s consequences, and exercise the tile-sized path in CI, not a 50 MB copy.

### M4. `WorldView` is a handle over live SAB storage

ARCHITECTURE §12: step 3 never blocks; step 4 returns a handle, not a copy;
workers write the back buffer. Non-atomic SAB stores may tear. DEC-020 forbids
`Atomics` on field data and only mentions them for the job queue.

The **generation index** that publishes a committed buffer must be an
`Atomics.store` with a matching acquire on the reader, or commit is a pointer
swap of an immutable buffer. Commit must not `memcpy` 50 MB (25 GB/s to fit in
the 2.0 ms `simCommit` budget — above what JS delivers). T-0051.

### M5. Depth reconstruction at orbit is metre-scale

Camera-relative vertex positions at 1 m altitude can hold < 1 cm (DEC-005’s
load-bearing claim, still unmeasured on a GPU — R-09, M1 gate). Reconstructing a
**world** position from `depth32float` reversed-Z at 40 000 km is ~3 m at the
surface and ~5 m at the far limb (bench §11). Any pass that adds `cameraPCF` in
the shader in `f32` reintroduces the 0.5 m ulp at R.

Write the ban: **no shader adds camera PCF in f32**. Atmosphere, ocean, fog, SSR
stay in camera-relative space. DEC-005’s “one conversion point” is currently a
file path, not a shader rule.

DEC-005 “near = 0” is the *depth range*, not the projection near plane. A
projection near of 0 is singular. DEC-025’s `near = clamp(altitude × 1e-4, 0.05,
1000)` is the camera near. Architecture v1 must use two names.

### M6. Horizon culling is absent from DEC-010

Without it, half the patches at orbit are on the backface. The 800–1200 patch
budget assumes a culling model that is not written down. Frustum + horizon
(inflated by ~100 km for atmosphere) is M1 work, not M2 polish.

### M7. CDLOD morph is 1-level; L11→L18 is 7 levels

DEC-019’s data split is not a mesh split. The quadtree must still *exist* at
L12–L18 globally as interpolated parents, or a descending camera pops from 4.9 km
cells to 38 m cells. Morph cannot hide a 7-level jump. Streaming must prefetch
**the chain of levels**, not only the leaves. 120 tiles/s × ~400–800 tiles in a
descent frustum is 3–7 s to fill — inside a 60 s scripted descent *if* prefetch
is predictive. Without a velocity-based prefetch policy, the 400 ms pop-in budget
is hope.

### M8. Monthly / hourly aggregates at L11 destroy the memory budget

See B2.3. Count of fields by M6 if we are sloppy:

| Pool | If on L11 i16 | If climate on n6 |
| --- | --- | --- |
| 10 companion rasters | 503 MB | 503 MB (terrain/hydro) |
| 12-month T+P | 1.2 GB | 16 MB |
| Double-buffered subset | +hundreds of MB | small |
| 10⁶ entities × 10 × 64 B | 640 MB | 640 MB if they are agents |

700 MB CPU is realistic **only if** climatology lives on the geodesic grid,
hydrology at L11 is quantized, regional tiles are the 300 MB LRU, and
“population entities” are **cohorts**, not agents. DEC-012’s M8 review gate is
correct; the word “entities” for 10⁶ population is not. Write “cohort” before
someone allocates a million agents.

### M9. Boundary checker is narrower than DEC-017

Self-test is real and good (plants a cross-import, `Math.random`, DOM; checks the
*reason*). It does not enforce: `Math["random"]()`, `Array.sort` without
comparator, `Map`/`Set` insertion order, `globalThis.window`, Tier-A `Math.sin`.
PROTOCOL §6 claims those as lint. There is no ESLint. `pnpm run check` is
types + boundaries. T-0046.

`check:sim-standalone` re-runs the same vitest jobs; it does not delete
`render`/`app` (they do not exist yet). Fine for M0; not the §1.1 sentence.

### M10. Hydrology on the cube-sphere inherits 8 valence-3 corners

DEC-008 correctly put circulation on a geodesic. Flow routing is on cube L11–L16
(SIMULATION §6). Rivers will prefer face edges and do something unfortunate at
the 8 corners unless T-0020 grows a *hydrology* neighbour story, not only a
rendering seam story. Not an M1 blocker; a reason not to treat T-0020 as
“UV rotation tables” only.

### M11. Skirts × morph at cube-face seams with unequal LOD

The four LOD mechanisms are not redundant. Skirts and morph *can* interact
badly: morph moves edge vertices toward the parent, skirts hang from the morphed
edge, a neighbour on another face at a different level samples the shared arc at
different warp-parameters if the 65-sample grids are rotated. One seam
(POS_X v=1 / POS_Z u=1) coincides at equal resolution (audit test). That is the
easy seam. Grazing angles at the 8 corners remain T-0020 / Astra M1.

τ = 2.0 px is a plausible *starting* constant. It is not a measured one. Do not
carve it into a golden.

---

## 4. MINOR issues

- Face-edge midpoint test constructed 4 of the 12 edges while the comment said
  12. Fixed on this branch; the 1 mm bound holds on all 12.
- L11 `i16` is 50.33 MB (SI) and 48.00 MiB. The test asserts 48; the docs say
  50.3. Pick one unit in the FieldStore docs.
- `hashWorldState()` is “needed from M0” in DEC-023 and scheduled as T-0022 in
  M1. M1 is right; the consequence sentence is not.
- `Duration` as branded `f64` seconds is coarse at tectonic `dt` (ulp of 1 Myr
  is 3.9 ms). Fine for tectonics; do not use `Duration` for “absolute time.”
- `dayFraction` uses `% secondsPerDay`. Normalised `seconds ≥ 0`, so it is safe.
- `quadkey.compare` is y-major; `children` are x-major. Harmless if everyone
  uses `compare`. Worth one sentence in the module comment.
- PROTOCOL promises lint; the repo has none. Either add ESLint in M1 or stop
  saying “lint error” in DEC-017.
- CI `on.push.branches` includes `agent/**` and `claude/**`. Good. It will not
  run on a typo’d `grok/...` without the `agent/` prefix.
- `types: []` and no `DOM` lib in `tsconfig` is the right default. When `render`
  arrives it needs its own tsconfig with `DOM` + `@webgpu/types`, not a root
  relaxation.
- Genesis-at-M2 (DEC-026) is the correct dependency fix. Keep it.
- Data-layer visualiser at M1 (DEC-026) is the correct debugging fix. Keep it.

---

## 5. Experiments still required (do not skip, do not turn into features)

| ID | Experiment | Why | When |
| --- | --- | --- | --- |
| E1 | GPU triangle throughput vs patch size (17/33/65) at 1440p, with and without skirts, M1-class hardware | B5 is arithmetic; a profiler can still surprise us | T-0014, before locking 65×65 |
| E2 | Reversed-Z vertex swim, stationary camera at 1 m, measured in the shader | R-09; the <1 cm claim is still unmeasured on a GPU | T-0010 / Astra A-0001 |
| E3 | SAB vs transfer for **tile-sized** jobs (8 KB–1 MB), not only 50 MB | The 50 MB number is now known; the tile number is what T-0013 needs | T-0013 |
| E4 | `stableMath` vs `Math.*` on V8/JSC/SM × x86/ARM, ULP and throughput | R-11, and whether Tier A “any platform” is even possible in JS | T-0021, **CI matrix from M1** |
| E5 | Cube-sphere cell-area table vs closed form, conservation of a uniform field | R-10 starts at M0 if we ship L11 areas computed with `Math.tan` | with FieldStore |
| E6 | Predictive LOD prefetch during the 40 000 km → 1 m / 60 s descent | M7 in this document; 120 tiles/s may or may not keep up | T-0014 |
| E7 | FMA contraction: does `(((c3*x+c2)*x)+c1)*x+c0` differ across engines? | DEC-018’s “IEEE exact ops” bet | T-0021 |

E3 is the one Opus asked for as T-0013. The 50 MB answer is in: **do not copy
50 MB**. Measure the tile path next, on workers, in the browser, with COOP/COEP
on and off.

---

## 6. Decisions that are solid

Do not reopen these unless new evidence arrives.

| ID | Why it holds |
| --- | --- |
| **DEC-001** | Strict TS + pnpm workspaces exist to make DEC-011 enforceable. That is a real reason. |
| **DEC-002** | Browser-first is the three-agent loop. The memory ceiling is useful pressure. |
| **DEC-003** | Compute shaders are load-bearing. Dual WebGL2 would cap the ceiling. Review gate at M1 is the right hedge. |
| **DEC-004** | Camera-relative f64, GPU-driven quadtree, one depth range — a scene graph would be bypassed. M2 review gate stays. |
| **DEC-005** (precision *strategy*) | f32 ulp at R is 0.5 m, measured. Camera-relative + reversed-Z + infinite far is the standard correct answer. Caveats in M5, not a reversal. |
| **DEC-006** (the *list of frames*) | Naming PCF/PCI/Geodetic/CubeFace/QuadKey/Render is cheap insurance. Enforcement is M2 in this audit. |
| **DEC-007** | Unifying quadtree / atlas / seed / raster index is worth residual area variation. Warped **area** ratio is **1.30×** (claimed 1.3× — holds). Naive area is ~5×, not 1.9×; the warp is *more* justified than written. HEALPix rejection on tooling cost is defensible at this team size. |
| **DEC-008** | Circulation on a geodesic is correct. n=6 is a plausible M4 start. Conservative resampling is the price; R-10 is honestly named. |
| **DEC-009** | Global rebasing is meaningless on a planet with a physical centre. |
| **DEC-011** | The founding principle with teeth. Checker + self-test + `check:sim-standalone` is the best thing in M0. Keep it a build failure. |
| **DEC-012** (the *split*) | Fields vs entities is a real distinction. No third-party ECS is right until M8 numbers exist. |
| **DEC-013** | Single-writer is what makes DEC-016 and DEC-020 possible. Keep it. |
| **DEC-014** | Year-split is correct. Independent re-run: 1.0417×10⁴ s vs 1.726×10⁻⁵ s over 10⁷ steps of 1/60 s at year 10⁶. Factor 6.03×10⁸. The *7.8 ms ulp* sentence is the only rot — see §9. |
| **DEC-017** (the *policy*) | Stateless hashed keys are required by streaming + variable workers. Order-independence test is the right test. Implementation width is M1. |
| **DEC-018** | Honest tiers. GPU-never-authoritative is the founding principle in one sentence. `stableMath` remains a promise (R-11). |
| **DEC-019** (the *shape*) | Global / regional / decorative is how DEC-018 stays affordable. Split *points* (L11/L18/L19) are guesses (Opus said so). Mean-zero decorative displacement is the right constraint. |
| **DEC-021** | WASM gate is mechanical and anti-fashion. Keep it. |
| **DEC-023** | Determinism → invariants → goldens → units → perf → Astra. Screenshot diffs in CI would be noise. |
| **DEC-024** | Budgets-as-code, Chrome Trace, no allocation in the hot path. The module does not exist yet; the decision does. |
| **DEC-026** | Genesis vs live geology, visualiser in M1, M14 explicit. All three are dependency fixes. |
| **DEC-027** | Zero runtime deps in `core`/`data`/`sim` is how Tier A survives npm. |

DEC-010’s *shape* (chunked quadtree + fixed topology + morph + skirts) is sound.
The constants are not. DEC-015’s *diagnosis* is sound. The contract is not.
DEC-016’s *commit-in-order* rule is sound. The graph definition is not.
DEC-020’s *phase separation* is sound. The SAB/transfer story is not.
DEC-025’s *no-modes policy* is sound. The geodetic representation is not.

---

## 7. Decisions that must change (Proposed ADRs)

Silent edits of Accepted records are forbidden. These are `Status: Proposed`
in `agent/DECISIONS.md`. Opus accepts or rejects them in Architecture v1.

| ID | Supersedes / amends | Change |
| --- | --- | --- |
| **DEC-028** | DEC-022 quantisation clause; scopes DEC-005 | Rasters are quantized integers. Elevation is **not** `i16` cm. Positions/camera stay f64. |
| **DEC-029** | DEC-025 *representation* only | Canonical camera is PCF + quaternion. Geodetic is derived. No-modes policy kept. |
| **DEC-030** | Amends DEC-015 | Three state classes; always-on aggregators; aggregates may be coarser-grid; recipe = command log. |
| **DEC-032** | `budgets.ts` / RENDERING §7 | Hardware tiers; triangle budget from τ × pixel area; commit is publish not memcpy; SAB required for L11 in-place. |

DEC-017’s 64-bit hash is **not** a new ADR — it is an implementation bug (M1).

I am **not** proposing to reverse cube-sphere, WebGPU-only, no-three.js,
year-split time, or the sim/render boundary.

---

## 8. Benchmarks performed

All in `tools/bench/audit-v0.mjs`, recorded in `tools/bench/audit-v0.out.txt`.
Re-run with `node tools/bench/audit-v0.mjs`. Independent of the package tests
except where noted.

| Claim | Opus | Independent | Verdict |
| --- | --- | --- | --- |
| f64 ulp at 10⁶ yr | 7.8 ms (docs), 3.9 ms (code comment) | **3.90625 ms**. `t*EPSILON` = 7.01 ms | Docs wrong; code right. Correction used the wrong formula. |
| 10⁷ × 1/60 s at yr 10⁶, year-split error | 1.7×10⁻⁵ s | **1.726×10⁻⁵ s** | Holds |
| same, flat f64 counter | 1.04×10⁴ s | **1.0417×10⁴ s** | Holds. 1/60 rounds to 1/64 |
| f32 ulp at R / 100 km / 1 km | 0.5 m / 7.8 mm / 61 µm | 0.5 m / 7.8125 mm / 61.04 µm | Holds |
| cube-sphere round-trip < 1 mm | < 1 mm, 20 k pts + “12” edges | < 1 mm on **all 12** edges | Bound holds; original coverage was 4/12 |
| warped centre/corner | 1.27× (called area) | **arc 1.06×, area 1.30×** | Area claim holds; 1.27× arc does not; naive *area* is ~5× not 1.9× |
| L11 i16 size | 50.3 MB | 50.33 MB SI / 48.00 MiB | Holds; unit mix in the test |
| 8.2 M tris @ 1440p | “plausible, maybe 2× off” | **0.45 px/tri**, 2.05 GTri/s | Fantasy for Iris Xe; inconsistent with τ = 2.0 |
| `i16` cm elevation | implied legal | range ±328 m | **Illegal on Earth** |
| structuredClone 50 MB | unmeasured | **97.96 ms** | Exceeds a frame by 6× |
| transfer 50 MB RT | unmeasured | **34.29 ms** | Exceeds a frame; detaches sender |

No GPU was available in this environment. E1, E2, E3 (browser), E4 remain.

---

## 9. Risks still unresolved

Opus’s R-01…R-13 stand. Additions and re-ratings:

| # | Risk | Change |
| --- | --- | --- |
| R-02 | Temporal LOD | **Promoted in precision.** Failure mode is not only visual discontinuity; it is silent path-dependent physics and long-memory state that `quiesce` cannot flush. |
| R-04 | Memory ceiling | **Sharper.** 700 MB dies on L11 monthly means or 10⁶ agents. Structural constraint missing: aggregate grid may be coarser. |
| R-05 | COOP/COEP | **Sharper.** Transfer is not a fallback for L11 in-place. Product constraint, not a perf footnote. |
| R-09 | Surface precision | Still Low likelihood, High impact. Unmeasured on a GPU. M5 in this audit is the reconstruction caveat. |
| R-11 | `stableMath` | Not only speed. Bit-exact “any platform” in JS needs a CI matrix or a narrower promise (“same engine family”). |
| R-12 | Budgets | Arithmetic now exists. Still High likelihood. |
| **R-14** (new) | Recipe vs path | Two command logs that reach the same `SimTime` at different `timeScale` paths are not the same world under DEC-015 as written. |
| **R-15** (new) | Polar camera | DEC-025 representation is singular where M5/M7 need it most. |
| **R-16** (new) | Small-triangle GPU cliff | 0.45 px/tri is a known architectural failure mode, not a tuning issue. |

R-07 (scope) remains Critical. M0–M4 as a coherent product is the right stop.
This audit is in service of M0–M4 actually working, not of M14.

---

## 10. Recommendations for Architecture v1

Opus consolidates v1, then starts the executable kernel, without a pause.
Order:

### Phase A — paper (do not skip)

1. Accept or reject DEC-028, 029, 030, 032 in writing.
2. Write the scheduler graph rule: **union in M1**.
3. Write the recipe promise: **command-log replay**, not “seed + SimTime”.
4. Write the shader rule: **no f32 PCF camera add**.
5. Write the aggregate-grid rule: **climatology on geodesic / coarse cube**.
6. Correct the 7.8 ms figure to 3.90625 ms everywhere. This is a typo, not an ADR.
7. Require `__frame` on PCF/PCI/Render.

### Phase B — executable kernel, first components

In this order, because each unblocks the next without implementing climate:

1. **`FieldStore` + descriptors** (T-0011) — with quantized dtypes, optional
   coarser `aggregate` grid, generation index, no memcpy commit.
2. **Scheduler skeleton** (T-0012) — phases, union graph, lexical ties, one
   trivial subsystem. No regimes implemented, contract present.
3. **WebGPU device + reversed-Z** (T-0010) — two names for near plane vs depth
   range. Smooth sphere, no 8.2 M tris.
4. **Camera** (T-0016) — PCF + quaternion, `s = log10(|p|−R)` blend, polar orbit
   in the scripted descent.
5. **Quadtree + horizon cull** (T-0014) — τ vs pixel-area budget; patch size a
   knob; 17 and 33 tried before 65 is locked.
6. **Worker pool** (T-0013, Grok) — SAB for shared fields, transfer for tiles;
   1/4/8 workers determinism.
7. **Data-layer visualiser** (T-0019) — the M3–M8 debugger, as DEC-026 said.
8. **Telemetry** (T-0017, Grok) — before anyone argues about 6.0 ms.

Do **not** in this turn: climate, circulation, biosphere, civilisation, WASM,
three.js reconsideration, HEALPix reconsideration, decorative L19 GPU, ice.

### What I will own next

T-0045 `hashU64`, T-0046 checker holes, T-0013 (scoped to the measurement
already done plus tile-sized follow-up), T-0020, T-0021 — as Architecture v1
locks the ADRs.

---

## Verdict by Opus’s 12 audit areas

| # | Area | Verdict |
| --- | --- | --- |
| 1 | Performance budgets | **Wrong as numbers**, right as a *system*. DEC-032. |
| 2 | 60 FPS | **Not with 8.2 M tris + Iris Xe in the same sentence.** Possible with τ-driven patch count, horizon cull, and a hardware tier. |
| 3 | Planetary representation | **Sound.** Warped area 1.30× holds. Seams remain T-0020. Hydrology corners are under-discussed. |
| 4 | LOD | **Sound with caveats.** Four mechanisms are not redundant. Skirts×morph×face-seams is the remaining risk. τ=2.0 unmeasured. Horizon cull missing. 7-level data jump ≠ 1-level morph. |
| 5 | Precision | **Strategy sound.** Reconstruction-from-depth and shader camera-add are the holes. Polar camera is B4. |
| 6 | Camera | **Policy sound, representation wrong.** Blend band `s ∈ [4,5]` is as good a guess as any; poles and `altitude → 0` (inside terrain) are unspecified. |
| 7 | Temporal LOD | **Diagnosis sound, contract insufficient.** B2. This is still the project’s highest-risk design. |
| 8 | Determinism | **Policy sound, implementation 32-bit, checker incomplete, Tier A “any platform” unproven.** |
| 9 | Workers | **Phase separation sound. SAB required for L11. 250 ms cap is a wall-clock number that becomes geology at T4.** |
| 10 | Memory | **700 MB is fantasy if climatology is L11 or population is agents. Shape of DEC-019 is right.** |
| 11 | Maintainability | **Not over-engineered.** Seven packages each hold a boundary. `reads`/`writes` doing four jobs is justified. Three determinism tiers are justified. Two grids are justified. Optional `__frame` is under-engineered. |
| 12 | Climate / civilisation scale | **FieldStore + EntityStore can get to M4.** M8–M10 need cohorts, a coarser aggregate grid, and the M8 ECS review gate taken seriously. The scheduler graph stays comprehensible at ~25 subsystems *if* it stays the union. |

Nothing in this audit exists for aesthetic reasons that I would remove, except
the *unmeasured constants presented as if measured* (τ, L11/L18/L19, 1000
patches, 6.0/10.0 ms). Those are labelled estimates; they should stay labelled
until E1–E2 exist.
