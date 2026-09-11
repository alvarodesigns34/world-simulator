# World Simulator

A professional, modular 3D planetary simulation engine: terrain, geology, oceans,
atmosphere, climate, hydrology, biosphere, evolution, civilisations, cities,
economy and infrastructure, evolving across time scales from seconds to millions
of years.

> **Status: M0 — Architecture & Infrastructure.** No simulator yet. This branch
> carries the architectural foundation only.

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
| [`agent/DECISIONS.md`](agent/DECISIONS.md) | Architecture Decision Records |

## Branch model

- `main` — stable states and approved milestones only.
- `dev` — integration branch.
- `agent/<name>/<topic>` — short-lived working branches.

See [`agent/PROTOCOL.md`](agent/PROTOCOL.md) before touching anything.
