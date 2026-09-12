# ARCHITECTURE — World Simulator

**Version:** Architecture v0 (M0)
**Status:** Proposed for adversarial review by Grok 4.6
**Authority:** Every decision here is backed by a record in
[`agent/DECISIONS.md`](../agent/DECISIONS.md). Where this document and a decision
record disagree, the record wins.

---

## 1. What this is

A planetary simulation engine. One planet, simulated as a coupled system —
geology, terrain, hydrology, oceans, atmosphere, climate, biosphere, civilisation,
economy — across time scales from a single second to a hundred million years, and
across spatial scales from orbit to a metre above the ground, rendered at 60 FPS.

It is a **simulation with a renderer attached**, not a renderer with a simulation
attached. That ordering is the whole architecture.

### 1.1 Founding principle

> **Simulation State != Rendering State.**

Concretely, this means four things that are enforced rather than encouraged:

| | Rule | Enforced by |
| --- | --- | --- |
| 1 | `sim` may not import `render`; `render` may not import `sim`. | `pnpm run check:boundaries`, CI (DEC-011) |
| 2 | `core`, `data`, `sim` contain no DOM, no `window`, no WebGPU types. They run under Node today. | lint + the test suite (DEC-002) |
| 3 | The GPU may never produce authoritative world state. | DEC-018, DEC-019 |
| 4 | The renderer reads world state through a read-only `WorldView`. It cannot ask the simulation to compute anything. | type system (DEC-011) |

The test of the principle: **delete `packages/render` and `packages/app`, and the
simulation still builds, runs, steps, saves and passes its tests.** This is an
actual CI job, not a thought experiment.

---

## 2. Layer map

```
┌──────────────────────────────────────────────────────────────────────────┐
│  app            shell · UI · dev HUD · command dispatch · WIRING         │
│                 the only place where sim and render meet                 │
└───────────────┬──────────────────────────────────────┬───────────────────┘
                │                                      │
    ┌───────────▼────────────┐          ┌──────────────▼──────────────┐
    │  sim                   │          │  render                     │
    │  scheduler             │          │  WebGPU device & passes     │
    │  subsystem registry    │          │  planetary LOD quadtree     │
    │  regimes (temporal LOD)│          │  camera (f64 → f32 here)    │
    │  world state assembly  │          │  terrain / ocean / sky      │
    │  commands & replay     │          │  tile atlas & streaming     │
    │  persistence           │          │  overlays & data layers     │
    └───────────┬────────────┘          └──────────────┬──────────────┘
                │        ╳  no dependency either way   │
                └───────────────┬──────────────────────┘
                                │
        ┌───────────────────────▼────────────────────────┐
        │  data                                          │
        │  FieldStore (SoA rasters)  EntityStore         │
        │  grids: cube-sphere, geodesic                  │
        │  coordinate frames & conversions               │
        │  WorldView (read-only)                         │
        │  serialisation container                       │
        └───────────────────────┬────────────────────────┘
                                │
        ┌───────────────────────▼────────────────────────┐
        │  core                                          │
        │  math (f64 vec/mat)  ·  SimTime  ·  Duration   │
        │  hashing & stateless RNG  ·  stableMath        │
        │  assertions  ·  telemetry  ·  budgets          │
        │  zero runtime dependencies                     │
        └────────────────────────────────────────────────┘

        ┌────────────────────────────────────────────────┐
        │  workers    job protocol · pool · SAB plumbing │  (core, data)
        ├────────────────────────────────────────────────┤
        │  tools      benchmarks · trace tooling · CLI   │  (everything)
        └────────────────────────────────────────────────┘
```

### 2.1 Dependency rules (DEC-011)

| Package | May depend on | Runtime deps allowed |
| --- | --- | --- |
| `core` | *nothing* | **none** |
| `data` | `core` | **none** |
| `sim` | `core`, `data` | **none** |
| `render` | `core`, `data` | with an ADR |
| `workers` | `core`, `data` | with an ADR |
| `app` | all | with an ADR |
| `tools` | all | dev only |

Violations **fail the build**. They are not warnings.

### 2.2 Why these seven packages

Each exists to hold a boundary, not to organise files:

