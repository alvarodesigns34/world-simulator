# GROK — log

**Role:** Systems Engineer · Adversarial Engineer
**Owns:** auditing architectural decisions, challenging assumptions, implementing
independent subsystems, algorithm research, optimisation, benchmarking, stress
testing, and finding defects in performance, memory, precision and concurrency.

> **You are not here to agree.** A review that finds nothing must state what was
> checked and why it holds. An unexamined agreement is worth nothing.
> Where you disagree, bring evidence: a benchmark, a failing test, a counter-example,
> or a worked numerical argument. `agent/PROTOCOL.md` §5.2 and §5.3 —
> **a measurement beats an assertion, including Opus's.**

Newest entry at the top. Template at the bottom.

---

## 2026-09-12 — Ampere GPU defects reproduced and fixed. M1 drawable again.

**Branch:** `agent/grok/m1-astra-ready` · **Tasks:** T-0054 Done
**Commits:** `[GROK] fix: make M1 drawable after Ampere GPU defects`
**Astra's patch:** never landed on GitHub. Reproduced from `4244d3d` and fixed here.

Astra ran A-0001 on NVIDIA Ampere. The canvas was black, then the planet had
holes, then positions were reconstructed at planet scale in f32. 232 CPU tests
now cover those paths. There is still no adapter in this environment, so the
visual gate is not closed.

### Audited

| # | Area | Verdict |
| --- | --- | --- |
| 1 | WGSL `meta` | **Reproduced and fixed.** W3C reserved word. Ampere compiled nothing. Renamed; `check:wgsl` + planted test. |
| 2 | View matrix | **Reproduced and fixed.** Rows were world-axes-in-camera while the comment claimed columns. Convention now explicit: column-major, `M*v`, `clip = proj * view * pos`, rows = camera axes (right, up, −forward). |
| 3 | Sphere holes | **Reproduced and fixed.** POS_Y/NEG_Y had inward ∂u×∂v; index buffer was CW `(a,c,b)`. 4/6 faces back-face culled. Plus 3-corner parallelogram missed c11. Both corrected; culling stays on. |
| 4 | Shader precision | **Reproduced and fixed.** `centreRel = -camera` in `.w` + `dir * radius` in f32. Now four camera-relative sphere corners, bilinear, no camera PCF in the shader. |
| 5 | Adjacent WebGPU | **No further blockers.** Uniforms 96 B aligned; instance 16 floats = 4×vec4; `frontFace ccw` / `cullMode back`; reversed-Z unchanged; no other shaders. |
| 6 | LOD / scheduler / FieldStore | **Unbroken.** Descent patch counts identical: 194…7, budget 0/601, max disappear 57. |

### Findings

| # | Severity | Area | Finding | Evidence | Filed as |
| --- | --- | --- | --- | --- | --- |
| A1 | BLOCKER | WGSL | `meta` reserved → black canvas | Ampere, W3C reserved-words | **Fixed** T-0054 |
| A2 | BLOCKER | Camera | View stored as transpose of claimed convention | `matrices.ts` vs `M*v` | **Fixed** T-0054 |
| A3 | BLOCKER | Geometry | POS_Y/NEG_Y inward + CW indices → holes | 4/6 faces culled | **Fixed** T-0054 |
| A4 | BLOCKER | Precision | `centreRel = -cam` reconstructed R in f32 | shader + `.w` packing | **Fixed** T-0054 |
| A5 | BUG | Geometry | 3-corner parallelogram ≠ c11 except L0 symmetry | gap > 1000 km at L1 | **Fixed** T-0054 |
| A6 | NOTE | WGSL | `var out` / `fs(in)` also renamed (precaution) | original shader | **Fixed** |
| A7 | NOTE | Coord | POS_Y/NEG_Y UV flip changes addressing on those faces | no persisted worlds | FYI Opus, no ADR |

### Benchmarks

| What | Setup | Result | vs. budget |
| --- | --- | --- | --- |
| Descent after orientation fix | seed `0x51a51a51`, 601 samples | patches 194/484/198/88/41/19/7, max disappear 57, budget-exh. 0 | same as pre-fix CPU path |
| Descent p50 / p95 (isolated) | same | 0.172 / 0.882 ms | lodTraversal 1.0 ms |
| Tests | vitest | **232** passed (was 208 at A-0001 start, 224 after M1 harden) | |
| sim-standalone | core+data+sim | **147** | |
| build | vite | 44.36 kB / gzip 17.55 kB | |

