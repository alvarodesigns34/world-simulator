# ROADMAP — milestones, acceptance criteria, risks

**Companion to** [`ARCHITECTURE.md`](ARCHITECTURE.md).
Roadmap adjustments to the original proposal are recorded in **DEC-026**.

---

## How to read this

- **Acceptance criteria are objective.** A criterion that cannot be measured or
  observed by a third party is not a criterion. Numbers where numbers are possible,
  a named observable behaviour where they are not.
- **Astra gate** marks milestones that require Astra's `APPROVED` verdict in
  `agent/ASTRA.md`. Every milestone needs one to close (DEC-023 / PROTOCOL §7), but
  the marked ones are those where Astra's judgement is the *substance* of the
  acceptance, not a formality.
- **Grok candidates** are modules that suit Grok's role: self-contained, algorithmic,
  benchmarkable, and independently verifiable against a specification.
- A milestone is not complete until every criterion is **measured and recorded with
  its number** in the milestone's closing log entry.

### Guiding constraint

> **Every milestone ships something you can look at and use.**
> No milestone is allowed to be pure infrastructure with nothing observable at the
> end. This is the only reliable defence against an unfinishable half-built engine
> (**R-07**).

---

## Changes from the proposed roadmap (DEC-026)

1. **Terrain genesis vs. live geology are separated, and both are correct.**
   M2 generates terrain from a **genesis-time geological history** — a plate
   simulation run once at world creation, whose *output* is the initial elevation
   field. M7 promotes that same solver to a runtime subsystem at geological time
   scales. Same code, two lifetimes.
   *Why:* continents, mountain belts and coastlines **are** the output of geology.
   Generating them from noise at M2 and then bolting on real tectonics at M7 would
   mean either throwing M2's terrain away or living with terrain that contradicts
   its own geology. The split gets a physically motivated planet at M2 for a
   fraction of M7's cost, and makes M7 a promotion rather than a rewrite.

2. **A minimal data-layer visualiser moves from M12 into M1.**
   A globe/flat-map overlay that renders any registered field as a colour ramp, with
   a legend and a probe readout.
   *Why:* it is roughly a day of work and it is the primary debugging tool for
   M3–M8. Building it at M12 means debugging five milestones blind. M12 remains the
   *polished* scientific visualisation milestone.

3. **M14 — Sharing, Modding & Tooling** is added as an explicit optional milestone,
   rather than letting those concerns leak into earlier ones.

Numbering and scope are otherwise preserved, so the shared vocabulary with the brief
stays intact.

---

## M0 — Architecture & Infrastructure

**Goal:** a foundation three agents can build on for years without tripping over
each other.

**Scope**
- `/agent` and `/docs` infrastructure; PROTOCOL, DECISIONS, TASKS, HANDOFF, logs.
- Architecture v0: all decisions recorded with alternatives and consequences.
- Monorepo skeleton, TypeScript strict, Vitest, boundary checker, CI.
- Minimal scaffolding **only** where it validates a hard-to-reverse decision:
  `SimTime`, stateless hashing, cube-sphere coordinates, budgets, assertions.

**Acceptance criteria**
- [ ] `pnpm run check` (typecheck + lint + boundaries) passes.
- [ ] `pnpm test` passes.
- [ ] The boundary checker **fails** on a deliberately introduced `sim → render`
      import (the check is proven, not merely present).
- [ ] `SimTime` arithmetic is exact: 10⁶ years of accumulated 1/60 s steps loses
      **zero** whole seconds, verified by test.
- [ ] Stateless hashing is order-independent: keys generated in forward and reverse
      order produce identical values, verified by test.
- [ ] Cube-sphere round-trip `PCF → CubeFace → PCF` error **< 1 mm** at R,
      including at face corners, verified by test.
- [ ] Every ADR records alternatives, rationale and consequences.
- [ ] `agent/HANDOFF.md` contains an actionable audit brief for Grok.

**Astra gate:** no (nothing to look at yet — this is the one exception to the
guiding constraint, and it is why M1 is deliberately small).
**Grok candidates:** the whole architecture, adversarially. Especially DEC-005,
DEC-010, DEC-015, DEC-016, DEC-020 and §7 of `RENDERING.md`.

---

## M1 — Planet Engine Foundation

**Goal:** a sphere on screen, correct at every scale, with the camera and precision
strategy **empirically proven**.