- **`core`** — pure, dependency-free, DOM-free primitives. It is small on purpose.
  Its job is to be the thing everyone can depend on without inheriting anything.
- **`data`** — the world's *shape*: how state is stored, addressed and read. It
  deliberately contains no physics. This is what lets `sim` and `render` share a
  vocabulary without sharing logic, which is what makes rule 1 above possible.
- **`sim`** — the world's *behaviour*. All physics, all rules, all time.
- **`render`** — everything GPU. Owns nothing about the world.
- **`workers`** — the concurrency substrate. Separate from `sim` because worker
  plumbing is platform code and `sim` must stay platform-free.
- **`app`** — wiring, UI, and the composition root. The only place a `sim` object
  and a `render` object are in scope together.
- **`tools`** — benchmarks, trace conversion, offline world generation.

---

## 3. World state

### 3.1 Two storage primitives (DEC-012)

The world contains two categorically different kinds of state, and conflating them
is a mistake in both directions.

#### Fields — dense values on a grid

```ts
interface FieldDescriptor {
  readonly id: FieldId;
  readonly grid: GridId;               // 'cubesphere@L11' | 'geodesic@n6' | ...
  readonly dtype: 'i16' | 'i32' | 'u8' | 'f32' | 'f64';
  readonly components: number;         // 1 = scalar, 2/3 = vector
  readonly units: string;              // SI, e.g. 'm', 'K', 'kg/m^2', 'm/s'
  readonly quantum?: number;           // physical value per integer step
  readonly range: readonly [number, number];
  readonly owner: SubsystemId;         // DEC-013 — the only writer
  readonly tier: 'A' | 'B' | 'C';      // DEC-018
  readonly doubleBuffered: boolean;    // DEC-020
  readonly aggregate?: FieldId;        // cross-regime aggregate (DEC-015)
  readonly persist: 'snapshot' | 'derived' | 'never';
}
```

Fields are Structure-of-Arrays over typed arrays, backed by `SharedArrayBuffer`
where available (DEC-020). One descriptor per field, in a compile-time registry.
There is no runtime field creation.

#### Entities — discrete, sparse, with lifetimes

```ts
type EntityId = { readonly index: number; readonly generation: number };
```

Component columns are typed arrays; rows are dense with a free list; iteration is
always by index. Settlements, plates, river segments, populations, trade routes.

**Not** a third-party ECS — we need control of iteration order (determinism),
memory layout (zero-copy worker transfer) and archetype churn, and the subset we
need is small. See DEC-012.

### 3.2 Ownership (DEC-013)

Every field and every component column has **exactly one owning subsystem**,
declared in `packages/sim/src/ownership.ts`. Only the owner writes it. The
scheduler validates declarations at startup and throws on violation; dev builds
also trap undeclared writes at runtime.

This single rule is what makes three other things work:
lock-free concurrency (DEC-020), a computable dependency graph (DEC-016), and an
answerable question when a field goes wrong.

> **No duplicated state.** If subsystem B needs a transformed version of A's field,
> B either computes it on read or owns a separate *derived* field and declares
> `reads: [A]`. B never keeps a private copy.

### 3.3 `WorldView` — the read-only seam

```ts
interface WorldView {
  readonly time: SimTime;
  readonly planet: PlanetParameters;
  readonly generation: number;
  field(id: FieldId): ReadonlyFieldAccessor;
  entities(kind: EntityKind): ReadonlyEntityTable;
}
```

Declared in `data`. Implemented by `sim`. Consumed by `render` and by the UI.
It is the *only* way anything outside `sim` sees world state, and it has no
method that causes computation.

---

## 4. Space: grids, coordinates and precision

Full treatment in [`RENDERING.md`](RENDERING.md); the summary that matters
architecturally:

### 4.1 Coordinate frames (DEC-006)

Six named frames, each a distinct branded type, with conversions confined to
`packages/data/src/coords/`:

