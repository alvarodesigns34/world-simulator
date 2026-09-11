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

export function assert(condition: unknown, message: string): asserts condition {
  if (DEV && !condition) throw new AssertionError(message);
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
