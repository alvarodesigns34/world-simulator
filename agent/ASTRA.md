# ASTRA — log

**Role:** Integration & Reality Engine · Visual Validation Gatekeeper
**Owns:** complex integration, inspecting the **running** application, localised
visual/technical defects, cross-agent debugging, orbit→surface validation, graphics
quality, rendering↔simulation interaction, and **approving or rejecting milestones**.

---

## Astra is a limited resource

Read `agent/PROTOCOL.md` §1.1 before queueing anything.

- **Budget: 3 requests per milestone**, plus 1 milestone gate review.
- **Never** ask Astra to write a subsystem, write tests, or produce large files.
  Astra produces little code, of high impact.
- **Never** ask Astra anything Opus or Grok can answer from the code or from a
  benchmark.
- A malformed request should be **rejected**, not answered.

### Astra is the right call for

- Does the running application actually look and behave correctly?
- Orbit → surface descent: continuity, precision, scale perception.
- Visual defects that are localised and hard to describe in text.
- Rendering ↔ simulation interaction bugs that cross agent boundaries.
- Graphics quality judgements.
- **Milestone approval or rejection.**

### Astra is the wrong call for

- Generating subsystems, tests or documentation.
- Anything answerable by reading the code.
- Anything answerable by a benchmark (that is Grok).
- Long investigations with no specific question.

---

## Request template

A request that does not fill in every field is malformed.

```
### A-NNNN — <title>
Milestone:      M<N>
Requested by:   <agent>
Branch/commit:  <sha>
How to run:     <exact commands>

What to look at:
  <specific view, altitude, location, time of day, time scale>

Reproduction:
  1. …
  2. …

What "correct" means:
  <the observable that decides it>

Already ruled out:
  <what has been checked, and how — so Astra does not repeat it>

The specific question:
  <one question>
```

## Verdict format

```
### A-NNNN — VERDICT

Verdict:   APPROVED | APPROVED WITH FINDINGS | REJECTED
Platform:  <GPU, driver, browser, OS, resolution>
Evidence:  <what was observed>

Findings:
| # | Severity | What | Where | Filed as |

Blocking (for REJECTED / WITH FINDINGS):
  <what must change before this can be approved>
```

**A milestone does not close without an `APPROVED` verdict recorded here.**
An Astra `REJECTED` is not overridable by argument — only by a fix
(`agent/PROTOCOL.md` §5.3).

---

## Milestones requiring Astra

| Milestone | Why Astra's judgement is the substance, not a formality |
| --- | --- |
| **M1** | Orbit→surface continuity, precision, depth behaviour, cube-face seams. **The critical gate** — it validates DEC-005 and DEC-025, both currently decided on reasoning alone. |
| **M2** | Terrain believability, LOD popping, streaming hitches, the L18→L19 authoritative/decorative transition. |
| **M3** | Atmospheric scattering, horizon, terminator, scale perception, ocean/terrain interface. |
| **M4** | Regime transitions (R-02, the project's highest risk) — their failure is visual and temporal. |
| **M6** | Vegetation rendering and biome believability at surface level. |
| **M7** | Deep-time visualisation; does continental drift read as believable? |
| **M9** | City visual quality, LOD transitions, street-level believability. |
| **M11** | Temporal coherence across the full time ladder; validates DEC-015 as a whole. |
| **M13** | Final polish. Astra's specialism end to end. |

M5, M8, M10, M12 are data-verifiable and need only a gate review, not investigation.

---

## 2026-09-12 (Grok final redteam) — still nothing in your brief changed

Grok attacked Opus's rewritten FieldStore (`707535e`, PR #6) and closed
descriptor mutation, production NaN, the 2^31 generation sign flip, and the
stamp/publish ordering. **None of it touches your list.** No shader, no
camera, no LOD, no winding probe.

**Run against `agent/grok/m1-final-redteam`, not PR #6, not `m1-structural-redteam`,
not `m1-astra-ready`.**

The descent harness still ends at **1 m**. `pnpm dev` is **http://localhost:8080**.

Order of operations: you are next, when the human queues you.

---

## 2026-09-12 (later) — nothing in your brief changed

A second Opus pass consolidated FieldStore, the scheduler and the production
invariants after Grok's structural red-team. **None of it touches your list.**
No rendering path changed; no visual behaviour changed.

Two things that may help when you do run:

- The descent harness now ends at **1 m**, matching the M1 criterion, instead of
  stopping at 2 m for no recorded reason.
- `docs/ROADMAP.md` has an **M1 scope reconciliation** table splitting every M1
  item into CLOSED TECHNICALLY / OPEN NON-VISUAL / **ASTRA-ONLY** / DEFERRED. The
  ASTRA-ONLY column is exactly your list and nothing else — if an item is not in
  that column, a test settled it and it is not worth your time.

Order of operations: Grok gets one pass at the rewritten FieldStore contracts
first, since M2 leans on them hardest. You are after that, when the human queues
you.

---

## 2026-09-12 — second-pass brief retargeted by Grok (structural redteam)

The running branch is **`agent/grok/m1-structural-redteam`**, not
`m1-astra-ready` and not Opus's GPU-integration HEAD alone. Grok reproduced
and fixed structural holes under Opus's GPU hardening (T-0066): FieldStore
partial publish, scheduler everyNOf/resume/cross-phase, a three-draw winding
probe that no longer guesses CW from a black pixel, polar `dragOrbit` via
qUp/qRight, and timestamp-query as optional.

**Do not re-diagnose T-0054.** Those four Ampere findings stay closed.
The winding HUD line now reports `unknown` rather than a CW guess when the
probe cannot run — if the canvas is black, that line is still the first
thing to read.

`pnpm dev` is **http://localhost:8080**, not 5173.

The rest of the second-pass brief (CLOSED STRUCTURALLY / STILL REQUIRES GPU
/ EYES / DEFERRED TO M2) in `agent/HANDOFF.md` still holds, with the winding
probe strengthened as above.

Opus's notes that still apply: E1 is no longer "is 33×33 fastest" (17×17
delivers identical geometry for 3.75× fewer triangles at M1). Bilinear sag
is ≤ 2.9 px, limb ≤ 1.6 px, τ honestly 4.0.

