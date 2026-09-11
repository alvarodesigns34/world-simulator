# RENDERING — precision, coordinates, LOD, camera, passes, budgets

**Companion to** [`ARCHITECTURE.md`](ARCHITECTURE.md). Decisions in
[`agent/DECISIONS.md`](../agent/DECISIONS.md).

> The renderer represents the world. It is never the source of truth for it.
> `render` may not import `sim`. The GPU may never produce authoritative state.

---

## 1. Graphics API (DEC-003, DEC-004)

**WebGPU only.** No WebGL2 backend will be written. A thin `GpuDevice` seam isolates
WebGPU calls so a fallback *could* be added; building one is out of scope.

**No 3D framework.** No three.js, no Babylon. The renderer is written directly
against WebGPU.

The reasoning in both cases is the same and it is not aesthetic: the three hardest
requirements here — camera-relative `f64 → f32` positioning, a GPU-driven planetary
LOD quadtree with indirect draws, and one depth buffer spanning orbit to centimetres
— all live in exactly the layers a framework owns. We would spend more time
bypassing a framework than writing the ~12 shaders we actually need. Compute shaders
(absent in WebGL2) are load-bearing for terrain detail, ocean and atmosphere.

The cost is accepted and named: we own camera, culling, materials, passes and asset
loading, and there is no fallback for a broken driver (**R-01**). The renderer is
kept deliberately **narrow** to contain that cost — it only ever needs planet
surface, ocean, atmosphere, clouds, instanced props, line/overlay geometry and UI
compositing.

All WebGPU calls live in `packages/render/src/gpu/`. Direct `navigator.gpu` use
elsewhere is a lint error.

---

## 2. Precision (DEC-005)

### 2.1 The numbers

| Quantity | Value |
| --- | --- |
| Planet radius R | 6.371 × 10⁶ m |
| `f32` ulp at R | **0.5 m** ← unusable for a surface camera |
| `f64` ulp at R | **~1 nm** ← free, JS numbers are already `f64` |
| `f32` ulp at 100 km | 7.8 mm |
| `f32` ulp at 1 km | 61 µm |
| `f32` ulp at 10 m | 0.95 µm |

A planet-centred position in `f32` quantises the surface to half-metre steps:
vertices jitter, normals flicker, a walking camera stutters. This is the single
constraint that shapes the entire renderer.

### 2.2 The four rules

1. **All world data is `f64`.** `Float64Array` for position-like fields. Never `f32`
   upstream of the renderer.
2. **All GPU vertex data is `f32` and camera-relative.** Per patch:
   `delta = originPCF_f64 − cameraPCF_f64`, computed in `f64` on the CPU; only
   `delta` and patch-local offsets reach the GPU. With patch origins within 100 km
   of the camera, one ulp is 7.8 mm.
3. **Reversed-Z, `depth32float`, infinite far plane.** Near maps to 1.0, far to 0.0;
   depth test `GreaterEqual`; clear to 0.0. This distributes float depth precision
   where reversed-Z wants it and removes any need to split the frustum into multiple
   depth ranges. Projection uses the infinite-far form (no `far` term), so there is
   no far-plane clipping at any altitude.
4. **Emulated GPU double precision (two-`f32`) is a targeted tool, not a policy.**
   Permitted only in a shader that provably needs it, with a comment saying why.
   Currently anticipated: none.

### 2.3 The single conversion point

There is exactly **one** place where an `f64` world position becomes an `f32` render
position: `packages/render/src/camera/`. Any other `f64 → f32` position conversion
is a bug, and the branded `Render` coordinate type makes it hard to write by accident.

The renderer must never cache an absolute `f32` world position across frames.

### 2.4 Why not the alternatives

| Rejected | Reason |
| --- | --- |
| `f32` with a scaled world (1 unit = 1 km) | Buys 3 decimal digits and loses them again the moment the camera is 1 m above ground. Moves the problem. |
| Split frustum / multiple depth ranges | Works, but triples terrain pass count and complicates everything that reads depth. |
| Logarithmic depth | Solves range, but needs per-fragment depth writes, killing early-Z. Reversed-Z is strictly better with float depth. |
| Global floating origin (shift the world) | Meaningless for a planet with a physical centre; invalidates every cached PCF coordinate and introduces a discontinuity per shift. See DEC-009. |