| Frame | Purpose |
| --- | --- |
| **PCF** — Planet-Centred Fixed, +Z = north, metres, `f64` | The canonical frame. All persisted geometry. |
| **PCI** — Planet-Centred Inertial | Sun direction, star field, orbit, axial tilt. |
| **Geodetic** — lat/lon/altitude, radians + metres, `f64` | Camera state, UI, import/export. |
| **CubeFace** — `(face, u, v)` on the tangent-warped cube-sphere | Terrain/surface raster addressing. |
| **QuadKey** — `(face, level, x, y)` | LOD nodes, tile cache keys, chunk seeds. |
| **Render** — camera-relative, +Y up, metres, `f32` | GPU only. Never persisted, never read by `sim`. |

SI units everywhere. Radians in code, degrees only at the UI edge.

### 4.2 Two grids, on purpose (DEC-007, DEC-008)

- **Cube-sphere, tangent-warped**, for terrain and rendering. It is the only
  candidate where the LOD quadtree, the GPU tile atlas, the chunk seed key and the
  raster index are *the same structure*.
  Cell size ≈ `10 007 543 / 2^L` m: L10 ≈ 9.8 km, L11 ≈ 4.9 km, L16 ≈ 153 m,
  L20 ≈ 9.5 m. Cell count `6·4^L`.
- **Icosahedral geodesic**, for the atmosphere/ocean circulation solver.
  `10·4ⁿ+2` cells: n=6 → 40 962 cells ≈ 112 km spacing.

This is not duplicated state. Each *field* lives on exactly one grid with exactly
one owner; the two grids are two discretisations chosen for two different physics
problems, joined by explicit, **conservative**, tested resampling operators.

### 4.3 Precision (DEC-005)

At Earth radius, one `f32` ulp is **0.5 m** — unusable. One `f64` ulp is
**~1 nanometre** — and free, because every JavaScript `number` is already `f64`.

1. All simulation and world data is `f64`.
2. All GPU vertex data is `f32` and **camera-relative**: `originPCF − cameraPCF` is
   differenced in `f64` on the CPU; only the small delta reaches the GPU. At a patch
   origin within 100 km, one ulp is 7.8 mm; within 1 km, 61 µm.
3. **Reversed-Z, `depth32float`, infinite far plane.** One depth range from orbit to
   centimetres; no split frusta.
4. Emulated GPU double precision is a targeted tool with a written justification,
   never a policy.

There is exactly **one** `f64 → f32` position conversion point, in
`packages/render/src/camera/`. Any other is a bug.

---

## 5. Time and scheduling

Full treatment in [`SIMULATION.md`](SIMULATION.md). Architecturally:

### 5.1 Time is exact (DEC-014)

```ts
interface SimTime { readonly year: number; readonly seconds: number }
```

`year` is an exact integer (±9 × 10¹⁵ available). `seconds` is `f64` within one
year, where one ulp is ~4 ns. A single `f64` seconds-since-epoch counter would have
a 3.90625 ms ulp at one million years and a 4 s ulp at one billion — which destroys
replay. The split point is the year because the year is the system's natural period
(tilt, seasons, orbit), so it is physically meaningful as well as numerically
convenient.

### 5.2 Temporal LOD (DEC-015) — the hardest problem in the project

At 1 Myr per real second, running weather at 1-hour steps needs 8.8 × 10⁹ steps per
second. This is not an optimisation problem; it is off by nine orders of magnitude.

The answer is **temporal LOD, symmetric with spatial LOD**: a subsystem is not one
model, it is a set of **regimes** at different fidelities, and the scheduler selects
one from the current effective `dt`.

```
atmosphere:  explicit (≤6 h) → synoptic (6 h–30 d) → climatology (30 d–100 y) → paleo (>100 y)
```

Three binding rules make it coherent rather than merely convenient:

1. **Regime transitions are lifecycle events.** `quiesce()` flushes transient state
   into the aggregate representation; `resume()` reconstructs from aggregates. A
   subsystem is never left half-stepped.
2. **Cross-regime fields have both an instantaneous and an aggregate
   representation**, and consumers declare which they read. Erosion at 1 Myr/s reads
   `precip.annualMean`, not `precip.instant` — which is how continents keep eroding
   when there is no weather.
3. **Coarse regimes conserve what fine regimes conserve**, verified by invariant
   tests across the transition.

### 5.3 The scheduler (DEC-016)

Subsystems are declarative:

