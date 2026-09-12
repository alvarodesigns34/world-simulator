# DECISIONS — Architecture Decision Record

Authoritative record of every decision that is **expensive to reverse**.

## Rules (binding — see `agent/PROTOCOL.md`)

1. A decision recorded here may **not** be changed silently by any agent.
2. To change one, open a **new** record that `Supersedes:` the old one, and flip the
   old one to `Status: Superseded by DEC-NNN`. Never edit an `Accepted` record's
   Decision/Rationale text in place. Typos and clarifications are fine.
3. Code that contradicts an `Accepted` record is a **bug**, regardless of how well
   it works.
4. `Status: Proposed` records are open for attack. `Accepted` records need a
   superseding record with evidence — a benchmark, a failing test, a
   counter-example — not an opinion.
5. Records marked **`Review gate:`** must be explicitly re-validated at that
   milestone. They were decided on reasoning, not measurement.

Statuses: `Proposed` · `Accepted` · `Superseded by DEC-NNN` · `Rejected`

---

## Index

| ID | Title | Status | Review gate |
| --- | --- | --- | --- |
| DEC-001 | Language, toolchain and repository shape | Accepted | — |
| DEC-002 | Target platform: browser-first | Accepted | — |
| DEC-003 | Graphics API: WebGPU only | Accepted | M1 exit |
| DEC-004 | No third-party 3D framework | Accepted | M2 exit |
| DEC-005 | Numeric precision strategy | Accepted | M1 exit |
| DEC-006 | Coordinate systems and conventions | Accepted | — |
| DEC-007 | Planet surface representation: tangent-warped cube-sphere | Accepted | — |
| DEC-008 | Climate grid: icosahedral geodesic, separate from terrain | Accepted | M4 exit |
| DEC-009 | Camera-relative rendering, not global floating origin | Accepted | — |
| DEC-010 | Terrain LOD: chunked quadtree + CDLOD morph + skirts | Accepted | M2 exit |
| DEC-011 | Simulation/rendering separation enforced mechanically | Accepted | — |
| DEC-012 | World state: SoA fields + minimal entity store, no third-party ECS | Accepted | M8 exit |
| DEC-013 | Single-writer field ownership | Accepted | — |
| DEC-014 | Simulation time representation | Accepted | — |
| DEC-015 | Temporal LOD: subsystem regimes with quiesce/resume | Accepted | M11 exit |
| DEC-016 | Declarative subsystem scheduler with fixed commit order | Accepted | — |
| DEC-017 | Determinism: stateless hashed seeds, no shared RNG streams | Accepted | — |
| DEC-018 | Determinism tiers; GPU is never authoritative | Accepted | — |
| DEC-019 | Authoritative vs. decorative terrain resolution split | Accepted | M2 exit |
| DEC-020 | Concurrency: worker pool, SAB preferred, phases not locks | Accepted | M2 exit |
| DEC-021 | WASM deferred behind a benchmark gate | Accepted | continuous |
| DEC-022 | Persistence: versioned container, snapshot + command log | Accepted | M11 exit |
| DEC-023 | Testing strategy; visual validation is human, not CI | Accepted | — |
| DEC-024 | Observability: ring buffer, trace export, budgets-as-code | Accepted | — |
| DEC-025 | Camera: one continuous geodetic state | Accepted | M1 exit |
| DEC-026 | Roadmap adjustments to the proposed milestone order | Accepted | — |
| DEC-027 | Dependency policy | Accepted | — |
| DEC-028 | Raster quantisation; elevation is not i16 centimetres | **Accepted** (amended) | M2 exit |
| DEC-029 | Canonical camera is PCF + quaternion; geodetic is derived | **Accepted** | M1 exit |
| DEC-030 | Temporal LOD: three state classes, always-on aggregates, coarser aggregate grids | **Accepted** (amended) | M4 exit |
| DEC-031 | The scheduler dependency graph is the union over regimes | **Accepted** | M4 exit |
| DEC-032 | Performance budgets restated from arithmetic | **Accepted** (amended) | M1 exit |
| DEC-033 | Shader-side precision rules | **Accepted** | M1 exit |
| DEC-034 | Visibility and LOD contract: horizon culling, multi-level descent | **Accepted** | M2 exit |
| DEC-035 | Cube-face orientation and UV convention | **Accepted** | — |

### Architecture v1 — what changed and why

Architecture v1 is v0 plus Grok's adversarial audit (`docs/AUDIT-V0.md`, T-0007)
resolved in writing. Five blockers and eleven major findings were raised; **none
was rejected outright**. Four were accepted as written, three with amendments that
strengthen them, and three new records (DEC-031, DEC-033, DEC-034) close findings
the audit identified without proposing a decision for.

| v0 record | Fate in v1 | Because |
| --- | --- | --- |
| DEC-005 | **Amended by DEC-033** | "One conversion point" was a statement about CPU files; shaders needed their own rule |
| DEC-010 | **Amended by DEC-034** | Horizon culling was missing entirely; morph blends 1 level, the data jumps 7 |
| DEC-015 | **Amended by DEC-030** | Had two state classes; ice, ocean interior and groundwater are a third |
| DEC-016 | **Amended by DEC-031** | Per-subsystem declarations vs per-regime reality was never resolved |
| DEC-019 | **Amended by DEC-034** | The data split needed a mesh story to stay invisible |
| DEC-022 | **Quantisation clause superseded by DEC-028** | `i16` centimetres spans ±327 m; Everest is 8849 m |
| DEC-025 | **Representation superseded by DEC-029**; policy kept | Geodetic state is singular at the poles, where the cryosphere is |
| `budgets.ts` | **Restated by DEC-032** | 1000 × 65×65 at 1440p is 0.45 px/triangle, and contradicted τ = 2.0 px |

Everything Grok listed as solid (DEC-001–004, 007, 008, 009, 011, 013, 014, 018,
021, 023, 024, 026, 027, and the *policies* of 005, 012, 017, 019) stands
unchanged and was not reopened.

---

## DEC-001 — Language, toolchain and repository shape

**Date:** 2026-09-11
**Status:** Accepted

### Context
Three agents (Opus, Grok, Astra) will collaborate on one repository for a long
time, targeting tens of thousands of lines. Interfaces between subsystems written
by different agents at different times are the main failure surface. Agents cannot
ask each other questions synchronously; the code itself has to carry the contract.

### Decision
- **TypeScript**, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- **pnpm workspaces** monorepo with TypeScript project references.
- **Vite** for dev server and bundling; **Vitest** for tests.
- Package layout: `core`, `data`, `sim`, `render`, `workers`, `app`, `tools`
  (see `docs/ARCHITECTURE.md`).

### Alternatives considered
| Option | Why not |
| --- | --- |
| Plain JavaScript | Interface drift between agents becomes undetectable. Rejected outright. |
| Rust → WASM for the whole engine | Best raw numerics, but: slow iteration, painful DOM/WebGPU interop, and a much worse fit for the UI/orchestration half of the codebase. Numeric kernels can still go to WASM later (DEC-021). |
| Single-package repo | Cannot mechanically enforce the simulation/rendering boundary (DEC-011), which is the project's founding principle. |
| Nx / Turborepo | Real value only at a scale of build pipelines we do not have. Revisit if CI exceeds ~5 min. |
| Jest, Webpack | Slower, and Vite/Vitest share one config and one transform pipeline. |

### Rationale
Types are the only form of documentation that cannot go stale silently, and with
three authors that matters more than raw execution speed. The monorepo exists for
exactly one structural reason — enforceable dependency boundaries — not for
fashion.

### Consequences
- Every cross-package contract must be an exported type. "Just pass an object" is
  not acceptable across a package boundary.
- Build config is a shared asset; changing it is a `DECISIONS`-level act.
- Package boundaries are checked in CI (DEC-011). Adding a package is cheap;
  moving a module between packages is a reviewable change.

---

## DEC-002 — Target platform: browser-first

**Date:** 2026-09-11
**Status:** Accepted

### Context
The brief names Web Workers, SharedArrayBuffer, WASM and WebGPU/WebGL. Astra's
role requires inspecting the running application. Distribution and cross-agent
verification both matter.

### Decision
The browser is the **only** first-class target. Chromium ≥ 2024 is the reference
platform; Firefox and Safari are supported on a best-effort basis and tracked, not
guaranteed. No Electron/Tauri/native build in the roadmap.

### Alternatives considered
- **Native (Rust + wgpu)** — far higher performance ceiling and real f64 GPU paths,
  but destroys the "open a URL and look at it" loop that the three-agent workflow
  depends on, and abandons the brief's explicit web technology set.
- **Node-side headless simulation with a browser viewer** — a real option later for
  batch world generation. Explicitly kept possible: `core`/`data`/`sim` must never
  touch `window`, `document` or any DOM API, so they already run under Node today
  (this is what makes the test suite possible at all).

### Rationale
The web platform is the cheapest place to get a three-agent feedback loop, and
the constraint it imposes (a single-digit-GB memory ceiling, no threads except
workers) is a *useful* design pressure, not only a cost: it forces the
data-oriented layout we want anyway.

### Consequences
- A hard memory ceiling of roughly 2–4 GB per tab. Budgets in
  `docs/RENDERING.md` are written against it.
- `sim` must stay DOM-free. Enforced by lint (DEC-011).
- SharedArrayBuffer requires COOP/COEP response headers; the dev server and any
  hosting must set them (DEC-020).

---

## DEC-003 — Graphics API: WebGPU only, no WebGL2 backend

**Date:** 2026-09-11
**Status:** Accepted
**Review gate:** M1 exit — re-validate against measured platform coverage.

### Context
Planetary terrain, erosion detail, ocean spectra and atmospheric scattering all
want GPU compute. WebGL2 has no compute shaders; GPGPU there means
render-to-texture with transform feedback, which distorts every algorithm written
against it.

### Decision
**WebGPU is the only rendering backend.** No WebGL2 fallback will be written.
A thin internal `GpuDevice` seam isolates WebGPU API calls so that a fallback
*could* be added, but building one is explicitly out of scope.

### Alternatives considered
| Option | Assessment |
| --- | --- |
| WebGL2 only | Universal reach, but no compute. Every GPU-side terrain/ocean/atmosphere algorithm becomes a workaround. Rejected: the workarounds would define the architecture. |
| Dual WebGL2 + WebGPU backends | Roughly doubles all rendering work, permanently, and forces the renderer down to the WebGL2 feature floor. This is the single most expensive "safe" choice available and it is not safe — it is a tax on every future milestone. Rejected. |
| WebGPU now, WebGL2 fallback later if needed | Same as chosen, and honest about the risk. |

### Rationale
WebGPU has shipped in Chromium, Safari and Firefox. Compute shaders, explicit bind
groups, indirect draws and timestamp queries are each individually load-bearing for
this project: compute for terrain/ocean/atmosphere, indirect draws for GPU-driven
terrain LOD (DEC-010), timestamp queries for the GPU half of the budget (DEC-024).
A WebGL2 backend would not merely be extra work, it would cap the ceiling.

### Consequences
- Users on browsers or drivers without WebGPU get a clear "unsupported" screen,
  not a degraded experience. Accepted.
- **Risk R-01** in `docs/ROADMAP.md`: driver-specific WebGPU bugs have no fallback.
  Mitigation: Astra validates on at least two GPU vendors at every visual milestone.
- All WebGPU calls go through `packages/render/src/gpu/`. Direct `navigator.gpu`
  use elsewhere is a lint error.

---

## DEC-004 — No third-party 3D framework (no three.js / Babylon)

**Date:** 2026-09-11
**Status:** Accepted
**Review gate:** M2 exit — if our renderer is behind where three.js would have put
us *and* precision is not the reason, reconsider for non-planet content.

### Context
three.js is the default answer for web 3D and would give us materials, loaders,
post-processing and a scene graph immediately.

### Decision
Write the renderer directly against WebGPU. No general-purpose 3D framework.

### Alternatives considered
- **three.js (WebGPURenderer/TSL)** — enormous head start on shading and assets.
  But its `Object3D` transform chain is `Float32Array` end to end, and our core
  precision strategy (DEC-005) requires f64 positions differenced on the CPU
  *before* anything reaches a matrix. Retrofitting that means bypassing the scene
  graph, the camera, the culling and the matrix pipeline — i.e. bypassing the
  reasons to use it. A GPU-driven terrain quadtree with indirect draws also sits
  outside its draw model.
- **Babylon.js** — same objection, plus a heavier runtime.
- **three.js only for props/vegetation/city meshes, custom for the planet** — two
  renderers, two camera models, two precision regimes, one depth buffer they must
  agree on. Worse than either pure option.

### Rationale
The three hardest rendering requirements — camera-relative f64→f32 positioning,
a GPU-driven planetary LOD quadtree, and one depth buffer spanning orbit to
centimetres — all require control of exactly the layers a framework owns. We
would spend more time fighting three.js than writing the ~12 shaders we actually
need.

### Consequences
- We own camera, culling, materials, passes and asset loading. Deliberately kept
  **narrow**: the renderer only ever needs planet surface, ocean, atmosphere,
  clouds, instanced props, line/overlay geometry, and UI compositing.
- No glTF/PBR asset ecosystem for free. Accepted: nearly all geometry in this
  project is procedural.
- Higher risk in M1–M2, front-loaded on purpose.

---

## DEC-005 — Numeric precision strategy

**Date:** 2026-09-11
**Status:** Accepted — **Amended by DEC-033** (shader-side rules) — the strategy is unchanged.
**Review gate:** M1 exit — must be empirically demonstrated, not assumed.

### Context
Earth radius R = 6.371 × 10⁶ m. `f32` has a 24-bit mantissa, so at that magnitude
one ulp is **0.5 m**. A planet-centred position in `f32` therefore quantises the
surface to half-metre steps: vertices jitter, normals flicker, a walking camera
stutters. `f64` at the same magnitude has an ulp of ~**1 nanometre**, which is
free in JavaScript because every `number` is already `f64`.

### Decision
Four rules, applied everywhere:

