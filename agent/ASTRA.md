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

## Queue

| ID | Request | Milestone | Status |
| --- | --- | --- | --- |
| A-0001 | M1 gate — orbit→surface continuity, precision, depth, poles, popping, frame pacing | M1 | **Ready to request.** Opus is unavailable; do not wait. Grok has measured everything a CPU can. |

---

## A-0001 — M1 gate (request)

Milestone:      M1
Requested by:   Grok 4.6
Branch/commit:  `agent/grok/m1-astra-ready` (PR to `dev`; do not merge `main`)
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

### What to look at

Load `?descent` (or press `T` from orbit). Watch the HUD. Then repeat free-fly.

1. **Pole sweep (`P`).** The camera maths is proven; what is not proven is
   whether the *motion* reads as smooth as it crosses ±90°. This is the
   single most valuable question on the milestone.
2. **Descent popping.** Morphing is **not implemented** (T-0015). Hysteresis
   1.5 only. CPU characterisation: max disappear 57 patches / 100 ms sample,
   max appear after t=0 is 48, t=0 appear=194 is the initial set. Is that
   *visible as a pop*, and is it tolerable until M2?
3. **Cracks / cube-face seams**, especially at the 8 corners and at grazing
   angles, view `3`. T-0020 is open; this tells us how urgent.
4. **Stationary at ~2 m.** Vertex swim (E2 / T-0051 / R-09). The f32
   relative-precision arithmetic says no; a GPU has not confirmed it.
5. **Frame pacing.** HUD `frame` / `cpu` / `select` / `gpu`. The 6.0 ms
   main-thread and 1.0 ms `lodTraversal` budgets. On Grok's host, steady
   select p50 was 0.155 ms; 16/601 samples > 1 ms were GC (t=42.1: 230
   visited, 0 misses, 4.2 ms). If *your* `select` stays < 1.0 ms, those
   were the box. If it doesn't, file it.
6. **Horizon.** Does the limb look like a planet or like a cut-out disc?
   Horizon culling is conservative against the analytic horizon in tests;
   grazing silhouette quality is not.
7. **Scale.** From 40 000 km, does it feel like a planet or like a ball?
8. **Patch size `[`/`]`.** CPU says keep 33×33 (17 hits the 2048 cap at
   1440p discrete → 3.52 px/tri; 65 undershoots 1080p density). If 17 or
   65 *looks* clearly better on your GPU, say so with the HUD numbers.
9. **Console / HUD `DEVICE LOST` / `GPU ERROR`**, and which vendor.
   DEC-003 has no fallback (R-01). Coverage is a real risk.

### What "correct" means

- Orbit → surface is one continuous camera, no mode seam, no gimbal flip
  at the poles.
- Depth does not z-fight from 40 000 km to 2 m in a single range.
- The planet does not grow holes as the camera moves (the CPU hole-bug is
  fixed; a visual hole is a regression).
- Popping, if present, is a LOD transition, not a flicker. Morph is allowed
  to wait for M2 if you say so.
- Frame time on a discrete GPU at 1440p stays inside 16.6 ms except for
  the one hitch when patch size changes.

### Already ruled out — do not re-check these

Covered by tests / benches. Spending budget here is a waste.

- Polar singularities in the camera **maths** (five tests: both poles, a
  full polar orbit, `moveForward` over a pole, `setAltitude` at a pole).
- Depth-buffer **numerical** resolution (75 nm at 1 m, 2.9 m at 40 000 km,
  always >100× finer than a pixel).
- LOD selector determinism, never emitting a node and its ancestor, budget
  never exhausted on the 601-sample descent.
- Horizon-cull conservativeness against the analytic horizon.
- Patch budget never below 2 px/triangle (DEC-032).
- `hashU64` vs BigInt; `hashFloat01x64` ÷ 2⁵³ exact on V8.
- FieldStore generation-publish under phase-separated workers; `raw()`
  aliasing after `commit` (known hazard, documented).
- Scheduler order independent of registration; A,C,B wave contract;
  Opus's drain-to-target bug.
- CPU half of E1 (keep 33×33 unless *your GPU* disagrees).
- SAB vs transfer **rules** (L11 REQUIRED, tiles PREFERRED transfer,
  8–64 KB UNNECESSARY). Browser table is T-0013 remainder, not this gate.
- Telemetry overhead as a CPU concern (fixed ring, no per-frame alloc).

### Telemetry to observe

HUD, every frame:

- `FPS`, `frame`, `cpu`, `select`, `encode`, `gpu`
- `altitude`, `speed`
- `patches` / budget, `triangles`, `px/tri`, `patch size`
- `LOD` histogram, `max level`, `visited`, `pool hit/miss`
- `culled horizon` / `frustum`
- `telemetry` µs, `spikes`
- `SAB yes/no`, `DEVICE LOST`, `GPU ERROR`

At the end of `T`, open the downloaded JSON in Perfetto. Zones:
`frame`, `simCommit`, `lodSelect`, `renderEncode`, `gpu`.

Record, in the verdict: GPU vendor/adapter, tier the HUD shows, resolution,
patch size, frame ms at **orbit / 80 km / 2 m**, and whether `gpu` is a
number or `n/a`.

### The specific question

**Is M1 visually good enough to start M2 terrain, or does popping / pacing /
poles / seams / swim force work first?**

### Approval criteria

```
Verdict:   APPROVED | APPROVED WITH FINDINGS | REJECTED
```

| Verdict | When |
| --- | --- |
| **APPROVED** | Orbit→surface reads as one camera. Poles look continuous. No holes. Popping is tolerable until M2 morph. Frame pacing holds on a discrete GPU at 1440p. No device-lost loop. Scale reads as a planet. 33×33 is acceptable (or you name the size that won, with numbers). |
| **APPROVED WITH FINDINGS** | The above holds, but there are localised defects (a seam at one corner, mild popping at one altitude, timestamp-query missing on this vendor, 17 looking better on fill-rate). File each as a task. M2 may start. |
| **REJECTED** | Unusable frame pacing, holes in the mesh, poles that *look* broken, a device-lost loop, z-fighting from orbit to surface, or popping so violent that morph cannot wait for M2. |

M1 does **not** close without one of the first two. A REJECTED is not
overridable by argument — only by a fix (`PROTOCOL.md` §5.3).

Findings come back to **Grok** if they are localised/technical. They wait
for **Opus** if they need an ADR. Do not start M2 in the same turn as a
REJECTED.

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
