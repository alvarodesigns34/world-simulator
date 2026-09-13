/**
 * Dependency graph construction (DEC-031).
 *
 * The execution order is a PURE FUNCTION OF THE REGISTRY. Registration order,
 * module load order, worker count, wall-clock and regime selection cannot affect
 * it. That is the whole point, and it is directly testable.
 *
 * Order is decided in three steps:
 *   1. phase        — fixed enum order
 *   2. topological  — within a phase, over the union read/write graph
 *   3. lexical      — ties broken by SubsystemId
 *
 * Startup ERRORS, never warnings:
 *   - a cycle in the union graph
 *   - a write conflict (two subsystems writing one field — violates DEC-013)
 *   - an undeclared owner (writing a field owned by someone else)
 *   - an unknown field
 *   - readsPrev on a field that is not double-buffered
 *   - an earlier phase reading the CURRENT generation of a later-phase writer
 *     (that is last tick's data, silently; declare readsPrev)
 *   - everyNOf with n < 1, unknown `of`, `of` onDemand, or follower ordered
 *     before its leader
 *
 * WAVE SEMANTICS. Ready nodes are emitted as a whole wave, sorted lexically,
 * then new nodes are discovered. That is NOT classic one-at-a-time Kahn:
 * if A and C are independent and B depends on A, with A < B < C lexically,
 * the order is A, C, B — not A, B, C. A test pins this. Do not "fix" it.
 */

import type { FieldId, FieldStore, SubsystemId } from '@ws/data';
import { PHASES, phaseIndex, type Phase, type Subsystem } from './types.js';

export interface ScheduleEntry {
  readonly subsystem: Subsystem;
  readonly order: number;
}

export class SchedulerGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerGraphError';
  }
}

function fail(message: string): never {
  throw new SchedulerGraphError(message);
}

/**
 * Explicit total order over strings. `Array.prototype.sort()` with no comparator
 * is banned in sim code (DEC-017) because its default is implementation-defined
 * for non-strings and locale-sensitive in some engines; this is the one ordering
 * every tie-break in this file uses.
 */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the deterministic execution order.
 *
 * `store` is optional so the graph can be unit-tested without allocating
 * fields; when present, ownership and field existence are validated against it.
 */
export function buildSchedule(
  subsystems: readonly Subsystem[],
  store?: FieldStore,
): readonly ScheduleEntry[] {
  // --- duplicate ids -------------------------------------------------------
  const seen = new Set<string>();
  for (const s of subsystems) {
    if (seen.has(s.id)) fail(`duplicate subsystem id '${String(s.id)}'`);
    seen.add(s.id);
  }

  const byId = new Map<string, Subsystem>();
  for (const s of subsystems) byId.set(s.id as string, s);

  // --- cadence (DEC-016 rule 1, everyNOf = every N steps of X) -------------
  for (const s of subsystems) {
    const c = s.cadence;
    if (c.kind === 'every') {
      if (!(c.dt > 0)) {
        fail(`subsystem '${String(s.id)}' has non-positive cadence dt ${String(c.dt)}`);
      }
    } else if (c.kind === 'everyNOf') {
      if (!Number.isInteger(c.n) || c.n < 1) {
        fail(`subsystem '${String(s.id)}' everyNOf.n must be an integer >= 1, got ${String(c.n)}`);
      }
      const other = byId.get(c.of as string);
      if (other === undefined) {
        fail(`subsystem '${String(s.id)}' follows unknown '${String(c.of)}'`);
      }
      if (other.cadence.kind === 'onDemand') {
        fail(`subsystem '${String(s.id)}' cannot follow onDemand '${String(c.of)}'`);
      }
    }
  }

  // --- unknown fields + ownership (DEC-013) --------------------------------
  if (store !== undefined) {
    const known = new Set<string>(store.fieldIds());
    for (const s of subsystems) {
      for (const f of [...s.reads, ...s.writes, ...(s.readsPrev ?? [])]) {
        if (!known.has(f)) {
          fail(`subsystem '${String(s.id)}' references unknown field '${String(f)}'`);
        }
      }
      for (const f of s.writes) {
        const owner = store.descriptor(f).owner;
        if (owner !== s.id) {
          fail(
            `subsystem '${String(s.id)}' declares a write to '${String(f)}', ` +
              `which is owned by '${String(owner)}' (DEC-013 single-writer)`,
          );
        }
      }
      for (const f of s.readsPrev ?? []) {
        if (!store.descriptor(f).doubleBuffered) {
          fail(
            `subsystem '${String(s.id)}' uses readsPrev on '${String(f)}', ` +
              `which is not double-buffered — there is no previous generation to read (DEC-020)`,
          );
        }
      }
    }
  }

  // --- write conflicts (DEC-013), independent of the store -----------------
  const writers = new Map<string, SubsystemId[]>();
  const writerOf = new Map<string, Subsystem>();
  for (const s of subsystems) {
    for (const f of s.writes) {
      const list = writers.get(f) ?? [];
      list.push(s.id);
      writers.set(f, list);
      writerOf.set(f as string, s);
    }
  }
  // deterministic-order: materialised then sorted by field id immediately below,
  // so the reported conflict is the same one on every run and on every machine.
  const conflicts = [...writers.entries()]
    .filter(([, ws]) => ws.length > 1)
    .sort((a, b) => cmpStr(a[0], b[0]));
  if (conflicts.length > 0) {
    const [field, ws] = conflicts[0] as [string, SubsystemId[]];
    const names = [...ws].map(String).sort(cmpStr).join(', ');
    fail(`write conflict on field '${field}': ${names} all declare writes to it (DEC-013)`);
  }

  // --- cross-phase current-gen reads (DEC-031) -----------------------------
  // Per-phase Kahn cannot see an edge that crosses PHASES. An earlier phase
  // reading the current generation of a later-phase writer silently gets last
  // tick's data. That coupling must be declared as readsPrev.
  for (const s of subsystems) {
    for (const f of s.reads) {
      const w = writerOf.get(f as string);
      if (w === undefined || w.id === s.id) continue;
      if (phaseIndex(s.phase) < phaseIndex(w.phase)) {
        fail(
          `subsystem '${String(s.id)}' (phase '${s.phase}') reads current generation of ` +
            `'${String(f)}' written in later phase '${w.phase}' by '${String(w.id)}' — ` +
            `that is last tick's data. Declare readsPrev (DEC-031)`,
        );
      }
    }
  }

  // --- per-phase topological sort with lexical tie-break -------------------
  const out: ScheduleEntry[] = [];
  let order = 0;

  for (const phase of PHASES) {
    const inPhase = subsystems
      .filter((s) => s.phase === phase)
      .sort((a, b) => cmpStr(a.id as string, b.id as string));
    if (inPhase.length === 0) continue;

    for (const s of sortPhase(inPhase, phase)) {
      out.push({ subsystem: s, order: order++ });
    }
  }

  // --- everyNOf follower must run AFTER its leader in the resolved order ---
  const pos = new Map<string, number>();
  for (const e of out) pos.set(e.subsystem.id as string, e.order);
  for (const e of out) {
    const c = e.subsystem.cadence;
    if (c.kind !== 'everyNOf') continue;
    const leaderPos = pos.get(c.of as string);
    if (leaderPos === undefined || e.order <= leaderPos) {
      fail(
        `everyNOf follower '${String(e.subsystem.id)}' must run after '${String(c.of)}' ` +
          `in the resolved order (DEC-016)`,
      );
    }
  }

  return out;
}