---

## Queue

| ID | Request | Milestone | Status |
| --- | --- | --- | --- |
| A-0001 | M1 gate — orbit→surface continuity, precision, depth, poles, popping, frame pacing | M1 | **First pass ran on Ampere. REJECTED (unusable). GPU defects fixed by Grok (T-0054). FieldStore contracts closed on `agent/grok/m1-final-redteam`. Second pass not yet requested — do not spend remaining budget until a human queues it, against that branch.** |

---

## A-0001 — first pass (Ampere) — Grok reconstruction

Astra ran this on NVIDIA Ampere against `agent/grok/m1-astra-ready` @ `4244d3d`
and hit her limit before commit/push. **Her patch is not on GitHub.** Grok
reproduced from current code and fixed the four defects (T-0054, 2026-09-12).

### What Astra found (do NOT re-investigate these)

| # | Symptom on Ampere | Cause | Grok status | Tests that now pin it |
| --- | --- | --- | --- | --- |
| 1 | WebGPU inits, canvas black, HUD “invalid command buffer” | WGSL identifier `meta` is reserved; Ampere compiled nothing | **FIXED** | `wgsl.test.ts`, `tools/check-wgsl.mjs` |
| 2 | Planet visible but rotated/wrong | View matrix stored as the transpose of the claimed `M*v` convention | **FIXED** | `camera.test.ts` (axes → local, 100 m forward → (0,0,−100), orthonormal) |
| 3 | Large holes in the sphere | POS_Y/NEG_Y inward ∂u×∂v **and** CW index buffer **and** 3-corner parallelogram missing c11 | **FIXED** | `coords.test.ts`, `geometry.test.ts` (6-face outward, CCW indices, 12 cube edges weld, bilinear vs parallelogram) |
| 4 | Planet-scale f32 reconstruction | `centreRel = -camera` packed in `.w`, shader did `dir * radius` | **FIXED** | `geometry.test.ts` packing; shader has no `centreRel`/`cameraPCF`/`meta`; DEC-033 gate |

Culling was **not** disabled. `frontFace: 'ccw'`, `cullMode: 'back'`.

### Closed — do not spend budget here on the second pass

Everything in the original “Already ruled out” list, **plus**:

- WGSL reserved-word `meta` (and the planted identifier gate).
- View-matrix convention / transpose.
- Cube-face winding and POS_Y/NEG_Y orientation.
- 3-corner vs 4-corner interpolation.
- Shader add of camera PCF / `centreRel` reconstruction.
- Polar camera **maths**, depth-buffer **numerical** resolution, LOD determinism,
  horizon-cull conservativeness, CPU E1 (keep 33×33 unless *your GPU* disagrees).

If the canvas is black again, it is a **new** shader/pipeline failure, not `meta`.
Check the HUD `GPU ERROR` line and the vendor string, and file it.

---

## A-0001 — second pass (when Astra is actually available)

Milestone:      M1
Requested by:   Grok 4.6
Branch/commit:  `agent/grok/m1-structural-redteam` (PR to `dev`; do not merge `main`)
Sheet:          `docs/M1-MEASUREMENTS.md`
How to run:

```
pnpm install
pnpm dev                 # http://localhost:8080  (COOP/COEP on; SAB path live)
# or jump straight into the scripted descent:
# open http://localhost:8080/?descent
```

Requires WebGPU. There is no WebGL2 fallback (DEC-003). An unsupported
browser prints a specific reason, not a blank canvas — that is correct.

**This request is ready. It is not queued until Astra is present.**
First pass already consumed the gate review. Treat the second pass as
using the remaining request budget, not as a new milestone.

### Controls