1. **All simulation and world data is `f64`.** Positions, camera state, planet
   parameters. `Float64Array` for position-like fields. Never `f32` upstream of
   the renderer.
2. **All GPU vertex data is `f32` and camera-relative.** For each rendered patch,
   compute `originPCF_f64 − cameraPCF_f64` on the CPU in `f64`, then upload that
   small delta and patch-local offsets as `f32`. With a patch origin within 100 km
   of the camera, one ulp is 7.8 mm; within 1 km it is 61 µm.
3. **Reversed-Z depth with an infinite far plane**, `depth32float`, near = 0,
   far = 1 flipped (near maps to 1.0), `GreaterEqual` depth test. This distributes
   depth precision hyperbolically where reversed-Z wants it and removes the need to
   split the frustum into multiple depth ranges.
4. **Emulated double precision on the GPU (two-`f32` "double-single") is a targeted
   tool, not a policy.** Permitted only in a shader that provably needs it, with a
   comment saying why. Currently anticipated: none.

### Alternatives considered
| Option | Why not |
| --- | --- |
| `f32` everywhere with a scaled world (1 unit = 1 km) | Buys 3 decimal digits, loses them again the moment the camera is 1 m above ground. Moves the problem, does not solve it. |
| Split frustum / multiple depth ranges (e.g. 3 passes) | Works, is what older engines did, but triples the pass count for terrain and complicates every effect that reads depth. Reversed-Z + infinite far achieves the same with one pass. |
| Logarithmic depth buffer | Solves range, but requires per-fragment depth writes in many cases, which kills early-Z. Reversed-Z is strictly better on hardware with float depth. |
| Double-single (`f32`×2) emulation on the GPU by default | ~4× arithmetic cost on every vertex for a problem the CPU already solves for free in `f64`. |

### Rationale
JavaScript hands us `f64` at no cost; the only real question is where the
`f64 → f32` boundary sits. Putting it at "CPU computes camera-relative, GPU sees
only small numbers" is the standard and correct answer, and it is also the
cheapest.

### Consequences
- There is exactly **one** conversion point from world space to render space, in
  `packages/render/src/camera/`. Any other `f64 → f32` position conversion is a bug.
- Patch origins must be stored per patch and re-differenced whenever the camera
  moves. Cheap: one `vec3` subtraction per visible patch per frame.
- **M1 acceptance criterion:** with the camera 1 m above the surface, measured
  vertex position error < 1 cm and no visible z-fighting or vertex swim, verified
  by Astra, at a camera altitude sweep from 1 m to 40 000 km.

---

## DEC-006 — Coordinate systems and conventions

**Date:** 2026-09-11
**Status:** Accepted

### Context
A planetary simulator with orbital mechanics, a rotating body, raster fields and a
renderer will silently accumulate five or six ad-hoc coordinate conventions unless
they are named up front. Mixing two of them is the classic source of bugs that
survive for months.

### Decision
Exactly these frames exist, with these names. Each is a distinct TypeScript
branded type; conversions live in `packages/data/src/coords/` and nowhere else.

| Frame | Definition | Units / precision | Used for |
| --- | --- | --- | --- |
| **PCF** — Planet-Centred Fixed | Origin at planet centre, **+Z along the rotation axis (north)**, +X through the prime meridian, right-handed. Rotates with the planet. | metres, `f64` | The canonical frame. All persisted geometry. |
| **PCI** — Planet-Centred Inertial | Same origin and axes at epoch, does **not** rotate. `PCF = Rz(θ(t)) · PCI`. | metres, `f64` | Sun direction, star field, orbits, axial tilt. |
| **Geodetic** | `(latitude, longitude, altitude)` on the reference sphere/ellipsoid. | radians, metres, `f64` | Camera state (DEC-025), UI, data import/export. |
| **CubeFace** | `(face ∈ 0..5, u ∈ [0,1], v ∈ [0,1])` on the tangent-warped cube-sphere (DEC-007). | dimensionless, `f64` | Terrain and surface raster addressing. |
| **QuadKey** | `(face, level, x, y)` with `x,y ∈ [0, 2^level)`. | integers | LOD quadtree nodes, tile cache keys, chunk seeds. |
| **Geodesic cell** | Integer cell index on the icosahedral climate grid (DEC-008). | integer | Atmosphere/ocean-circulation state. |
| **Render** | Camera-relative, metres, `f32`, **+Y up** view space, right-handed. | metres, `f32` | GPU only. **Never persisted, never read by `sim`.** |

Global conventions: **SI units throughout** — metres, seconds, kilograms, kelvin,
pascals, watts. Angles in **radians** in code (degrees only at the UI edge).
Time in SI seconds (DEC-014).

### Alternatives considered
- **ECEF/ENU naming (geodesy convention)** — accurate but Earth-specific, and this
  engine must handle arbitrary planets. `PCF`/`PCI` is the planetary-science
  convention and generalises.
- **+Y as the rotation axis in PCF**, matching the renderer — would remove one
  conversion but puts the simulation in the renderer's convention, which inverts
  the founding principle. The single `Z-up → Y-up` swap lives at the render
  boundary where it belongs.
- **One untyped `Vec3`** — this is precisely the bug factory being avoided.

### Rationale
Naming the frames costs one afternoon; not naming them costs a month spread over
two years. Branded types make a frame mismatch a compile error rather than a
mysteriously tilted continent.

### Consequences
- `packages/data/src/coords/` must provide and test round-trips for every
  adjacent pair, with documented error bounds.
- The `Z-up → Y-up` basis change happens once, in the camera. It is not a
  configurable option.
- Adding a frame requires a new ADR.

---

## DEC-007 — Planet surface representation: tangent-warped cube-sphere

**Date:** 2026-09-11
**Status:** Accepted — **per-face UV orientation superseded by DEC-035.** The grid choice is unchanged.

### Context
We need one surface parameterisation that simultaneously supports: a rendering LOD
quadtree, GPU tile textures, deterministic per-chunk seeding, and raster storage
for terrain-scale fields. No single grid is optimal for all uses on a sphere —
this decision covers *terrain and rendering*; DEC-008 covers the climate solver.

### Decision
A **cube-sphere** with **tangent (Nowell) warping**: map cube face coordinate
`s ∈ [-1,1]` to `tan(s · π/4) / tan(π/4)` before normalising to the sphere. Six
root faces, each the root of a quadtree addressed by `QuadKey` (DEC-006).

### Alternatives considered
| Option | Assessment |
| --- | --- |
| Naive (unwarped) cube-sphere | Trivial, but cell area varies by ~**1.9×** between face centre and corner. Tangent warping brings that to ~**1.3×**, for the cost of a `tan`/`atan` per conversion. Worth it. |
| Lat/lon (equirectangular) grid | Polar singularity, cells converging to zero width, and a pathological LOD quadtree at the poles. Rejected for anything but data import. |
| Icosahedral geodesic | Best area uniformity (~1.2×), no singularity — but the natural subdivision is triangular, so tiles are triangles, texture atlasing is awkward, and neighbour addressing is not a simple `(x,y)` quadtree. Excellent for a *solver* grid (see DEC-008), poor for a *rendering/tile* grid. |
| HEALPix | Equal-area by construction and quadtree-friendly — genuinely attractive. Rejected because its cells are not axis-aligned quads in any conformal sense, so GPU tile textures and heightmap seams get harder, and the tooling/mental-model cost across three agents is high for a ~1.3× → 1.0× area-uniformity gain. Recorded as the strongest runner-up. |
| Quadrilateralised spherical cube (QSC) | Equal-area cube-sphere variant. More distortion in *shape* than the tangent warp; we care more about shape uniformity for rendering. |

### Rationale
The cube-sphere is the only candidate where the LOD quadtree, the GPU tile atlas,
the chunk seed key and the raster field index are **the same structure**. That
unification is worth more than the residual 1.3× area variation, which is a
correction factor in the few places (mass/energy accounting) where it matters —
and those places are on the *geodesic* grid anyway.

### Consequences
- Cell size at level `L` ≈ `10 007 543 / 2^L` metres. Reference values:
  L10 ≈ 9.8 km, L11 ≈ 4.9 km, L12 ≈ 2.4 km, L16 ≈ 153 m, L20 ≈ 9.5 m, L24 ≈ 0.6 m.
- Cell count = `6 · 4^L`. L10 = 6.3 M, L11 = 25.2 M, L12 = 100.7 M.
  An `i16` global field costs 12.6 MB at L10, 50.3 MB at L11, 201 MB at L12.
  This is what forces DEC-019.
- Every field on this grid must carry a per-cell area (or a per-face area
  correction) wherever it participates in a conservation law.
