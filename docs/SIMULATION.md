# SIMULATION — time, scheduling, determinism, concurrency, persistence

**Companion to** [`ARCHITECTURE.md`](ARCHITECTURE.md). Decisions in
[`agent/DECISIONS.md`](../agent/DECISIONS.md).

---

## 1. Time (DEC-014)

### 1.1 Representation

```ts
interface SimTime {
  readonly year: number;     // exact integer, signed; negative = before epoch
  readonly seconds: number;  // f64, normalised to [0, planet.secondsPerYear)
}

type Duration = number;      // branded f64 seconds
```

**Why not a single `f64` seconds counter.** At one million years
(3.156 × 10¹³ s) one ulp is ≈ 4 ms; at one billion years it is ≈ 4 s. Two runs
would disagree about what time it is, and replay dies. The `year` split keeps a
*exact* integer where exactness is needed and `f64` where it is cheap: within one
year (max 3.156 × 10⁷ s) one `f64` ulp is ≈ 4 × 10⁻⁹ s.

**Why the year specifically.** It is the system's natural period — axial tilt,
seasons, insolation, orbit — so the split point is physically meaningful, not just
numerically convenient. Calendars and seasons fall out of it directly.

`planet.secondsPerYear` is fixed at world creation and stored in the save.
Changing it invalidates a world.

### 1.2 Rules

- Every operation normalises (carry/borrow into `year`).
- `SimTime` is immutable. `add`, `sub`, `compare`, `lerp`, `format`.
- **All time arithmetic goes through `packages/core/src/time/`.** Raw arithmetic on
  `.year`/`.seconds` anywhere else is a lint error.
- `sub()` returns a `Duration` and asserts when the span exceeds `f64` integer
  exactness (≈ 2.8 × 10⁸ years in seconds).

### 1.3 Two clocks

| Clock | Advances by | Drives |
| --- | --- | --- |
| **Wall clock** | real elapsed time, clamped to ≤ 100 ms/frame | rendering, camera, interpolation, UI |
| **Simulation clock** | `wallDt × timeScale`, via the scheduler | every subsystem |

They are decoupled. Pausing the simulation does not pause rendering. Rendering at
30 FPS does not change simulation results.

### 1.4 The time-scale ladder

`timeScale` is a **stepped ladder**, not a continuous slider — because crossing a
tier triggers regime transitions (§2), which cost a frame or two.

| Tier | `timeScale` | 1 real second ≈ | Live subsystems |
| --- | --- | --- | --- |
| **T0** Realtime | 1 – 60 | seconds – minutes | render, camera, day/night, ocean surface, weather (explicit) |
| **T1** Hours/days | 10³ – 10⁵ | hours – days | + hydrology routing, snow/ice, phenology |
| **T2** Years | 10⁶ – 10⁷ | weeks – months | weather → synoptic; + vegetation, population, economy |
| **T3** Centuries | 10⁸ – 10¹⁰ | years – centuries | weather → climatology; + civilisation, ice sheets, sea level, soil |
| **T4** Deep time | ≥ 10¹¹ | 10³ – 10⁶ years | weather → paleo; + tectonics, long-term erosion, evolution |

Rule: **entering a coarser tier requires finer-tier subsystems to quiesce** (§2.2).

---

## 2. Temporal LOD: regimes (DEC-015)

### 2.1 The problem, stated numerically

At T4 (1 Myr per real second), an explicit weather solver at a 1-hour step needs
8.76 × 10⁹ steps per second. There is no hardware and no optimisation that closes a
nine-order-of-magnitude gap. Yet erosion, hydrology and biomes at that scale still
need rainfall, and "turn the weather off" gives us continents that never erode.

### 2.2 The mechanism

A subsystem is **a set of models, not one model**. The scheduler selects by `dt`:

```ts
interface Regime {
  readonly id: string;
  readonly validFor: { minDt: Duration; maxDt: Duration };
  step(ctx: StepContext): void | WorkerJobHandle;
  quiesce(ctx: StepContext): void;   // flush transients into aggregates
  resume(ctx: StepContext): void;    // reconstruct transients from aggregates
}
```

Worked example — the atmosphere:

| Regime | Valid `dt` | Model | Produces |
| --- | --- | --- | --- |
| `explicit` | ≤ 6 h | advection + moisture + convection + orographic lift | instantaneous wind, cloud, rain; individual storms |
| `synoptic` | 6 h – 30 d | reduced solver, larger steps | pressure systems as fields, storms as statistics |
| `climatology` | 30 d – 100 y | monthly climatological means from the current boundary conditions | monthly means only; no weather events |
| `paleo` | > 100 y | energy balance vs. orbit, CO₂, albedo, orography | annual means; climate belts |