| key | action |
| --- | --- |
| drag | orbit |
| wheel / `W` `S` | altitude |
| `1` `2` `3` | shaded / LOD-level / patch-boundary |
| `[` `]` | patch size 17 ↔ 33 ↔ 65 (rebuilds the renderer; one hitch is expected) |
| `P` | automatic pole sweep |
| `T` | start the 60 s descent (seed `0x51a51a51`); downloads a Chrome Trace at t=60 |
| `G` | export the current telemetry ring as Chrome Trace JSON (Perfetto) |
| `` ` `` / `H` | toggle HUD |

### What to look at (second pass only)

The first pass never reached visual quality. These are now the questions:

1. **Is the canvas not black?** Shader must compile on Ampere (and whatever
   other vendor you have). HUD must not show a sticky `GPU ERROR` /
   invalid command buffer.
2. **Is the sphere closed?** No missing faces, no large holes, no T-junction
   cracks at cube-face corners in view `3`. Grazing angles at the 8 corners.
3. **Is the camera the right way up?** Looking at the planet, not 90° off.
   Pole sweep (`P`) motion continuous.
4. **Descent popping** (`T` / `?descent`). Morphing is still **not**
   implemented (T-0015). CPU: max disappear 57 / 100 ms. Is that *visible
   as a pop*, and is it tolerable until M2?
5. **Stationary at ~2 m.** Vertex swim (E2 / T-0051). The packing is now
   four small camera-relative corners; confirm it does not crawl.
6. **Frame pacing.** HUD `frame` / `cpu` / `select` / `gpu`. 6.0 ms main
   thread, 1.0 ms `lodTraversal`. Patch size `[`/`]`.
7. **Horizon limb and scale.** Planet vs cut-out disc; 40 000 km vs a ball.
8. **Bilinear sag (new, cheap).** From high orbit, does an L0 face look
   like a sphere or like a bilinear quilt sitting slightly inside it?
   A faceted silhouette is a quality note, not a hole. File it if it
   bothers you; do not reopen 4-corner packing to chase it.

### What "correct" means

- Orbit → surface is one continuous camera, no mode seam, no gimbal flip
  at the poles.
- Depth does not z-fight from 40 000 km to 2 m in a single range.
- The planet does not grow holes as the camera moves.
- Popping, if present, is a LOD transition, not a flicker. Morph is allowed
  to wait for M2 if you say so.
- Frame time on a discrete GPU at 1440p stays inside 16.6 ms except for
  the one hitch when patch size changes.
- **The canvas shows a planet on Ampere.** That is now a real criterion.

### Telemetry to observe

HUD, every frame: `FPS`, `frame`, `cpu`, `select`, `encode`, `gpu`,
`altitude`, `speed`, `patches` / budget, `triangles`, `px/tri`,
`patch size`, `LOD` histogram, `max level`, `visited`, `pool hit/miss`,
`culled horizon` / `frustum`, `telemetry` µs, `spikes`, `SAB yes/no`,
`DEVICE LOST`, `GPU ERROR`.

Record, in the verdict: GPU vendor/adapter, tier, resolution, patch size,
frame ms at **orbit / 80 km / 2 m**, and whether `gpu` is a number or `n/a`.

### The specific question

**Is M1 visually good enough to start M2 terrain, or do popping / pacing /
poles / seams / swim force work first?**

### Approval criteria

```
Verdict:   APPROVED | APPROVED WITH FINDINGS | REJECTED
```

| Verdict | When |
| --- | --- |
| **APPROVED** | Canvas shows a closed planet. Orbit→surface reads as one camera. Poles look continuous. No holes. Popping is tolerable until M2 morph. Frame pacing holds on a discrete GPU at 1440p. No device-lost loop. Scale reads as a planet. 33×33 is acceptable (or you name the size that won, with numbers). |
| **APPROVED WITH FINDINGS** | The above holds, but there are localised defects (a seam at one corner, mild popping at one altitude, timestamp-query missing on this vendor, 17 looking better on fill-rate, mild bilinear sag at L0). File each as a task. M2 may start. |
| **REJECTED** | Black canvas, unusable frame pacing, holes in the mesh, poles that *look* broken, a device-lost loop, z-fighting from orbit to surface, or popping so violent that morph cannot wait for M2. |

Findings that are localised/technical come back to **Grok**.
Architectural changes wait for **Opus**.
Do not start M2 in the same turn as a REJECTED.

### Reproduction of the scripted descent

Seed `0x51a51a51`. Keyframes in `packages/render/src/lod/descent.ts`:

| t s | what |
| ---: | --- |
| 0–12 | high orbit, equatorial, 40 000 km → 8 000 km |
| 12–24 | descend toward the pole |
| 24–36 | polar pass (the DEC-029 reason this exists), 1 500 km → 600 km |
| 36–48 | continental, mid-latitude, 80 km |
| 48–60 | surface approach to 2 m |

Same cameras on any machine. The CPU trace is `tools/bench/descent-trace.json`.
