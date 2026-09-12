# TASKS

Single source of truth for what is being worked on, by whom, and what "done" means.
Update it at the end of every session (`agent/PROTOCOL.md` §4.2).

**Status:** `Open` · `In progress` · `Blocked` · `Review` · `Done` · `Dropped`
**Priority:** `P0` blocking · `P1` next · `P2` soon · `P3` backlog

**Rules**
- Do not start a task assigned to another agent. If you think it is wrong, say so in
  `agent/HANDOFF.md` and in your log.
- A task without an acceptance criterion is not ready to start. Write one first.
- Discovered work becomes a new task with an ID; it does not get silently folded
  into the one you are doing.
- Task IDs are never reused.

---

## Now — Accelerated M1→M4 block (human-authorised 2026-09-12)

Grok is the long-running constructor for remaining non-visual M1 + M2 + M3 + M4.
Visual/GPU gates do **not** block later milestones. Claude consolidates the
block after this PR. Astra reviews the integrated planet afterwards.
Formal approval and implementation completeness are distinct states.

Architecture v1 is consolidated and the M1 kernel is executable. Grok measured
it, then reproduced and fixed the Ampere GPU defects Astra found on A-0001
(T-0054). **Opus's GPU-integration HEAD (`a1f3923`) was then red-teamed**
(T-0066). **Opus rewrote two FieldStore contracts** (T-0070…T-0077, PR #6).
**Grok's final M1 redteam** (`agent/grok/m1-final-redteam`) closed descriptor
mutation, production NaN, generation sign/wrap, and the stamp/publish protocol.
**This branch continues from that HEAD** and implements M2–M4.

What remains in M1 is what only a GPU and a human looking at the running app
can answer: E1 GPU, E2 vertex swim, popping-as-seen, camera feel, poles-as-seen,
and confirmation that Ampere now draws a closed planet.

| ID | Title | Owner | Status | Pri | Acceptance |
| --- | --- | --- | --- | --- | --- |
| T-0001 | Architecture v0 | Opus | **Done** | — | Superseded by Architecture v1 |
| T-0007 | Adversarial audit of Architecture v0 | Grok | **Done** | — | `docs/AUDIT-V0.md`; 5 blockers + 11 majors; all resolved in v1 |
| **T-0040** | **Architecture v1: close B1–B5** | Opus | **Done** | — | DEC-028/029/030/032 accepted (three amended); DEC-031/033/034 added; figures corrected |
| T-0041 | Required PCF/PCI/Render discriminants | Opus | **Done** | — | `__frame` required; `{x,y,z}` no longer assignable to two frames |
| T-0045 | `hashU64` as DEC-017 specified | Opus | **Done** | — | splitmix64 over u32 halves; verified against a BigInt oracle over 20 000 cases |
| T-0046 | Boundary checker covers sort / Map / quoted-property | Opus | **Done** | — | Seven planted violations, all rejected for the right reason |
| T-0011 | `FieldStore` + descriptors | Opus | **Done** | — | Quantised dtypes, ownership, temporal class, coarser aggregates, generation publish, dirty blocks. Grok added `handles()` / `consistentRead()` and concurrency tests |
| T-0012 | Scheduler: phases, union graph, ordering, quiesce/resume | Opus | **Done** | — | Order independent of registration; five startup errors. Grok: wave-Kahn O(V+E), 100-subsystem stress |
| T-0016 | Camera: PCF + quaternion | Opus | **Done** | — | Five polar-crossing tests including a full polar orbit |
| T-0010 | WebGPU device + reversed-Z | Opus | **Done** | — | Typed failure, no WebGL2; Grok: timestamp-query, cached depth view, lost/error on HUD |
| T-0014 | Quadtree + horizon cull + LOD selection | Opus | **Done** | — | Grok: NodePool, SelectWorkspace, hole-fix (split reserves 4), scalar frustum, stress |
| T-0019 | Data-layer / debug overlay | Grok | **Done** | P1 | Colour ramps + legend + probe for elevation, plateId, crustAge, uplift, T, precip, humidity, ice |
| **T-0013** | **Worker pool, SAB vs transfer, tile-sized jobs** | **Grok** | **Done** | **P0** | COOP/COEP table unit-tested; 1/4/8 identity; apply-in-id-order. Inline default (DOM-free); Worker backend injectable |
| **T-0017** | **Telemetry ring buffer + Chrome Trace export** | **Grok** | **Done** | **P0** | Fixed ring, no alloc in hot path, Perfetto JSON, HUD, `T`/`G`/`?descent`. `core` never calls `performance` |
| **T-0050** | **E1: patch-size sweep on real GPUs** | **Grok** | **Partial** | **P0** | CPU+arithmetic: keep 33×33 (`tools/bench/patch-size.out.md`). **GPU half is Astra** — 17/33/65 × 1080p/1440p/2160p on ≥ 2 vendors |
| **T-0051** | **E2: reversed-Z vertex swim, measured in-shader** | **Grok** | Open | P1 | Stationary camera at 1 m altitude; measure actual vertex jitter. Closes R-09. Needs a GPU |
| T-0020 | Cube-face seam topology, incl. valence-3 corners for hydrology | Grok | **Done** | P1 | 24 edge adjacencies; 8 valence-3 corners; area partition. DEC-035 not reopened |
| T-0021 | `stableMath` Tier-A transcendentals | Grok | **Done** | P1 | sin/cos/atan/exp/log/pow; ULP vs Math.* and series; cost ratio recorded |
| T-0022 | `hashWorldState()` + determinism suite | Grok | **Done** | P1 | Same-seed world digest; climate replay |
| T-0023 | Command types + command log recording | Grok | **Done** | P1 | timeScale/pause/resume/regime/visualField/stepOnce |
| T-0052 | Ancestor upsampling + chain prefetch | Grok | **Done** | P1 | TileCache prefetchChain coarse→fine; ancestor fallback |
| T-0053 | Derive `maxJobSimYears` from T4 arithmetic | Grok | Open | P2 | 5000 is a guess. At T4 1 Myr/s, 5000 yr = 5 ms wall. ADR-level; do not silently edit `budgets.ts`. M4 |
| **T-0054** | **Ampere GPU defects from A-0001 first pass** | **Grok** | **Done** | **P0** | `meta` not in WGSL; view convention explicit + tested; six faces outward; CCW indices; 4-corner camera-relative packing; no `centreRel` reconstruction; `check:wgsl` in `pnpm run check` |
| **T-0060** | **WGSL parsed with a real grammar, not a regex** | Opus | **Done** | — | `check:wgsl` parses via `wgsl_reflect`; reserved list consolidated 1 → 145 words; four planted bug classes caught |
| **T-0061** | **CPU↔GPU layout contract derived from the shader** | Opus | **Done** | — | `gpu-contract.test.ts` reflects the WGSL and asserts `layout.ts`; proven to bite (5th member = 4 failures, vec3 trap = 2) |
| **T-0062** | **Front-face convention measured on the GPU at startup** | Opus | **Done** | — | 1×1 probe picks `frontFace`; unavailable ⇒ `cullMode: 'none'`; reported in the HUD. **Grok T-0066:** three draws + `classifyProbePixels`; control black never guesses CW |
| **T-0063** | **Bilinear sag quantified; LOD error model corrected** | Opus | **Done** | — | `R·sin²(θ/2)`, exactly 2× the arc sagitta; τ 2.0 → 4.0 recorded in DEC-032; descent metrics at or better than baseline |
| T-0064 | Spherical patch interpolation (precision-safe) | Grok | **Done** | P1 | Closed form 1−\|Bd\|²; CPU tests; shader spherify + height displace |
| T-0065 | Graceful LOD degradation at the patch cap | **Grok** | **Partial** | P2 | Design/bench recorded (`lod.cap.test.ts`, `M1-MEASUREMENTS.md` §13). Adaptive τ near the cap beats truncation. **Not shipped:** τ=4.0 does not hit the cap. `budgets.ts` untouched |
| **T-0066** | **M1 structural redteam of Opus GPU-integration HEAD** | **Grok** | **Done** | **P0** | CI P0 (rng timeout, `check`+build). FieldStore partial publish, capability view, write barrier. Scheduler everyNOf/resume/cross-phase. Winding three-draw. Polar `dragOrbit`. timestamp-query retry. PR to `dev` |
| **T-0070** | **Read views handed out writable memory** | Opus | **Done** | — | Hostile tests reproduced both attacks; `view()` now holds no live memory; DEC-013 amended |
| **T-0071** | **Dirty mask had two incompatible lifetimes** | Opus | **Done** | — | 820→40 blocks over 40 generations; replication set + generation stamp split; DEC-032 amended |
| **T-0072** | **everyNOf dt semantics + graph ordering** | Opus | **Done** | — | Spans tile the leader timeline; leader→follower edge in the graph; DEC-016 amended |
| **T-0073** | consistentRead vs post-publish replication | Opus | **Done** | — | Reviewed, correct, pinned by tests incl. the SAB path. No change |
| **T-0074** | Write barrier review | Opus | **Done** | — | Correct; the captured-`rawMut` hole is now pinned by a test |
| **T-0075** | **Production invariants stripped by `assert()`** | Opus | **Done** | — | Ten found incl. all of `validateDescriptor`; `invariant()` added and converted |
| **T-0076** | GPU hardening code review | Opus | **Done** | — | No inconclusive path enables culling, proved over all 8 combinations. No change |
| **T-0077** | Descent harness reaches the 1 m criterion | Opus | **Done** | — | Lowered from 2 m; no regression |
| T-0078 | Benchmark `copyRange` against a real GPU upload | **Grok** | **Partial** | P1 | CPU path measured (`tools/bench/fieldstore-hotpath.out.md`): 1 dirty block raw 0.53 µs, L11 scan 11 µs. Dirty-block copyRange is the default. **GPU `writeBuffer` still open** |
| T-0079 | `blockGeneration` stamp wraps at 2^32 generations | **Grok** | **Done** | P3 | Real bug was signed Int32 at **2^31**. Public generation is uint32; 2^32 throws. ~2.3 years at 60 Hz is the documented ceiling, not silent data loss |
| **T-0080** | **`view().descriptor` was the live registry object** | **Grok** | **Done** | **P1** | Frozen canonical copy; `owner`/`quantum`/`offset`/`tier`/`range` cannot hijack `mut()` or decode. Also `store.descriptor(id)` |
| **T-0081** | **`set()` accepted NaN/±Inf in production** | **Grok** | **Done** | **P1** | `requireFinite` in every build. i16 used to encode NaN→0, ±Inf→dtype min/max |
| **T-0082** | **`commit` stamp/publish ordering** | **Grok** | **Done** | **P1** | Stamp then publish then replicate. `changedBlocksSince` uses `since < stamp ≤ now`. Field API is single-threaded; `blockGeneration` is not in `share()` |




## Backlog

| ID | Title | Owner | Status | Pri | Notes |
| --- | --- | --- | --- | --- | --- |
| T-0030 | Genesis plate simulation (M2) | **Grok** | **Done** | P2 | L6 Euler-pole Voronoi; elevation diagnosed from geology, not FBM |
| T-0031 | Erosion kernels: stream-power + hillslope diffusion | **Grok** | **Done** | P2 | Stream-power + diffusion + pit-fill; seam neighbours |
| T-0032 | Priority-flood depression filling | **Grok** | Open | P3 | Known-good references exist; ideal for verification against a spec |
| T-0033 | Serialisation container + quantisation + migrations | Opus | Open | P2 | M2 needs tile persistence; full format at M11 |
| T-0034 | Icosahedral geodesic grid + conservative resampling operators | **Grok** | **Done** | P3 | n-grid, neighbours, areas; extensive round-trip ≤ 1e-9 |
| T-0035 | Choose the M4 atmospheric solver formulation, with a benchmark | Grok | **Done** | P3 | DEC-036: 1-layer SW + Newtonian T + moisture |
| T-0036 | UI framework decision (ADR) | Opus | Open | P3 | Deferred until the UI has real requirements (M8+) |

---

## Astra queue

Astra is a **limited resource** (`agent/PROTOCOL.md` §1.1): max 3 requests per
milestone plus the milestone gate. Requests must use the template in
`agent/ASTRA.md`. Do not queue anything Opus or Grok can answer.

| ID | Request | Milestone | Status |
| --- | --- | --- | --- |
| A-0001 | **M1 gate** — orbit→surface continuity, precision, depth, seam quality, popping, frame pacing | M1–M4 | **First pass on Ampere: REJECTED. Second pass retargeted to the integrated M1–M4 planet on `agent/grok/m1-m4-accelerated`. Do not insert Astra between M2/M3/M4.** |

---

## Done

| ID | Title | Owner | Closed |
| --- | --- | --- | --- |
| T-0001 | Architecture v0 | Opus | M0 — superseded by Architecture v1 |
| T-0002 | Monorepo, strict TS, Vitest, CI, boundary checker | Opus | M0 |
| T-0003 | `SimTime` / `Duration` year-split arithmetic | Opus | M0 |
| T-0004 | Stateless hashing (`hashU32`) | Opus | M0 — extended by T-0045 |
| T-0005 | Cube-sphere coordinates, tangent warp, quadkeys | Opus | M0 |
| T-0006 | `budgets.ts` + dev assertions | Opus | M0 — restated by DEC-032 |
| T-0007 | Adversarial audit of Architecture v0 | Grok | `docs/AUDIT-V0.md` |
| T-0010 | WebGPU device + reversed-Z | Opus | M1 |
| T-0011 | `FieldStore` + descriptors | Opus | M1 |
| T-0012 | Scheduler: union graph, phases, ordering | Opus | M1 |
| T-0014 | Quadtree + horizon cull + LOD selection | Opus | M1 |
| T-0016 | Camera: PCF + quaternion, polar-safe | Opus | M1 |
| T-0024 | Attack the performance budgets with arithmetic | Grok | Folded into T-0007; led to DEC-032 |
| T-0040 | Architecture v1: close B1–B5 | Opus | DEC-028…034 |
| T-0041 | Required PCF/PCI/Render discriminants | Opus | M1 |
| T-0045 | `hashU64` as DEC-017 specified | Opus | M1 |
| T-0046 | Boundary checker: sort / Map / quoted-property / Tier A | Opus | M1 |
| T-0017 | Telemetry ring buffer + Chrome Trace export | Grok | M1 — `packages/core/src/telemetry.ts` |
| T-0054 | Ampere GPU defects from A-0001 first pass | Grok | M1 — WGSL `meta`, view convention, cube-face winding, 4-corner packing |
| T-0066 | M1 structural redteam of Opus GPU-integration HEAD | Grok | M1 — CI, FieldStore publish, scheduler, winding, polar, timestamp-query |
| T-0079 | Field generation is uint32; 2^32 wrap throws | Grok | M1 — the 2^31 signed mix was the real bug |
| T-0080 | Frozen canonical FieldDescriptor | Grok | M1 |
| T-0081 | `requireFinite` on `Field.set` | Grok | M1 |
| T-0082 | Stamp-then-publish; `changedBlocksSince` `stamp ≤ now` | Grok | M1 |

### Deferred with a reason

| ID | Title | Why not now |
| --- | --- | --- |
| T-0015 | Patch mesh: CDLOD morphing + skirts | M1 ships hysteresis only. Morphing needs the tile pipeline to carry a parent surface to morph *toward*, which arrives with M2. Popping is now *measured* (max disappear 57/frame @ 10 Hz, seed `0x51a51a51`); Astra's gate decides whether that is tolerable until M2. |
| T-0018 | Dev HUD budget bars | Folded into T-0019; the overlay reads `resolvePatchBudget` already. |