/**
 * Wave-Kahn with a lexically-ordered ready set, O(V+E) per phase plus one
 * sort per wave.
 *
 * The ready set is emitted as a whole wave (not one node at a time). That is
 * what makes "A and C independent, B depends on A" produce A,C,B rather than
 * A,B,C, and it is a contract, not an accident.
 */
function sortPhase(subsystems: readonly Subsystem[], phase: Phase): readonly Subsystem[] {
  const byId = new Map<string, Subsystem>(subsystems.map((s) => [s.id as string, s]));
  const ids = subsystems.map((s) => s.id as string);

  const writerOf = new Map<string, string>();
  for (const s of subsystems) for (const f of s.writes) writerOf.set(f as string, s.id as string);

  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    outgoing.set(id, []);
  }
  const addEdge = (from: string, to: string, seen: Set<string>): void => {
    if (from === to || seen.has(from)) return;
    seen.add(from);
    indegree.set(to, (indegree.get(to) as number) + 1);
    (outgoing.get(from) as string[]).push(to);
  };

  for (const s of subsystems) {
    const reader = s.id as string;
    const seen = new Set<string>();
    for (const f of s.reads) {
      const w = writerOf.get(f as string);
      if (w === undefined) continue;
      addEdge(w, reader, seen);
    }
    // An everyNOf follower reads its leader's step count. That is a real
    // dependency even though no field carries it, so it belongs in the graph.
    //
    // Declaring it here ORDERS the pair. Without it the ordering fell out of
    // the lexical tie-break, so whether a valid configuration built at all
    // depended on whether the follower's id happened to sort after the
    // leader's — renaming a subsystem could break the build. The post-sort
    // check further down then becomes a belt-and-braces assertion instead of
    // the mechanism.
    const c = s.cadence;
    if (c.kind === 'everyNOf' && indegree.has(c.of as string)) {
      addEdge(c.of as string, reader, seen);
    }
  }

  const remaining = new Set<string>(ids);
  const result: Subsystem[] = [];

  while (remaining.size > 0) {
    const ready: string[] = [];
    // deterministic-order: remaining is scanned only to collect the ready set, which is sorted lexically before emission.
    for (const id of remaining) {
      if ((indegree.get(id) as number) === 0) ready.push(id);
    }

    if (ready.length === 0) {
      // deterministic-order: copied out and sorted, so the cycle report is stable.
      const cycle = [...remaining].sort(cmpStr).join(' -> ');
      fail(
        `dependency cycle in phase '${phase}': ${cycle}. ` +
          `Break it explicitly with readsPrev on a double-buffered field (DEC-031 rule 4)`,
      );
    }

    ready.sort(cmpStr);
    for (const id of ready) {
      result.push(byId.get(id) as Subsystem);
      remaining.delete(id);
      // deterministic-order: indegree decrement is commutative; the next wave re-collects and sorts.
      for (const reader of outgoing.get(id) as string[]) {
        indegree.set(reader, (indegree.get(reader) as number) - 1);
      }
    }
  }

  return result;
}

/** Human-readable dump of the resolved order. Used by the HUD and by tests. */
export function describeSchedule(schedule: readonly ScheduleEntry[]): string {
  const lines: string[] = [];
  let phase: Phase | null = null;
  for (const e of schedule) {
    if (e.subsystem.phase !== phase) {
      phase = e.subsystem.phase;
      lines.push(`[${String(phaseIndex(phase)).padStart(2, '0')}] ${phase}`);
    }
    const reads = e.subsystem.reads.length;
    const writes = e.subsystem.writes.length;
    lines.push(`       ${String(e.order).padStart(3)} ${e.subsystem.id}  (r${reads} w${writes})`);
  }
  return lines.join('\n');
}

/** Fields written by the schedule, in a deterministic order. */
export function writtenFields(schedule: readonly ScheduleEntry[]): readonly FieldId[] {
  const out: FieldId[] = [];
  for (const e of schedule) for (const f of e.subsystem.writes) out.push(f);
  return out;
}
