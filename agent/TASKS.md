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

## Now — M1 closing / M2 opening

Architecture v1 is consolidated and the M1 kernel is executable. What remains in
M1 is measurement on real hardware (E1/E2), the worker pool, telemetry, and
Astra's visual gate — none of which can be done from here.

| ID | Title | Owner | Status | Pri | Acceptance |
| --- | --- | --- | --- | --- | --- |
| T-0001 | Architecture v0 | Opus | **Done** | — | Superseded by Architecture v1 |
| T-0007 | Adversarial audit of Architecture v0 | Grok | **Done** | — | `docs/AUDIT-V0.md`; 5 blockers + 11 majors; all resolved in v1 |
| **T-0040** | **Architecture v1: close B1–B5** | Opus | **Done** | — | DEC-028/029/030/032 accepted (three amended); DEC-031/033/034 added; figures corrected |
| T-0041 | Required PCF/PCI/Render discriminants | Opus | **Done** | — | `__frame` required; `{x,y,z}` no longer assignable to two frames |
| T-0045 | `hashU64` as DEC-017 specified | Opus | **Done** | — | splitmix64 over u32 halves; verified against a BigInt oracle over 20 000 cases |
| T-0046 | Boundary checker covers sort / Map / quoted-property | Opus | **Done** | — | Seven planted violations, all rejected for the right reason |
| T-0011 | `FieldStore` + descriptors | Opus | **Done** | — | Quantised dtypes, ownership, temporal class, coarser aggregates, generation publish, dirty blocks |
| T-0012 | Scheduler: phases, union graph, ordering, quiesce/resume | Opus | **Done** | — | Order independent of registration; five startup errors; 24 tests |
| T-0016 | Camera: PCF + quaternion | Opus | **Done** | — | Five polar-crossing tests including a full polar orbit |
| T-0010 | WebGPU device + reversed-Z | Opus | **Done** | — | Typed failure, no WebGL2; depth measured across the altitude sweep |
| T-0014 | Quadtree + horizon cull + LOD selection | Opus | **Done** | — | Horizon/frustum/SSE/hysteresis; budget never exceeded across 3 tiers × 3 sizes × 3 resolutions |
| T-0019 | Data-layer / debug overlay | Opus | **Partial** | P1 | Patch boundaries, LOD level, culling, altitude, frame time, resolved budget. **Field colour-ramp view still to do** — needs a field with spatial data, i.e. M2 |
| **T-0013** | **Worker pool, SAB vs transfer, tile-sized jobs** | **Grok** | Open | **P0** | 1/4/8 workers identical. 50 MB numbers are in; measure the **tile** path (8 KB–1 MB) in a browser, COOP/COEP on and off |
| **T-0017** | **Telemetry ring buffer + Chrome Trace export** | **Grok** | Open | **P0** | Opens in Perfetto; ≤ 0.2 ms/frame; no allocation in the hot path. Needed before anyone argues about the 6.0 ms budget |
| **T-0050** | **E1: patch-size sweep on real GPUs** | **Grok** | Open | **P0** | 17/33/65 at 1080p/1440p/2160p on ≥ 2 vendors. CPU half is in `tools/bench/patch-size.out.md`; the GPU half decides the default |
| **T-0051** | **E2: reversed-Z vertex swim, measured in-shader** | **Grok** | Open | P1 | Stationary camera at 1 m altitude; measure actual vertex jitter. Closes R-09 |
| T-0020 | Cube-face seam topology, incl. valence-3 corners for hydrology | Grok | Open | P1 | 24 edge adjacencies; write-up covers hydrology at the 8 corners |
| T-0021 | `stableMath` Tier-A transcendentals | Grok | Open | P1 | ULP bound vs a high-precision reference; benchmark vs native; CI matrix for E4 |
| T-0022 | `hashWorldState()` + determinism suite | Opus | Open | P1 | Same seed / reversed order / 1-4-8 workers / save→load→step |
| T-0023 | Command types + command log recording | Opus | Open | P1 | All mutation flows through commands; `timeScale` changes ARE commands (DEC-030) |
| T-0052 | Ancestor upsampling + chain prefetch | Opus | Open | P1 | DEC-034 rules 2–4. Needs tiles, so it lands with M2 |

## Backlog

| ID | Title | Owner | Status | Pri | Notes |
| --- | --- | --- | --- | --- | --- |
| T-0030 | Genesis plate simulation (M2) | **Grok** | Open | P2 | Prime Grok module — self-contained, algorithmic, benchmarkable |
| T-0031 | Erosion kernels: stream-power + hillslope diffusion | **Grok** | Open | P2 | Benchmark first; WASM candidate under DEC-021 |
| T-0032 | Priority-flood depression filling | **Grok** | Open | P3 | Known-good references exist; ideal for verification against a spec |
| T-0033 | Serialisation container + quantisation + migrations | Opus | Open | P2 | M2 needs tile persistence; full format at M11 |
| T-0034 | Icosahedral geodesic grid + conservative resampling operators | **Grok** | Open | P3 | M3/M4; round-trip conservation to 1e-9 |
| T-0035 | Choose the M4 atmospheric solver formulation, with a benchmark | Opus + Grok | Open | P3 | DEC-008 fixes the grid, not the equations — this is deliberately open |
| T-0036 | UI framework decision (ADR) | Opus | Open | P3 | Deferred until the UI has real requirements (M8+) |

---

## Astra queue

Astra is a **limited resource** (`agent/PROTOCOL.md` §1.1): max 3 requests per
milestone plus the milestone gate. Requests must use the template in
`agent/ASTRA.md`. Do not queue anything Opus or Grok can answer.

| ID | Request | Milestone | Status |
| --- | --- | --- | --- |
| A-0001 | **M1 gate** — orbit→surface continuity, precision, depth, seam quality | M1 | Not yet ready (needs T-0010, T-0014, T-0015, T-0016) |

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

### Deferred with a reason

| ID | Title | Why not now |
| --- | --- | --- |
| T-0015 | Patch mesh: CDLOD morphing + skirts | M1 ships hysteresis only. Morphing needs the tile pipeline to carry a parent surface to morph *toward*, which arrives with M2. Astra's gate decides whether the popping is tolerable until then. |
| T-0018 | Dev HUD budget bars | Folded into T-0019; the overlay reads `resolvePatchBudget` already. |