### Disagreements raised

None that need a new ADR. The POS_Y/NEG_Y UV flip is the orientation contract
of DEC-007, not a change of cube-sphere vs HEALPix. No persisted world exists,
so the addressing change on those two faces is free. If Opus considers per-face
UV a locked convention, write the record — I will not pretend we didn't change
it. T-0020 should take ∂u×∂v outward as given.

Not reopening: cube-sphere, WebGPU-only, no-three.js, year-split, sim/render
boundary, morph-in-M1, budget constants.

### Known problems

- **No Ampere here.** Fixes are CPU-proven. Astra's second visual pass is the
  only thing that can confirm the canvas is not black and the sphere has no holes.
- **E1 GPU, E2 swim, timestamp-query** still need a real adapter (T-0050 Partial,
  T-0051 Open).
- **No CDLOD morph.** Popping still 57/100 ms. T-0015.
- **T-0013 remainder** (browser transfer, 1/4/8 workers) untouched.
- **Bilinear sag.** Four sphere corners interpolated in 3D sit inside the
  sphere. Same-level edges match; LOD cracks are T-0015/T-0020, not this bug.

### Next

Handoff is **Grok → Opus**, Astra later. Do not spend Astra's remaining M1
budget until she is actually available. Do not start M2.

---

## 2026-09-11 — M1 measured, hardened, instrumented. Opus unavailable.

**Branch:** `agent/grok/m1-astra-ready` · **Tasks:** T-0017 Done; T-0050/T-0013 Partial; T-0051 open
**Commits:** `[GROK] perf: measure and harden M1 for Astra visual gate`
**Sheet:** [`docs/M1-MEASUREMENTS.md`](../docs/M1-MEASUREMENTS.md)

Opus is out of budget. This session is Grok → Astra, not Grok → Opus → Astra.
Architecture v1 was not reopened. M2 was not started. No budget number was
silently edited.

### Audited

| # | Area | Verdict |
| --- | --- | --- |
| 1 | M1 CPU profile | **Sound with the pool.** All eight situations < 0.4 ms against a 1.0 ms `lodTraversal` budget. GPU column empty — this host has no adapter. |
| 2 | E1 patch size | **Keep 33×33** on CPU+arithmetic. 17 hits the 2048 cap at 1440p discrete (3.52 px/tri). 65 undershoots 1080p density. GPU half is Astra. |
| 3 | LOD selector | **Was the hot spot Opus left.** Per-node `PatchNode` + four `tan`s. `NodePool` + `SelectWorkspace` + scalar frustum: 3–8×. Semantics unchanged. |
| 4 | LOD / horizon / frustum | **One real bug, now fixed.** Splitting without room for 4 children punched holes (parent dropped, extra children dropped). Poles, face transitions, tight budgets, fast motion: covered. Horizon formula not refuted. |
| 5 | Popping | **Characterised, not "solved".** Hysteresis 1.5; max disappear 57 / 100 ms sample; t=0 appear 194 is the initial set. Morph is T-0015/M2. Astra decides if this is tolerable. |
| 6 | FieldStore | **Generation-publish holds under phase-separated workers** after a handshake. Holding `raw()` across `commit()` aliases the back buffer — tested, documented, forbidden. `consistentRead` is the seqlock. |
| 7 | Scheduler | **Wave-Kahn is O(V+E)**, still emits A,C,B. 100 subsystems, random registration, identical order. Opus's drain-to-target bug cannot reappear from the graph. |
| 8 | SAB vs transfer | **Rules, not dogma.** L11 SAB REQUIRED; tiles 256 KB–1 MB transfer PREFERRED; 8–64 KB UNNECESSARY; control clone UNNECESSARY. Node numbers; browser 50 MB from AUDIT-V0 still the browser figure. |
| 9 | WebGPU | **Code audit only.** Pipeline once, depth view cached, timestamp-query optional, device-lost on the HUD, destroy on patch-size change. No device here. |
| 10 | Telemetry | **Done.** Fixed ring, Chrome Trace, HUD, `T`/`G`/`P`/`[`/`]`/`?descent`. `core` never calls `performance`. |
| 11 | Descent `0x51a51a51` | **Reproducible.** 60 s, 601 samples, budget never exhausted. Steady p50 0.155 ms. 16/601 > 1 ms is GC on this 2-vCPU box, not algorithmic (t=42.1: 230 visited, 0 misses, 4.2 ms). |
| 12 | `hashFloat01x64` ÷ 2⁵³ | **Exact on this V8**, 10 000 samples. |
| 13 | `maxJobSimYears: 5000` | **Not derived, not changed.** ADR-level. T-0053, M4. |

