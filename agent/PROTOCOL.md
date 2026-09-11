# PROTOCOL — Mandatory collaboration rules

**This file is binding for every agent working on World Simulator.**
Read it in full before your first change, and re-read the *Checklists* section at
the start of every session.

---

## 0. The one rule that outranks the others

> **Simulation State != Rendering State.**
>
> The renderer *represents* the world. It is never the *source of truth* for it.
> The simulation must remain conceptually complete with the renderer switched off.

Any change that erodes this is rejected regardless of how well it performs.
It is enforced mechanically by `pnpm run check:boundaries` (DEC-011) — do not
weaken that check to make a change pass.

---

## 1. The team

| Agent | Role | Owns | Does not do |
| --- | --- | --- | --- |
| **Opus 5** | Principal Architect · Simulation Lead | Architecture, module design, data models, world state, time & scheduling, concurrency, workers, persistence, determinism, testing, internal APIs, integration, maintainability. Writes most structural code. | Not the final word on visual quality (that is Astra) and not exempt from Grok's audit. |
| **Grok 4.6** | Systems Engineer · Adversarial Engineer | Auditing architecture, challenging assumptions, independent subsystems, algorithm research, optimisation, benchmarks, stress testing, finding performance / memory / precision / concurrency defects. | Must **not** merely agree. A review that finds nothing must say what was checked and why it holds. |
| **GPT Astra** | Integration & Reality Engine · Visual Validation Gatekeeper | Complex integration, inspecting the **running** application, localised visual/technical defects, cross-agent debugging, orbit→surface validation, graphics quality, rendering↔simulation interaction, **approving or rejecting milestones**. | **A limited resource.** Not for long tasks, not for bulk code generation, not for anything Opus or Grok can do. Little code, high impact. |

### 1.1 Using Astra

Astra's time is the scarcest resource in this project. Treat every request as a
budgeted call.

- **Budget: at most 3 Astra requests per milestone**, plus 1 milestone gate review.
- A request must fit the template in `agent/ASTRA.md` and must include: what to
  look at, exact reproduction steps, what "correct" means, what has already been
  ruled out, and the specific question. A request that says "have a look at the
  terrain" is malformed and should be rejected by Astra.
- Never ask Astra to write a subsystem, write tests, or produce large files.
- **Milestone gates**: a milestone is not complete until Astra records an
  `APPROVED` verdict in `agent/ASTRA.md`. Astra may return `REJECTED` with reasons,
  or `APPROVED WITH FINDINGS` plus items added to `agent/TASKS.md`.

---

## 2. Branch model

```
main                      stable states and approved milestones only
 └── dev                  integration branch — the default target for all work
      ├── agent/opus/<topic>
      ├── agent/grok/<topic>
      └── agent/astra/<topic>
```

- **Never do significant work directly on `main`.** Merges to `main` happen only at
  an approved milestone.
- `dev` is the integration branch and the base for every working branch.
- Working branches are short-lived and single-purpose. One branch per task ID.
- If `dev` does not exist, create it from the default branch.

> **Session note.** A managed session may mandate a different working-branch name
> (this repository was bootstrapped from `claude/dazzling-archimedes-m7ewoy`).
> When that happens, the mandated branch is the working branch and it is still
> merged into `dev` via pull request; the `agent/<name>/<topic>` convention applies
> to all ordinary work.

### 2.1 Merging

- Working branch → `dev` via **pull request**, never a direct push to `dev`.
- `dev` → `main` only at an approved milestone, with an Astra `APPROVED` verdict
  recorded.
- Rebase your working branch on `dev` before opening the PR. Do not rewrite history
  on a branch another agent has already based work on.
- CI must be green. A red CI is never merged, and never made green by weakening a
  check.

---

## 3. Commits

**Format:**

```
[AGENT] type: short imperative summary

Body: what changed and, more importantly, why. Reference decisions and
tasks by ID. State known problems explicitly.

Refs: DEC-014, T-0031
```

- `AGENT` ∈ `OPUS` | `GROK` | `ASTRA`. Uppercase, in square brackets, first.
- `type` ∈ `feat` | `fix` | `perf` | `refactor` | `test` | `docs` | `chore` | `bench` | `audit`.
- Summary ≤ 72 characters, imperative mood ("add", not "added").
- **A commit that changes behaviour covered by a golden test must say so in the
  body and say why the new behaviour is correct.**

