# M1 measurements

Grok session 2026-09-11, branch `agent/grok/m1-astra-ready`.
This is the number sheet Astra (and anyone arguing about the 6.0 ms budget)
should read before looking at the running app.

## Host

| | |
| --- | --- |
| OS | Linux 6.12.8+ x64 |
| CPU | 2 × Intel Xeon Platinum 8481C @ 2.70 GHz |
| Node | v22.23.2 |
| GPU | **none** — no adapter, no timestamp-query, no rasterisation numbers |
| Viewport used here | 2560×1440 unless stated |
| Patch size | 33×33 (see E1) |
| GPU tier | `discrete` (the arithmetic tier; this host has no GPU) |
| Browser | not this environment. Node `worker_threads` for transfer; Vitest for CPU |

Raw benches: `tools/bench/{patch-size,transfer,m1-profile,descent-trace}.out.md`.

Reproduce:

```
pnpm run bench:patch
pnpm run bench:transfer
pnpm run bench:profile
pnpm run bench:descent
```

---

## 1. CPU profile — LOD selector with NodePool

`tools/bench/m1-profile.out.md`. Pool warmed. RSS 100 MB, heap 20 MB, pool 2966.

| situation | altitude | select ms | patches | visited | H-cull | F-cull | tris | vs 1.0 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| high orbit | 4.0e+7 m | 0.366 | 195 | 318 | 45 | 0 | 399k | ok |
| low orbit | 4.0e+5 m | 0.220 | 56 | 294 | 47 | 119 | 115k | ok |
| approach | 8.0e+4 m | 0.196 | 33 | 242 | 48 | 102 | 68k | ok |
| near surface | 2.0e+3 m | 0.107 | 17 | 230 | 24 | 133 | 35k | ok |
| surface | 5.0e+0 m | 0.112 | 7 | 230 | 24 | 143 | 14k | ok |
| north pole | 2.0e+5 m | 0.049 | 44 | 234 | 37 | 96 | 90k | ok |
| south pole | 2.0e+5 m | 0.045 | 44 | 234 | 37 | 96 | 90k | ok |
| fast motion | 3.0e+5 m | 0.295 | 66 | 282 | 45 | 102 | 135k | ok |

**Before the pool** the same high-orbit call was ~3–6 ms (one `makeNode` per
visit, four `tan`s each). Pool is a 3–8× cut on this host. Semantics unchanged:
`makeNode` is pure, a cached node is bit-identical.

GPU frame time: not available. Astra fills that column from the HUD
(`gpu` line; `-1` means the adapter lacks `timestamp-query`).

---

## 2. E1 — patch size (CPU + arithmetic). GPU still Astra.

`tools/bench/patch-size.out.md`. **Keep 33×33.**

At 1440p discrete:

| size | budget | px/tri | select ms | note |
| --- | ---: | ---: | ---: | --- |
| 17×17 | 2048 (capped) | **3.52** | 0.480 | Hits `maxVisiblePatches` before the pixel-area floor. τ=2.0 is not met. |
| 33×33 | 900 | **2.00** | **0.429** | Hits the floor. Fastest of the three. |
| 65×65 | 225 | 2.00 | 0.482 | Same tris as 33, slower CPU. 1080p discrete budget is only 126 patches. |

`QUALITY.patchVerticesPerSide` stays 33. Flip it only if Astra's GPU timestamps
show 17 winning on fill-rate or 65 winning on draw-call overhead by a margin
that beats the 1080p density loss.

---

## 3. E3 — SAB vs transfer vs structuredClone (tile sizes)

`tools/bench/transfer.out.md`. Node `worker_threads`, median of 12 after 2 warm.