---

## 3. Coordinates and the planet surface (DEC-006, DEC-007)

### 3.1 Frames

See [`ARCHITECTURE.md` §4.1](ARCHITECTURE.md#41-coordinate-frames-dec-006). The
renderer's concern is the tail of the chain, which runs once per frame in `f64`:

```
CameraState (geodetic, f64)
  → PCF (f64)
  → per-patch: originPCF − cameraPCF   (f64 subtraction)
  → Render (f32, camera-relative, +Y up)
```

The `Z-up (PCF) → Y-up (Render)` basis change happens once, here. It is not a
configurable option.

### 3.2 Cube-sphere with tangent warping

Face coordinate `s ∈ [-1, 1]` is warped by `tan(s·π/4) / tan(π/4)` before
normalisation to the sphere. This reduces cell-area variation from 5.20× (naive) to
~1.3×, for the cost of a `tan`/`atan` per conversion.

| Level | Cell size | Cells (6·4^L) | `i16` field size |
| --- | --- | --- | --- |
| L8 | 39.1 km | 393 k | 0.8 MB |
| L10 | 9.8 km | 6.29 M | 12.6 MB |
| **L11** | **4.9 km** | **25.2 M** | **50.3 MB** ← global authoritative |
| L12 | 2.4 km | 100.7 M | 201 MB |
| L14 | 611 m | 1.61 G | — |
| L16 | 153 m | 25.8 G | — |
| **L18** | **38 m** | — | ← regional authoritative floor |
| L20 | 9.5 m | — | decorative |
| L24 | 0.60 m | — | decorative |

Face-boundary seams (a face edge meets another face's edge with a rotation) need
explicit neighbour resolution. This is a known, bounded piece of work scheduled in
M1, and it is the classic source of cube-sphere bugs — expect to find them at
grazing angles near the 8 corner points, where three cells meet.

---

## 4. LOD (DEC-010)

### 4.1 The four elements

Each is present to cancel a specific defect of the others.

1. **Chunked LOD over the cube-sphere quadtree.** Split/merge driven by
   **screen-space error**: a node splits when its projected geometric error exceeds
   τ pixels. Initial τ = 2.0, tunable, budgeted.
2. **Fixed-topology patch mesh.** Every patch uses the *same* 65×65 vertex grid;
   only its heightmap tile and its origin differ. Geometry is therefore one shared
   vertex/index buffer and every patch is an instance → **indirect, GPU-driven
   draws**. This is what keeps CPU draw-call cost flat.
3. **CDLOD-style vertex morphing.** Vertices morph toward the parent level's surface
   as a node approaches its merge threshold, driven by a per-instance morph factor.
   This removes popping — the one real weakness of chunked LOD.
4. **Skirts** on every patch edge as a correctness backstop against T-junction
   cracks, including at cube-face seams. Skirt depth scales with patch size; a fixed
   depth is visible at low levels and insufficient at high ones.

Rejected: geometry clipmaps (awkward toroidal update and seams on a sphere), pure
CDLOD (poor fit for streaming and per-tile caching, no natural unit for worker jobs
or chunk seeds), ROAM (per-triangle CPU work), index-buffer stitching (2⁴ variants
per patch, interacts badly with morphing — skirts trade a little overdraw for
robustness and we take robustness).

### 4.2 Geometry arithmetic

65×65 = **4 225 vertices**, **8 192 triangles** per patch.

| Visible patches | Triangles |
| --- | --- |
| 500 | 4.1 M |
| **1 000** | **8.2 M** ← budget |
| 2 000 | 16.4 M ← above target |

So the patch budget is ~800–1 200 visible patches, not the ~2 000 a naive
screen-space-error target would produce. τ is tuned against this budget, not the
other way round.

A tile without a **measured geometric error** (computed when the tile is baked)
cannot participate in LOD selection — an unmeasured error means an unbounded
screen-space error.

### 4.3 Tiles and streaming

- Heightmap tiles live in a `texture_2d_array` atlas.
- **Authoritative** tiles (L11–L18) are produced by CPU workers, Tier A (DEC-019).
- **Decorative** detail (L19+) is produced by GPU compute, Tier C, and must be
  **displacement-only and mean-zero** over a regional cell so it cannot change
  anything the simulation believes about the terrain.
- Streaming requests are priority-ordered by screen-space error and cancellable;
  a tile the camera is looking at outranks one behind it.
- LRU eviction, OPFS-backed. Eviction is invisible because tiles are a pure function
  of `hash(seed, quadkey)` (DEC-017).

**The visual seam between L18 authoritative and L19+ decorative must be
undetectable. This is an Astra validation item at M2.**

---

## 5. Camera (DEC-025)

### 5.1 One state, no modes

```ts
interface CameraState {
  lat: number; lon: number;                  // radians, f64
  altitude: number;                          // metres above reference surface, f64
  yaw: number; pitch: number; roll: number;  // radians, f64
  fovY: number;                              // radians
}
```

"Orbital" is not a mode. It is a large `altitude`.

The usual implementation — an orbital camera and a surface camera with a switch —
produces a visible discontinuity at exactly the moment that is supposed to impress.
Making altitude the primary state variable satisfies the continuity requirement *by
construction* instead of by a special case.

### 5.2 Continuous blending

Let `s = log10(altitude)`. Every altitude-dependent scalar is a **smooth function of
`s`** with no branches:

| Quantity | Behaviour |
| --- | --- |
| Control mapping | a drag maps to rotation about the planet centre at high `s`, to look-around at low `s`, smoothly interpolated across `s ∈ [4, 5]` (10–100 km) |
| Movement speed | proportional to altitude, clamped |
| Damping | increases as altitude falls |
| Near plane | `clamp(altitude × 1e-4, 0.05, 1000)` m |
| Far plane | infinite (DEC-005) |
| LOD τ | may tighten near the surface |
| Atmospheric parameters | continuous in altitude |

**A `switch` on altitude is a bug.**

### 5.3 Controllers

Arcball, surface-walk, entity-follow and cinematic-spline are *controllers* that
write the same `CameraState`. They are swappable without the state being rebuilt.
The state is serialisable from M1, so cinematic keyframes can be authored at any
milestone without a camera rewrite — which is why M13 does not require a camera
redesign.

### 5.4 Acceptance (M1)

A scripted descent from **40 000 km to 1 m in 60 s** with:
- no frame exceeding 33 ms,
- no visible discontinuity in motion or control response,
- measured vertex position error < 1 cm at 1 m altitude,
- no z-fighting at any point in the sweep.

Astra-verified. This is the empirical validation of DEC-005 and DEC-025, both of
which are currently decided on reasoning rather than measurement.

---

## 6. Render passes

Target shape. Passes are added by the milestone that needs them.

| # | Pass | Notes | Milestone |
| --- | --- | --- | --- |
| 0 | Tile generation (compute) | decorative detail into the atlas; async, not per-frame | M2 |
| 1 | Depth prepass | optional; evaluate against measured overdraw | M2 |
| 2 | Terrain | indirect instanced patches, reversed-Z | M1/M2 |
| 3 | Ocean | screen-space or patch-based surface, depth-aware | M3 |
| 4 | Shadows | cascaded, camera-relative; cascade split is altitude-dependent | M3 |
| 5 | Atmosphere | precomputed scattering LUTs; ray-marched at grazing angles | M3 |
| 6 | Clouds | volumetric, temporally amortised | M3/M4 |
| 7 | Props / vegetation | GPU instancing, LOD, impostors at range | M6 |
| 8 | Cities / infrastructure | instanced + procedural meshes | M9 |
| 9 | Overlays / data layers | field colour ramps, vectors, legends, probes | **M1** |
| 10 | Post | tonemap, exposure, bloom; DOF and motion blur at M13 | M3 → M13 |
| 11 | UI | DOM overlay, composited | M1 |

**Pass 9 is at M1 on purpose** (DEC-026): a flat-map/globe overlay that renders any
registered field as a colour ramp with a legend and a probe readout is the primary
debugging tool for M3–M8. Building it at M12 would mean debugging five milestones
blind.

---

## 7. Performance budgets

Authoritative copy lives in **`packages/core/src/budgets.ts`**. A budget that exists
only in a document is not a budget (DEC-024). These are **preliminary** — set by
reasoning, to be corrected by measurement.

### 7.1 Reference hardware

A 2021-or-later laptop: Apple M1 / RTX 3050 / Intel Iris Xe class, Chromium,
**1440p**, 60 FPS target → **16.6 ms/frame**.

### 7.2 Main thread — 6.0 ms

| Zone | Budget |
| --- | --- |
| Input + camera update | 0.3 ms |
| Scheduler + sim result commit | 2.0 ms |
| LOD traversal + culling | 1.0 ms |
| Render command encoding | 2.0 ms |
| UI / HUD / overlays | 0.7 ms |
| **Total** | **6.0 ms** |

10.6 ms of headroom against the 16.6 ms frame is deliberate: GC pauses, browser
compositing and worker-message handling all eat into it.

### 7.3 GPU — 10.0 ms

| Pass | Budget |
| --- | --- |
| Terrain | 4.0 ms |
| Ocean | 1.5 ms |
| Atmosphere + clouds | 2.5 ms |
| Shadows | 1.0 ms |
| Post | 1.0 ms |
| **Total** | **10.0 ms** |

### 7.4 Workers

| Metric | Budget |
| --- | --- |
| Per job wall-clock | ≤ 250 ms (cancellation responsiveness) |
| Terrain tile bake | ≤ 8 ms per tile per worker |
| Tile throughput | ≥ 120 tiles/s aggregate on 4 workers |
| Climate step (geodesic n6) | ≤ 40 ms |
| Save (snapshot, 300 MB) | ≤ 5 s, non-blocking |

### 7.5 Memory

| Pool | Budget |
| --- | --- |
| CPU simulation state | ≤ 700 MB |
| Tile cache (CPU) | ≤ 300 MB |
| GPU buffers + textures | ≤ 1.2 GB |
| **Total tab** | **≤ 2.5 GB** |

The browser's practical ceiling is ~2–4 GB (**R-04**). 2.5 GB leaves margin for
fragmentation and the compositor.

### 7.6 Quality-of-experience

| Metric | Budget |
| --- | --- |
| Visible pop-in at 100 m/s surface flight | none exceeding 400 ms |
| Hitch during orbit→surface descent | no frame > 33 ms |
| Hitch on a time-scale tier change (regime transition) | ≤ 2 frames > 33 ms |
| Cold start to first rendered planet | ≤ 4 s |
| Telemetry overhead | ≤ 0.2 ms/frame in dev, ~0 in production |

### 7.7 Honest caveat

Every number above is an engineering estimate, not a measurement. The GPU split in
particular is guesswork until a real terrain pass exists — 4.0 ms for terrain at
8.2 M triangles plus atlas sampling is plausible on the reference hardware and could
be off by 2×. **This section is a primary target for Grok's audit**: the budgets
should be attacked with arithmetic before they are attacked with a profiler.

---

## 8. Observability (DEC-024)

- `Telemetry` ring buffer, fixed size, **no allocation in the hot path**.
- CPU zones, subsystem timings, worker latency and queue depth, GPU pass timings via
  WebGPU `timestamp-query`, memory counters, patch/tile counts.
- **Trace export in Chrome Trace Event JSON** — opens directly in Perfetto and
  `chrome://tracing`. Professional tooling for zero dependencies.
- Dev HUD: frame graph, budget bars (green/amber/red against `budgets.ts`), subsystem
  cadence view, LOD/patch counts, memory.
- `timestamp-query` is not universally available; the HUD degrades to CPU-only
  timings when absent, and says so rather than showing zeros.

---

## 9. Open rendering questions

Deliberately undecided (see [`ARCHITECTURE.md` §14](ARCHITECTURE.md#14-what-is-deliberately-not-decided-yet)):

- Whether a depth prepass pays for itself — measure overdraw at M2.
- Vegetation rendering strategy (instancing / impostors / procedural) — M6.
- City rendering strategy — M9.
- Cloud representation (volumetric vs. layered) — M3/M4.
- Whether τ = 2.0 px is the right starting screen-space error — measure at M2.
- Whether atmospheric scattering LUTs need recomputation as the climate changes,
  or can be parameterised — M4.