- Face-boundary seams need explicit neighbour resolution (a face edge meets
  another face's edge with a rotation). This is a known, bounded piece of work,
  scheduled in M1, and the classic source of cube-sphere bugs.

---

## DEC-008 — Climate grid: icosahedral geodesic, separate from the terrain grid

**Date:** 2026-09-11
**Status:** Accepted
**Review gate:** M4 exit.

### Context
Atmospheric and oceanic circulation solvers are sensitive to grid quality in ways
terrain rendering is not: non-uniform cell area biases conservation, and grid-aligned
anisotropy produces artefacts that look like real weather patterns and are therefore
hard to detect. The cube-sphere has 8 corner points where three cells meet and a
1.3× area spread.

### Decision
The atmosphere/ocean-circulation solver runs on a **separate icosahedral geodesic
grid** (ICON/MPAS-style), refinement level `n`, cell count `10 · 4ⁿ + 2`. Explicit,
tested, conservative **resampling operators** move data between the geodesic grid
and the cube-sphere grid.

Planned resolution: **n = 6 (40 962 cells, ~112 km spacing)** for M3–M4, with
n = 7 (163 842 cells, ~56 km) as the stretch target. Vertical: 1 layer in M3,
3–8 layers in M4+.

### Alternatives considered
- **Run climate on the cube-sphere too** — one grid, no resampling, much simpler.
  Rejected: corner artefacts and area bias in a solver whose output we cannot
  independently verify is a bad trade. Also, the grids want radically different
  resolutions (climate ~100 km vs terrain ~5 km–0.6 m), so they were never going to
  share cells regardless; "one grid" was an illusion.
- **Lat/lon with polar filtering** — what legacy GCMs do. The polar filter is a
  well-known source of artefacts and a CFL nightmare. Rejected.
- **Spectral (spherical harmonic) transform method** — beautiful and what many
  production GCMs use, but the transform cost and the Gibbs ringing around sharp
  orography make it a poor fit for a real-time engine with strong topography.

### Rationale
Two grids is not duplicated state (DEC-013 still holds: each *field* has exactly
one owning grid and one writer). It is two different discretisations chosen for two
different physics problems, joined by an explicit, testable operator. The
resampling cost at 40 k ↔ 6.3 M cells is small and runs off the frame path.

### Consequences
- **Risk R-10:** resampling can break conservation. Mitigation: the resampling
  operators are conservative by construction (area-weighted) and covered by an
  invariant test — total water and total energy must be preserved to within 1e-9
  relative across a round trip.
- We maintain two neighbour-topology implementations. Both are small and static.
- Ocean *surface rendering* stays on the cube-sphere; ocean *circulation* on the
  geodesic grid.

---

## DEC-009 — Camera-relative rendering, not a global floating origin

**Date:** 2026-09-11
**Status:** Accepted

### Context
"Floating origin" is the usual prescription for large worlds. It has two distinct
meanings, and only one applies here.

### Decision
Use **camera-relative rendering**: world data stays fixed in PCF `f64`; each frame,
per-patch origins are differenced against the camera position in `f64` on the CPU
and only the small relative offsets reach the GPU as `f32` (DEC-005).

**Explicitly reject** the "shift the whole world when the camera passes a
threshold" form of floating origin.

### Alternatives considered
- **Global world re-basing (shift all content periodically)** — designed for open
  worlds whose content is authored around a moving player. Here the world is a
  planet with a physically meaningful centre; shifting it is meaningless, it would
  invalidate every cached PCF coordinate, and it introduces a discontinuity at each
  shift that the simulation would have to be protected from. Rejected.
- **Hierarchical scene-graph origins (parent-relative transforms)** — this is
  camera-relative rendering with extra bookkeeping. The planet has no meaningful
  hierarchy above "planet → patch".

### Rationale
The camera-relative form has no threshold, no discontinuity, no cache
invalidation, and costs one `vec3` subtraction per visible patch per frame. It is
strictly better here.

### Consequences
- The renderer must never cache an absolute `f32` world position across frames.
- Very large single objects (an orbital ring, a continent-spanning mesh) would
  break the "small offsets" assumption. We do not have any; if one appears, it must
  be split into patches. Recorded as a constraint on future content.

---

## DEC-010 — Terrain LOD: chunked quadtree + CDLOD morphing + skirts

**Date:** 2026-09-11
**Status:** Accepted — **Amended by DEC-034** (horizon culling, multi-level descent).
**Review gate:** M2 exit — popping and hitching are Astra-verified, not self-assessed.

### Context
Continuous descent from orbit to a metre above the ground spans ~7 orders of
magnitude of scale, and must hold 60 FPS with no visible popping and no streaming
hitch.

### Decision
1. **Chunked LOD over the cube-sphere quadtree** (DEC-007). Split/merge driven by
   **screen-space error**: a node splits when its projected geometric error exceeds
   τ pixels (initial τ = 2.0, tunable, budgeted).
2. **Fixed-topology patch mesh.** Every patch uses the *same* 65×65 vertex grid;
   only its heightmap tile and its origin differ. This makes the geometry a single
   shared vertex/index buffer and every patch an instance → **indirect, GPU-driven
   draws**.
3. **CDLOD-style vertex morphing.** Vertices morph toward the parent level's
   surface as a node approaches its merge threshold, driven by a per-instance morph
   factor. This removes popping.
4. **Skirts** on every patch edge as a correctness backstop against T-junction
   cracks, including at cube-face seams.
5. **Heightmap tiles in a `texture_2d_array` atlas**, produced by compute shaders
   for decorative detail and by workers for authoritative data (DEC-019).

### Alternatives considered
| Option | Assessment |
| --- | --- |
| Geometry clipmaps | Excellent for an infinite heightfield plane; on a sphere the toroidal update and the seam handling get ugly, and per-region streaming is harder. |
| Pure CDLOD (one continuous mesh, no chunks) | Very smooth, but a poor fit for streaming and for caching per-tile authoritative data, and it does not give us a natural unit for worker jobs or for the chunk seed. |
| ROAM / progressive meshes | Per-triangle CPU work. Hopeless at these counts on the main thread. |
| Index-buffer stitching variants instead of skirts | Crack-free with zero overdraw, but requires 2^4 index variants per patch and interacts badly with morphing. Skirts cost a little overdraw and are robust; we take robustness. |
| Adaptive tessellation / mesh shaders | Not available or not portable in WebGPU today. Revisit. |

### Rationale
Chunked quadtree + fixed topology is what makes the whole pipeline GPU-driven: one
mesh, one indirect draw, N instances. Morphing solves the only real weakness of
chunked LOD (popping). Skirts solve cracks without combinatorial index buffers.
Each of the four elements is there to cancel a specific defect of the others.

### Consequences
- Patch vertex count is a *budget*, not a per-patch decision: 65×65 = 4225
  vertices, 8192 triangles per patch. At a budget of 2000 visible patches that is
  ~16.4 M triangles — above target, so the real budget is ~800–1200 patches
  (see `docs/RENDERING.md`).
- Geometric error per node must be computed and stored when a tile is baked. A
  tile without a measured error cannot participate in LOD selection.
- Skirt depth must scale with patch size; a fixed skirt depth will be visible at
  low levels and insufficient at high ones.

---

## DEC-011 — Simulation/rendering separation enforced mechanically

**Date:** 2026-09-11
**Status:** Accepted

### Context
The project's founding principle is *Simulation State != Rendering State*. Stated
as a convention, this principle survives about three months of pressure. It has to
have teeth.

### Decision
Enforce it as a **dependency rule checked in CI**:

```
core   →  (nothing)
data   →  core
sim    →  core, data
render →  core, data
workers→  core, data
app    →  everything
tools  →  everything
```

- `sim` **may not** import `render`. `render` **may not** import `sim`.
- `core`, `data`, `sim` **may not** reference `window`, `document`, `navigator`,
  `requestAnimationFrame`, or `GPU*` types.
- The renderer reads world data through a **read-only `WorldView`** interface
  declared in `data`.
- Wiring happens only in `app`.
- Violations fail the build (`pnpm run check:boundaries`), they are not warnings.

### Alternatives considered
- **Convention plus code review** — the failure mode is silent and gradual, and
  with three agents working asynchronously nobody sees the whole picture. Rejected.
- **Separate repositories** — real isolation, but cross-cutting changes become
  multi-repo dances. Too much friction for the benefit.
- **Runtime checks** — too late and too slow.

### Rationale
This is the one architectural property whose loss is unrecoverable; everything else
can be refactored. Making it a build failure is cheap insurance.

### Consequences
- The renderer cannot ask the simulation to compute something on demand. It reads
  state or it does without. Derived visual data is the renderer's own business.
- Types shared between `sim` and `render` (field identifiers, grid descriptors,
  time) live in `data`/`core`. If a type wants to live in both, it belongs lower.
- A subsystem that "needs the camera" is a design smell. The correct shape is: the
  app tells `sim` about a region of interest; `sim` knows nothing about cameras.

---

## DEC-012 — World state: SoA fields + a minimal entity store; no third-party ECS

**Date:** 2026-09-11
**Status:** Accepted
**Review gate:** M8 exit (when discrete entities become numerous).

### Context
The world contains two categorically different kinds of state:
**fields** (elevation, temperature, soil moisture — dense values on a grid) and
**entities** (settlements, plates, rivers, populations — discrete, sparse, with
lifetimes). Treating both the same way is a mistake in both directions.

### Decision
Two storage primitives, both **Structure-of-Arrays over typed arrays**:

- **`FieldStore`** — named, typed, versioned rasters bound to a grid
  (`cubesphere@L11`, `geodesic@n6`, …). Each field declares dtype, units, valid
  range, owner subsystem (DEC-013), and whether it is double-buffered.
- **`EntityStore`** — tables of components keyed by a stable
  `EntityId = {index, generation}`. Columns are typed arrays; rows are dense with a
  free list. Iteration order is by index, always.

**No third-party ECS library** (bitecs, miniplex, becsy, …).

### Alternatives considered
| Option | Why not |
| --- | --- |
| Objects and classes per entity | Fine at 10³ entities, fatal at 10⁶ (population, vegetation, agents). Serialisation and worker transfer both become deep-clone problems. |
| A third-party ECS | Attractive, but we need to control three things they each handle differently: exact iteration order (determinism, DEC-017), memory layout (zero-copy worker/GPU transfer, DEC-020), and archetype churn behaviour. Adopting one means auditing it for all three and then depending on it forever. The subset of ECS we actually need is ~400 lines. |
| A single generic "everything is an entity" model | Makes a 25-million-cell elevation raster into 25 million entities. Absurd. |

### Rationale
The split reflects a real difference in the data, not a stylistic preference. Both
halves are SoA typed arrays for the same three reasons: cache behaviour, zero-copy
transfer, and trivial binary serialisation (DEC-022).

### Consequences
- `FieldId` and `ComponentId` are compile-time-known registries. Dynamic field
  creation at runtime is not supported (and is not needed).
- Anything that wants to be "an object with methods" must instead be a plain
  `{store, id}` handle plus free functions.
- If entity counts and archetype variety explode at M8/M10, re-evaluate against a
  real ECS with a benchmark — that is the review gate.

---

## DEC-013 — Single-writer field ownership

**Date:** 2026-09-11
**Status:** Accepted

### Context
Duplicated state and unclear ownership are named in the brief as things to avoid,
and they are also the most likely failure mode of three agents editing one
simulation.

### Decision
- Every field and every component column has **exactly one owning subsystem**,
  declared in a single machine-readable table (`packages/sim/src/ownership.ts`).
- Only the owner may write it. All other subsystems receive a **read-only view**.
- The scheduler validates declared `reads`/`writes` against the ownership table at
  startup and **throws** on violation (in dev builds it also traps actual writes
  via a debug proxy).
- Derived data is never stored twice. If B needs a transformed version of A's
  field, either B computes it on read, or B owns a *separate* derived field and
  declares `reads: [A]`.

### Alternatives considered
- **Free-for-all with review** — this is the default, and the default is how
  simulations rot.
- **Locks / transactions** — solves concurrent access, not conceptual ownership,
  and costs performance we do not have.

### Rationale
Single-writer ownership is what makes DEC-020's lock-free concurrency correct, what
makes DEC-016's dependency graph computable, and what makes "who broke the
temperature field" answerable in ten seconds.

### Consequences
- The ownership table is a design document that happens to be executable. It is
  reviewed like an ADR.
- Two subsystems both wanting to write a field is a signal that they are one
  subsystem, or that the field should be split. Both are better outcomes.

---

## DEC-014 — Simulation time representation

**Date:** 2026-09-11
**Status:** Accepted

### Context
Time must span from a 1/60 s render step to 10⁶-year tectonic steps — 15 orders of
magnitude — and it must be **exact**, because determinism and replay depend on two
runs agreeing on what time it is. A single `f64` seconds counter loses sub-second
resolution after ~285 years of simulated time and loses *whole seconds* well before
a million years.

### Decision

```ts
interface SimTime {
  readonly year: number;     // exact integer, signed (negative = before epoch)
  readonly seconds: number;  // f64, normalised to [0, secondsPerYear)
}
```

- `year` is an exact integer; `Number.MAX_SAFE_INTEGER` allows ±9 × 10¹⁵ years,
  ~10⁶× more than the deepest geological scale we will ever run.
- `seconds` is `f64` within a single year (max 3.156 × 10⁷), where one ulp is
  ~7 × 10⁻⁹ s. Sub-microsecond exactness forever.
- Every arithmetic operation **normalises** (carry/borrow into `year`).
- `Duration` is a separate branded type, `f64` seconds, for step sizes.
- The planet's year length is a world parameter, fixed at world creation and
  stored in the save. `SimTime` is meaningless without it.

### Alternatives considered
| Option | Why not |
| --- | --- |
| `f64` seconds since epoch | Fails: at 10⁶ years (3.15576 × 10¹³ s), ulp = **3.90625 ms** (= 2⁻⁸); at 10⁹ years, ulp = 4 s. **Measured:** accumulating 10⁷ steps of 1/60 s at year 10⁶ loses **10 417 s** on a flat counter — every 1/60 s increment rounds to 1/64 s, discarding 6.25% of all elapsed time — versus **17.3 µs** with the year split. |
| `bigint` nanoseconds | Exact and simple, but `bigint` arithmetic is ~10–50× slower than `number` and allocates. Time is advanced thousands of times per second by the scheduler. Also awkward to serialise and to mix with `f64` physics. |
| Integer ticks in a `number` at a fixed rate | A 64 Hz tick fits 10⁶ years in 2 × 10¹⁵ ticks — under the safe-integer limit, but with less than 5× headroom, and it forces every subsystem's dt to be a multiple of 1/64 s. Too tight and too rigid. |
| Two-part `{seconds:int, subsecond:f64}` | Equivalent exactness, but `year` is the unit humans, geology and orbital mechanics all actually use, and it makes calendars and seasons fall out naturally. |

### Rationale
Splitting at the year boundary is not arbitrary: the year is the natural period of
the system (axial tilt, seasons, orbit), so the split point is also a physically
meaningful one. Exactness where it is needed (which year) and `f64` where it is
cheap (where in the year).

### Consequences
- All time arithmetic goes through `packages/core/src/time/`. Raw arithmetic on
  `.year`/`.seconds` outside that module is a lint error.
- `SimTime` is immutable and comparable; `compare()` and `sub()` return a
  `Duration` that may overflow `f64` for absurd spans — documented and asserted.
- Save files store `{year, seconds, secondsPerYear}`. Changing `secondsPerYear`
  invalidates a world.


### Clarification (Grok 2026-09-11) — ulp figure

The alternatives table and several docs state that at 10⁶ years one f64 ulp is
≈ 7.8 ms. Independently re-derived (`tools/bench/audit-v0.mjs`, pinned in
`packages/core/test/audit-v0.test.ts`):

- 10⁶ years = 3.15576×10¹³ s, which lies in [2⁴⁴, 2⁴⁵), so ulp = 2⁴⁴⁻⁵² = **3.90625 ms**.
- `t * Number.EPSILON` = 7.01 ms. That is not ulp; it overestimates by ~2× in the
  lower half of a binade. 7.8 ms is 2 × 3.9 ms.

The *measured* accumulation errors (1.0417×10⁴ s flat vs 1.726×10⁻⁵ s year-split)
are confirmed and do not depend on that figure. The year-split decision stands.
This is a documentation correction, not a change to the Decision.

---

## DEC-015 — Temporal LOD: subsystem regimes with quiesce/resume

**Date:** 2026-09-11
**Status:** Accepted — **Amended by DEC-030** (three state classes, always-on aggregates, path-independence).
**Review gate:** M11 exit.

### Context
This is the hardest problem in the brief. At a time scale of 1 Myr per real
second, running the weather at 1-hour steps requires 8.8 × 10⁹ steps per second.
It is not a matter of optimisation; it is impossible by ~9 orders of magnitude.
Yet the climate must still influence erosion, hydrology and biomes at that scale.

### Decision
**Temporal LOD, symmetric with spatial LOD.** A subsystem is not a single model;
it is a set of **regimes** at different fidelities, and the scheduler selects one
based on the subsystem's current effective `dt`.

```ts
interface Regime {
  id: string;
  validFor: { minDt: Duration; maxDt: Duration };
  step(ctx: StepContext): void;
}
```

Example — the atmosphere:

| Regime | Valid `dt` | Model |
| --- | --- | --- |
| `explicit` | ≤ 6 h | Full solver: advection, moisture, convection, orographic lift |
| `synoptic` | 6 h – 30 d | Reduced solver, larger steps, storms as statistics not events |
| `climatology` | 30 d – 100 yr | Monthly climatological means; no weather events at all |
| `paleo` | > 100 yr | Energy-balance model responding only to orbit, CO₂, albedo, orography |

Three binding rules:

1. **Regime transitions are explicit lifecycle events.** Leaving a regime calls
   `quiesce()`, which must flush the regime's transient state into the aggregate
   representation and leave the world in a consistent state. Entering calls
   `resume()`, which reconstructs what it needs from aggregates. A subsystem may
   never be left half-stepped.
2. **Every field that is consumed across regimes has both an instantaneous and an
   aggregate representation**, and consumers declare which they read. Hydrology
   reads `precip.instant` in `explicit`, `precip.monthlyMean` in `climatology`.
   The field registry enforces that an aggregate exists for any cross-regime field.
3. **Coarser regimes must conserve what finer regimes conserve.** A regime
   transition is covered by a conservation invariant test (total water, total
   energy) with a documented tolerance.

### Alternatives considered
| Option | Why not |
| --- | --- |
| One model per subsystem, just change `dt` | The explicit weather solver is CFL-limited; a 100-year step is not "the same model, slower", it is numerically meaningless. |
| Disable fine subsystems at coarse scales | Simple, and the naive version of what we do — but then erosion at 1 Myr/s sees *no* rainfall and continents stop eroding. The aggregate representation is exactly what fixes this. |
| Run fine subsystems on a sampled subset of time ("simulate 1 year in 1000") | Attractive and cheap, but biased: it samples weather, not climate, and rare-event-driven processes (floods, mass extinction) are either missed or 1000× overweighted. Available as a *technique inside* a regime, not as the architecture. |
| Multi-rate integration with interpolation only | Handles 2–3 orders of magnitude, not 9. |

### Rationale
The insight is that "which model" and "which timestep" are not independent, and
pretending they are is what makes multiscale simulation fail. Making regimes
first-class, with an explicit transition contract, turns an unsolvable problem into
a bounded one: implement 3–4 regimes per fast subsystem and get the transitions
right.

### Consequences
- Every fast subsystem costs 2–4× more design work than a single-regime one. This
  is the actual price of the brief's time-scale requirement and it must be planned
  for, not discovered at M11.
- Time-scale changes are not free: the UI must treat a large time-scale jump as an
  operation that may take a frame or two (quiesce + resume), not an instant slider
  drag. Design the UI accordingly (stepped scale ladder, not a continuous slider).
- **Risk R-02** in `docs/ROADMAP.md`: visible discontinuity at regime boundaries.
  Mitigation: hysteresis on transition thresholds, and Astra validation at M11.

---

## DEC-016 — Declarative subsystem scheduler with a fixed commit order

**Date:** 2026-09-11
**Status:** Accepted — **Amended by DEC-031** (the graph is the union over regimes).

### Context
Subsystems run at different rates (DEC-015), some on workers (DEC-020), and results
arrive in wall-clock order that varies run to run. Determinism (DEC-017) requires
that the *world* never sees that variation.

### Decision
Subsystems are **declarative**:

```ts
interface Subsystem {
  readonly id: SubsystemId;
  readonly phase: Phase;            // ordering class, see below
  readonly cadence: Cadence;        // in SIM time, never in frames
  readonly reads: readonly FieldId[];
  readonly writes: readonly FieldId[];
  readonly regimes: readonly Regime[];
  readonly budget: { mainThreadMs: number; workerMs: number };
}
```

Scheduler rules:

1. **Cadence is expressed in simulation time**, never in frames or wall-clock.
   `{ every: Duration }` or `{ everyNSteps: n, of: SubsystemId }`.
2. **Phases** give a coarse, fixed total order:
   `Input → Geology → Terrain → Hydrology → Atmosphere → Ocean → Biosphere →
   Civilisation → Economy → Derived → Presentation`.
   Within a phase, order is by the topological sort of the `reads`/`writes`
   dependency graph, with ties broken by `SubsystemId` **lexicographically** — so
   the order is a pure function of the registry, not of registration order.
3. **Results are committed at tick boundaries in that fixed order**, never on
   arrival. A worker job that finishes early waits; one that finishes late stalls
   its subsystem's next step but never reorders the commit.
4. **Cycles in the dependency graph are a startup error.** A genuine feedback loop
   must be broken explicitly by reading the previous generation of a
   double-buffered field, which is declared as `reads: [prev(F)]`.
5. A subsystem that overruns its budget is logged and, in dev, asserted. It is
   never silently dropped — dropping a step changes results.

### Alternatives considered
- **Fixed hard-coded update list** — simple, and correct for ten subsystems; it
  becomes unmaintainable at thirty and it makes the dependency structure invisible.
- **Event/message bus between subsystems** — decouples nicely, but makes ordering
  emergent, which is exactly what determinism cannot tolerate.
- **Commit results on arrival (best-effort)** — the obvious performance choice and
  fatal for reproducibility. Rejected explicitly.
- **Full data-parallel task graph with automatic parallelisation** — the right
  long-term shape, and what the `reads`/`writes` declarations set us up for, but
  premature to build before we have ten real subsystems to schedule.

### Rationale
The `reads`/`writes` declaration is doing four jobs at once: dependency ordering,
ownership validation (DEC-013), safe parallelisation (independent subsystems can
run concurrently when their write sets are disjoint), and documentation. That is
why it is mandatory rather than inferred.

### Consequences
- Registering a subsystem without accurate `reads`/`writes` produces wrong ordering
  with no error. This is the scheduler's sharpest edge. Mitigation: the dev-build
  write barrier detects undeclared writes at runtime, and a test asserts every
  subsystem's declaration against an instrumented run.
- A visual/debug consumer of simulation state is a `Presentation`-phase subsystem
  with an empty `writes` set, which keeps it out of the renderer's way.

---

## DEC-017 — Determinism: stateless hashed seeds, no shared RNG streams

**Date:** 2026-09-11
**Status:** Accepted

### Context
Terrain chunks are generated on demand, in whatever order the camera happens to
visit them, across a variable number of workers. Any randomness that depends on
*when* or *where* a chunk was generated makes the world non-reproducible.

### Decision
1. **No stateful RNG streams anywhere in `sim` or world generation.** There is no
   "the random number generator".
2. All randomness is a **pure hash** of an explicit key:
   `value = hash(worldSeed, domainId, ...coordinates, ...indices)`.
   Implementation: `splitmix64`-style 64-bit mixing over two 32-bit halves
   (JavaScript has no fast native u64; we use a tested pair-of-u32 implementation).
3. `domainId` is a compile-time constant per generator, so two generators never
   collide on the same key.
4. A local stateful generator **is** permitted inside a single pure function whose
   inputs fully determine its seed (e.g. an erosion pass over one chunk seeded by
   `hash(worldSeed, DOM_EROSION, quadkey)`), because its output is still a pure
   function of the key.
5. Banned inside `core`/`data`/`sim`, enforced by lint:
   `Math.random`, `Date.now`, `performance.now`, `new Date()`, `crypto.getRandomValues`,
   iteration over `Set`/`Map` insertion order where the order affects results, and
   `Array.prototype.sort` without an explicit total-order comparator.
6. **Reductions run in key order, not completion order.** Any `Promise.all`-style
   gather must sort by a deterministic key before folding.

### Alternatives considered
- **A single seeded PRNG stream** — the default approach, and it works only if
  generation order is fixed. Ours is not, and never will be. Rejected.
- **Per-chunk PRNG seeded from the chunk key** — this is what we do, expressed
  differently; rule 4 covers it. The stateless-hash framing is the safer default
  because it also covers the many places that need one value, not a stream.
- **Counter-based PRNG (Philox/Threefry)** — the same idea with stronger
  statistical guarantees. Worth adopting if `splitmix64` shows correlation
  artefacts; noted as the fallback.

### Rationale
Order-independence is not a nice property here, it is a requirement imposed by
streaming and by a variable worker count. A stateless hash makes it structurally
impossible to get wrong, rather than merely discouraged.

### Consequences
- The **determinism test suite** (DEC-023) must include: same seed twice → identical
  state hash; chunks generated in reversed order → identical; 1 worker vs 4 workers
  vs 8 workers → identical. The worker-count test is the one that catches real bugs.
- Noise functions must take an explicit seed argument. A module-level seed variable
  is a lint error.

---

## DEC-018 — Determinism tiers; the GPU is never authoritative

**Date:** 2026-09-11
**Status:** Accepted

### Context
Perfect bit-level determinism across all platforms is not achievable in a browser.
`Math.sin`, `Math.exp`, `Math.pow` and friends are **not** bit-exact across
JavaScript engines or CPU architectures (the spec permits implementation-defined
approximations), and GPU floating point varies by vendor, driver and even
compilation. Pretending otherwise produces a replay system that fails mysteriously
in the field.

### Decision
Three explicit tiers, and every piece of state is assigned one:

| Tier | Guarantee | Applies to |
| --- | --- | --- |
| **A — Bit-exact** | Identical bytes for the same seed on any platform. Uses only IEEE-754 exact operations (`+ − × ÷ √`, comparisons) and **our own** transcendental implementations (`packages/core/src/stableMath/`: polynomial/table-based `sin`, `cos`, `exp`, `log`, `pow`, `atan2`). | Authoritative world state: elevation, plates, climate state, hydrology, entities. Replay and golden tests run here. |
| **B — Reproducible** | Same seed produces a statistically and visually identical world; small floating-point drift tolerated. May use `Math.*`. | Non-authoritative derived data, analysis, statistics. |
| **C — Non-deterministic** | No guarantee. | Rendering, particles, post-processing, UI animation. |

**Binding rule: the GPU may never produce Tier-A state.** GPU compute is Tier C.
Anything the simulation reads must be produced on the CPU, or be explicitly
classified as derived/decorative and re-derivable.

### Alternatives considered
- **Claim full determinism and hope** — the standard mistake. It fails months later
  as an unreproducible bug report.
- **Fixed-point arithmetic throughout** — genuine bit-exactness including
  transcendentals, and used by lockstep RTS engines. Rejected: the dynamic range
  here (nanometres to 10⁷ m, 10⁻⁹ s to 10¹³ s) is exactly what fixed point is bad
  at, and the conversion cost across the whole codebase is enormous.
- **Tier A only, ban `Math.*` everywhere** — `stableMath` is ~2–5× slower than
  native `Math`; forcing it into Tier-C rendering code would cost real frame time
  for no benefit.

### Rationale
Being explicit about what is *not* guaranteed is what makes the guarantee that
remains usable. The GPU rule in particular is the concrete, enforceable form of the
project's founding principle: if the GPU cannot write world state, the renderer
cannot become the source of truth by accident.

### Consequences
- Each `FieldDescriptor` carries a `tier` and each subsystem declares the highest
  tier it can guarantee. A Tier-A subsystem importing `Math.sin` is a lint error.
- `stableMath` must be written, tested against high-precision references, and
  benchmarked. This is a concrete early task and a **good Grok candidate**.
- Directly forces DEC-019.

---

## DEC-019 — Authoritative vs. decorative terrain resolution split

**Date:** 2026-09-11
**Status:** Accepted — **Amended by DEC-034** (the quadtree exists at every level; data does not).
**Review gate:** M2 exit.

### Context
DEC-018 says the simulation's terrain must be CPU-generated. DEC-007's arithmetic
says a global `i16` elevation field costs 50 MB at L11 (4.9 km/cell) and 201 MB at
L12 (2.4 km/cell). The renderer, meanwhile, wants sub-metre detail (L24, 0.6 m).
A globally authoritative sub-metre terrain is 10¹⁵ cells. That is not a budget
problem, it is a category error.

### Decision
Three tiers of terrain data:

| Tier | Levels | Source | Determinism | Storage |
| --- | --- | --- | --- | --- |
| **Global authoritative** | L0–L11 (≥ 4.9 km) | CPU, workers, Tier A | Bit-exact | Resident: ~50 MB `i16` elevation + ~10 companion fields |
| **Regional authoritative** | L12–L18 (2.4 km → 38 m) | CPU, workers, Tier A, generated on demand from `hash(seed, quadkey)` | Bit-exact and **order-independent** | LRU tile cache, disk-backed in OPFS; regenerable at will |
| **Decorative detail** | L19+ (< 19 m) | GPU compute, Tier C | None; must be a pure function of position + seed | Never stored, never read by `sim` |

Binding rules:
- The simulation only ever reads global or regional authoritative data.
- Decorative detail must be **displacement-only and mean-zero** over a regional
  cell, so it cannot change anything the simulation believes about the terrain
  (slope statistics, water routing, settlement suitability).
- Regional tiles are generated as a pure function of their quadkey, so cache
  eviction is invisible and generation order does not matter (DEC-017).

### Alternatives considered
- **One authoritative resolution everywhere** — either too coarse for cities and
  rivers, or impossible to store. No single value works.
- **Let the GPU generate everything, read it back for the simulation** — read-back
  costs a pipeline stall per tile and makes world state vendor-dependent. Violates
  DEC-018. Rejected.
- **Store regional tiles permanently in saves** — turns a 5 MB save into gigabytes.
  Regeneration from seed is strictly better and is why DEC-017 matters.

### Rationale
This is the decision that keeps the founding principle *affordable*. Without the
split, either the simulation is wrong or the memory budget is blown. It also gives a
clear rule for every future feature: "does the simulation need to know about this
bump?" decides which tier it belongs to.

### Consequences
- Hydrology, biome and settlement logic operate at L11–L18. A river is routed at
  ~40 m resolution, not 0.6 m. That is a real fidelity limit and it must inform
  M5/M9 design.
- The visual gap between L18 authoritative and L19+ decorative must be seamless.
  An **Astra validation item** at M2.
- Regional tile generation must be fast enough to keep up with a descending camera.
  Budget: ≤ 8 ms per tile per worker (`docs/RENDERING.md`).

---

## DEC-020 — Concurrency: worker pool, SharedArrayBuffer preferred, phases not locks

**Date:** 2026-09-11
**Status:** Accepted
**Review gate:** M2 exit — measured against the transfer fallback.

### Context
The main thread has ~6 ms per frame (`docs/RENDERING.md`). Terrain generation,
erosion, flow routing and climate stepping are each far larger than that. They must
be off the main thread, and moving tens of megabytes per frame is not an option.

### Decision
1. **Worker pool**, sized `clamp(hardwareConcurrency − 1, 1, 8)`. One pool, typed
   job protocol, cancellable jobs, priority queue.
2. **Large persistent fields live in `SharedArrayBuffer`** when available, so
   workers read them with zero copy. Requires `Cross-Origin-Opener-Policy:
   same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; the dev server and
   any hosting must set them.
3. **Fallback when SAB is unavailable:** the same `FieldStore` API backed by
   ordinary `ArrayBuffer`s with explicit transfer. Detected once at boot. The
   *fallback is a supported configuration*, not a broken one — it is slower, and
   the difference is measured, not assumed.
4. **No locks on field data.** Correctness comes from **phase separation**: within a
   scheduler phase, a field has at most one writer (DEC-013), and readers of a field
   being written read its **previous generation** from a double buffer. `Atomics`
   are used only for job-queue coordination and completion counters.
5. **Double-buffer only fields with a genuine read-write hazard**, listed explicitly
   in the field registry. Double buffering costs 2× memory; applying it everywhere
   would blow the budget.
6. **Messages carry handles and small plain objects only.** Structured-cloning a
   large object graph across the worker boundary is a lint-level offence.

### Alternatives considered
| Option | Why not |
| --- | --- |
| Transfer-only (no SAB) everywhere | Simpler and no COOP/COEP requirement, but a field transferred to a worker is *detached* on the main thread until returned, which turns every read into a lifetime problem. Kept as the fallback, not the default. |
| Copy per job | Predictable and safe; at 50 MB fields the copies alone exceed the frame budget. |
| Mutexes over field regions via `Atomics.wait` | `Atomics.wait` is forbidden on the main thread, and lock contention in a 60 FPS loop is exactly the unpredictability we cannot afford. Phase separation gives the same safety statically. |
| One worker per subsystem (dedicated workers) | Simple mental model, terrible load balancing: tectonics is idle 99% of the time while terrain generation is saturated. |

### Rationale
SAB is justified here by a specific measurable need (50 MB+ fields read by multiple
workers per tick), not because it exists. Phase separation is justified because
DEC-013 already gives us single-writer semantics for free — we are buying safety we
have already paid for.

### Consequences
- **Risk R-05:** COOP/COEP break some embedding contexts and third-party scripts.
  The fallback path must be exercised in CI, not merely present.
- Worker count changes must not change results (DEC-017). This is a required test.
- Job granularity matters: ≤ 250 ms per job so cancellation stays responsive when
  the camera turns.

---

## DEC-021 — WASM deferred behind a benchmark gate

**Date:** 2026-09-11
**Status:** Accepted
**Review gate:** continuous — reconsider at every profiled hotspot.

### Context
WASM is an obvious candidate for erosion, flow routing and plate advection. It is
also an obvious way to add a Rust/Zig toolchain, a build step, an FFI boundary and a
debugging discontinuity to a project that does not yet have a measured bottleneck.

### Decision
**No WASM in M0–M4.** WASM may be introduced only when **all** of these hold:

1. A profiled hotspot accounts for ≥ 5% of a relevant budget.
2. A written benchmark shows ≥ **2×** speedup for a WASM implementation of that
   specific kernel, on the reference hardware.
3. The kernel is **stable and isolated**: a pure function over typed arrays, with
   no allocation across the boundary, that we do not expect to redesign.
4. The benchmark and the decision are recorded as a new ADR.

Anticipated candidates, in likely order: erosion iteration, priority-flood
depression filling, plate advection/collision, large-scale FBM noise,
`stableMath` transcendentals.

### Alternatives considered
- **WASM-first for all numerics** — a defensible engineering position, but it
  front-loads cost against unmeasured benefit, and modern JIT-compiled JavaScript
  over typed arrays is typically within 1.5–3× of scalar WASM. The larger wins
  available to us are algorithmic and GPU-side.
- **Never WASM** — gives up SIMD, which is a real 2–4× on the right kernel.
  Deferring is not refusing.

### Rationale
This is the brief's "no technology because it is fashionable" rule applied
concretely. The gate is deliberately mechanical so that the decision does not turn
on anyone's taste.

### Consequences
- The benchmark harness (DEC-024) must exist early enough to make this gate
  usable. It is an M0/M1 deliverable and a **good Grok candidate**.
- Kernels that are WASM candidates should be written as pure functions over typed
  arrays from the start, so the port is mechanical when it is justified.

---

## DEC-022 — Persistence: versioned container, snapshot + command log

**Date:** 2026-09-11
**Status:** Accepted — **Quantisation clause superseded by DEC-028.** `i16` centimetres cannot represent Earth's elevation range.
**Review gate:** M11 exit.

### Context
Worlds must be reproducible from a seed, saveable, versionable across engine
changes, and eventually shareable. These are four different requirements and one
format will not serve all of them well.

### Decision
**Two save kinds over one container format.**

Container: a header (JSON, versioned, human-readable) followed by length-prefixed
binary blobs, one per field/table, each carrying its own `schemaVersion`, dtype,
grid id and quantisation. Fields are quantised (elevation `i16` in centimetres,
temperature `i16` in 0.01 K, …) and compressed with the platform's
`CompressionStream('deflate-raw')` — no dependency.

| Kind | Contents | Size | Validity |
| --- | --- | --- | --- |
| **Recipe** | `worldSeed` + world parameters + `SimTime` + the full command log | kilobytes | Only under Tier-A determinism (DEC-018). Ideal for sharing. |
| **Snapshot** | Full dump of all authoritative fields and entity tables | 50–500 MB | Always valid, engine-version-migrated |

- **Hybrid = snapshot + subsequent command log** → this is also how **replay** works.
- **Command log from day one.** Every user action and every parameter change is a
  timestamped `Command` object recorded in `sim`. This is cheap now and impossible
  to retrofit later. Replay *validation* comes at M11; recording starts at M0.
- Storage: **OPFS** for snapshots (large, streaming writes), **IndexedDB** for the
  world index and small metadata. Export as a single `.wsim` file.
- **Migrations are a registry**, `migrate(from, to)`, applied in sequence. A blob
  whose version has no migration path fails loudly. Never load-and-hope.

### Alternatives considered
- **JSON saves** — human-readable, and 25 million numbers as JSON text is
  indefensible.
- **Seed-only saves** — beautiful and what we want for sharing; unsound alone,
  because any Tier-B/C state or any engine change breaks it. Hence the two kinds.
- **Protobuf / FlatBuffers / MessagePack** — good general answers; our payload is
  ~95% homogeneous typed arrays, for which a length-prefixed blob container is
  simpler and faster than any of them. The JSON header covers the remaining 5%.
- **IndexedDB for everything** — fine for metadata, poor for hundreds of MB of
  streaming binary. OPFS is the right tool.

### Rationale
Separating "how the world was made" from "what the world currently is" matches how
the world is actually produced (DEC-017/DEC-019: most of it is regenerable), and it
is what makes tiny shareable worlds possible without giving up robust saving.

### Consequences
- Every field must declare its quantisation and the resulting precision loss must
  be acceptable to its consumers. Documented per field.
- The command log requires that all mutation flows through commands — no direct
  poking at sim state from the UI. This is a discipline with real teeth and it must
  start at M0.
- Save/load runs on a worker; it must not block the frame.

---

## DEC-023 — Testing strategy; visual validation is human, not CI

**Date:** 2026-09-11
**Status:** Accepted

### Context
A simulation has almost no "correct output" to assert against. Conventional unit
testing catches very little of what actually goes wrong (an ocean slowly losing
water, a continent drifting into the void, a climate that inverts at year 400).

### Decision
Six layers, in descending order of how much they actually protect us:

1. **Determinism tests** *(highest value)*. Same seed → identical state hash.
   Reversed chunk-generation order → identical. 1 vs 4 vs 8 workers → identical.
   Save → load → step → identical to not saving.
2. **Invariant / property tests.** Conservation of water, energy and mass within a
   documented ε. No `NaN` or `Infinity` in any field (a `FieldValidator` sweep).
   Monotonic simulation time. Quadtree well-formedness. Values within declared
   ranges. Coordinate round-trips within error bounds.
3. **Golden-state regression.** Hash of the full world state after N ticks from a
   fixed seed, stored in-repo. A change is a **deliberate act** requiring a note in
   `DECISIONS.md` or the commit body, never a silent re-baseline.
4. **Unit tests.** Maths, coordinate conversions, time arithmetic, quadkeys,
   serialisation round-trips, `stableMath` against high-precision references.
5. **Performance tests.** Benchmarks with thresholds from `budgets.ts`. CI records
   every run; it **fails only on regressions > 25%**, because CI timing is noisy and
   a flaky perf gate gets disabled within a week.
6. **Visual validation — human, by Astra.** Pixel-diff screenshot testing on WebGPU
   across drivers is unreliable enough to be a net negative. Visual quality,
   popping, hitching, scale perception and "does this look like a planet" are
   **Astra's gate**, recorded in `agent/ASTRA.md`, not a CI job.

CI runs layers 1–5 on every push. No merge to `dev` with a red CI.

### Alternatives considered
- **Screenshot-diff visual regression in CI** — tried by many WebGL/WebGPU projects,
  and the false-positive rate across driver versions makes it noise. Reconsider only
  with a pinned software rasteriser (e.g. a headless Dawn/SwiftShader build), which
  is itself a project.
- **High coverage targets** — coverage percentage is a poor proxy here; a 95%-covered
  simulation can still silently lose all its water. Layers 1–3 are what matter.
- **No golden tests (too brittle)** — brittleness is the *feature*: the point is to
  notice that behaviour changed.

### Rationale
The tests are ordered by what actually fails in this class of software. Determinism
and conservation bugs are subtle, cheap to detect mechanically, and ruinous if found
late. Visual bugs are obvious to a human in five seconds and expensive to detect
mechanically. Assign each to whichever agent is good at it.

### Consequences
- A `hashWorldState()` function is core infrastructure, needed from M0.
- The golden file is a merge-conflict magnet with three agents. Mitigation: it is a
  single hash per scenario, and conflicts are resolved by re-running, with the
  reason stated in the commit.
- Astra's validation is a **blocking milestone gate** — see `agent/PROTOCOL.md`.

---

## DEC-024 — Observability: ring buffer, trace export, budgets-as-code

**Date:** 2026-09-11
**Status:** Accepted

### Context
"60 FPS on reasonable hardware" is meaningless unless we can say, at any moment,
where the 16.6 ms went. Three agents optimising without a shared measurement tool
will optimise different things and contradict each other.

### Decision
1. **A single `Telemetry` module** with a fixed-size ring buffer of zone timings
   (no allocation in the hot path), covering: per-frame CPU zones, per-subsystem sim
   timings, worker job latency and queue depth, GPU pass timings via WebGPU
   `timestamp-query`, and memory counters (field bytes, GPU buffer bytes, tile atlas
   occupancy, entity counts).
2. **Trace export in Chrome Trace Event JSON format**, which opens directly in
   Perfetto and `chrome://tracing`. Zero dependencies, professional-grade tooling for
   free.
3. `performance.mark`/`measure` mirroring so the browser devtools timeline is useful
   too.
4. **A dev HUD overlay**: frame graph, budget bars (green/amber/red against
   `budgets.ts`), subsystem cadence view, LOD/patch counts, memory.
5. **`packages/core/src/budgets.ts` is the single source of truth** for every
   performance budget. The HUD reads it, the perf tests read it, the docs reference
   it. A budget that exists only in a document is not a budget.
6. **Assertions** (`assert`, `assertFinite`, `assertField`) are compiled out of
   production builds by a Vite define, so they can be liberal in dev.

### Alternatives considered
- **Ad-hoc `console.time`** — no aggregation, no history, and it perturbs what it
  measures.
- **A third-party profiler/telemetry SDK** — built for production analytics, not for
  a 16 ms frame loop, and a dependency we do not need.
- **Budgets in documentation only** — they drift from reality within weeks.

### Rationale
Observability is infrastructure for *collaboration* as much as for performance:
it is how three agents agree on what is actually slow, and how Grok's benchmark
claims become checkable rather than assertable.

### Consequences
- GPU timestamp queries require the `timestamp-query` feature, which is not
  universally available; the HUD degrades to CPU-only timings when absent.
- Telemetry itself has a budget: ≤ 0.2 ms/frame in dev, ~0 in production.

---

## DEC-025 — Camera: one continuous geodetic state

**Date:** 2026-09-11
**Status:** Accepted — **Representation superseded by DEC-029.** The no-modes policy, the `s = log10(altitude)` blend and the altitude-driven near plane are kept.
**Review gate:** M1 exit.

### Context
Orbit-to-surface descent is the project's signature interaction. The usual
implementation — an orbital camera mode and a surface camera mode with a switch —
produces a visible discontinuity exactly at the moment that is supposed to impress.

### Decision
**There is one camera and one camera state**, expressed geodetically:

```ts
interface CameraState {
  lat: number; lon: number;       // radians, f64
  altitude: number;               // metres above the reference surface, f64
  yaw: number; pitch: number; roll: number;  // radians, f64
  fovY: number;                   // radians
}
```

- "Orbital" is not a mode; it is simply a large `altitude`.
- **Control mapping blends continuously** with `s = log10(altitude)`: a mouse drag
  maps to angular motion about the planet centre at high `s` and to look-around at
  low `s`, interpolated smoothly across the transition band
  (`s ∈ [4, 5]`, i.e. 10–100 km). Movement speed, damping, rotation rate and
  near-plane distance are all continuous functions of `altitude`.
- `near = clamp(altitude × 1e-4, 0.05, 1000)`, far = infinite (DEC-005).
- **Behaviours** (arcball, surface-walk, entity-follow, cinematic spline) are
  *controllers* that write the same state; they are swappable without the state
  being rebuilt.
- The camera state is serialisable from M1, so cinematic keyframes can be authored
  at any milestone without a camera rewrite.

### Alternatives considered
- **Discrete modes with a transition animation** — the transition is a special case
  that has to be maintained forever, and it always looks like a transition.
- **Cartesian PCF camera position** — simpler to render from, but altitude (the
  variable that everything scales by) becomes a derived quantity requiring a
  surface query every frame, and near/far/speed scaling gets awkward.
- **Physically simulated spacecraft/aircraft camera** — a genuinely attractive
  option for a later "vehicle" mode, but it must not be the base camera: a
  free-look camera that fights orbital mechanics is unusable for development.

### Rationale
Making altitude the primary state variable means the hard requirement ("continuous
transition across 7 orders of magnitude") is satisfied by construction rather than
by a special case.

### Consequences
- Every altitude-dependent scalar (speed, damping, near plane, LOD τ, atmospheric
  parameters) must be a smooth function with no branches. A `switch` on altitude is
  a bug.
- The `Geodetic → PCF → camera-relative render` chain runs once per frame in `f64`.
- **M1 acceptance criterion:** a scripted descent from 40 000 km to 1 m in 60 s with
  no frame exceeding 33 ms and no visible discontinuity — Astra-verified.

---

## DEC-026 — Roadmap adjustments to the proposed milestone order

**Date:** 2026-09-11
**Status:** Accepted

### Context
The proposed milestone order places Dynamic Geology (M7) after Terrain (M2), yet
terrain's large-scale structure — continents, mountain belts, coastlines — *is* the
output of geology. It also places Scientific Visualisation at M12, but climate and
hydrology cannot be debugged without map views of their fields.

### Decision
Keep the M0–M13 numbering and scope, with three adjustments:

1. **Terrain genesis vs. live geology are separated, and both are correct.**
   M2 generates terrain from a **genesis-time geological history**: a plate
   simulation run once at world creation (thousands of steps, seconds of wall clock,
   Tier A), whose *output* is the initial elevation field. M7 then promotes that same
   solver to a **runtime subsystem** that keeps running at geological time scales.
   Same code, two lifetimes. This makes M2's terrain physically motivated instead of
   "noise that looks like continents", and it makes M7 a promotion rather than a
   rewrite.
2. **A minimal data-layer visualiser moves from M12 into M1.** A flat map / globe
   overlay that can render any registered field as a colour ramp, with a legend and
   a probe readout. It is ~a day of work, it is the primary debugging tool for
   M3–M8, and building it at M12 means debugging five milestones blind. M12 remains
   the *polished* scientific visualisation milestone (cross-sections, time series,
   vector fields, data export).
3. **M14 — Sharing, Modding & Tooling** is added as an explicit optional milestone
   after M13, rather than letting those concerns leak into earlier milestones.

### Alternatives considered
- **Move geology wholesale to M2** — would make M2 enormous and delay any visible
  planet by months. The genesis/runtime split gets the benefit at a fraction of the
  cost.
- **Keep visualisation at M12 as proposed** — would mean shipping M3–M8 with
  `console.log` as the only window into the fields. Rejected for a reason that is
  practical rather than aesthetic.

### Rationale
Both changes are made because of a dependency that the original ordering did not
account for, not because of preference. The numbering is preserved so that the
shared vocabulary with the brief stays intact.

### Consequences
- M2 depends on a plate-tectonics *generator* existing, which enlarges M2 and is a
  strong **Grok candidate** (algorithmic, self-contained, benchmarkable).
- M1 gains the visualiser as an acceptance item.
- See `docs/ROADMAP.md` for the full milestone definitions and acceptance criteria.

---

## DEC-027 — Dependency policy

**Date:** 2026-09-11
**Status:** Accepted

### Context
Every runtime dependency is a permanent liability in a project meant to live for
years: supply-chain risk, breaking changes, bundle size, and a behaviour we do not
control sitting in the middle of a deterministic simulation.

### Decision
- **`core`, `data` and `sim` have zero runtime dependencies.** Not "few". Zero.
  This is checked in CI.
- `render`, `workers` and `app` may take runtime dependencies only with a recorded
  justification in this file.
- Dev dependencies (TypeScript, Vite, Vitest, ESLint, the boundary checker) are
  unrestricted in kind but reviewed in number.
- Prefer platform APIs over packages: `CompressionStream` over a zlib package,
  `structuredClone` over a clone library, OPFS over a storage wrapper.
- Anything under ~200 lines that we would need to audit for determinism gets
  written, not installed.

### Alternatives considered
- **Use good libraries freely** — faster in month one; by year two the determinism
  audit surface and the upgrade treadmill dominate.
- **Vendor dependencies into the repo** — keeps control, loses upstream fixes, and
  bloats review diffs.

### Rationale
The simulation half of this codebase has an unusual requirement — bit-level
reproducibility — that essentially no npm package is written to guarantee. A zero-
dependency rule there is not purism, it is the only way the guarantee holds.

### Consequences
- We write our own noise, hashing, `stableMath`, spatial indices, serialisation and
  math types. All are small, all are testable, and several are excellent **Grok
  candidates**.
- UI may eventually justify a dependency; that will be its own ADR.


---

## DEC-028 — Raster quantisation; elevation is not i16 centimetres

**Date:** 2026-09-11
**Status:** **Accepted with amendment** (Opus, 2026-09-11 — see *Opus resolution*)
**Supersedes:** the quantisation clause of DEC-022 (*"elevation i16 in centimetres"*)
**Amends:** DEC-005 (scopes "all world data is f64" to positions, camera, and in-register physics)
**Author:** Grok 4.6
**Evidence:** `packages/data/test/audit-v0.test.ts`, `tools/bench/audit-v0.mjs` §4, `docs/AUDIT-V0.md` B1

### Context
DEC-022 stores elevation as `i16` centimetres. That encoding's range is
[−327.68, +327.67] m. Everest is 8849 m; the Mariana trench is −10 994 m.
DEC-005 simultaneously requires all world data to be `f64`. An L11 `f64` field
is 201 MB; ten of them blow the 700 MB CPU budget.

### Decision
1. **Stored rasters are quantized integers** (`i16` / `i32` / `u8`) with an
   explicit `quantum` and `offset` on the `FieldDescriptor`. They are not f64.
2. **Positions, camera state, planet parameters, and in-register physics** remain
   f64. DEC-005's precision strategy is unchanged for those.
3. **Global elevation is `i16` metres** (quantum = 1 m, offset = 0, range
   ±32 767 m). 1 m is below the L11 cell size (4.9 km); the 50.3 MB footprint
   is unchanged. Regional tiles that store *deltas from a parent* may use a
   finer quantum; absolute regional elevation must still cover the Earth range.
4. **Temperature `i16` 0.01 K** is accepted with offset 273.15 K (store
   `(T − 273.15) × 100`). Absolute kelvin is not.

### Alternatives considered
| Option | Why not |
| --- | --- |
| Keep i16 cm | Cannot represent Earth. |
| i32 centimetres globally | Works; doubles L11 elevation to 100.7 MB. Unjustified at 4.9 km cells. |
| f64 rasters | 201 MB/field; contradicts the memory budget that forced DEC-019. |
| i16 × 0.5 m | Covers ±16 km, 0.5 m quantum. Also legal. 1 m is enough at L11 and simpler. |

### Rationale
Quantisation is how DEC-018 stays affordable. The quantum has to fit the planet.
This is a one-line data-model fix that is cheap today and a save-format break
after T-0033.

### Consequences
- Every field declares `(dtype, quantum, offset, units)`. Undeclared quantisation
  is a descriptor error.
- Architecture v1 docs must stop saying "i16 centimetres for elevation."
- Existing M0 code has no FieldStore yet; there is nothing to migrate.

### Opus resolution — Accepted, amended with per-tile offset + quantum

The finding is correct and independently reproduced: `i16` × 0.01 m is
**[−327.68, +327.67] m**; Everest is 8849 m. The clause in DEC-022 was wrong and
is superseded.

Grok's fixed global quantum is accepted for the **global** field but is the wrong
answer for **regional tiles**, and the amendment matters because hydrology is
downstream of it.

**Amendment 1 — global field: `i16`, quantum 1 m, offset 0.** Range ±32.767 km,
which covers Earth (−10 994 … +8 849 m) and also Mars (−8 200 … +21 900 m), so
the encoding is not Earth-specific. 1 m is far below the L11 cell size (4.9 km).
50.3 MB unchanged. Grok proposed this; it stands.

**Amendment 2 — regional tiles carry their own `offset` and `quantum`.**
A fixed 1 m quantum at L18 (38 m cells) gives a slope quantum of 1/38 = 0.026,
i.e. 1.5°. Flow routing over floodplains and deltas at that resolution produces
large spurious flats and ambiguous drainage — priority-flood will *resolve* them,
but it will resolve them arbitrarily rather than physically. Since a single tile
spans a small area, its elevation range is small, and a per-tile encoding recovers
one to two orders of magnitude of vertical resolution for 8 bytes of header:

```
offset  = snapToQuantum((min + max) / 2)
quantum = 2 ^ ceil(log2((max − min) / 65534))     // clamped to [2^-10 m, 1 m]
stored  = round((h − offset) / quantum)           // i16
h       = offset + stored * quantum               // exact reconstruction
```

**The quantum is snapped to a power of two and the offset to a multiple of the
quantum.** That is not a detail — it makes both the division and the
reconstruction exactly representable in IEEE-754, so a tile decodes bit-identically
on any platform. A non-power-of-two quantum would make decoding a rounding
operation and quietly drop regional terrain out of determinism Tier A (DEC-018).

A 2.4 km L18 tile with 600 m of relief gets a quantum of 2⁻⁶ = **15.6 mm**
instead of 1 m — a 64× gain in vertical resolution for 8 bytes of tile header.
(The snap rounds *up*: rounding down would not fit the tile's range in `i16`.)

**Amendment 3 — `min`/`max` are computed in a fixed index order** over the tile,
so the chosen `offset`/`quantum` are a pure function of the tile's content and
therefore of `hash(seed, quadkey)`. Tile encoding stays order-independent
(DEC-017).

**Amendment 4 — temperature.** Accepted as Grok wrote it: `i16`, quantum 0.01 K,
offset 273.15 K. Absolute kelvin in `i16` centikelvin covers 0–327 K and is
rejected.

**Consequence.** `FieldDescriptor` carries `(dtype, quantum, offset, units)` and
tiles may override `quantum`/`offset` per tile. Implemented in T-0011 with tests
for exact round-trip and for the power-of-two invariant.

---

## DEC-029 — Canonical camera is PCF + quaternion; geodetic is derived

**Date:** 2026-09-11
**Status:** **Accepted** (Opus, 2026-09-11 — see *Opus resolution*)
**Supersedes:** the *representation* in DEC-025. The no-modes policy, the
`s = log10(altitude)` blend, and the "orbital is a large altitude" rule are kept.
**Author:** Grok 4.6
**Evidence:** `packages/data/test/audit-v0.test.ts` (pole collapse), `docs/AUDIT-V0.md` B4

### Context
DEC-025 stores `CameraState` as geodetic `{lat, lon, altitude, yaw, pitch, roll}`.
At `lat = ±π/2`, longitude is undefined and yaw-about-Z gimbal-locks. Two
headings at the pole are the same PCF. Polar orbit and ice-sheet inspection are
in-scope for M1/M5/M7.

DEC-025 rejected "Cartesian PCF" because "altitude becomes a derived quantity
requiring a surface query." Altitude above the *reference sphere* is `|PCF| − R`.
Altitude above *terrain* is a surface query in any representation.

### Decision
```ts
interface CameraState {
  position: PCF;                 // f64, planet-centred
  orientation: Quat;             // unit quaternion, PCF basis
  fovY: number;                  // radians
}
```
- Geodetic `{lat, lon, altitude, yaw, pitch, roll}` is **derived** for UI, for
  serialised keyframes that want to be human-editable, and for the
  `s = log10(|position| − R)` control blend, which is unchanged.
- Controllers write PCF + quaternion. A geodetic keyframe is converted on load.
- **A `switch` on altitude remains a bug.** The no-modes policy stands.
- Near plane remains `clamp(altitudeSphere × 1e-4, 0.05, 1000)`.

### Alternatives considered
| Option | Why not |
| --- | --- |
| Keep geodetic, special-case the poles | The special case is a mode. DEC-025 exists to forbid modes. |
| lat/lon with a quaternion only for heading | Still singular in position. |
| Look-at + up vectors | Two vectors that must stay orthonormal; a quaternion is the same data with
  the constraint in the type. Acceptable implementation of this decision. |

### Rationale
The continuity requirement is about *not switching controllers*. It is not about
storing coordinates in the chart that happens to make `altitude` a struct field.

### Consequences
- T-0016 implements this, not the DEC-025 struct.
- The M1 scripted descent must include a polar pass, not only an equatorial one.
- Serialised camera state from M1 uses PCF + quat; a geodetic view is derived.

### Opus resolution — Accepted as proposed

Grok is right and my rejection of "Cartesian PCF" in DEC-025 was wrong for the
reason he gives. I rejected it because "altitude becomes a derived quantity
requiring a surface query". Altitude above the *reference sphere* is `|p| − R` —
no query at all. Altitude above *terrain* needs a query in either representation.
The argument I used did not distinguish the two, so it justified nothing.

The cost of being wrong here is concrete: `lat = ±π/2` makes longitude undefined
and gimbal-locks yaw-about-Z, and ice sheets, polar orbits and the M1 descent
sweep all live exactly there. A camera that cannot fly over a pole cannot inspect
the cryosphere, which is an M5/M7 subject.

**What survives from DEC-025 unchanged:** the no-modes policy, "orbital is just a
large altitude", the `s = log10(altitude)` control blend, altitude-driven near
plane, and the rule that a `switch` on altitude is a bug. DEC-029 changes the
*representation*, not the policy. DEC-025 is marked `Superseded in part`.

**Added to the acceptance criteria:** the M1 scripted descent includes a polar
pass, and `packages/render/test/` carries an explicit polar-crossing test —
a camera advancing tangentially across both poles must produce a continuous
position and orientation track with no discontinuity in the derived heading.

---

## DEC-030 — Temporal LOD: three state classes, always-on aggregates, coarser grids

**Date:** 2026-09-11
**Status:** **Accepted with amendment** (Opus, 2026-09-11 — see *Opus resolution*)
**Amends:** DEC-015 (does not replace regimes, `quiesce`/`resume`, or hysteresis)
**Author:** Grok 4.6
**Evidence:** `docs/AUDIT-V0.md` B2, `tools/bench/audit-v0.mjs` §8 and §10

### Context
DEC-015's diagnosis is correct: 1 Myr/s vs 1-hour weather is nine orders of
magnitude. Regimes are the right shape. The contract is not sufficient:

- Ice sheets, ocean interior and groundwater cannot be reconstructed from a
  monthly mean. They are not "fast state" and they are not "aggregates."
- A 12-month i16 climatology of T+P at L11 is 1.2 GB, over the 700 MB budget.
  The same on geodesic n6 is 16 MB. DEC-015 does not allow an aggregate to live
  on a coarser grid.
- Aggregates computed only at `quiesce` make every transition a conservation
  event. Running windows do not.
- Recipe = seed + SimTime is path-dependent under hysteresis + `resume()`.

### Decision
Four rules on top of DEC-015:

1. **Three state classes**, declared on every field:
   - **slow** — always live, stepped at a coarse cadence, never flushed
     (plates, ice volume, groundwater, crust). `quiesce` is a no-op.
   - **fast** — regime-switched transients (wind, storms, convective towers).
     May be discarded on `quiesce` and re-seeded on `resume` from aggregates +
     world seed (pure, so replay of the same command log is deterministic).
   - **aggregate** — statistics of fast state (monthly/annual means).
2. **Aggregates are always-on running windows**, updated in the fine regime.
   `quiesce` stops the fine solver. `resume` starts it from the current
   aggregate + seed. Conservation tests still run across the transition.
3. **An aggregate may live on a coarser grid than its instant field.**
   `FieldDescriptor.aggregate` names a `FieldId` whose `grid` may differ.
   Cross-grid writes go through the conservative resampler (DEC-008). Default
   for atmosphere/ocean climatology: geodesic n6 (or n5). Not cube L11.
4. **A recipe reproduces a command log**, not "seed + SimTime via any path."
   `timeScale` changes are commands. Two logs that reach the same `SimTime` by
   different scale paths are different worlds and must not be claimed identical.

### Alternatives considered
| Option | Why not |
| --- | --- |
| Keep two classes, special-case ice as its own subsystem | Ice is the example, not the set. Ocean interior, soil, groundwater share the shape. |
| Sample 1 year in 1000 (DEC-015 already rejected) | Biases rare events. Still available *inside* a regime. |
| Same-grid aggregates | Illegal under the memory budget (AUDIT §8). |

### Rationale
This is DEC-019 applied to time: the simulation's source of truth is allowed to
be coarser than the visual weather, and long-memory quantities are not asked to
pretend they are weather. Always-on aggregators turn the most novel, least
tested moment in the project (`quiesce`) into a boring one.

### Consequences
- T-0011's `FieldDescriptor` gains `class: 'slow' | 'fast' | 'aggregate'` and
  a possibly-different `aggregate` grid.
- T-0012 does not implement regimes, but the descriptor and the recipe rule
  must already exist so M4 is not a rewrite.
- R-02 remains; this is the mitigation, not a proof it works. Invariants still
  required at M4/M11.
- Worker job caps at T4 must be evaluated in *sim-time lag*, not only wall-clock
  (a 250 ms paleo job is ~80 000 years). Paleo regimes must be cheap.

### Opus resolution — Accepted, amended with a path-independence rule

I asked to be told I was wrong about DEC-015 and I was, in the specific way Grok
identifies. My contract had **fast state** and **aggregates** and quietly assumed
every quantity was one of the two. Ice sheets, the ocean interior, groundwater and
soil carbon are none of them: their memory is longer than the coarse step and they
cannot be reconstructed from a monthly mean. `quiesce`-into-an-aggregate is not a
lossy operation for an ice sheet, it is a *meaningless* one.

The three classes are accepted. Always-on running aggregators are accepted, and
are strictly better than my flush-at-transition design for the reason Grok gives:
they turn the least-tested moment in the project into a boring one. Coarser
aggregate grids are accepted — a 12-month `i16` T+P climatology at L11 is
**1.21 GB** against **1.97 MB** on geodesic n6 (independently recomputed), so
same-grid aggregates were never affordable.

Two amendments, because the proposal does not yet close the path-dependence hole
it correctly opens.

**Amendment 1 — slow state steps on a fixed sim-time cadence, independent of
`timeScale`.** This is the rule that makes long-memory state path-independent *by
construction* rather than by hope. DEC-016 already requires cadence in simulation
time; DEC-030 makes it binding for class `slow`: an ice-sheet solver stepping
every 10 simulated years steps every 10 simulated years whether the user is at T0
or T4. `timeScale` then changes only how much wall-clock a span costs and which
*fast* regime is active. It does not change the slow trajectory's step sequence.

The residual coupling is that slow state reads aggregates, and a `climatology`
regime produces different monthly means than an `explicit` one. That coupling is
irreducible, so it gets named rather than hidden — see Amendment 2.

**Amendment 2 — temporal LOD changes results, and we say so.** This is the honest
framing that was missing from both DEC-015 and DEC-030:

> Running a span at a coarse `timeScale` is not an approximation of running it at
> a fine one. It is a different, cheaper model of the same physics, exactly as a
> low LOD patch is a different, cheaper model of the same terrain. Determinism is
> a promise about `(worldSeed, command log)` — and `timeScale` changes are
> commands. It is **not** a promise that two different paths to the same `SimTime`
> agree.

Grok's rule 4 says this for recipes; I am promoting it from a save-format footnote
to a **property of the simulation**, because it also governs what the UI may claim
("fast-forwarding will change your world" is a user-facing fact, not a bug), what
the invariant tests may assert (conservation across a transition — yes; identical
state via two paths — no), and what R-14 actually is.

**Amendment 3 — the worker-lag figure is worse than stated.** Grok cites ~80 000
years for a 250 ms job at T4. At the T4 rate DEC-015 actually names — 1 Myr per
real second, `timeScale` ≈ 3.16 × 10¹³ — a 250 ms job is **≈ 250 000 simulated
years** of committed-state lag. The conclusion is unchanged and reinforced: paleo
regimes must be cheap enough that lag is bounded *in sim time*, and
`budgets.WORKERS.maxJobMs` needs a companion `maxJobSimYears`.

**Consequence.** `FieldDescriptor` gains `temporalClass: 'slow' | 'fast' |
'aggregate'`, and `aggregate` may name a field on a different grid. Both land in
T-0011 now, so M4 is not a rewrite. DEC-015 is marked `Amended by DEC-030`.

---

## DEC-032 — Performance budgets restated from arithmetic

**Date:** 2026-09-11
**Status:** **Accepted with amendment** (Opus, 2026-09-11 — see *Opus resolution*)
**Amends:** `packages/core/src/budgets.ts` and `docs/RENDERING.md` §7 (a budget
change is an ADR per PROTOCOL §5.1 and DEC-024)
**Author:** Grok 4.6
**Evidence:** `tools/bench/audit-v0.mjs` §7, §8, §12; `packages/core/test/audit-v0.test.ts`

### Context
M0 budgets are labelled estimates. Independent arithmetic, before a profiler
exists, already falsifies several of them as currently written.

### Decision
1. **Reference hardware is a tier, not a union.**
   - *Primary:* Apple M1 / RTX 3050-class, 1440p, 60 FPS.
   - *Floor:* Intel Iris Xe 96EU, 1080p, 30 FPS acceptable, reduced patch cap.
   Shipping criteria name the tier.
2. **Triangle budget is derived from τ and pixel area, not from 1000 × 65×65.**
   A 65×65 patch at 1440p × 1000 visible = 0.45 px/triangle (small-triangle
   cliff). Cap mean triangle area at ≥ 2 px, or cap visible patches so that
   `PATCH_TRIANGLES * visible ≤ 2 × pixelCount`. 65×65 remains *a* patch size,
   tried against 33×33 in E1 before it is locked.
3. **Horizon culling is in the M1 LOD contract**, not a later optimisation.
4. **Commit of a large field is a generation publish (pointer swap / atomic
   index), never a 50 MB memcpy.** `simCommit: 2.0 ms` cannot copy L11.
5. **SAB is required for in-place L11 updates.** Transfer is supported for
   tile-sized jobs (≤ ~1 MB). `structuredClone(50 MB)` measured 98 ms;
   transfer round-trip 34 ms. Neither fits a frame.
6. **Numbers in `budgets.ts` stay as labelled estimates** until E1/E2 run on
   real hardware. This ADR changes the *rules that produce them*, not the
   placeholders, except:
   - add `minPxPerTriangle: 2.0`
   - add `hardwareTier: 'primary' | 'floor'`
   - document that `maxVisiblePatches: 1200` is an *upper bound that τ must
     also satisfy*, not a target.

### Alternatives considered
| Option | Why not |
| --- | --- |
| Keep one hardware sentence | Makes the M1 60 FPS criterion unfalsifiable. |
| Lock 33×33 now | Unmeasured. E1 exists so we do not guess twice. |
| Drop 60 FPS | Against the brief. Reduce *work*, not the target, on primary hardware. |

### Rationale
Opus asked for arithmetic before a profiler. The arithmetic says the patch count
and the patch size cannot both sit at their documented max at 1440p, and that
Iris Xe is not the same GPU as an RTX 3050.

### Consequences
- T-0014 treats 65×65 as a knob. E1 runs before M1 close.
- T-0013 does not promise a 50 MB transfer fallback for L11.
- HUD and perf tests read the new fields once they exist. Until DEC-032 is
  Accepted, `budgets.ts` numbers are unchanged (PROTOCOL: no silent budget edit).

### Opus resolution — Accepted, amended into a budget *function*

I asked for the budgets to be attacked with arithmetic before a profiler existed.
They were, and they lost. Independently recomputed at 1440p (3 686 400 px):

| Patch | Triangles | 1000 patches @1440p | Patches at ≥ 2 px/tri |
| --- | --- | --- | --- |
| 17×17 | 512 | 7.20 px/tri | 3600 |
| 33×33 | 2 048 | 1.80 px/tri | 900 |
| **65×65** | **8 192** | **0.450 px/tri** | **225** |

And the budget contradicted its own LOD rule, which is the part that actually
matters. At τ = 2.0 px a 64-segment patch subtends ~128 px, so a *full 1440p
screen* holds ~225 patches ≈ **1.84 M triangles** — not the 8.2 M in
`budgets.ts`. `maxVisiblePatches: 1200` and `lodScreenSpaceErrorPx: 2.0` were
never simultaneously satisfiable. They were two independent guesses written down
as if they were one design.

All six of Grok's rules are accepted. Three amendments.

**Amendment 1 — the budget is a function, not a constant.** This is what the
brief asked for and what Grok's rule 2 implies without stating. `budgets.ts`
exports `resolvePatchBudget({ pixelCount, gpuTier, patchVerticesPerSide,
targetFrameMs })` returning the admissible visible-patch count and τ. The HUD, the
LOD selector and the perf tests all call the same function, so a device that is
not the reference device gets a budget rather than a failure. Constants that a
selector reads directly are how the 1200/2.0 contradiction happened.

**Amendment 2 — three tiers, not two.** Grok's primary/floor split is right but
under-resolved: an M1 (≈2.6 TFLOPS) is not an RTX 3050 (≈5–8 TFLOPS) either.
`discrete` / `integrated` / `floor`, each with its own resolution and frame
target. The M1 criterion then names a tier and becomes falsifiable.

**Amendment 3 — `maxJobSimYears` joins `maxJobMs`.** From DEC-030 Amendment 3: a
wall-clock job cap is not a cap at all once `timeScale` is 10¹³.

Numbers stay labelled estimates until E1/E2 run on real hardware. What changes
today is the *shape*: budgets are derived, tiers are explicit, and the small-
triangle cliff is a rule the selector enforces rather than a fact we rediscover.

### Amendment, 2026-09-12 — `lodScreenSpaceErrorPx` 2.0 → 4.0 (T-0063)

Recorded here rather than edited silently, per PROTOCOL §5.1.

The node error model reported the **arc sagitta** while the renderer draws a
**bilinear quad**, whose true deviation is exactly twice that. A nominal τ of
2.0 px was therefore delivering ~4.0 px of real geometric deviation for the
whole of M1. Correcting the model without touching τ made the selector demand
twice the patches, saturating the 900-patch cap at ~2.2 × 10⁶ m; the resulting
truncation produced 200-patch churn per frame, which is far worse than the sag
it removed.

| | peak visible | max disappear | max appear | >1 ms | exhausted |
| --- | --- | --- | --- | --- | --- |
| before (model wrong, τ 2.0) | — | 57 | 48 | 24 | 0 |
| model fixed, τ 2.0 | **900 (saturated)** | 211 | 212 | 51 | 15 |
| model fixed, **τ 4.0** | 759 | 56 | 48 | **11** | 0 |

τ = 4.0 reproduces the previous *behaviour* — because that is what was actually
being delivered — while the number now means what it says, and select-time
overruns more than halve. This is a truth-in-labelling change, not a quality
reduction. Whether 4 px of limb deviation is acceptable is a visual question
that is now answerable; it was not before, because the stated figure was not the
delivered one.

---

---

## DEC-031 — The scheduler dependency graph is the union over regimes

**Date:** 2026-09-11
**Status:** Accepted
**Amends:** DEC-016
**Closes:** AUDIT-V0 B3
**Author:** Opus 5

### Context
DEC-016 declares `reads`/`writes` per `Subsystem` and builds a topological order
at startup. DEC-015/DEC-030 give each subsystem several **regimes**, and regimes
of the same subsystem read *different* fields — `precip.instant` in `explicit`,
`precip.annualMean` in `climatology`. A per-subsystem declaration and a
per-regime reality cannot both be the graph. B3 is that this was never specified,
so T-0012 would have shipped one of them by accident.

### Decision

**1. The declared set is the union over all regimes.** A subsystem's `reads` and
`writes` are the union of every regime's accesses. The graph is built once, at
startup, from the registry alone.

**2. The execution order is a pure function of the registry**, in this order:
   1. `phase` (fixed enum order);
   2. within a phase, topological sort of the union graph;
   3. ties broken **lexicographically by `SubsystemId`**.

   Registration order, module load order, worker count, wall-clock and regime
   selection therefore cannot affect execution order. This is testable directly
   and is a required M1 test.

**3. Four startup errors, never warnings:**
   - a **cycle** in the union graph;
   - a **write conflict** — two subsystems declaring `writes` on the same field
     (violates DEC-013's single-writer rule);
   - an **undeclared owner** — writing a field whose `owner` is another subsystem;
   - an **unknown field** in either set.

**4. Feedback loops are broken explicitly** by `readsPrev: [FieldId]`, which reads
the previous generation of a double-buffered field. `readsPrev` creates **no**
graph edge. Making the one-step lag explicit is the point: an implicit lag is how
a climate quietly changes behaviour.

**5. Regime changes never rebuild the graph in M1.** Recomputing per active regime
set is a legitimate later optimisation — it stays deterministic as long as it is a
pure function of `(registry, activeRegimes)` with the same tie-break — but it is
not M1, and it needs a test proving the two orders agree where they should.

### Alternatives considered
| Option | Why not |
| --- | --- |
| Per-regime graphs, rebuilt on transition | More parallelism available at coarse `dt`, but the order becomes a function of the regime *path*, which is exactly the path-dependence DEC-030 Amendment 2 is trying to contain. Deferred, not rejected. |
| Infer `reads`/`writes` by instrumenting a run | Cannot see a branch that this run did not take — and the branches are the regimes. Useful as a *check* (rule 6 below), useless as a source of truth. |
| Let subsystems declare per-regime sets and union them automatically | Equivalent to this decision with more ceremony. Revisit if a subsystem's union becomes so wide it serialises the phase. |

### Rationale
The union is conservative: it can only *over*-constrain, never under-constrain.
An over-constrained schedule loses some parallelism; an under-constrained one
loses determinism. At M1's scale the parallelism is worth nothing and the
determinism is worth everything.

### Consequences
- A subsystem whose union spans most of a phase serialises that phase. If that
  happens, the answer is to split the subsystem, not to weaken the rule.
- **Rule 6 — the declaration is verified, not trusted.** Dev builds trap writes
  through a barrier and assert against the declared set; a test runs an
  instrumented step *per regime* and asserts the observed accesses are a subset of
  the union. Grok's point stands: a union declaration plus a single-regime test is
  weaker than it looks, so the test iterates regimes.
- T-0012 implements rules 1–4 and 6 now. Regimes themselves are M4.

---

## DEC-033 — Shader-side precision rules

**Date:** 2026-09-11
**Status:** Accepted
**Amends:** DEC-005
**Closes:** AUDIT-V0 M5
**Author:** Opus 5

### Context
DEC-005 says there is "exactly one `f64 → f32` conversion point" and names a
*file path*. A file path is not enforceable inside a shader. Grok's M5 shows two
concrete ways the 0.5 m ulp at planet radius walks back in through the GPU even
though the CPU side is correct.

### Decision

**1. No shader may add a planet-centred camera position in `f32`.**
`worldPos = cameraPCF + relativePos` in a shader reconstructs a number of
magnitude 6.37 × 10⁶ in `f32` and immediately quantises it to 0.5 m. Every pass —
atmosphere, ocean, fog, shadows, SSR, any screen-space effect — stays in
**camera-relative** space. Where a true PCF quantity is genuinely needed (e.g. a
latitude for insolation), it is computed on the CPU in `f64` and passed as a
uniform, or derived from a *normalised direction*, which is scale-free and safe.

**2. World position reconstructed from the depth buffer is a low-precision
quantity and is labelled as such.** At 40 000 km, reversed-Z `depth32float`
reconstruction is metre-scale at the surface (≈3 m) and worse at the limb (≈5 m).
That is fine for fog, atmospheric density and soft particles. It is **not** fine
for anything that must agree with geometry — contact shadows, decals, terrain
picking, or any simulation query. Picking and any CPU-visible query use a CPU-side
ray/sphere or ray/patch intersection in `f64`, never a depth read-back.

**3. Two names, because they are two different things.**
   - **`cameraNear`** — the projection near plane,
     `clamp(altitude × 1e-4, 0.05, 1000)` m. Never zero; a zero near plane is
     singular.
   - **`depthNear` / `depthFar`** — the *depth range*, reversed: near maps to
     `1.0`, far to `0.0`, clear to `0.0`, test `GreaterEqual`.

   DEC-005 wrote "near = 0" meaning the second and it reads as the first. Fixed.

**4. The far plane is infinite** (the projection has no `far` term), so there is
no far-plane clipping at any altitude. Unchanged from DEC-005; restated here
because it is part of the same shader contract.

### Alternatives considered
| Option | Why not |
| --- | --- |
| Emulated double-single (`f32`×2) camera adds in shaders | ~4× vertex arithmetic to solve a problem the CPU already solves for free. DEC-005 keeps this as a targeted tool with written justification; it is not the answer here. |
| A 64-bit depth or a separate high-precision G-buffer position target | Bandwidth cost of a full extra RGBA32F target for an accuracy nothing currently needs. Revisit if contact shadows or decals arrive. |
| Split depth ranges | Rejected in DEC-005 for the same reasons; unchanged. |

### Rationale
DEC-005's precision strategy is correct and Grok agrees. What it lacked was a rule
expressed in the units a shader author works in. "One conversion point" is a
statement about CPU code; these are the three statements about GPU code that make
it true end to end.

### Consequences
- WGSL review checks for a `cameraPCF`-shaped uniform being added to a position.
  There is deliberately **no** `camera_pcf` uniform in the standard bind group —
  the absence is the enforcement.
- T-0010 exposes `cameraNear` and the reversed-Z depth range under those names.
- R-09 (surface precision unmeasured on a GPU) is unchanged and remains an M1
  Astra gate item. This decision removes two ways to fail it, not the need to
  measure it.

---

## DEC-034 — Visibility and LOD contract: horizon culling and multi-level descent

**Date:** 2026-09-11
**Status:** Accepted
**Amends:** DEC-010, DEC-019
**Closes:** AUDIT-V0 M6, M7
**Author:** Opus 5

### Context
DEC-010 specified split/merge by screen-space error and said nothing about which
patches are visible at all. On a sphere seen from orbit, roughly half the surface
faces away from the camera; a frustum test does not remove it. The patch budget in
DEC-032 therefore assumed a culling model that was never written down (M6).

Separately, DEC-019 caps authoritative data at L11 globally and L12–L18
regionally. That is a *data* split. DEC-010's CDLOD morph blends **one** level.
A camera descending from orbit crosses seven levels between them (M7).

### Decision

**1. Horizon culling is part of the M1 LOD contract**, not an M2 optimisation.
For a camera at distance `d` from the planet centre with reference radius `R`, a
patch bounding sphere centred at `c` (radius `r`) is culled when it lies behind
the horizon plane. The standard conservative test, with two inflations:
   - the effective radius is `R + maxTerrainElevation`, so mountains beyond the
     geometric horizon are not culled;
   - a further **+100 km** for the atmosphere shell, so limb scattering is not
     clipped.
   Order: cheap horizon test first, then frustum, then screen-space error. The
   horizon test rejects the most patches for the least arithmetic.

**2. The quadtree exists at every level; the *data* does not.** A node at L12–L18
outside a cached regional tile is rendered from its **nearest ancestor's tile,
bilinearly upsampled**, with its geometric error inherited and scaled. The mesh
LOD is therefore continuous even where authoritative data jumps seven levels. This
is what makes DEC-019's data split invisible rather than a 4.9 km → 38 m pop.

**3. Streaming prefetches the chain, not the leaf.** Requesting L18 for a patch
enqueues its missing ancestors first, in coarse-to-fine order. A leaf that arrives
before its parents cannot be displayed without a discontinuity, so leaf-first
streaming is not merely inefficient, it is wrong.

**4. Prefetch is predictive, from camera velocity.** Target: the tile chain for
the camera's position at `t + 2 s` is requested by `t`. Without this the 400 ms
pop-in budget is a wish — a descent frustum needs several hundred tiles and
120 tiles/s takes seconds to fill.

**5. LOD selection has hysteresis.** Split at τ, merge at `τ × 1.5`. A node
sitting exactly on the threshold must not oscillate; oscillation is both a
performance bug and a visible one, and it is the temporal analogue of the regime
thrash DEC-015 already guards against.

### Alternatives considered
| Option | Why not |
| --- | --- |
| Frustum culling only | Leaves ~half the planet's patches in the set at orbital altitude, which is where the budget is tightest. |
| Backface culling per patch normal | Correct for a flat patch, wrong for a curved one spanning many degrees, and it does not handle occlusion by the planet's own limb. The horizon test is the curved-surface generalisation and costs the same. |
| GPU occlusion queries / HZB | Genuinely better for city geometry at M9. Overkill for a convex sphere, where the analytic horizon is exact and free. |
| Render L11 data all the way down, add detail only at L19+ | The 4.9 km → 0.6 m gap is exactly the M7 pop. Rejected. |

### Rationale
Horizon culling is not an optimisation on a planet, it is the visibility function.
Deferring it would mean tuning τ and the patch budget against a patch set twice
the size of the real one — i.e. every number measured in E1 would have to be
measured again.

### Consequences
- T-0014 implements horizon culling, ancestor upsampling, chain prefetch and
  hysteresis. The M1 acceptance criteria gain a horizon-culling correctness test
  (no patch visible on screen is ever culled — a conservative-ness test, which is
  the direction that matters).
- The LOD selector needs a per-node bounding sphere and an inherited geometric
  error. Both are computed at tile bake and stored, per DEC-010.
- `maxTerrainElevation` becomes a planet parameter the renderer reads.

---

## DEC-035 — Cube-face orientation and UV convention

**Date:** 2026-09-12
**Status:** Accepted
**Amends:** DEC-007 (fixes the per-face convention DEC-007 left as "a convention")
**Closes:** the architectural FYI Grok raised in `agent/HANDOFF.md` after the
Ampere pass
**Author:** Opus 5

### Context

Astra's Ampere run showed large holes in the sphere. One cause was that on
`POS_Y` and `NEG_Y` the 3-D image of `∂/∂u × ∂/∂v` pointed **inward**, so those
two faces were wound opposite to the other four and back-face culling removed
them. Grok fixed the mapping (`POS_Y` now `z = -b`, `NEG_Y` now `x = a`) and
correctly flagged that this **changes which physical location a given quadkey on
those two faces addresses**.

He then asked the right question rather than answering it himself: is per-face
UV orientation an implementation detail of DEC-007, or part of the persistent
coordinate system?

DEC-007 says only that "the orientation within a face is a convention, fixed
here". That sentence names the thing without pinning it, which is precisely how
it managed to be wrong on two faces for a whole milestone.

### Decision

**Per-face UV orientation is part of the coordinate system, not an implementation
detail.** It is specified here, exhaustively, and changing it from now on
requires a superseding record and a save-format migration.

With `a = warp(2u − 1)` and `b = warp(2v − 1)`, `warp(s) = tan(sπ/4)`, the six
faces are exactly:

| Face | id | (x, y, z) before normalisation | ∂u | ∂v | ∂u × ∂v |
| --- | --- | --- | --- | --- | --- |
| `POS_X` | 0 | `( 1,  a,  b)` | +Y | +Z | **+X** |
| `NEG_X` | 1 | `(-1, -a,  b)` | −Y | +Z | **−X** |
| `POS_Y` | 2 | `( a,  1, -b)` | +X | −Z | **+Y** |
| `NEG_Y` | 3 | `( a, -1,  b)` | +X | +Z | **−Y** |
| `POS_Z` | 4 | `( a,  b,  1)` | +X | +Y | **+Z** |
| `NEG_Z` | 5 | `( a, -b, -1)` | +X | −Y | **−Z** |

**The binding invariant: on every face, `∂u × ∂v` points outward** — into the
same hemisphere as the face's own cube axis. Everything else follows from it:

1. In `(u, v)` parameter order, the triangle `(0,0) → (1,0) → (0,1)` is
   counter-clockwise **seen from outside the planet**. The index buffer is wound
   `(a,b,c) + (b,d,c)` to match.
2. A patch's four corners packed in `(c00, c10, c01, c11)` order have
   `cross(c10 − c00, c01 − c00)` pointing away from the planet centre, so the
   shader's geometric normal needs no sign fix and no per-face special case.
3. The inverse map `unitToCubeFace` must invert exactly this table. It is not
   free to choose its own signs.

`u` and `v` both increase; there is no face on which either axis is reversed
relative to its own tangent basis. Any future face-local flip must be recorded
here, not absorbed into a function.

### Alternatives considered

| Option | Why not |
| --- | --- |
| **Treat this as an implementation fix to DEC-007, no record** (Grok's Option 1) | Defensible *today*: no world is persisted, and the old mapping was internally inconsistent, so nothing correct was broken. Rejected because of *when* we are. M2 begins binding data to tiles keyed by quadkey; from that moment the mapping is a save-format commitment and a change to it silently relocates terrain. The cost of the record is one table; the cost of not having it is discovered after the first shared world. |
| Keep the old `POS_Y`/`NEG_Y` mapping and flip the winding per face in the renderer | Makes the renderer carry a per-face sign table forever, and leaves `∂u × ∂v` meaning different things on different faces — which is the ambiguity that caused the bug. |
| Derive each face basis from a generated rotation table instead of a literal switch | Fewer characters, more indirection, and the six cases are the specification. A reader must be able to check the table against the code by eye. |
| Adopt a published convention (OpenGL cubemap face layout) | Genuinely tempting for interoperability with cubemap tooling. Rejected: GL's cubemap layout is left-handed with `-Y` down and flipped `t`, chosen for historical render-to-texture reasons, and adopting it would put an inward `∂u × ∂v` on some faces — reintroducing exactly this bug for the sake of a texture-loading convenience we do not need. Noted so nobody "fixes" the table toward GL later. |

### Rationale

The orientation is load-bearing in three places at once — the renderer's
winding, the shader's normal, and the quadkey → physical location map — and it
was only ever written down in one of them. Anything depended on by three
subsystems and specified in none of them is a latent defect; this milestone
found out how it fails.

Writing the table now costs nothing because no world exists. Writing it after M2
costs a migration.

### Consequences

- The table above is the specification. `cubesphere.ts` is checked against it by
  `packages/render/test/geometry.test.ts`, which asserts outwardness on all six
  faces on an interior grid, not only at face centres.
- Quadkeys on `POS_Y`/`NEG_Y` address different physical locations than they did
  before `889cebf`. **No migration is needed** because no world has been
  persisted — this is the last moment at which that sentence is true.
- T-0020 (seam topology, hydrology corners) treats outwardness as given and is
  concerned only with valence-3 corner behaviour.
- DEC-007's "orientation within a face is a convention" is superseded by this
  table; DEC-007's grid choice is untouched.
- Any future planet with a different reference frame reuses this table
  unchanged: it is expressed in the body's own axes.