| size | clone RT ms | transfer RT ms | SAB read RT ms |
| --- | ---: | ---: | ---: |
| 8 KB | 0.073 | 0.053 | 0.052 |
| 64 KB | 0.151 | 0.050 | 0.058 |
| 256 KB | 0.394 | 0.070 | 0.090 |
| 1 MB | 1.014 | 0.075 | 0.158 |
| 4 MB | 2.024 | 0.099 | 0.156 |
| 50 MB | 133.435 | 1.014 | 1.802 |

AUDIT-V0 browser number still stands for the 50 MB *browser* path:
`structuredClone` 98 ms, transfer RT 34 ms. Node ≠ browser. Do not mix them.

### Rules (where SAB is REQUIRED / PREFERRED / UNNECESSARY)

| Payload | Mechanism | Verdict | Why |
| --- | --- | --- | --- |
| Persistent L11 fields (≈50 MB, in-place) | SAB + generation-publish | **REQUIRED** | Clone is ~5–8× a frame. Transfer detaches the field. |
| Regional tiles 256 KB–1 MB | Transferable ArrayBuffer | **PREFERRED** | One-shot ownership. Tile is immutable after bake. |
| Dirty-block uploads 8–64 KB | Transferable, or `writeBuffer` from SAB | **UNNECESSARY to invent SAB** | Both < 0.3 ms. Use whatever the buffer already is. |
| Control messages / job headers (< 4 KB) | structuredClone | **UNNECESSARY** | SAB adds COOP/COEP ceremony for noise. |
| Double-buffered field, concurrent readers | SAB + phase separation + seqlock | **REQUIRED** | `consistentRead` detects a torn generation. Holding `raw()` across `commit()` aliases the back buffer — tested, forbidden. |

SAB is not a dogma. It is the only mechanism that lets two threads read a 50 MB
field without copying it and without detaching it.

T-0013 remainder: the same table in a **browser**, COOP/COEP on and off, and
1/4/8 workers producing identical results. Not this host.

---

## 4. Deterministic descent — seed `0x51a51a51`

`tools/bench/descent-trace.out.md` + `.json`. 60 s, 601 samples @ 10 Hz.
Keyframes in `packages/render/src/lod/descent.ts`. Live: `?descent` or **T**.

| t s | altitude | patches | select ms | appear | disappear | maxL |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 4.00e+7 m | 194 | 5.223 (cold pool) | 194 | 0 | 3 |
| 12 | 8.00e+6 m | 484 | 0.275 | 0 | 0 | 4 |
| 24 | 1.50e+6 m | 198 | 0.501 | 0 | 0 | 5 |
| 32 | 6.00e+5 m | 88 | 0.093 | 0 | 0 | 6 |
| 40 | 8.00e+4 m | 41 | 0.080 | 0 | 0 | 8 |
| 50 | 6.00e+3 m | 19 | 0.051 | 0 | 0 | 11 |
| 60 | 2.00e+0 m | 7 | 0.053 | 0 | 0 | 12 |

- budget-exhausted: **0/601**
- p50 0.155 ms, p95 0.821 ms
- max disappear/frame: **57** (hysteresis only, no morph)
- max appear after t=0: **48**
- 16/601 samples > 1.0 ms. They do not track work (t=42.1: 230 visited, 0 misses, 4.2 ms vs 0.08 ms typical). Shared-runner GC. The live renderer keeps the pool.

---

## 5. Popping (characterised, not "fixed")

Hysteresis factor 1.5 (DEC-034 rule 5). No CDLOD morph (T-0015, needs parent
surface from M2 tiles).

- A node sitting on τ does not oscillate: hysteresis test vs a no-`previouslySplit` control.
- Worst disappear: 57 patches in one 100 ms sample. Worst appear after init: 48.
- t=0 appear=194 is the initial set.
- Morphing is a visual judgement. Astra decides if this is tolerable until M2.

Skirts / stitching were not added. They would hide cracks, not pops, and
T-0020 (cube-face topology) is still open.

---

## 6. FieldStore