### 2.3 The three rules that make it coherent

**Rule 1 — transitions are explicit lifecycle events.**
`quiesce()` must leave the world consistent: transient state is folded into the
aggregate representation, partial steps are completed or discarded cleanly. A
subsystem is never left half-stepped. `resume()` reconstructs plausible transients
from aggregates (e.g. seeding a wind field from the climatological pressure
gradient).

**Rule 2 — cross-regime fields exist in two representations.**

```ts
{ id: 'precip.instant',    aggregate: 'precip.monthlyMean' }
{ id: 'precip.monthlyMean' }
```

Consumers declare which they read. Erosion at T4 reads `precip.annualMean` and keeps
working. The field registry **enforces** that any field read across a regime
boundary has an aggregate. This rule is what prevents the "turn it off" failure.

**Rule 3 — coarse regimes conserve what fine regimes conserve.**
Total water and total energy are invariants across a regime transition, tested with
a documented tolerance. A transition that leaks water is a bug, not a rounding
artefact.

### 2.4 Hysteresis

Transition thresholds have hysteresis (enter `climatology` above 30 d, leave below
20 d) so that a `timeScale` sitting on a boundary does not thrash. Thrashing regimes
would be both slow and visibly wrong.

### 2.5 What this costs

Each fast subsystem costs **2–4× the design work** of a single-regime one. That is
the real price of the brief's time-scale requirement. It is planned for here rather
than discovered at M11.

---

## 3. The scheduler (DEC-016)

### 3.1 Declaration

```ts
interface Subsystem {
  readonly id: SubsystemId;
  readonly phase: Phase;
  readonly cadence: Cadence;          // SIM time, never frames
  readonly reads:  readonly FieldId[];
  readonly writes: readonly FieldId[];
  readonly regimes: readonly Regime[];
  readonly budget: { mainThreadMs: number; workerMs: number };
  readonly tier: 'A' | 'B';
}

type Cadence =
  | { kind: 'every';      dt: Duration }
  | { kind: 'everyNOf';   n: number; of: SubsystemId }
  | { kind: 'onDemand';   trigger: TriggerId };
```

### 3.2 Ordering

1. **Phases** give a fixed coarse order:
   `Input → Geology → Terrain → Hydrology → Atmosphere → Ocean → Biosphere →
   Civilisation → Economy → Derived → Presentation`.
2. Within a phase: **topological sort** of the `reads`/`writes` dependency graph.
3. Ties broken **lexicographically by `SubsystemId`**.

Consequence: order is a pure function of the registry contents. Registration order,
module load order and worker count cannot affect it.

### 3.3 Commit discipline — the rule that buys determinism

> **Completed worker results are applied at the next tick boundary, in the fixed
> subsystem order — never on arrival.**

A job that finishes early waits. A job that finishes late stalls its own subsystem's
next step but never reorders anything. This is the price of being asynchronous and
deterministic at the same time, and it is a low price: the only cost is a little
latency, which is invisible at simulation time scales.

### 3.4 Feedback loops

Cycles in the dependency graph are a **startup error**. A genuine physical feedback
(ocean temperature ↔ atmospheric temperature) is broken explicitly by reading the
previous generation of a double-buffered field, declared as `reads: [prev(F)]`.
Making the lag explicit also makes it *visible*, which matters — an implicit
one-step lag is the kind of thing that silently changes a climate's behaviour.

### 3.5 Budgets and overruns

A subsystem that overruns its budget is logged and, in dev builds, asserted.
It is **never silently dropped** — dropping a step changes results, which is a
determinism bug wearing a performance costume. The correct responses are: lower the
cadence, move it to a worker, or choose a coarser regime.

### 3.6 The sharpest edge

An inaccurate `reads`/`writes` declaration produces wrong ordering with **no error**.
Mitigations:
- dev-build write barrier detects undeclared writes at runtime;
- a test runs an instrumented step and asserts every subsystem's declaration against
  its observed accesses.

---

## 4. Determinism (DEC-017, DEC-018)

### 4.1 Stateless seeds

```ts
const h = hash64(worldSeed, DOMAIN_TERRAIN_BASE, face, level, x, y);
```

There is no global RNG. `domainId` is a compile-time constant per generator so two
generators never collide on a key. A local stateful generator is permitted *inside*
a pure function whose seed is fully determined by its inputs, because the output is
still a pure function of the key.