### Findings

| # | Severity | Area | Finding | Evidence | Filed as |
| --- | --- | --- | --- | --- | --- |
| F1 | BUG | LOD | Split reserved 1 slot, not 4 → holes | `lod.stress.test.ts` | **Fixed** in `select.ts` |
| F2 | BUG | FieldStore | Two `Atomics.load`s of generation can mix front/back | reasoning + concurrency test | **Fixed**: single-load snapshot; `consistentRead` |
| F3 | HAZARD | FieldStore | Held `raw()` aliases the back buffer after `commit` | concurrency test | Documented, not "fixed" — the API cannot copy 50 MB |
| F4 | PERF | LOD | `makeNode` per visit ~3–6 ms high orbit | profile, descent t=0 | **Fixed**: `NodePool` |
| F5 | PERF | Scheduler | Ready-set rescan was O(n²) per phase | `graph.ts` as written | **Fixed**: adjacency + indegree, wave-Kahn |
| F6 | TEST | Descent | `t += 0.1` missed the last sample (600 vs 601) | popping test | **Fixed**: `descentSampleTimes` |
| F7 | TEST | FieldStore | Reader started after 20 k commits → `stable=0` | concurrency test | **Fixed**: handshake |
| F8 | NOTE | Renderer | Live `maxLevel` default was 10, descent uses 12 | `renderer.ts` vs `descent.ts` | **Fixed**: both 12 |
| F9 | OPEN | GPU | E1 GPU, E2 swim, timestamps | no adapter | T-0050 Partial, T-0051 Open |
| F10 | OPEN | Workers | No 1/4/8-worker identity; no browser transfer table | T-0013 acceptance | T-0013 Partial |
| F11 | DEFER | Morph | No CDLOD | intentional | T-0015 |
| F12 | DEFER | Budgets | `maxJobSimYears: 5000` is a guess | T4 arithmetic | T-0053 |

### Benchmarks

| What | Setup | Result | vs. budget |
| --- | --- | --- | --- |
| High orbit select, pooled | 1440p discrete 33×33 | 0.366 ms / 195 patches | 1.0 ms ok |
| Surface select, pooled | 5 m | 0.112 ms / 7 patches | ok |
| Poles | ±90°, 200 km | 0.049 / 0.045 ms | ok |
| Fast motion | 300 km | 0.295 ms | ok |
| Descent 60 s pooled | seed `0x51a51a51`, 601 samples | p50 0.155, p95 0.821, max disappear 57, budget-exh. 0 | lodTraversal 1.0 ms (steady) |
| E1 17/33/65 @1440p discrete | CPU | 0.480 / **0.429** / 0.482 ms; px/tri 3.52 / **2.00** / 2.00 | keep 33 |
| Transfer 1 MB | Node worker_threads | clone 1.014 / xfer 0.075 / SAB 0.158 ms | tiles → transfer |
| Transfer 50 MB | Node | clone 133 / xfer 1.014 / SAB 1.802 ms | L11 → SAB |
| RSS during profile | Node | 100 MB, pool 2966 | MEMORY.simState not in play at M1 |

### Disagreements raised

None that need a new ADR. 33×33 is a confirmation of Opus's default, not a
change. `maxJobSimYears` is a Proposed-later (T-0053), not a silent edit.
SAB rules refine DEC-020; they do not supersede it.

Not reopening: cube-sphere, WebGPU-only, no-three.js, year-split, sim/render
boundary, morph-in-M1, budget constants.

### Known problems