```ts
interface Subsystem {
  readonly id: SubsystemId;
  readonly phase: Phase;
  readonly cadence: Cadence;          // in SIM time, never frames
  readonly reads:  readonly FieldId[];
  readonly writes: readonly FieldId[];
  readonly regimes: readonly Regime[];
  readonly budget: { mainThreadMs: number; workerMs: number };
}
```

Fixed phase order:
`Input → Geology → Terrain → Hydrology → Atmosphere → Ocean → Biosphere →
Civilisation → Economy → Derived → Presentation`.
Within a phase, topological sort of the `reads`/`writes` graph, ties broken
lexicographically by id — so the order is a pure function of the registry, not of
registration order.

**Results are committed at tick boundaries in that fixed order, never on arrival.**
A worker job that finishes early waits. This is the single rule that lets us be both
asynchronous and deterministic.

The `reads`/`writes` declaration does four jobs at once: ordering, ownership
validation, safe parallelisation (disjoint write sets may run concurrently), and
documentation. That is why it is mandatory rather than inferred.

---

## 6. Determinism

### 6.1 Stateless seeds (DEC-017)

There is no "the random number generator". All randomness is a pure hash of an
explicit key:

```
value = hash(worldSeed, domainId, ...coordinates)
```

Terrain chunks are generated in whatever order the camera visits them, across a
variable number of workers. Order-independence is therefore a *requirement*, not a
nicety, and a stateless hash makes it structurally impossible to get wrong.

Banned in `core`/`data`/`sim`, by lint: `Math.random`, `Date.now`,
`performance.now`, `new Date()`, `crypto.getRandomValues`, result-affecting
iteration over insertion-ordered collections, `sort()` without a total-order
comparator. Reductions fold in **key order**, never completion order.

### 6.2 Honest tiers (DEC-018)

Perfect cross-platform bit-exactness is not achievable in a browser: `Math.sin`,
`Math.exp` and `Math.pow` are implementation-defined, and GPU floating point varies
by vendor and driver. Pretending otherwise produces a replay system that fails
mysteriously in the field.

| Tier | Guarantee | Applies to |
| --- | --- | --- |
| **A** | Bit-exact on any platform. Only exact IEEE ops + our own `stableMath` transcendentals. | Authoritative world state. Replay and golden tests. |
| **B** | Same seed → statistically and visually identical; small FP drift tolerated. | Derived data, analysis. |
| **C** | No guarantee. | Rendering, particles, post, UI. |

**The GPU may never produce Tier-A state.** This is the concrete, enforceable form
of the founding principle: if the GPU cannot write world state, the renderer cannot
become the source of truth by accident.

### 6.3 The resolution split this forces (DEC-019)

DEC-018 says terrain the simulation reads must be CPU-generated. The arithmetic says
a global `i16` elevation field costs 50 MB at L11 and 201 MB at L12 — and the
renderer wants L24 (0.6 m), which globally would be 10¹⁵ cells.

| Tier | Levels | Source | Storage |
| --- | --- | --- | --- |
| Global authoritative | L0–L11 (≥ 4.9 km) | CPU workers, Tier A | resident, ~50 MB/field |
| Regional authoritative | L12–L18 (2.4 km → 38 m) | CPU workers, Tier A, on demand from `hash(seed, quadkey)` | LRU cache, OPFS-backed, regenerable |
| Decorative detail | L19+ (< 19 m) | GPU compute, Tier C | never stored, never read by `sim` |

Decorative detail must be **displacement-only and mean-zero** over a regional cell,
so it cannot change anything the simulation believes about the terrain.

This is the decision that keeps the founding principle *affordable*.

---

## 7. Concurrency (DEC-020)

- **One worker pool**, `clamp(hardwareConcurrency − 1, 1, 8)`, typed job protocol,
  cancellable, priority-ordered.
- **Large fields in `SharedArrayBuffer`** where available — zero-copy reads from
  workers. Requires COOP/COEP headers. **Fallback to transferable `ArrayBuffer`s is
  a supported configuration**, exercised in CI, not an afterthought.
- **No locks on field data.** Correctness comes from **phase separation**: within a
  phase a field has one writer (DEC-013), and readers of a field being written read
  its previous generation from a double buffer. `Atomics` are used only for job-queue
  coordination.