- `commit()` is `Atomics.store` of the generation index. Readers `Atomics.load` once and pick the front buffer from that snapshot. Two separate loads can mix generations — that pairing is the actual race, now closed on the `get`/`raw`/`rawMut` paths.
- `consistentRead(fn)` is a seqlock: load, read, load. `torn` means retry.
- Holding `raw()` across `commit()` aliases the back buffer. Tested in `fieldstore.concurrency.test.ts`. Forbidden. Documented on the type.
- Phase-separated `worker_threads` see only committed generations (handshake so the reader is live before the first publish).
- Dirty blocks of 4096 cells: an L11 field is a 768-byte bitmap. Fine enough that a renderer re-uploads kilobytes. Not re-tuned; no evidence it is wrong at M1 scale (the M1 field is a 6-cell rotation angle).

---

## 7. Scheduler

Union graph, wave-Kahn, O(V+E) per phase plus one sort per wave.

- A,C independent, B depends on A → **A, C, B** (not A,B,C). Pinned by test. Do not "fix".
- 100 subsystems, mixed phases, random registration order, < 50 ms to build, identical order every time.
- Cycles, write conflicts, unknown fields, undeclared owners, `readsPrev` on a single-buffered field: all still startup errors.
- Opus's drain-one-subsystem-to-target bug cannot reappear: `advance` still walks the schedule, not the ready-set-per-subsystem.

---

## 8. WebGPU audit (code, no device here)

| Topic | Finding |
| --- | --- |
| Pipelines | Created once in the constructor. Recreated only when the user changes patch size (`[`/`]`), which destroys the renderer. |
| Bind groups | Recreated only when the instance buffer grows (geometric). Steady state: none. |
| Buffers | Grid, index, uniforms: once. Instance buffer grows, never shrinks per frame. |
| Uniform upload | 96 bytes/frame (`Float32Array(24)`). |
| Depth | Cached view; rebuilt on resize only. Previous texture destroyed. |
| Timestamp-query | Requested if the adapter has the feature. HUD shows `n/a` otherwise. Resolve is skipped while a previous `mapAsync` is pending — one-frame gaps, no stall. |
| Device lost | `device.lost` + `uncapturederror` surfaced on the HUD. No auto-recreate (would hide a driver bug from Astra). |
| CPU/GPU sync | No `mapAsync` on the hot path except the timestamp buffer, and that is deferred. |
| Leaks | `destroy()` releases instance, depth, uniforms, grid, index, query set. Pipeline/bind group have no `destroy` in the API. |

DEC-003: no WebGL fallback. Unsupported browsers get `fail()` with a reason.

---

## 9. Telemetry

Fixed ring, `Float64Array`, no allocation in `begin`/`end`/`record`.
Timestamps supplied by the caller (`core` never touches `performance`).
Export is Chrome Trace Event JSON (`G`, or auto-download at the end of a `T`
descent). Opens in Perfetto.

HUD (`\` or `H`): FPS, frame/cpu/gpu ms, telemetry µs, spikes, altitude, speed,
patches, tris, px/tri, patch size, budget reason, LOD histogram, visited,
pool hit/miss, horizon/frustum culls, SAB yes/no, device-lost, last GPU error.

---

## 10. Determinism extras

- `hashFloat01x64` ÷ 2⁵³ is exact on this V8: 10 000 samples round-trip as integers.
- `hashU64` still matches the BigInt oracle (20 000 cases) — untouched.
- Boundary checker: remaining `Map`/`Set` scans in `graph.ts` carry
  `// deterministic-order:` and re-sort before emission.

---

## 11. `maxJobSimYears: 5000`

Not changed (PROTOCOL §5.1 — budgets are ADR-level). At T4 (1 Myr/s) a 250 ms
job is ≈ 250 000 sim-years; 5000 years is 5 ms of wall at that rate, so the
year cap is tighter than `maxJobMs` at T4 and looser at T1. Derivation deferred
to M4 when workers actually exist. Filed as T-0053.
