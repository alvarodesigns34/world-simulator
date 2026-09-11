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

## Now — M0 closing / M1 opening

| ID | Title | Owner | Status | Pri | Acceptance |
| --- | --- | --- | --- | --- | --- |
| T-0001 | Architecture v0: decisions, docs, agent infrastructure | Opus | **Review** | P0 | All M0 criteria in `docs/ROADMAP.md`; every ADR has alternatives/rationale/consequences |
| T-0002 | Monorepo skeleton, strict TS, Vitest, CI, boundary checker | Opus | **Review** | P0 | `pnpm run check` and `pnpm test` pass; `check:boundaries:selftest` proves the checker rejects cross-package imports, `Math.random` and DOM access |
| T-0003 | `SimTime` / `Duration` with exact year-split arithmetic | Opus | **Review** | P0 | 10⁷ steps of 1/60 s at year 10⁶ has error < 1 ms and beats a flat f64 counter by > 10⁶×; full op coverage |
| T-0004 | Stateless hashing + noise primitives (`hash64`, domain ids) | Opus | **Review** | P0 | Forward/reverse identical (holds for `hashU32`). **Gap:** DEC-017 says 64-bit; code is `hashU32`. Follow-up T-0045 |
| T-0005 | Cube-sphere coordinates, tangent warp, quadkeys | Opus | **Review** | P0 | `PCF → CubeFace → PCF` round-trip error < 1 mm at R, including face corners |
| T-0006 | `budgets.ts` + dev assertions | Opus | **Review** | P0 | Budgets are importable and referenced by docs; assertions strip from production builds |
| **T-0007** | **Adversarial audit of Architecture v0** | **Grok** | **Review** | **P0** | Report in `docs/AUDIT-V0.md`; 12-area verdicts; DEC-028/029/030/032 Proposed; benches in `tools/bench/` |

---

## Next — M1 (Planet Engine Foundation)

| ID | Title | Owner | Status | Pri | Acceptance |
| --- | --- | --- | --- | --- | --- |
| T-0010 | WebGPU device, pipeline layer, reversed-Z infinite-far depth | Opus | Open | P0 | Clears and draws; depth behaviour verified across the altitude sweep |
| T-0011 | `FieldStore` + `EntityStore` + registry + `WorldView` | Opus | Open | P0 | **Blocked on T-0040 / DEC-028+030.** Descriptors include dtype/quantum/offset, `class`, coarser aggregate grid, generation publish (no memcpy). WorldView read-only by type; serialisation round-trip |
| T-0012 | Scheduler skeleton: phases, cadence, ordering, commit discipline | Opus | Open | P0 | **Blocked on T-0040 (union-graph rule).** Order independent of registration; cycle detection throws; graph is the union of regimes |
| T-0013 | Worker pool, job protocol, SAB detection + transfer fallback | **Grok** | Open | P0 | 1/4/8 workers identical. 50 MB clone=98 ms, transfer RT=34 ms measured (`tools/bench/audit-v0.mjs`). Fallback is **tile-sized jobs**, not in-place L11. SAB required for L11 writes |
| T-0014 | Cube-sphere quadtree, screen-space error, split/merge | Opus | Open | P0 | Horizon culling in M1. 65×65 is a knob (E1). Patch count also satisfies min px/triangle (DEC-032). Prefetch the chain of levels, not only leaves |
| T-0015 | Patch mesh, CDLOD morphing, skirts, indirect instanced draws | Opus | Open | P1 | No popping; no cracks at face seams or corners at grazing angles |
| T-0016 | Camera: continuous state + altitude-blended controllers | Opus | Open | P0 | **Blocked on T-0040 / DEC-029.** PCF+quat canonical; geodetic derived. Descent includes a **polar** pass. No `switch` on altitude |
| T-0017 | Telemetry ring buffer, zones, Chrome Trace export | **Grok** | Open | P1 | Trace opens in Perfetto; overhead ≤ 0.2 ms/frame; no allocation in the hot path |
| T-0018 | Dev HUD: frame graph, budget bars, counters | Opus | Open | P2 | Reads `budgets.ts`; colours match actual budget state |
| T-0019 | Data-layer visualiser (field → colour ramp + legend + probe) | Opus | Open | P1 | Any registered field; probe readout matches the underlying value exactly |
| T-0020 | Cube-face seam topology and neighbour resolution | **Grok** | Open | P1 | No visible seam at any face boundary or corner; unit tests for all 24 edge adjacencies. Write-up covers valence-3 corners for hydrology |
| T-0021 | `stableMath`: Tier-A sin/cos/exp/log/pow/atan2 | **Grok** | Open | P1 | Documented ULP bound vs. a high-precision reference; benchmark vs. native `Math.*` recorded |
| T-0022 | `hashWorldState()` + determinism test suite | Opus | Open | P0 | Same seed, reversed order, 1/4/8 workers, save→load→step — all identical |
| T-0023 | Command types + command log recording | Opus | Open | P1 | All mutation flows through commands; log serialises and replays (validation at M11) |
| **T-0024** | **Attack the performance budgets in `RENDERING.md` §7 with arithmetic** | **Grok** | **Review** | **P0** | Done in T-0007. 0.45 px/tri; 50 MB clone 98 ms; DEC-032 Proposed. Numbers in `budgets.ts` not silently edited |

---

---

## Architecture v1 (from T-0007) — do these before T-0011 / T-0012 / T-0016

| ID | Title | Owner | Status | Pri | Acceptance |
| --- | --- | --- | --- | --- | --- |
| **T-0040** | **Architecture v1: accept/reject DEC-028/029/030/032 and close B1–B5** | **Opus** | Open | **P0** | Each Proposed ADR is Accepted or Rejected with reasoning. Union-graph, recipe=command-log, no-f32-PCF-add, required `__frame`, ulp 3.90625 ms written down. Blocks T-0011/12/16 |
| T-0041 | Required PCF/PCI/Render discriminants | Opus | Open | P0 | `{x,y,z}` is not assignable to both PCF and PCI; constructors only. Part of T-0040 |
| T-0045 | `hashU64` as DEC-017 already specified | **Grok** | Open | P0 | 64-bit mix; `hashU32` goldens unchanged; L11-scale birthday documented. Bug against DEC-017, not a new ADR |
| T-0046 | Boundary checker covers sort / Map / quoted-property | **Grok** | Open | P1 | Self-test plants `Math["random"]()` and a comparator-less `sort` and sees them rejected |


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
| — | — | — | — |
