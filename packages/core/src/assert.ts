/**
 * Development-only assertions (DEC-024).
 *
 * `__WS_DEV__` is replaced at build time by the bundler define. When the
 * identifier is absent (tests, plain Node) assertions are on, which is what we
 * want everywhere except a production bundle.
 */
declare const __WS_DEV__: boolean | undefined;

export const DEV: boolean = typeof __WS_DEV__ === 'undefined' ? true : __WS_DEV__ === true;

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

/**
 * DEV-ONLY diagnostic. Compiled out of production builds.
 *
 * Use for conditions where a violation produces visibly wrong output and the
 * check is on a hot path: coordinate range checks, internal postconditions of
 * our own arithmetic. If a stripped check would let the system continue with
 * corrupted or silently wrong authoritative state, it is not this — use
 * `invariant`.
 */
export function assert(condition: unknown, message: string): asserts condition {
  if (DEV && !condition) throw new AssertionError(message);
}

export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}

/**
 * PRODUCTION SAFETY INVARIANT. Throws in every build, including production.
 *
 * The distinction from `assert` is not stylistic (T-0075). Grok found that
 * DEC-013's single-writer rule ran through `assert()`, so ownership enforcement
 * vanished in the only build that ships. A sweep found ten more of the same
 * shape — most importantly the whole of `validateDescriptor`, which is DEC-028's
 * enforcement: stripped, an `i16`-centimetres elevation field ships and
 * silently truncates Everest.
 *
 * The rule: if the system would CONTINUE, with wrong state, when the check is
 * removed, it is an invariant. If it would fail obviously anyway, it is an
 * assert.
 */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message);
}

/** Rejects NaN and ±Infinity. The most common silent simulation failure. */
export function assertFinite(value: number, name: string): void {
  if (DEV && !Number.isFinite(value)) {
    throw new AssertionError(`${name} is not finite: ${String(value)}`);
  }
}

export function assertInRange(value: number, lo: number, hi: number, name: string): void {
  if (DEV && !(value >= lo && value <= hi)) {
    throw new AssertionError(`${name} out of range [${lo}, ${hi}]: ${String(value)}`);
  }
}

export function assertInteger(value: number, name: string): void {
  if (DEV && !Number.isSafeInteger(value)) {
    throw new AssertionError(`${name} is not a safe integer: ${String(value)}`);
  }
}

/** Marks a branch that must be unreachable; also gives exhaustiveness checking. */
export function unreachable(value: never, message = 'unreachable'): never {
  throw new AssertionError(`${message}: ${JSON.stringify(value)}`);
}
