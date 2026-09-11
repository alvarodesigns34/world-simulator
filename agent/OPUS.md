# OPUS — log

**Role:** Principal Architect · Simulation Lead
**Owns:** global architecture, module design, data models, world state, time and
scheduling, concurrency, workers, persistence, determinism, testing, internal APIs,
technical integration, maintainability.

Newest entry at the top. Template at the bottom.

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
| Time | `{year: int, seconds: f64}` | A single `f64` seconds counter has a **4 ms ulp at 10⁶ years** — replay dies |
| Multiscale | Temporal LOD: regimes + `quiesce`/`resume` + mandatory aggregates | 1 Myr/s vs. 1 h weather steps is a **9-order-of-magnitude** gap; no optimisation closes it |
| Determinism | Stateless hashed seeds; honest A/B/C tiers; GPU never authoritative | Chunks generate in camera order across a variable worker count — order-independence is a requirement |
| Terrain data | Global L11 authoritative / regional L12–L18 on demand / L19+ decorative | What makes "the GPU is never authoritative" *affordable* |
| Concurrency | Worker pool, SAB preferred, phase separation not locks | Single-writer ownership already gives us the safety; we buy it once |

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