- **Double-buffer only fields with a genuine read-write hazard**, listed explicitly.
  2× memory is too expensive to apply by default.
- Messages carry handles and small plain objects. Structured-cloning a large object
  graph across the worker boundary is an offence.
- Job granularity ≤ 250 ms so cancellation stays responsive when the camera turns.

**Worker count must not change results.** This is a required test (DEC-023) and it is
the one that catches real determinism bugs.

**WASM is deferred** behind a mechanical gate (DEC-021): ≥ 5% of a budget,
≥ 2× measured speedup, a stable isolated kernel, and a new ADR.

---

## 8. Persistence (DEC-022)

One container format, two save kinds:

| Kind | Contents | Size | Validity |
| --- | --- | --- | --- |
| **Recipe** | seed + parameters + `SimTime` + command log | kilobytes | Tier-A determinism only. Ideal for sharing. |
| **Snapshot** | all authoritative fields + entity tables | 50–500 MB | Always valid, version-migrated |

Snapshot + subsequent command log = **replay**.

Container: JSON header + length-prefixed binary blobs, each with its own
`schemaVersion`, dtype, grid and quantisation; quantised (`i16` centimetres,
`i16` 0.01 K) and compressed with the platform's `CompressionStream` — no
dependency. **OPFS** for snapshots, **IndexedDB** for the world index. Export as a
single `.wsim` file.

**The command log starts at M0.** Every user action and parameter change is a
timestamped `Command`. It is cheap now and impossible to retrofit later. This is why
the UI never writes simulation state directly.

Migrations are a registry applied in sequence. A blob with no migration path fails
loudly — never load-and-hope.

---

## 9. Testing (DEC-023)

Ordered by how much they actually protect us:

1. **Determinism tests.** Same seed twice; reversed chunk order; 1 vs 4 vs 8 workers;
   save→load→step vs. not saving. *Highest value.*
2. **Invariant tests.** Water/energy/mass conservation within ε. No `NaN` in any
   field. Monotonic time. Quadtree well-formedness. Values in range. Coordinate
   round-trips within bounds.
3. **Golden-state regression.** `hashWorldState()` after N ticks from a fixed seed.
   A change is a deliberate act requiring justification — never a silent re-baseline.
4. **Unit tests.** Maths, coords, time, quadkeys, serialisation, `stableMath`.
5. **Performance tests.** Thresholds from `budgets.ts`; CI records every run and
   fails only on > 25% regressions, because a flaky perf gate gets disabled.
6. **Visual validation — human, by Astra.** Screenshot diffing on WebGPU across
   drivers is net-negative noise. Visual quality, popping, hitching and scale
   perception are Astra's gate, recorded in `agent/ASTRA.md`.

---

## 10. Observability (DEC-024)

- One `Telemetry` module, fixed-size ring buffer, **no allocation in the hot path**.
- CPU zones, subsystem timings, worker latency and queue depth, GPU pass timings via
  WebGPU `timestamp-query`, memory counters.
- **Trace export in Chrome Trace Event JSON**, which opens directly in Perfetto.
  Professional tooling for zero dependencies.
- Dev HUD: frame graph, budget bars against `budgets.ts`, cadence view, patch counts.
- **`packages/core/src/budgets.ts` is the single source of truth** for budgets. The
  HUD reads it, the perf tests read it, the docs cite it. A budget that lives only in
  a document is not a budget.
- Assertions compile out of production builds, so they can be liberal in dev.

---

## 11. Module map (target shape)

Directories marked *(M0)* exist now; the rest are planned and are created by the
milestone that needs them.

