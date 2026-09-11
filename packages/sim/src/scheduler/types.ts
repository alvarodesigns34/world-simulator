/**
 * Subsystem contract (DEC-016, amended by DEC-031).
 *
 * Declarative: a subsystem says what it reads, what it writes, when it runs and
 * in which phase. The declaration does four jobs at once — ordering, ownership
 * validation, safe parallelisation, and documentation — which is why it is
 * mandatory rather than inferred.
 */

import type { Duration, SimTime } from '@ws/core';
import type { FieldId, SubsystemId } from '@ws/data';

/**
 * Coarse, fixed ordering classes. The enum order IS the execution order between
 * phases; within a phase, DEC-031 decides.
 */
export const PHASES = [
  'Input',
  'Geology',
  'Terrain',
  'Hydrology',
  'Atmosphere',
  'Ocean',
  'Biosphere',
  'Civilisation',
  'Economy',
  'Derived',
  'Presentation',
] as const;

export type Phase = (typeof PHASES)[number];

export function phaseIndex(p: Phase): number {
  return PHASES.indexOf(p);
}

/**
 * Cadence is expressed in SIMULATION time, never frames or wall-clock.
 *
 * For `temporalClass: 'slow'` subsystems this is also what makes long-memory
 * state path-independent (DEC-030 amendment 1): a solver stepping every 10
 * simulated years steps every 10 simulated years at T0 and at T4 alike.
 */
export type Cadence =
  | { readonly kind: 'every'; readonly dt: Duration }
  | { readonly kind: 'everyNOf'; readonly n: number; readonly of: SubsystemId }
  | { readonly kind: 'onDemand' };

export interface StepContext {
  readonly time: SimTime;
  /** The simulated span this step covers. */
  readonly dt: Duration;
  readonly step: number;
}

export interface Subsystem {
  readonly id: SubsystemId;
  readonly phase: Phase;
  readonly cadence: Cadence;
  /** Union over all regimes (DEC-031 rule 1). */
  readonly reads: readonly FieldId[];
  /** Union over all regimes. Must be owned by this subsystem (DEC-013). */
  readonly writes: readonly FieldId[];
  /**
   * Reads of the PREVIOUS generation of a double-buffered field. Creates NO
   * graph edge — this is how a genuine physical feedback loop is broken, and
   * making the one-step lag explicit is the point (DEC-031 rule 4).
   */
  readonly readsPrev?: readonly FieldId[];
  readonly budgetMs?: number;
  step(ctx: StepContext): void;
  /** DEC-030: no-op for slow state; discards transients for fast state. */
  quiesce?(ctx: StepContext): void;
  resume?(ctx: StepContext): void;
}