**Scope**
- WebGPU device, pipelines, reversed-Z infinite-far depth.
- Cube-sphere quadtree, LOD traversal, screen-space error, morphing, skirts.
- Camera: one continuous geodetic state, controllers, altitude blending.
- `FieldStore`, `EntityStore`, `WorldView`, grid registry.
- Scheduler skeleton with phases, cadence, one trivial subsystem.
- Worker pool, SAB detection and transfer fallback.
- Telemetry, trace export, dev HUD, `budgets.ts`.
- **Data-layer visualiser** (DEC-026): any field as a colour ramp + legend + probe.
- Cube-face seam resolution.

**Acceptance criteria**
- [ ] Scripted descent 40 000 km → 1 m in 60 s: **no frame > 33 ms**.
- [ ] At 1 m altitude, measured vertex position error **< 1 cm**; no visible vertex
      swim when the camera is stationary.
- [ ] **No z-fighting** anywhere in the altitude sweep.
- [ ] No visible crack or seam at any cube-face boundary, including the 8 corners,
      at grazing angles.
- [ ] 60 FPS sustained at 1440p on reference hardware with a smooth-sphere planet.
- [ ] Main thread ≤ 6.0 ms, GPU ≤ 10.0 ms, measured and recorded from a telemetry
      trace.
- [ ] Trace exports and opens in Perfetto.
- [ ] Data-layer visualiser renders an arbitrary registered field with a correct
      legend and a probe readout that matches the underlying value.
- [ ] Determinism suite green, including **1 vs 4 vs 8 workers**.
- [ ] SAB-unavailable fallback path runs and is measured against the SAB path.

**Astra gate:** **yes — the critical one.** Orbit→surface continuity, precision,
depth behaviour, seam quality. This validates DEC-005 and DEC-025, which are
currently decided on reasoning alone.
**Grok candidates:** worker pool and SAB plumbing; screen-space-error maths;
telemetry ring buffer; the `budgets.ts` numbers (attack them with arithmetic);
cube-face seam topology.

---

## M2 — Planetary Terrain

**Goal:** a planet that looks like a planet, generated by a plausible geological
history rather than by noise.

**Scope**
- **Genesis plate simulation** (DEC-026): initial plate layout from the seed,
  thousands of steps of drift/collision/subduction, producing crust age, thickness
  and elevation.
- Terrain field derivation: continents, mountain belts, plateaus, rift valleys,
  coastlines.
- Fluvial erosion (stream-power) and hillslope diffusion at L11, plus regional
  refinement.
- Tile baking: authoritative L11–L18 on CPU workers; decorative L19+ on GPU compute.
- Streaming, LRU tile cache, OPFS backing.
- `stableMath` (Tier A transcendentals).

**Acceptance criteria**
- [ ] Continents, mountain belts, plateaus and coastlines are identifiable and
      **correlate with the genesis plate boundaries** (convergent boundaries carry
      mountains; divergent carry rifts) — verifiable on the data-layer visualiser.
- [ ] Hypsometric curve (area vs. elevation) is within a documented envelope of
      Earth's, or a deliberate deviation is documented.
- [ ] Genesis generation completes in **≤ 60 s** on reference hardware.
- [ ] Terrain is **bit-identical** for the same seed across runs and worker counts.
- [ ] Tile bake ≤ **8 ms** per tile per worker; ≥ **120 tiles/s** on 4 workers.
- [ ] 60 FPS sustained during 100 m/s surface flight; **no pop-in exceeding 400 ms**.
- [ ] The L18→L19 authoritative/decorative transition is **visually undetectable**.
- [ ] Visible patch count stays within 800–1 200; triangles ≤ 8.2 M.
- [ ] `stableMath` accuracy within a documented ULP bound of a high-precision
      reference, with a benchmark against native `Math.*` recorded.
- [ ] Memory within budget (§7.5 of `RENDERING.md`).

**Astra gate:** **yes.** Terrain believability, LOD popping, streaming hitches, the
detail transition.
**Grok candidates:** **the plate genesis solver** (excellent fit — self-contained,
algorithmic, benchmarkable); erosion kernels; priority-flood depression filling;
noise/FBM; `stableMath`; the tile cache eviction policy.

---

## M3 — Ocean + Atmosphere

**Goal:** the planet reads as a *world* — sea, sky, light, day and night.

**Scope**
- Sea level, ocean surface rendering, shoreline, depth-based colour.
- Atmospheric scattering (precomputed LUTs, ray-marched at grazing angles).
- Day/night, axial tilt, seasons, orbital position (PCI frame).
- Energy-balance radiation model + prescribed circulation cells on the geodesic grid.
- Clouds (first pass), shadows, tonemapping.