**Why this and not a seeded stream:** terrain chunks are generated in camera-visit
order across a variable number of workers. Order-independence is a requirement, and
a stateless hash makes it structurally impossible to violate.

### 4.2 Banned in `core` / `data` / `sim` (lint-enforced)

`Math.random` · `Date.now` · `performance.now` · `new Date()` ·
`crypto.getRandomValues` · result-affecting iteration over `Set`/`Map` insertion
order · `Array.prototype.sort()` without an explicit total-order comparator ·
reductions folded in completion order.

### 4.3 Tiers

| Tier | Guarantee | Uses | Applies to |
| --- | --- | --- | --- |
| **A** | Bit-exact on any platform | exact IEEE ops + `stableMath` | authoritative world state; replay; golden tests |
| **B** | Same seed → statistically/visually identical | `Math.*` allowed | derived data, analysis, statistics |
| **C** | None | anything | rendering, particles, post, UI |

`Math.sin`, `Math.exp`, `Math.pow` are **not** bit-exact across JavaScript engines
or architectures — the specification permits implementation-defined approximations.
GPU floating point varies by vendor, driver and shader compilation. Tier A therefore
uses `packages/core/src/stableMath/`: polynomial/table implementations with
documented accuracy, tested against high-precision references.

> **The GPU may never produce Tier-A state.** This is the enforceable form of
> *Simulation State != Rendering State*.

### 4.4 The tests that matter

```
same seed, twice                       → identical hashWorldState()
chunks generated in reversed order     → identical
1 worker vs 4 vs 8                     → identical      ← catches the real bugs
save → load → step N                   → identical to stepping N without saving
regime transition A→B→A                → water and energy conserved within ε
```

---

## 5. Concurrency (DEC-020)

### 5.1 Shape

```
main thread          workers (hardwareConcurrency − 1, clamped 1..8)
──────────────       ─────────────────────────────────────────────
input, camera        terrain tile generation
scheduler            erosion passes
result commit        flow routing / depression filling
renderer             climate steps
UI / HUD             plate advection
                     save / load serialisation
```

The main thread has ~6 ms per frame. Everything larger goes to a worker.

### 5.2 Memory

