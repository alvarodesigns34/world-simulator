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
 * Four conditions are startup ERRORS, never warnings:
 *   - a cycle in the union graph
 *   - a write conflict (two subsystems writing one field — violates DEC-013)
 *   - an undeclared owner (writing a field owned by someone else)
 *   - an unknown field
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
  for (const s of subsystems) {
    for (const f of s.writes) {
      const list = writers.get(f) ?? [];
      list.push(s.id);
      writers.set(f, list);
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

  return out;
}

/**
 * Kahn's algorithm with a lexically-ordered ready set.
 *
 * The ready set is kept sorted rather than used as a queue: that is what makes
 * the result independent of the input order, which is the property DEC-031
 * actually promises and which `deterministic ordering` tests assert.
 */
function sortPhase(subsystems: readonly Subsystem[], phase: Phase): readonly Subsystem[] {
  const byId = new Map<string, Subsystem>(subsystems.map((s) => [s.id as string, s]));

  // Edge writer -> reader for every field written here and read here.
  // `readsPrev` deliberately creates no edge (DEC-031 rule 4).
  const writerOf = new Map<string, string>();
  for (const s of subsystems) for (const f of s.writes) writerOf.set(f as string, s.id as string);

  const deps = new Map<string, Set<string>>();
  for (const s of subsystems) deps.set(s.id as string, new Set());
  for (const s of subsystems) {
    for (const f of s.reads) {
      const w = writerOf.get(f as string);
      if (w !== undefined && w !== (s.id as string)) {
        (deps.get(s.id as string) as Set<string>).add(w);
      }
    }
  }

  const remaining = new Set<string>(subsystems.map((s) => s.id as string));
  const result: Subsystem[] = [];

  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const s of subsystems) {
      const id = s.id as string;
      if (!remaining.has(id)) continue;
      const d = deps.get(id) as Set<string>;
      let blocked = false;
      for (const need of d) {
        if (remaining.has(need)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) ready.push(id);
    }

    if (ready.length === 0) {
      // deterministic-order: copied out and sorted, so the cycle report is stable.
      const cycle = [...remaining].sort(cmpStr).join(' -> ');
      fail(
        `dependency cycle in phase '${phase}': ${cycle}. ` +
          `Break it explicitly with readsPrev on a double-buffered field (DEC-031 rule 4)`,
      );
    }

    ready.sort(cmpStr); // lexical tie-break — DEC-031 rule 2.3
    for (const id of ready) {
      result.push(byId.get(id) as Subsystem);
      remaining.delete(id);
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