```
packages/
  core/src/
    math/          vec3/mat4 f64, quaternions, interpolation, constants
    time/          SimTime, Duration, calendar, normalisation          (M0)
    rng/           splitmix64 hashing, noise primitives, domain ids    (M0)
    stableMath/    Tier-A sin/cos/exp/log/pow/atan2                    (M1)
    telemetry/     ring buffer, zones, trace export                    (M1)
    budgets.ts     single source of truth for performance budgets      (M0)
    assert.ts      dev-only assertions, stripped in production         (M0)

  data/src/
    coords/        frames, branded types, conversions, cube-sphere     (M0)
    grids/         cube-sphere quadtree, icosahedral geodesic
    fields/        FieldStore, descriptors, registry, accessors
    entities/      EntityStore, component tables, free list
    view/          WorldView read-only interface
    serial/        container format, quantisation, migrations

  sim/src/
    scheduler/     phases, cadence, regimes, commit order
    ownership.ts   the field→subsystem ownership table
    world.ts       world assembly, generation counter, hashWorldState
    commands/      command types, log, replay
    subsystems/
      geology/     plates, faults, volcanism, orogenesis
      terrain/     genesis generation, erosion, tile baking
      hydrology/   basins, flow routing, rivers, lakes, sea level
      atmosphere/  radiation, circulation, moisture, precipitation
      ocean/       currents, heat transport, sea ice
      biosphere/   biomes, vegetation, productivity, populations
      civilisation/ settlements, population, territory, technology
      economy/     resources, production, trade, infrastructure

  render/src/
    gpu/           device, pipelines, buffers — the only WebGPU surface
    camera/        CameraState, controllers, the single f64→f32 point
    lod/           quadtree traversal, screen-space error, morphing
    terrain/       patch pipeline, tile atlas, streaming
    ocean/  sky/  clouds/  overlays/  post/
    shaders/       WGSL

  workers/src/
    pool.ts  protocol.ts  jobs/  sab.ts

  app/src/
    main.ts  loop.ts  ui/  hud/  wiring/

  tools/
    bench/  trace/  worldgen-cli/
```

---

## 11a. What exists today (Architecture v1 + M1)

### Executable engine core

| Module | Role | Decision |
| --- | --- | --- |
| `data/fields` | `FieldStore`: closed registry, quantised rasters, ownership, dirty blocks, generation-publish commit | DEC-012, DEC-013, DEC-028, DEC-030, DEC-032 |
| `data/grids` | cube-sphere and geodesic grid registry; aggregate grids may be coarser | DEC-007, DEC-008, DEC-030 |
| `sim/scheduler` | union dependency graph, phases, cadence in sim time, deterministic order, quiesce/resume | DEC-016, DEC-030, DEC-031 |
| `render/camera` | PCF + quaternion state, derived geodetic, the single f64→f32 point, reversed-Z projection | DEC-005, DEC-029, DEC-033 |
| `render/lod` | quadtree nodes, horizon + frustum culling, screen-space error, hysteresis | DEC-010, DEC-032, DEC-034 |
| `render/gpu` | WebGPU device with typed failure, instanced planet renderer | DEC-003, DEC-004 |
| `app` | composition root, input, frame loop, debug overlay | DEC-011, DEC-026 |
| `core/math` | f64 vectors and unit quaternions | DEC-029 |
| `core/rng` | `hashU32` and `hashU64` (splitmix64), domain separation | DEC-017 |
| `core/time` | `SimTime` year-split, `Duration`, calendar | DEC-014 |
| `core/budgets` | `resolvePatchBudget()` — the budget is a function, not a constant | DEC-024, DEC-032 |

**154 tests.** Typecheck clean under `strict` + `noUncheckedIndexedAccess` +
`exactOptionalPropertyTypes`, boundaries clean, `check:sim-standalone` clean,
`vite build` clean.

### What the numbers actually are

Every figure below is measured in this repository, not estimated.

| Claim | Result |
| --- | --- |
| `SimTime` vs a flat `f64` counter | **1.7 × 10⁻⁵ s** vs **1.04 × 10⁴ s** error over 10⁷ steps of 1/60 s at year 10⁶ |
| `f64` ulp at 10⁶ years | **3.90625 ms** (v0 published 7.8 ms, which was `t × EPSILON`, not an ulp) |
| Cube-sphere round-trip | **< 1 mm** at planet radius, all 12 edge midpoints and 8 corners |
| Tangent warp distortion | **area 1.30×, arc 1.06×** — against **5.20×** and **2.12×** naive |
| `f32` ulp at planet radius | **0.5 m** — the reason for the whole precision strategy |
| Depth resolution | **75 nm** at 1 m altitude; **2.9 m** at 40 000 km — both >100× finer than one pixel |
| `hashU64` collisions | **0** in 300 000 keys, where 32-bit expects ~10 |
| L11 `i16` field | **50.33 MB** (48.00 MiB) |
| 12-month T+P climatology | **1.21 GB** on cube L11, **1.97 MB** on geodesic n6 |
| 65×65 × 1000 patches @1440p | **0.450 px/triangle** — the small-triangle cliff |