**Preferred: `SharedArrayBuffer`.** Large persistent fields (a 50 MB elevation
field at L11) are read by several workers per tick; copying them is not affordable.
Requires `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on the dev server and any hosting.

**Fallback: transferable `ArrayBuffer`s.** A *supported configuration*, exercised in
CI, measured rather than assumed. It is slower and has lifetime constraints (a
transferred buffer is detached on the sender), which the `FieldStore` API hides.

### 5.3 Safety without locks

Correctness comes from **phase separation**, not mutexes:

- Within a scheduler phase, a field has at most one writer (DEC-013).
- Readers of a field currently being written read its **previous generation** from a
  double buffer.
- `Atomics` are used only for job-queue coordination and completion counters —
  never over field data.
- `Atomics.wait` is forbidden on the main thread anyway; lock contention in a 60 FPS
  loop is exactly the unpredictability we cannot afford.

**Double-buffer only fields with a genuine read-write hazard**, listed explicitly in
the registry. 2× memory is too expensive to apply by default.

### 5.4 Job protocol

- Typed messages; handles and small plain objects only. Structured-cloning a large
  object graph across the boundary is an offence.
- Jobs are **cancellable** and **priority-ordered** (a tile the camera is looking at
  outranks one behind it).
- **≤ 250 ms per job**, so cancellation stays responsive when the camera turns.
- Jobs are pure functions of their inputs plus the world seed, so a cancelled and
  re-issued job produces the same result.

---

## 6. Subsystem catalogue

Target shape. Cadences are indicative and will be tuned against budgets.

| Subsystem | Phase | Grid | Typical `dt` | Regimes | Milestone |
| --- | --- | --- | --- | --- | --- |
| `plates` | Geology | geodesic n5 + entities | 10³–10⁵ yr | 1 | M2 (genesis) → M7 (runtime) |
| `volcanism` | Geology | cube L11 | 10²–10⁴ yr | 1 | M7 |
| `terrainBake` | Terrain | cube L11–L18 | on demand | 1 | M2 |
| `erosion` | Terrain | cube L11 (+regional) | 10²–10⁵ yr | 2 (fluvial / long-term) | M2 → M7 |
| `seaLevel` | Hydrology | scalar + cube L11 | 1 yr | 1 | M5 |
| `flowRouting` | Hydrology | cube L11–L16 | 1 d – 1 yr | 2 | M5 |
| `snowIce` | Hydrology | cube L11 | 1 d – 10 yr | 2 | M5 |
| `radiation` | Atmosphere | geodesic n6 | 1 h – 1 yr | 2 | M3 |
| `circulation` | Atmosphere | geodesic n6 | 1 h – 100 yr | **4** | M3 → M4 |
| `moisture` | Atmosphere | geodesic n6 | 1 h – 1 yr | 3 | M4 |
| `oceanCurrents` | Ocean | geodesic n6 | 1 d – 100 yr | 2 | M4 |
| `biomes` | Biosphere | cube L11 | 1 – 100 yr | 1 | M6 |
| `vegetation` | Biosphere | cube L11 | 1 mo – 10 yr | 2 | M6 |
| `populations` | Biosphere | entities + cube L11 | 1 yr | 2 | M6 |
| `settlements` | Civilisation | entities | 1 yr | 1 | M8 |
| `demography` | Civilisation | entities | 1 yr | 1 | M8 |
| `territory` | Civilisation | cube L11 | 1 – 10 yr | 1 | M8 |
| `technology` | Civilisation | entities | 1 yr | 1 | M8 |
| `resources` | Economy | cube L11 | 1 yr | 1 | M10 |
| `production` | Economy | entities | 1 yr | 1 | M10 |
| `trade` | Economy | graph | 1 yr | 1 | M10 |
| `infrastructure` | Economy | graph + cube L14 | 1–10 yr | 1 | M10 |
| `pollution` | Economy | cube L11 | 1 yr | 1 | M10 |
| `dataLayers` | Presentation | any | per frame | 1 | M1 |

---

## 7. Commands and replay (DEC-022)

```ts
interface Command {
  readonly at: SimTime;
  readonly seq: number;               // total order, ties broken by seq
  readonly kind: CommandKind;
  readonly payload: Readonly<Record<string, number | string | boolean>>;
}
```

**All mutation flows through commands.** The UI never writes simulation state
directly. This has teeth: it is what makes replay possible, what makes the recipe
save format possible, and what makes "why did this world turn out like this"
answerable.

Recording starts at **M0** — it is cheap now and impossible to retrofit. Replay
*validation* (a golden test replaying a log and comparing state hashes) arrives at
M11.

---

## 8. Persistence (DEC-022)

### 8.1 Container

```
[ JSON header: engineVersion, worldSeed, planetParams, simTime, blobIndex[] ]
[ blob 0: fieldId, schemaVersion, grid, dtype, quantum, length, deflate-raw bytes ]
[ blob 1: ... ]
```

Quantised (`i16` centimetres for elevation, `i16` 0.01 K for temperature) then
compressed with the platform's `CompressionStream('deflate-raw')` — no dependency
(DEC-027). Each blob carries its own `schemaVersion`.

### 8.2 Save kinds

| Kind | Contents | Size | Valid when |
| --- | --- | --- | --- |
| **Recipe** | seed, parameters, `SimTime`, full command log | kilobytes | Tier-A determinism holds and the engine version matches or migrates |
| **Snapshot** | all authoritative fields + entity tables | 50–500 MB | always |
| **Hybrid** | snapshot + subsequent command log | — | this is also **replay** |

Regional terrain tiles (L12–L18) are **never saved** — they are a pure function of
`hash(seed, quadkey)` and are regenerated. This is what keeps snapshots at hundreds
of megabytes rather than hundreds of gigabytes, and it is a direct dividend of
DEC-017.

### 8.3 Storage and migration

- **OPFS** for snapshots (large, streaming writes); **IndexedDB** for the world
  index and metadata; export as a single `.wsim` file for sharing.
- Migrations are a registry, `migrate(from, to)`, applied in sequence.
  A blob whose version has no migration path **fails loudly**. Never load-and-hope.
- Save/load runs on a worker and must not block the frame.

---

## 9. Where the hard problems are

Honest assessment, for whoever picks this up next:

1. **Regime transitions (§2).** The most novel mechanism here and the one with the
   least prior art to copy. Expect the first implementation to be wrong in ways that
   only show up as a slowly drifting climate.
2. **Conservation across two grids (DEC-008).** Area-weighted resampling is
   straightforward to write and easy to get subtly wrong; the invariant tests are
   what will catch it.
3. **`stableMath` performance.** If Tier-A transcendentals are 5× slower than
   `Math.*` in a hot erosion loop, DEC-018 gets expensive. Needs measurement early.
4. **Erosion and tectonics at planetary resolution over 10⁸ years** (R-06). The
   arithmetic may simply not fit the budget, in which case M7 needs an algorithmic
   answer, not a faster loop.
5. **Accurate `reads`/`writes` declarations (§3.6).** The failure is silent.