**Acceptance criteria**
- [ ] Terminator, sunrise/sunset and twilight are physically plausible from orbit
      **and** from the surface, at all latitudes.
- [ ] Axial tilt produces correct seasonal insolation: measured per-latitude
      insolation matches an analytic reference within **2%**.
- [ ] Surface temperature field is within a documented envelope of an Earth-like
      latitudinal profile (equator–pole gradient, seasonal swing).
- [ ] Ocean horizon is clean at every altitude; no seam between ocean and terrain.
- [ ] GPU budget respected: ocean ≤ 1.5 ms, atmosphere + clouds ≤ 2.5 ms,
      shadows ≤ 1.0 ms.
- [ ] 60 FPS sustained from orbit and from the surface.
- [ ] Energy conservation: top-of-atmosphere net flux balances within **1%** over a
      simulated year.

**Astra gate:** **yes.** Scattering quality, horizon, terminator, scale perception,
ocean/terrain interface.
**Grok candidates:** scattering LUT generation and parameterisation; the radiation
model; geodesic grid topology and neighbour operators; cloud rendering cost.

---

## M4 — Climate

**Goal:** weather and climate that emerge from the planet rather than being painted
onto it — and the first real test of temporal LOD.

**Scope**
- Circulation solver on the geodesic grid (n6): choose between single-layer
  primitive equations and shallow-water + moisture advection, **with a benchmark**.
- Moisture transport, convection, orographic precipitation, rain shadows.
- Ocean currents and heat transport; sea ice.
- **Regimes**: `explicit` / `synoptic` / `climatology` / `paleo` with
  `quiesce`/`resume` (DEC-015).
- Conservative resampling operators between the geodesic and cube-sphere grids.

**Acceptance criteria**
- [ ] Hadley/Ferrel/Polar cells and the trade winds/westerlies **emerge** from the
      solver, not from a prescribed pattern.
- [ ] Rain shadows appear downwind of mountain belts, verifiable on the data layer.
- [ ] Precipitation and temperature fields produce a recognisable Köppen-like
      distribution.
- [ ] **Water is conserved to within 1e-6 relative over 100 simulated years**,
      including across every regime transition.
- [ ] **Energy is conserved to within 1e-6 relative** over the same span.
- [ ] Grid resampling round-trip conserves mass to within **1e-9 relative**.
- [ ] Climate step ≤ **40 ms** at n6; the simulation never blocks a frame.
- [ ] Regime transitions cost **≤ 2 frames > 33 ms** and produce no discontinuity in
      annual-mean fields greater than a documented tolerance.
- [ ] Time-scale ladder T0→T4 traversable in both directions with no state
      corruption; determinism suite green after a full traversal.

**Astra gate:** **yes.** Regime transitions are the highest-risk mechanism in the
project (**R-02**) and their failure mode is visual and temporal.
**Grok candidates:** **the solver itself** (prime Grok territory — numerics,
stability, CFL, benchmarking); semi-Lagrangian advection; conservative resampling;
the conservation test harness; regime-transition stress testing.

---

## M5 — Hydrology

**Goal:** water that flows where it should and stays where it should.

**Scope**
- Drainage basins, flow accumulation, priority-flood depression filling.
- Rivers as entities with discharge; lakes with levels; deltas and estuaries.
- Runoff, infiltration, snowpack, glaciers, ice sheets.
- Dynamic sea level (thermal expansion + ice volume).
- River and lake rendering.

**Acceptance criteria**
- [ ] Every cell drains to the ocean or to an endorheic basin; **no unresolved sinks**.
- [ ] River networks are dendritic; discharge scales with upstream area and
      precipitation within a documented envelope.
- [ ] Water balance closes: precipitation = evaporation + runoff + storage change,
      within **1e-6 relative** over 100 simulated years.
- [ ] Lake levels are stable under constant forcing and respond correctly to changed
      forcing.
- [ ] Sea level responds to ice volume with the correct sign and plausible magnitude.
- [ ] Global flow routing ≤ **500 ms** on the worker pool; does not block a frame.
- [ ] Rivers are visible and correctly placed from orbit down to the surface.

**Astra gate:** no (data-verifiable), but a visual check of river placement at M5
close is cheap and worth one request.
**Grok candidates:** **priority-flood and flow accumulation** (classic, benchmarkable
algorithms with known-good references); basin labelling; the water-balance harness.

---

## M6 — Biosphere

