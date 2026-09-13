# World Simulator

A professional, modular 3D planetary simulation engine: terrain, geology, oceans,
atmosphere, climate, hydrology, biosphere, evolution, civilisations, cities,
economy and infrastructure, evolving across time scales from seconds to millions
of years.

> **Status: M1–M13 integrated; Astra hardware/visual gate pending.** The engine
> now evolves terrain, geology, ocean, atmosphere, climate, hydrology, biosphere,
> civilisations, cities, economy and infrastructure across the T0–T4 ladder. It
> records history, replays command logs, and supports recipe/snapshot saves plus
> scientific field visualisation and a deterministic cinematic camera. `pnpm
> install && pnpm dev` renders the planet at http://localhost:8080. WebGPU is
> required; hardware-only frame/GPU acceptance remains explicitly unclaimed.

## Founding principle

**Simulation State != Rendering State.**
The renderer *represents* the world. It is never the *source of truth* for it.
The simulation must remain conceptually complete with the renderer switched off.

## Where to start

| Document | Purpose |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System layers, packages, data model, state ownership |
| [`docs/SIMULATION.md`](docs/SIMULATION.md) | Time, scheduling, determinism, concurrency, persistence |
| [`docs/RENDERING.md`](docs/RENDERING.md) | Precision, coordinates, LOD, camera, render passes, budgets |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Milestones, acceptance criteria, risks |
| [`docs/AUDIT-V0.md`](docs/AUDIT-V0.md) | Grok adversarial audit of Architecture v0 (T-0007) |
| [`agent/PROTOCOL.md`](agent/PROTOCOL.md) | **Mandatory** collaboration rules for all agents |
| [`agent/DECISIONS.md`](agent/DECISIONS.md) | Architecture Decision Records (34) |
| [`docs/M1-MEASUREMENTS.md`](docs/M1-MEASUREMENTS.md) | Grok's M1 number sheet (E1/E3/profile/descent) |

## Branch model

- `main` — stable states and approved milestones only.
- `dev` — integration branch.
- `agent/<name>/<topic>` — short-lived working branches.

See [`agent/PROTOCOL.md`](agent/PROTOCOL.md) before touching anything.

## Running it

```bash
pnpm install
pnpm dev      # http://localhost:8080  (COOP/COEP; SharedArrayBuffer on)
pnpm check    # typecheck + package boundaries + checker self-test
pnpm test     # vitest
pnpm run bench:descent   # 60 s CPU trace, seed 0x51a51a51
```

Controls: drag to orbit · wheel or `W`/`S` for altitude · `1`/`2`/`3` for
shaded / LOD-level / patch-boundary views · `[`/`]` to change patch size ·
`P` for an automatic pole sweep · `T` (or `?descent`) for the scripted
60 s orbit→surface descent · `G` to export a Chrome Trace · `` ` `` / `H`
to toggle the HUD.

Requires WebGPU. There is no WebGL2 fallback and none is planned
([DEC-003](agent/DECISIONS.md)); an unsupported browser gets a specific reason,
not a blank canvas.
