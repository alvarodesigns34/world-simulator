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
| A-0001 | M1 gate — orbit→surface continuity, precision, depth, seams | M1 | Not ready (needs T-0010, T-0014, T-0015, T-0016) |

---

*(No entries yet — M0 has nothing to look at. This is the one milestone without an
Astra gate, and it is why M1 is deliberately kept small.)*