**Goal:** life distributed by climate, terrain and water rather than by hand.

**Scope**
- Biome classification from climate + soil + terrain.
- Vegetation density, net primary productivity, seasonal phenology.
- Populations, simplified trophic chains, migration, extinction.
- Vegetation rendering (strategy chosen at this milestone).

**Acceptance criteria**
- [ ] Biome boundaries follow climate and orography; no grid-aligned artefacts.
- [ ] Biome distribution is within a documented envelope of Earth's area fractions,
      or the deviation is explained by the planet's parameters.
- [ ] Seasonal phenology is visible (leaf-out, senescence, snow cover) and consistent
      with the climate.
- [ ] Populations are stable under stable climate and respond to climate change
      without unbounded oscillation.
- [ ] Vegetation rendering within GPU budget; ≥ 60 FPS at surface level.
- [ ] Biome and vegetation fields are deterministic and bit-identical across runs.

**Astra gate:** **yes.** Vegetation rendering quality and biome believability at
surface level.
**Grok candidates:** population dynamics stability (this is where unbounded
oscillation hides); NPP model; vegetation instancing performance.

---

## M7 — Dynamic Geology

**Goal:** promote the M2 genesis solver to a live subsystem; the planet has a future
as well as a past.

**Scope**
- Plates as runtime entities: drift, collision, subduction, rifting.
- Orogenesis, volcanism, faults, earthquakes.
- Continental drift over 10⁷–10⁸ years.
- Long-term erosion coupled to climate (reading `precip.annualMean`).
- Isostasy.

**Acceptance criteria**
- [ ] Continents drift, collide and rift over 10⁸ simulated years without the
      simulation diverging or producing invalid geometry.
- [ ] Mountain belts form at convergent boundaries and erode away after collision
      ceases.
- [ ] Crust mass is conserved (creation at ridges = consumption at trenches) within
      a documented tolerance.
- [ ] 10⁸ years simulates in **≤ 10 minutes** of wall clock at T4.
- [ ] Terrain, hydrology and climate all update consistently as geology changes;
      no field is left stale.
- [ ] Determinism suite green over a 10⁸-year run.

**Astra gate:** **yes.** Deep-time visualisation and whether drift reads as
believable rather than as a sliding texture.
**Grok candidates:** **the entire plate solver** — highest-value Grok module in the
project. Collision/subduction handling, isostasy, numerical stability over 10⁸ years,
and the performance target.

---

## M8 — Civilisation

**Goal:** people who settle where it makes sense.

**Scope**
- Settlement siting from terrain, water, climate, resources.
- Population and demography; carrying capacity.
- Territory and expansion.
- Technology development.

**Acceptance criteria**
- [ ] Settlements appear on coasts, rivers and fertile land; **no settlements in
      oceans, on ice sheets, or on impossible slopes**.
- [ ] Population responds to carrying capacity without unbounded growth or collapse
      oscillation.
- [ ] Territory expansion respects terrain barriers.
- [ ] 10⁴ settlements and 10⁶ population entities within CPU and memory budget.
- [ ] Civilisation step ≤ **20 ms** on the worker pool at T3.
- [ ] Deterministic across runs and worker counts.
- [ ] **DEC-012 review gate:** `EntityStore` performance at these counts measured;
      re-evaluate against a real ECS if it falls short.

**Astra gate:** no (data-verifiable). Visual gate arrives with M9.
**Grok candidates:** siting suitability evaluation at scale; `EntityStore`
performance and archetype churn; demography model stability.

---

## M9 — Procedural Cities

**Goal:** settlements become places.

**Scope**
- Street networks, districts, plots, buildings.
- City growth over time, coupled to population and economy.
- City rendering: LOD, instancing, impostors at range.

**Acceptance criteria**
- [ ] Street networks adapt to terrain (follow contours, cross rivers at bridges).
- [ ] Cities grow plausibly over time rather than appearing fully formed.
- [ ] City geometry is deterministic from the seed and the city's state.
- [ ] A 10⁶-inhabitant city renders at 60 FPS from street level and from orbit.
- [ ] City geometry generation ≤ **200 ms** per city on a worker.
- [ ] The city→terrain transition is seamless at every LOD.

**Astra gate:** **yes.** City visual quality, LOD transitions, street-level
believability.
**Grok candidates:** street network generation algorithms; building instancing
performance; city LOD/impostor strategy.

---

## M10 — Economy & Infrastructure

**Goal:** the network that connects the places.

