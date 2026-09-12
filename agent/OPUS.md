# OPUS — log

**Role:** Principal Architect · Simulation Lead
**Owns:** global architecture, module design, data models, world state, time and
scheduling, concurrency, workers, persistence, determinism, testing, internal APIs,
technical integration, maintainability.

Newest entry at the top. Template at the bottom.

---

## 2026-09-12 — M1 GPU integration review (post-Ampere)

**Branch:** `agent/opus/m1-gpu-integration-review` → PR to `dev`
**Base:** `889cebf` (Grok's Ampere fixes) · **Tasks:** T-0060…T-0063 done
**Astra:** not available; not invoked.

### The question I was asked

After four defects that only a real GPU found, are the renderer's contracts
explicit enough to keep building on? Short answer: they were not, and now they
are. Grok's four fixes are all **correct** — I re-derived each rather than
trusting the tests — but each was *verified* by a regex or by inspection, so the
next defect of the same kind would have got through too.

### Review of Grok's fixes

| # | Fix | Verdict |
| --- | --- | --- |
| 1 | WGSL `meta` removed | **CORRECT**, gate incomplete — see below |
| 2 | View matrix transpose | **CORRECT** — re-derived the whole chain: CPU `c*4+r` indexing, WGSL column-major interpretation, `view·forward = (0,0,−1)`, reversed-Z projection. Self-consistent. |
| 3 | Cube-face orientation + winding + 4-corner bilinear | **CORRECT** — all six faces re-derived by hand; `∂u × ∂v` outward on every one; inverse map inverts the same table |
| 4 | No f32 planet reconstruction | **CORRECT** — and I verified it by *magnitude*, not by identifier name |

### What I changed, and why each was necessary

**T-0060 — WGSL is parsed, not pattern-matched.** Astra proved that a green
TypeScript build says nothing about whether WGSL compiles. A reserved-word regex
closes exactly one hole. Shaders are now parsed with a real grammar
(`wgsl_reflect`, MIT, dev-only, no runtime deps), which catches syntax errors,
bad types and malformed attributes; the reserved list stays alongside it because
reserved words *parse fine* — which is precisely why `meta` got through.

I also found a live divergence: `wgsl-reserved.ts` held **one** reserved word
while the tool held **145**. A shader using `layout` or `filter` would have
passed the test and failed the tool. Two sources of truth for one rule, with the
test-facing copy at 1/145th coverage. One list now.

**T-0061 — the layout contract runs shader → CPU.** `gpu-contract.test.ts`
reflects the WGSL and asserts the CPU packer against what the shader actually
declares. That direction matters: the compiler on the far side of the boundary
is the one that gets to be right. Proven to bite before I trusted it.

**T-0062 — the front-face convention is measured.** This is the finding I care
most about. WebGPU's NDC is y-up and its framebuffer y-down; whether
`frontFace: 'ccw'` is evaluated before or after that flip decides whether the
sphere draws or is culled to a black screen. I could not settle it from here and
the spec does not tell you what a *driver* does. So the engine asks it at
startup with a 1×1 readback, and falls back to `cullMode: 'none'` — correct for
a convex body — if it cannot. This does not weaken Grok's "culling stays on"; it
makes culling correct-by-measurement instead of correct-by-assumption.

**T-0063 — the LOD error model was wrong, and correcting it exposed a worse
problem.** The shader draws a bilinear quad through four sphere corners, so it
sags inside the sphere by `R·sin²(θ/2)` — **exactly twice** the arc sagitta the
model reported. So τ = 2.0 px had been delivering ~4.0 px for the whole of M1.

Correcting the model without touching τ doubled patch demand, saturated the
900-patch cap at 2.2 × 10⁶ m, and produced **200-patch churn per frame** — worse
than the sag it removed. I did not accept that. τ is now 4.0, which reproduces
the previous behaviour (because that is what was actually being delivered) while
the number finally means what it says. Descent p95 improved 0.882 → 0.669 ms and
>1 ms samples fell 24 → 11. Recorded as an amendment in DEC-032, not edited
silently.

### DEC-035 — written

Grok asked whether per-face UV orientation is an implementation detail or part
of the coordinate system. It is part of the coordinate system. His Option 1 is
defensible *today* — no world is persisted — but M2 begins binding tile data to
quadkeys, and from that moment the mapping is a save-format commitment. The
table costs one afternoon now and a migration later.

### Two findings worth carrying forward

1. **Tessellation is geometrically inert.** Every vertex of an n×n patch lies on
   the same bilinear quad, so patch size buys *no* accuracy — only splitting
   does. This inverts E1's CPU-only "keep 33×33": at equal τ, 17×17 gives
   identical geometry for **3.75× fewer triangles** and never saturates. It stops
   being true the moment M2 displaces those vertices.
2. **The patch cap truncates hard.** Nothing degrades gracefully when the budget
   is reached; it just stops splitting and churns. Not hit at τ=4.0, so T-0065
   is P2, but it is a real edge.

### Known problems

1. **The winding probe is itself unverified on hardware** — it is new code that
   has never run on a GPU. Its failure path is safe by construction and tested,
   but Astra should read the HUD `winding` line first if anything looks wrong.
2. **`wgsl_reflect` is a parser, not a compiler.** No type checking, no device
   limits, no driver quirks. Stated in the module header so nobody over-trusts it.
3. **τ = 4.0 is honest but unjudged.** Nobody has looked at 4 px of limb
   deviation. That is item 8 of Astra's brief.
4. **Spherical interpolation is deferred** and M2 cannot skip it.
5. Everything Grok listed as needing a GPU still needs a GPU.

### Next

Astra's second pass, when the human queues her — brief in `agent/HANDOFF.md`,
split into CLOSED STRUCTURALLY / STILL REQUIRES EYES / DEFERRED TO M2. Grok:
T-0050 (E1 GPU column, with the 17×17 question reframed), T-0013, T-0065.

---

## 2026-09-11 — Architecture v1 + M1 Planet Engine Foundation

**Branch:** `claude/dazzling-archimedes-m7ewoy` → PR #1 to `dev`
**Tasks:** T-0040/41/45/46 done; T-0010/11/12/14/16 done; T-0019 partial
**Merged:** `agent/grok/architecture-v0-audit` (PR #2 content)

### Phase A — Architecture v1

Grok's audit (`docs/AUDIT-V0.md`) raised 5 blockers and 11 majors. **I rejected
none of them.** Four proposed ADRs accepted — three with amendments that
strengthen rather than dilute them — and three new records written to close
findings Grok identified without proposing a decision for.

| | Change | The amendment I added, and why |
| --- | --- | --- |
| DEC-028 | elevation is not `i16` cm | **Per-tile offset + quantum**, both snapped to powers of two so decode is exactly representable and stays Tier A. Grok's fixed global quantum is right for the global field and wrong for regional tiles: 1 m over 38 m cells is a 1.5° slope quantum, which makes flow routing resolve floodplains arbitrarily rather than physically. A 2.4 km L18 tile now gets 15.6 mm. |
| DEC-029 | camera is PCF + quaternion | None. Accepted as written — my DEC-025 rejection of Cartesian PCF was wrong for exactly the reason Grok gave: altitude above the *reference sphere* is `\|p\|−R`, no surface query. |
| DEC-030 | three temporal state classes | **Slow state steps on a fixed sim-time cadence independent of `timeScale`**, making long-memory trajectories path-independent by construction; and **temporal LOD changes results**, stated as a property rather than hidden. Grok's rule 4 was a save-format footnote; it governs the UI, the tests and R-14. |
| DEC-031 | scheduler graph = union | New. Union in M1 as Grok recommended, plus five startup errors and a proof-by-test that order is a pure function of the registry. |
| DEC-032 | budgets restated | **The budget is a function**, not constants. Constants read directly by a selector are precisely how `maxVisiblePatches: 1200` and `τ = 2.0 px` coexisted while being unsatisfiable together. Three tiers, not two. |
| DEC-033 | shader precision rules | New. "One conversion point" was a claim about CPU files and unenforceable in a shader. |
| DEC-034 | visibility contract | New. Horizon culling was absent entirely; the quadtree must exist at every level so DEC-019's 7-level data jump stays invisible. |

### Phase B — M1

`FieldStore`, scheduler, WebGPU renderer, PCF+quaternion camera, quadtree with
horizon culling, debug overlay, patch-size benchmark. **154 tests.** Typecheck,
boundaries, self-test, standalone-sim and build all clean. `pnpm dev` renders a
planet.

### Three bugs my own tests found

Worth recording, because in each case the test existed *because of* the audit:

1. **Horizon culling had a sign error.** I inflated the occluder radius for
   terrain and atmosphere. That raises the threshold and culls **more**, which is
   backwards — the planet occludes at its solid radius however tall its mountains
   are. The node is what grows.
2. **The scheduler drained each subsystem to the target before starting the next.**
   `terrain` ran three times, then `rivers` three times — breaking the dependency
   order the graph exists to guarantee.
3. **Off-by-one at the step boundary.** A step at instant `T` covers `[T, T+dt)`,
   so a subsystem due exactly at the target belongs to the next advance. Using
   `<=` double-counted every boundary.

### Figures I had wrong, now corrected

- `f64` ulp at 10⁶ years: I published 7.8 ms using `t × EPSILON`, which is not an
  ulp. It is **3.90625 ms**. My original 4 ms guess was closer than my correction.
- Cube-sphere distortion: v0 said "1.27× area". It is **1.30× area / 1.06× arc**,
  against **5.20× / 2.12×** naive. The tangent warp is better justified than I
  claimed.
- `snapQuantum(600/65534)` is 2⁻⁶ = 15.6 mm, not the 7.8 mm I first wrote in
  DEC-028. Rounding must go *up* or the range does not fit.

### One correction to Grok

The worker-lag figure is **too small**, not too large: at the T4 rate DEC-015
names (1 Myr/s), a 250 ms job is ≈ **250 000** simulated years, not ~80 000. The
conclusion is reinforced; `maxJobSimYears` now exists.

### Known problems

1. **No CDLOD morphing.** M1 has hysteresis only. Popping during descent is
   expected and is an explicit Astra question.
2. **`selectPatches` allocates per visited node, every frame** (315 nodes at
   1440p, four `tan`/`atan` each). Left unoptimised on purpose — I would rather
   Grok measured it than that I guessed.
3. **The generation-publish memory model is untested with real concurrency.**
   `Atomics.store`/`load` on the index should pair correctly; unproven.
4. **Patch size 33×33 was chosen on arithmetic alone.** E1 may say 17.
5. **The union graph is O(n²) per phase.** Fine at 2 subsystems; unknown at 25.
6. **The data-layer visualiser is partial** — instrument panel only, no field
   colour ramp, because there is no spatial field to ramp until M2.
7. **No workers, no telemetry, no persistence, no terrain.** M2 and Grok's tasks.

### Next

Grok: T-0050 (E1 GPU half), T-0013 (tile-sized SAB vs transfer), T-0017
(telemetry), then attack FieldStore/scheduler/LOD. Brief in `agent/HANDOFF.md`.

Astra: **not invoked.** A drafted A-0001 is in `agent/ASTRA.md` listing what only
a human at the running app can answer and what tests have already ruled out. Do
not spend her budget before T-0013/T-0017/E1.

---

## 2026-09-11 — Architecture v0

**Branch:** `claude/dazzling-archimedes-m7ewoy` → PR to `dev`
**Tasks:** T-0001 … T-0006 → Review
**Commits:** `[OPUS] chore: initialise repository`, `[OPUS] docs: …`, `[OPUS] feat: …`

### Done

Repository was **completely empty** — no commits, no default branch. Bootstrapped
`main` (README + .gitignore only), created `dev` from it, and did all work on the
session's designated branch.

- **`agent/` infrastructure**: `PROTOCOL.md`, `TASKS.md`, `DECISIONS.md`,
  `HANDOFF.md`, `OPUS.md`, `GROK.md`, `ASTRA.md`.
- **`docs/`**: `ARCHITECTURE.md`, `SIMULATION.md`, `RENDERING.md`, `ROADMAP.md`.
- **27 ADRs** (DEC-001 … DEC-027), each with alternatives considered, rationale and
  consequences. Six carry an explicit review gate at a named milestone because they
  were decided on reasoning rather than measurement.
- **Minimal scaffolding** — `packages/core` and `packages/data`, built only to
  validate the decisions that are hardest to reverse. Not a simulator and not
  trying to be one.

### Key decisions and why

| Area | Decision | The reason, in one line |
| --- | --- | --- |
| Stack | TypeScript strict, pnpm monorepo, Vite, Vitest | The monorepo exists to make the sim/render boundary *enforceable*, not to organise files |
| Graphics | WebGPU only, no WebGL2, no three.js | Compute shaders are load-bearing; a framework owns exactly the layers our precision strategy needs |
| Precision | `f64` world, camera-relative `f32` upload, reversed-Z infinite far | `f32` ulp at Earth radius is **0.5 m**; `f64` is free in JS |
| Grids | Tangent-warped cube-sphere (terrain) + icosahedral geodesic (climate) | One structure for quadtree/atlas/seed/index; a separate solver grid with no corners or poles |
| Time | `{year: int, seconds: f64}` | A flat `f64` seconds counter loses **10 417 s** where the year split loses **17 µs** (measured) |
| Multiscale | Temporal LOD: regimes + `quiesce`/`resume` + mandatory aggregates | 1 Myr/s vs. 1 h weather steps is a **9-order-of-magnitude** gap; no optimisation closes it |
| Determinism | Stateless hashed seeds; honest A/B/C tiers; GPU never authoritative | Chunks generate in camera order across a variable worker count — order-independence is a requirement |
| Terrain data | Global L11 authoritative / regional L12–L18 on demand / L19+ decorative | What makes "the GPU is never authoritative" *affordable* |
| Concurrency | Worker pool, SAB preferred, phase separation not locks | Single-writer ownership already gives us the safety; we buy it once |

### Measured, not assumed

The scaffolding exists to turn four claims from reasoning into measurement.
All four now have numbers:

| Claim | Result |
| --- | --- |
| `SimTime` beats a flat `f64` seconds counter (DEC-014) | **1.7 × 10⁻⁵ s** vs **1.04 × 10⁴ s** error over 10⁷ steps of 1/60 s at year 10⁶ — a factor of 6 × 10⁸. The flat counter rounds every 1/60 s to 1/64 s and loses 6.25% of all elapsed time. |
| Cube-sphere round-trip error (DEC-007) | **< 1 mm** at planet radius over 20 000 sampled points, and at all 8 cube corners and 12 edge midpoints. |
| Tangent warp reduces area distortion (DEC-007) | centre/corner **area** ratio **1.30×** vs **5.20×** naive; **arc** ratio **1.06×** vs **2.12×**. *(v0 wrote 1.27× and called it area; it was neither — corrected in v1.)* |
| Stateless hashing is order-independent (DEC-017) | Forward, reversed and hash-shuffled generation of 2 400 keys produce **identical** maps. Golden values recorded so a hash change cannot happen silently. |

Also proven rather than asserted:

- `pnpm run check:boundaries:selftest` plants a cross-package import, a
  `Math.random` and a DOM access, confirms each is rejected **for the right
  reason**, and removes them. A check that has never been seen to fail is not a
  check.
- `pnpm run check:sim-standalone` runs the pure packages under plain Node with no
  renderer present — `ARCHITECTURE.md` §1.1's founding-principle test as an actual
  CI job.

45 tests, `tsc --noEmit` clean under `strict` + `noUncheckedIndexedAccess` +
`exactOptionalPropertyTypes`.

### A figure I had wrong

My first draft claimed a ~4 ms `f64` ulp at 10⁶ years. I then "corrected" it to 7.8 ms using `t × EPSILON`, which is not an ulp. It is **3.90625 ms** — my first figure was closer than my correction. The
docs now carry measured numbers rather than my arithmetic. Noted because it is
exactly the kind of thing this scaffolding exists to catch, and because Grok
should assume the same about the performance budgets, which have had no such
correction yet.

### Reasoning I want challenged

- **DEC-015 (temporal LOD)** is the most novel thing here and the one with the least
  prior art. R-02, rated Critical/High. Its failure mode is a climate that drifts
  slowly enough that nobody notices for months.
- **`RENDERING.md` §7 budgets** are engineering estimates presented as numbers. They
  are labelled as such. Grok should attack them with arithmetic before a profiler
  exists (T-0024).
- **DEC-004 (no three.js)** is the most expensive decision here if it is wrong. It
  has an M2 review gate.

### Known problems

1. **Every performance budget is unmeasured.** Labelled, but still unmeasured.
2. **`stableMath` does not exist yet**, so Tier A is currently a promise. R-11.
3. **Cube-face seam handling is specified but unimplemented** — historically the
   classic source of cube-sphere bugs (T-0020).
4. **Scaffolding is deliberately thin.** No `FieldStore`, no scheduler, no renderer.
   That is M1, and building them now would have been building on unaudited
   decisions.
5. **The `reads`/`writes` declaration is the scheduler's sharpest edge** — an
   inaccurate declaration produces wrong ordering with no error. Mitigations are
   designed (dev write barrier, instrumented-run test) but not built.
6. **Astra has not seen anything**, because there is nothing to see. First gate is
   M1 and it is the important one.
7. **Protocol/branch naming divergence**: the session mandated
   `claude/dazzling-archimedes-m7ewoy` rather than `agent/opus/architecture-v0`.
   Noted in `PROTOCOL.md` §2; ordinary work uses the `agent/<name>/<topic>` form.

### Next

Blocked on **T-0007** — Grok's audit. I do not want to build M1 on decisions that
have not been attacked. See `agent/HANDOFF.md` for the audit brief.

After the audit: T-0010 (WebGPU device), T-0011 (`FieldStore`/`EntityStore`),
T-0012 (scheduler), T-0016 (camera). Grok has T-0013, T-0017, T-0020, T-0021,
T-0024 in parallel.

---

## Entry template

```
## YYYY-MM-DD — <title>

**Branch:** · **Tasks:** · **Commits:**

### Done
### Key decisions and why
### Known problems
### Next
```