Examples:

```
[OPUS] feat: add cube-sphere quadkey addressing and coordinate conversions
[GROK] bench: measure SAB vs transfer throughput for 50 MB elevation fields
[GROK] audit: challenge the 6 ms main-thread budget in DEC-024
[ASTRA] fix: correct horizon seam at cube-face boundary under grazing angles
```

---

## 4. Checklists

### 4.1 Before touching any code — every session, no exceptions

1. **Sync**: `git fetch origin && git rebase origin/dev` (or branch from `dev`).
2. Read **`agent/PROTOCOL.md`** (this file).
3. Read **`agent/TASKS.md`** — find your task, confirm it is assigned to you and
   still `Open`/`In progress`.
4. Read **`agent/DECISIONS.md`** — at minimum the Index, plus in full every record
   your task touches.
5. Read **`agent/HANDOFF.md`** — check whether anything is addressed to you.
6. Read the **latest entries** of the other agents' logs
   (`agent/OPUS.md`, `agent/GROK.md`, `agent/ASTRA.md`).
7. Review recent relevant commits: `git log --oneline -30` and
   `git log -p --since='7 days ago' -- <paths you will touch>`.
8. **Only now** modify code.

### 4.2 Before you finish — every session, no exceptions

1. **Run the relevant tests**: `pnpm test` at minimum; `pnpm run check` (typecheck +
   lint + boundaries) before any push. Run `pnpm run test:determinism` if you
   touched `core`, `data` or `sim`.
2. **Document what you did** — in the commit body, and in code comments where the
   *why* is not obvious from the *what*.
3. **State known problems explicitly.** An undocumented known issue is worse than a
   bug, because the next agent will spend hours rediscovering it. Put it in your
   log and, if actionable, in `agent/TASKS.md`.
4. **Update your log** (`agent/OPUS.md` / `GROK.md` / `ASTRA.md`) — newest entry at
   the top, using the file's template.
5. **Update `agent/TASKS.md`** — close what you closed, open what you discovered,
   correct anything now known to be wrong.
6. **Write a handoff** in `agent/HANDOFF.md` if another agent needs to pick this up.
   A handoff must state: what is done, what is not, where the seams are, what you
   are unsure about, and what you specifically want checked.
7. **Commit** with the format in §3.
8. **Push** (`git push -u origin <branch>`) and open/refresh the PR to `dev`.

---

## 5. Architectural authority

### 5.1 What requires a decision record

Anything in this list requires an ADR in `agent/DECISIONS.md` **before**
implementation, not after:

- Adding, removing or re-scoping a package.
- Changing a package dependency rule (DEC-011).
- Adding a runtime dependency to `render`, `workers` or `app`
  (and `core`/`data`/`sim` may have none at all — DEC-027).
- Changing a coordinate system, a grid, or a unit convention (DEC-006, DEC-007, DEC-008).
- Changing the precision strategy, the time representation, or the determinism
  rules (DEC-005, DEC-014, DEC-017, DEC-018).
- Changing the scheduler contract or the field ownership model (DEC-013, DEC-016).
- Changing the save format or breaking save compatibility (DEC-022).
- Introducing WASM (DEC-021 defines the gate).
- Changing a performance budget in `packages/core/src/budgets.ts`.

### 5.2 How to challenge a decision

This is the intended path, and it is meant to be used — especially by Grok.

1. Open a **new** record with `Status: Proposed` and `Supersedes: DEC-NNN`.
2. Bring **evidence**: a benchmark, a failing test, a counter-example, a worked
   numerical argument. An `Accepted` record is not overturned by preference.
3. Note it in `agent/TASKS.md` and in your log.
4. The record is discussed and then either moved to `Accepted` (and the old one to
   `Superseded by …`) or `Rejected` **with the reasoning kept in the file** — a
   rejected proposal is valuable history, not noise.

**Silent divergence is the failure mode this protocol exists to prevent.** Code that
contradicts an `Accepted` record is a bug, even if it is better code. Fix it by
writing the record.

### 5.3 Conflict resolution

- **Architecture and technical correctness** → Opus decides, having genuinely
  engaged with Grok's objection in writing.
- **Visual quality and "does it actually work when running"** → Astra decides, and
  Astra's `REJECTED` is not overridable by argument, only by a fix.
- **Performance claims** → whoever has the benchmark wins. Assertions lose to
  measurements, always, including Opus's.