**Scope**
- Resources, extraction, production, trade.
- Roads, railways, ports, energy, industry.
- Pollution; economic feedback into population and land use.

**Acceptance criteria**
- [ ] Trade routes follow terrain-aware least-cost paths; ports appear on navigable
      coasts.
- [ ] Infrastructure connects settlements in a plausible topology (hub-and-spoke
      around large cities, not a uniform mesh).
- [ ] Resource extraction depletes deposits; the economy responds.
- [ ] Pollution correlates with industry and disperses with wind — an observable
      coupling back into the climate subsystem.
- [ ] Economy step ≤ **20 ms** on the worker pool at T3.
- [ ] No unbounded growth or collapse over 10³ simulated years.

**Astra gate:** no (data-verifiable), one visual check of infrastructure rendering.
**Grok candidates:** least-cost path finding at planetary scale; trade network
solvers; economic model stability over long runs.

---

## M11 — Planetary Timeline

**Goal:** the whole time ladder, coherently, in both directions — plus replay.

**Scope**
- Full T0–T4 ladder with all regimes implemented and all transitions correct.
- Timeline UI: scrub, jump, bookmark eras.
- Snapshot/replay validation; recorded history and event log.
- Save format finalisation and migration testing.

**Acceptance criteria**
- [ ] A single run traverses T0 → T4 → T0 with **no state corruption**; determinism
      suite green afterwards.
- [ ] Conservation invariants hold across **every** regime transition in both
      directions.
- [ ] Replay of a command log reproduces the state hash **exactly** (Tier A).
- [ ] A recipe save under 100 kB reproduces a world bit-identically.
- [ ] A snapshot save/load round-trip is bit-identical.
- [ ] Save migration from an earlier engine version succeeds, or fails loudly with a
      clear message — never silently.
- [ ] 4.5 × 10⁹ simulated years completes without divergence, `NaN`, or invalid
      geometry.
- [ ] Timeline scrubbing does not exceed **2 frames > 33 ms** per transition.

**Astra gate:** **yes.** Temporal coherence is visual as much as numerical; this is
the milestone that validates DEC-015 as a whole.
**Grok candidates:** replay validation harness; long-run stress testing (this is
where 10⁹-year divergence hides); save migration testing; regime-transition fuzzing.

---

## M12 — Scientific Visualization

**Goal:** the planet as an instrument.

**Scope**
- All field layers with proper colour ramps, units and legends.
- Cross-sections (crust, atmosphere, ocean); vertical profiles.
- Time-series plots; comparison of eras.
- Vector field visualisation (wind, currents, plate motion).
- Data export (CSV, GeoTIFF-like, JSON).

**Acceptance criteria**
- [ ] Every registered field is visualisable with correct units and a correct legend.
- [ ] Probe readouts match the underlying field values exactly.
- [ ] Cross-sections are geometrically correct against a known analytic case.
- [ ] Time series are drawn from recorded history, not re-simulated.
- [ ] Exported data round-trips: export → import → identical values.
- [ ] Visualisation adds ≤ **1.0 ms** GPU and ≤ **0.5 ms** main thread.

**Astra gate:** no (correctness is checkable), one review for legibility and colour
choices.
**Grok candidates:** colour ramp perceptual correctness; export format design;
cross-section sampling accuracy.

---

## M13 — Cinematic / Final Polish

**Goal:** it looks as good as it is.

**Scope**
- Cinematic camera: splines, keyframes, easing, shot composition.
- Depth of field, motion blur, exposure adaptation, bloom, colour grading.
- Weather and atmospheric visual effects.
- Audio hooks (if in scope).
- Performance polish against every budget.

**Acceptance criteria**
- [ ] A 3-minute cinematic sequence from orbit to street level runs with **no frame
      exceeding 20 ms**.
- [ ] Post effects within the 1.0 ms GPU budget (or a revised, recorded budget).
- [ ] Exposure adaptation is smooth across the full orbit→surface luminance range.
- [ ] No visual artefacts at any altitude, time of day, or weather state.
- [ ] Every budget in `budgets.ts` met on reference hardware, recorded from traces.

**Astra gate:** **yes — the final gate.** This milestone is Astra's specialism end
to end.
**Grok candidates:** post-processing cost; final profiling pass; regression hunting
across the whole engine.

---

## M14 — Sharing, Modding & Tooling *(optional)*

**Scope:** world sharing via recipe saves, a parameter/scenario editor, a documented
subsystem plugin API, offline world generation CLI.
**Acceptance:** a shared `.wsim` recipe reproduces bit-identically on another
machine; a third-party subsystem can be registered without modifying engine code.
**Astra gate:** no. **Grok candidates:** the plugin API's isolation guarantees.

