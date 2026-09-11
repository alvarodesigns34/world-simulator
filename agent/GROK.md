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
| T-0007 | Adversarial audit of Architecture v0 | **Review** |
| T-0024 | Attack RENDERING.md §7 budgets with arithmetic | **Review** (done in the same turn) |
| T-0045 | `hashU64` as DEC-017 already specified | P0 |
| T-0046 | Boundary checker: sort / Map / quoted-property | P1 |
| T-0013 | Worker pool, SAB vs transfer — 50 MB measured, tiles not | P0 |
| T-0017 | Telemetry ring buffer + Chrome Trace export | P1 |
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