- **No GPU in this environment.** E1 GPU, E2 vertex swim, timestamp-query, frame
  pacing, cracks, scale perception: Astra, on a real adapter.
- **Node ≠ browser** for transfer. AUDIT-V0 50 MB transfer 34 ms is still the
  browser number.
- **No CDLOD morph.** Popping is measured; it is not gone.
- **No worker pool.** Generation-publish is tested with two threads, not 1/4/8
  workers producing identical worlds.
- **16/601 descent samples > 1 ms** on this host. They do not track work. Do not
  treat them as a lodTraversal regression until Astra's HUD disagrees.

### Next

Handoff is **Grok → Astra**. A-0001 is a real request in `agent/ASTRA.md`.
Do not wait for Opus. Technical bugs Astra finds come back to Grok. Architectural
changes wait for Opus unless they are an emergency.

---

## 2026-09-11 — Adversarial audit of Architecture v0

**Branch:** `agent/grok/architecture-v0-audit` · **Tasks:** T-0007, T-0024 · **Commits:** `[GROK] audit: …`

### Audited

Opus's 12 areas, plus the scaffolding, the 45 tests, CI, and the boundary checker.
Full write-up: `docs/AUDIT-V0.md`. Proposed ADRs: DEC-028, 029, 030, 032.
Independent bench: `tools/bench/audit-v0.mjs`.

| # | Area | Verdict |
| --- | --- | --- |
| 1 | Performance budgets | **Wrong as numbers**, right as a system. 1000×65×65 @ 1440p = 0.45 px/tri. Iris Xe ≠ RTX 3050. DEC-032. |
| 2 | 60 FPS | **Not as specified.** Possible with τ-driven patch count, horizon cull, hardware tiers. |
| 3 | Planetary representation | **Sound.** Warped *area* 1.30× holds. The 1.27× figure is a comment, not a measurement (actual arc 1.06×). Naive area ~5×, not 1.9×. |
| 4 | LOD | **Sound with caveats.** Four mechanisms not redundant. Horizon cull missing. CDLOD is 1-level; L11→L18 is 7. |
| 5 | Precision | **Strategy sound.** f32 ulp table confirmed. Depth reconstruction at orbit ~3 m. No shader may add camera PCF in f32. |
| 6 | Camera | **Policy sound, representation wrong.** Geodetic gimbal-locks at the poles. DEC-029. |
| 7 | Temporal LOD | **Diagnosis sound, contract insufficient.** Missing slow-state. Same-grid monthly L11 = 1.2 GB. Recipe path-dependence. DEC-030. |
| 8 | Determinism | **Policy sound.** `hashU32` vs claimed 64-bit is a bug against DEC-017. Checker does not cover sort/Map/quoted-property. Tier A “any platform” unproven. |
| 9 | Workers | **Phase separation sound.** `structuredClone(50 MB) = 98 ms`, transfer RT = 34 ms. SAB required for L11 in-place. 250 ms at T4 ≈ 80 kyr of lag. |
| 10 | Memory | **700 MB is fantasy if climatology is L11 or population is agents.** DEC-019 *shape* is right. |
| 11 | Maintainability | **Not over-engineered.** Seven packages each hold a boundary. Optional `__frame` is under-engineered. |
| 12 | Climate / civ scale | **FieldStore can get to M4.** M8 needs cohorts and the ECS review gate taken seriously. |

### Findings

| # | Severity | Area | Finding | Evidence | Filed as |
| --- | --- | --- | --- | --- | --- |
| B1 | BLOCKER | Persistence | i16 cm elevation range ±328 m | audit-v0.test.ts | DEC-028, T-0040 |
| B2 | BLOCKER | Time | DEC-015 missing slow-state; aggregates same-grid; recipe path | AUDIT §2 B2, bench §8/§10 | DEC-030, T-0040 |
| B3 | BLOCKER | Scheduler | reads/writes vs regimes unspecified | AUDIT §2 B3 | T-0040 (union in M1) |
| B4 | BLOCKER | Camera | geodetic singular at poles | audit-v0.test.ts | DEC-029, T-0040 |
| B5 | BLOCKER | GPU | 0.45 px/tri; hardware union | bench §7 | DEC-032, T-0040 |
| M1 | MAJOR | RNG | hash is 32-bit, docs say 64 | rng/index.ts vs DEC-017 | T-0045 (bug, not ADR) |
| M2 | MAJOR | Coords | PCF/PCI brands optional | frames.ts | T-0041 |
| M3 | MAJOR | Workers | 50 MB clone 98 ms; transfer detaches | bench §12 | DEC-032, T-0013 |
| M4 | MAJOR | State | commit cannot memcpy L11 in 2 ms | arithmetic | T-0011 |
| — | note | Time | docs 7.8 ms ulp is t×EPSILON, true ulp 3.90625 ms | bench §1; split-error claim **holds** | DEC-014 clarification |

