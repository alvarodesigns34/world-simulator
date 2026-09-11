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
| T-0002 | Monorepo skeleton, strict TS, Vitest, CI, boundary checker | Opus | **Review** | P0 | `pnpm run check` and `pnpm test` pass; boundary checker fails on a deliberate `sim → render` import |
| T-0003 | `SimTime` / `Duration` with exact year-split arithmetic | Opus | **Review** | P0 | 10⁶ yr of 1/60 s steps loses zero whole seconds; full op coverage |
| T-0004 | Stateless hashing + noise primitives (`hash64`, domain ids) | Opus | **Review** | P0 | Forward and reverse key-order generation produce identical values; distribution sanity test |
| T-0005 | Cube-sphere coordinates, tangent warp, quadkeys | Opus | **Review** | P0 | `PCF → CubeFace → PCF` round-trip error < 1 mm at R, including face corners |
| T-0006 | `budgets.ts` + dev assertions | Opus | **Review** | P0 | Budgets are importable and referenced by docs; assertions strip from production builds |
| **T-0007** | **Adversarial audit of Architecture v0** | **Grok** | **Open** | **P0** | See `agent/HANDOFF.md`. Every listed area answered with a verdict and evidence; findings filed as tasks or as `Proposed` ADRs |

---

## Next — M1 (Planet Engine Foundation)

| ID | Title | Owner | Status | Pri | Acceptance |
| --- | --- | --- | --- | --- | --- |
| T-0010 | WebGPU device, pipeline layer, reversed-Z infinite-far depth | Opus | Open | P0 | Clears and draws; depth behaviour verified across the altitude sweep |
| T-0011 | `FieldStore` + `EntityStore` + registry + `WorldView` | Opus | Open | P0 | Field descriptors enforced; `WorldView` is read-only by type; serialisation round-trip |
| T-0012 | Scheduler skeleton: phases, cadence, ordering, commit discipline | Opus | Open | P0 | Deterministic order independent of registration order; cycle detection throws at startup |
| T-0013 | Worker pool, job protocol, SAB detection + transfer fallback | **Grok** | Open | P0 | Determinism identical at 1/4/8 workers; fallback path measured against SAB path |
| T-0014 | Cube-sphere quadtree, screen-space error, split/merge | Opus | Open | P0 | Correct traversal; no cracks; patch count within 800–1 200 |
| T-0015 | Patch mesh, CDLOD morphing, skirts, indirect instanced draws | Opus | Open | P1 | No popping; no cracks at face seams or corners at grazing angles |
| T-0016 | Camera: continuous geodetic state + altitude-blended controllers | Opus | Open | P0 | 40 000 km → 1 m descent with no discontinuity; no `switch` on altitude anywhere |
| T-0017 | Telemetry ring buffer, zones, Chrome Trace export | **Grok** | Open | P1 | Trace opens in Perfetto; overhead ≤ 0.2 ms/frame; no allocation in the hot path |
| T-0018 | Dev HUD: frame graph, budget bars, counters | Opus | Open | P2 | Reads `budgets.ts`; colours match actual budget state |
| T-0019 | Data-layer visualiser (field → colour ramp + legend + probe) | Opus | Open | P1 | Any registered field; probe readout matches the underlying value exactly |
| T-0020 | Cube-face seam topology and neighbour resolution | **Grok** | Open | P1 | No visible seam at any face boundary or corner; unit tests for all 24 edge adjacencies |
| T-0021 | `stableMath`: Tier-A sin/cos/exp/log/pow/atan2 | **Grok** | Open | P1 | Documented ULP bound vs. a high-precision reference; benchmark vs. native `Math.*` recorded |
| T-0022 | `hashWorldState()` + determinism test suite | Opus | Open | P0 | Same seed, reversed order, 1/4/8 workers, save→load→step — all identical |
| T-0023 | Command types + command log recording | Opus | Open | P1 | All mutation flows through commands; log serialises and replays (validation at M11) |
| **T-0024** | **Attack the performance budgets in `RENDERING.md` §7 with arithmetic** | **Grok** | Open | **P0** | Each budget either defended with a calculation or challenged with a corrected number |

---

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