---

## Risks

| # | Risk | Impact | Likelihood | Mitigation | Owner |
| --- | --- | --- | --- | --- | --- |
| **R-01** | WebGPU unavailable or driver-broken, with no fallback (DEC-003) | High | Medium | Clear unsupported screen; Astra validates on ≥ 2 GPU vendors at every visual gate; `GpuDevice` seam keeps a fallback *possible* | Opus |
| **R-02** | Temporal LOD regime transitions are visibly or physically discontinuous (DEC-015) | **Critical** | **High** | Hysteresis; conservation invariants across transitions; aggregate representations mandatory; Astra gate at M4 and M11 | Opus / Grok |
| **R-03** | Determinism erodes silently (DEC-017) | **Critical** | Medium | Lint bans; worker-count determinism test in CI from M0; golden state hashes; the failure is caught the day it is introduced | Opus |
| **R-04** | Browser memory ceiling (~2–4 GB) vs. planetary ambitions | High | **High** | DEC-019 resolution split; strict budgets; quantised fields; regenerable regional tiles; memory counters in the HUD from M1 | Opus |
| **R-05** | COOP/COEP requirement for SAB breaks hosting or embedding | Medium | Medium | Transfer fallback is a *supported configuration*, exercised in CI and measured, not an afterthought | Grok |
| **R-06** | Erosion/tectonics at planetary resolution over 10⁸ yr is too slow to be interactive | High | **High** | Multi-resolution solvers; the M7 budget (10⁸ yr ≤ 10 min) is an acceptance criterion, so failure is visible early; algorithmic answers before faster loops | Grok |
| **R-07** | Scope: 14 milestones is years of work; risk of an unfinishable half-built engine | **Critical** | **High** | Every milestone ships something observable; milestones are independently valuable; M0–M4 is a coherent product on its own | All |
| **R-08** | Three agents, one repository: merge conflicts and silent architectural drift | High | **High** | `agent/PROTOCOL.md`; the ownership table; ADRs required before implementation; boundary checks in CI | Opus |
| **R-09** | Surface precision claims (DEC-005) fail in practice | High | Low | M1 acceptance criteria measure them directly, before anything is built on top | Astra |
| **R-10** | Two-grid resampling breaks conservation (DEC-008) | Medium | Medium | Conservative-by-construction operators; round-trip invariant test at 1e-9 | Grok |
| **R-11** | `stableMath` is too slow for Tier-A hot loops (DEC-018) | Medium | Medium | Benchmark at M2; if it fails, the answer is a narrower Tier-A boundary, recorded as a new ADR — not silently using `Math.*` | Grok |
| **R-12** | The performance budgets in `RENDERING.md` §7 are simply wrong | Medium | **High** | They are explicitly labelled estimates; M1 measures them; Grok is asked to attack them with arithmetic before a profiler exists | Grok |
| **R-13** | No third-party 3D framework means rendering features arrive slowly (DEC-004) | Medium | Medium | Renderer scope kept deliberately narrow; DEC-004 has an M2 review gate | Opus / Astra |

### Risk posture

**R-02, R-03, R-04 and R-07 are the ones that would actually kill the project.**
Each has a mitigation that is *structural* rather than procedural — a test that runs
in CI, a budget that is an acceptance criterion, or an architectural rule that makes
the failure impossible rather than merely discouraged. Procedural mitigations
("we'll be careful") are not accepted for these four.

---

## Dependency order

```
M0 ─→ M1 ─→ M2 ─→ M3 ─→ M4 ─┬─→ M5 ─→ M6 ─┬─→ M8 ─→ M9 ─→ M10 ─┐
                            │             │                    │
                            └──────→ M7 ──┴────────────────────┴─→ M11 ─→ M12 ─→ M13 ─→ M14
```

- **M7 (dynamic geology)** needs M4's climate for erosion coupling, and M2's genesis
  solver as its starting point. It can run in parallel with M5/M6.
- **M5 (hydrology)** needs M4's precipitation.
- **M6 (biosphere)** needs M4 (climate) and M5 (water).
- **M11** needs everything, because it is the milestone that proves everything
  coexists across the full time ladder.
- **M0–M4 is a coherent deliverable on its own**: a living planet with terrain,
  ocean, atmosphere and climate. If the project stops there, it stopped somewhere
  worth stopping. This is deliberate (**R-07**).