### What is deliberately absent

No terrain generation, no tile streaming, no workers, no telemetry ring buffer,
no persistence, no regimes. Those are M2 and the tasks assigned to Grok. M1's job
was to make the decisions executable and falsifiable, not to fill them in.

---

## 12. The frame loop

```
requestAnimationFrame(t):
  1. telemetry.beginFrame()
  2. input → commands                    (app)
  3. sim.advance(wallDt × timeScale)     (sim)
       ├─ scheduler picks due subsystems by SIM-time cadence
       ├─ selects each one's regime from its effective dt      (DEC-015)
       ├─ dispatches worker jobs (fire-and-forget)             (DEC-020)
       └─ COMMITS completed results in fixed subsystem order   (DEC-016)
  4. worldView = sim.view()              (read-only snapshot handle)
  5. camera.update(wallDt)               (app → render)
  6. render.draw(worldView, camera)      (render)
       ├─ LOD traversal, screen-space error, split/merge
       ├─ tile streaming requests → worker pool
       ├─ camera-relative f64→f32 per patch                    (DEC-005)
       └─ encode passes, submit
  7. hud.draw(telemetry)
  8. telemetry.endFrame()
```

Points worth noting:

- **Step 3 never blocks.** Main-thread subsystem work is time-sliced against
  `budgets.mainThread.sim`; worker results land at the *next* tick boundary.
- **Step 4 returns a handle, not a copy.** `WorldView` is a read-only façade over
  live storage. The renderer reading a field mid-write is prevented by phase
  separation and double buffering (DEC-020), not by copying.
- **Steps 5 and 6 are the only places `f32` positions exist.**
- Rendering may run at a different rate to simulation. It already does: the
  scheduler's cadences are in simulation time, and the frame rate is wall-clock.

---

## 13. Risks this architecture carries

Full register with mitigations in [`ROADMAP.md`](ROADMAP.md#risks). The ones that
are *architectural* rather than merely difficult:

| # | Risk | Why it is architectural |
| --- | --- | --- |
| R-01 | WebGPU has no fallback (DEC-003) | A platform-coverage problem we chose; reversing it means writing a second renderer. |
| R-02 | Temporal LOD regime transitions are visibly or physically discontinuous (DEC-015) | This is the project's most novel mechanism and the one with the least prior art to copy. |
| R-03 | Determinism erodes silently (DEC-017) | One `Math.random` in a hot path invalidates replay and sharing, and the failure is invisible until someone tries. |
| R-04 | Browser memory ceiling (~2–4 GB) vs. planetary data | Forces DEC-019 and caps fidelity permanently. |
| R-06 | Geology/erosion at planetary resolution over 10⁸ years may be too slow to be interactive | Would make M7 and M11 a slideshow rather than a simulation. |
| R-08 | Three agents, one repository, silent architectural drift | The reason `agent/PROTOCOL.md` and `agent/DECISIONS.md` exist. |

---

## 14. What is deliberately *not* decided yet

Listing these matters as much as listing the decisions, because an undecided
question that looks decided is how architectures rot.

- **UI framework.** None chosen; the dev HUD is plain DOM. Deferred until the UI has
  real requirements (M8+). It will be its own ADR.
- **Atmospheric solver formulation.** DEC-008 fixes the *grid*, not the equations.
  M3 is energy-balance + prescribed circulation; M4 chooses between a single-layer
  primitive-equation solver and a shallow-water + moisture-advection scheme, with a
  benchmark. Deliberately open.
- **Vegetation and city rendering strategy** (instancing vs. impostors vs.
  procedural meshes). M6/M9.
- **Whether `EntityStore` survives contact with M8–M10 entity counts** (DEC-012
  review gate).
- **Multiplayer / shared worlds.** Out of scope; DEC-017 and DEC-022 keep the door
  open without paying for it.
- **Whether `stableMath` is fast enough for Tier-A hot loops.** Needs measurement —
  a first-class Grok task.