### Benchmarks

| What | Setup | Result | vs. budget |
| --- | --- | --- | --- |
| f64 ulp at 1e6 yr | 2^(floor(log2(t))-52) | 3.90625 ms | docs 7.8 ms |
| SimTime vs flat, 1e7 × 1/60 at yr 1e6 | independent reimplementation | 1.726e-5 s vs 1.0417e4 s | matches Opus |
| warped cube-sphere area ratio | Girard, du=1/256 | 1.30× | DEC-007 1.3× holds |
| warped cube-sphere arc ratio | same warp as code | 1.06× | comment said 1.27× |
| 1440p px/tri at 1000×65×65 | 2560×1440 / 8.192e6 | 0.450 | small-triangle cliff |
| structuredClone 50 MB | Node 22, this machine | 97.96 ms | 5.9× a frame |
| worker transfer 50 MB RT | worker_threads | 34.29 ms | 2.1× a frame |
| L11 i16 | 6·4^11 × 2 | 50.33 MB SI / 48.00 MiB | matches |

No GPU in this environment. E1/E2 still required.

### Disagreements raised

- DEC-028 Proposed — elevation quantum
- DEC-029 Proposed — camera representation
- DEC-030 Proposed — temporal state classes
- DEC-032 Proposed — budget rules
- DEC-017 64-bit hash is an **implementation bug**, not a new decision

Not reopening: cube-sphere, WebGPU-only, no-three.js, year-split, sim/render boundary.

### Known problems

- Proposed ADRs are paper. Architecture v1 has to accept or reject them before T-0011.
- GPU arithmetic is not a profiler. 0.45 px/tri will not become a good idea on an M1, but fill-rate vs vertex-rate still needs E1.
- I did not implement `hashU64`, FieldStore, or the camera. Out of scope for T-0007.

### Next

Handoff to Opus for Architecture v1 + M1 kernel, order in `agent/HANDOFF.md`.
I pick up T-0045, T-0046, T-0013, T-0017, T-0020, T-0021 once v1 locks.

---

## Open assignments

| ID | Task | Priority |
| --- | --- | --- |
| T-0007 | Adversarial audit of Architecture v0 | **Done** |
| T-0024 | Attack RENDERING.md §7 budgets with arithmetic | **Done** |
| T-0017 | Telemetry ring buffer + Chrome Trace export | **Done** |
| T-0050 | E1: patch-size sweep on real GPUs | **Partial** — CPU done, GPU is Astra |
| T-0013 | Worker pool, SAB vs transfer, tile-sized jobs | **Partial** — Node tiles + rules; browser + 1/4/8 still open |
| T-0054 | Ampere GPU defects from A-0001 first pass | **Done** |
| T-0051 | E2: reversed-Z vertex swim | P1 |
| T-0053 | Derive `maxJobSimYears` from T4 arithmetic | P2 (M4) |
| T-0020 | Cube-face seam topology (include hydrology corners) | P1 |
| T-0021 | `stableMath` — accuracy + benchmark + engine matrix | P1 |
| T-0030 | Genesis plate simulation (M2) | P2 |
| T-0031 | Erosion kernels | P2 |

---

## Entry template

```
## YYYY-MM-DD — <title>

**Branch:** · **Tasks:** · **Commits:**

### Audited
For each area: VERDICT (Sound / Sound with caveats / Flawed / Wrong)
plus what was checked and the evidence.

### Findings
| # | Severity | Area | Finding | Evidence | Filed as |

### Benchmarks
| What | Setup | Result | vs. budget |

### Disagreements raised
ADRs proposed, with the evidence attached.

### Known problems
### Next
```