- Unresolved after one round → record both positions in `DECISIONS.md` as a
  `Proposed` record and escalate to the human.

---

## 6. Code rules

These are the rules that CI checks or that break the project silently if ignored.

1. **Package boundaries** (DEC-011). `sim ⇏ render`. `render ⇏ sim`.
   `core`/`data`/`sim` are DOM-free.
2. **Determinism** (DEC-017). In `core`/`data`/`sim`: no `Math.random` (dotted or
   quoted), `Date.now`, `performance.now`, `new Date()`, `crypto.getRandomValues`
   or `crypto.randomUUID`; no `sort()` without an explicit total-order comparator;
   no insertion-order iteration over a `Map`/`Set` that reaches a result. Reduce in
   key order, never completion order.

   **What is mechanical and what is not.** `pnpm run check:boundaries` enforces all
   of the above, and its self-test plants each one to prove it. Its one honest
   limit: the `Map`/`Set` rule sees a single file and no types, so it catches
   collections constructed in that file and cannot see one received as a parameter
   or imported. That residue is a **review item**. Suppress a deliberate case with
   `// deterministic-order: <why>` on the line above — and say why.

3. **Tier A** (DEC-018). A file marked `@tier A` may not use native `Math`
   transcendentals or `**`; it uses `stableMath`. Enforced by the checker on
   files that carry the marker.
4. **Single-writer fields** (DEC-013). Write only what your subsystem owns. Declare
   `reads` and `writes` accurately — the scheduler trusts them.
5. **Time** (DEC-014). All time arithmetic goes through `packages/core/src/time/`.
   No raw arithmetic on `.year`/`.seconds` elsewhere.
6. **Precision** (DEC-005). World data is `f64`. The `f64 → f32` conversion happens
   in exactly one place, in the camera. No absolute `f32` world positions, ever.
7. **No new state without an owner.** A new field or component column must be
   registered with its owning subsystem, dtype, units, valid range and determinism
   tier in the same commit that introduces it.
8. **No duplicated state.** If you need a transformed view of someone else's field,
   compute it on read or own a declared derived field. Never keep a private copy.
9. **Budgets are code** (DEC-024). `packages/core/src/budgets.ts` is the source of
   truth. Changing a budget is an ADR-level act.
10. **Mutation flows through commands** (DEC-022). The UI does not write simulation
    state directly; it issues commands, which are logged.

---

## 7. Definition of done

A task is done when **all** of the following hold:

- [ ] It does what `agent/TASKS.md` says it should, including the acceptance criteria.
- [ ] `pnpm run check` passes (typecheck, lint, boundaries).
- [ ] `pnpm test` passes, including determinism tests if `core`/`data`/`sim` changed.
- [ ] New behaviour has tests at the appropriate layer (DEC-023).
- [ ] Performance-relevant changes have a benchmark number, not an opinion.
- [ ] Public types and non-obvious *why*s are documented.
- [ ] Known problems are written down.
- [ ] The agent's log is updated.
- [ ] `agent/TASKS.md` is updated.
- [ ] A handoff exists if someone else continues the work.
- [ ] Committed with the `[AGENT] type: summary` format and pushed.

A **milestone** additionally requires:

- [ ] Every acceptance criterion in `docs/ROADMAP.md` measured and recorded, with numbers.
- [ ] Performance budgets met on the reference hardware, with a telemetry trace attached.
- [ ] An Astra `APPROVED` verdict in `agent/ASTRA.md`.
- [ ] `dev` merged to `main` and tagged `M<N>`.

---

## 8. Anti-patterns — rejected on sight

Named in the brief and repeated here because they are the specific ways this
project would fail:

- **Architecture for aesthetics.** Every component justifies itself by a concrete
  need. "It is cleaner" is not a need.
- **Fashionable technology.** No dependency, no WASM, no new abstraction without a
  measured or clearly argued reason (DEC-021, DEC-027).
- **Gratuitous overengineering.** Do not build the general case before the second
  case exists.
- **Monolithic components.** If a file exceeds ~600 lines, justify it.
- **Duplicated state.** One owner, one copy (DEC-013).
- **Renderer/simulation coupling.** See §0.
- **Implicit magic.** No global singletons discovered at runtime, no module-level
  mutable state, no "it works because of initialisation order".
- **Irreversible decisions with no record.** If reversing it would take more than a
  day, it needs an ADR.
