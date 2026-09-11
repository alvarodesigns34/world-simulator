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
| A-0001 | M1 gate — orbit→surface continuity, precision, depth, poles | M1 | **Not yet requested.** The engine now runs; see the brief below for what will be asked and what has already been ruled out. |

---

## A-0001 (draft) — what Astra should check at the M1 gate

**Not yet a request.** Astra has not been invoked and must not be until T-0013,
T-0017 and E1 (T-0050) have run, because several of the questions below need a
telemetry trace to be answerable and it would waste a budgeted call to ask twice.
This section exists so the request is ready and so nobody re-derives it.

### How to run

```
pnpm install && pnpm dev     # http://localhost:5173
```
Controls: drag to orbit, wheel or `W`/`S` for altitude, `1`/`2`/`3` for shaded /
LOD-level / patch-boundary views, `[` and `]` to change patch size at runtime,
`P` to toggle the automatic pole sweep.

### What has ALREADY been ruled out — do not re-check these

These are covered by tests and are not worth Astra's budget:

- Polar singularities in the camera **maths** (five tests: both poles, a full
  polar orbit, `moveForward` over a pole, `setAltitude` at a pole).
- Depth-buffer **numerical** resolution across the altitude sweep (measured:
  75 nm at 1 m, 2.9 m at 40 000 km, always >100× finer than a pixel).
- LOD selector determinism, budget compliance, and never emitting both a node and
  its ancestor.
- Horizon-cull conservativeness against the analytic horizon.
- That the patch budget can never fall below 2 px/triangle.

### What only a human looking at the running app can answer

1. **Does the pole sweep (`P`) LOOK continuous?** The maths is proven; what is
   not proven is whether the *motion* reads as smooth or whether the control
   mapping does something disconcerting as it crosses. This is the single most
   valuable question.
2. **Is there visible vertex swim** with the camera stationary near the surface?
   The f32 relative-precision arithmetic says no; a GPU has not confirmed it
   (R-09, E2/T-0051).
3. **Is LOD popping visible** during a descent? Morphing is **not implemented
   yet** — M1 has hysteresis but no CDLOD morph — so some popping is expected.
   The question is whether it is *tolerable enough to defer morphing to M2*, or
   whether it must be done first.
4. **Do patch boundaries (`3`) line up across cube faces**, especially at the 8
   corners and at grazing angles? T-0020 is open; this would tell us how urgent.
5. **Does the scale read as planetary?** From orbit, does it feel like a planet
   or like a ball? This is a judgement no test makes.
6. **Any console errors or device-lost events** on your GPU/driver — and which
   vendor, since DEC-003 has no fallback (R-01) and coverage is a real risk.

### What will be asked for in the verdict

A tier judgement per DEC-032 (`discrete` / `integrated` / `floor`), the observed
frame time from the HUD at three altitudes, and whether item 3 blocks M2.

---

*(No entries yet — M0 has nothing to look at. This is the one milestone without an
Astra gate, and it is why M1 is deliberately kept small.)*
