/**
 * Worker pool (T-0013, DEC-020).
 *
 * Workers CALCULATE. They never publish authoritative state. Results wait at
 * the scheduler/main boundary and are applied in job-id order, never
 * completion order (DEC-016 rule 3, DEC-017 reductions).
 *
 * Transfer policy, from the Node measurements in docs/M1-MEASUREMENTS.md:
 *
 *   bytes ≥ 8 MB (L11 fields)  SAB required; clone/transfer miss the frame
 *   256 KB .. 1 MB (tiles)     transfer preferred; SAB fine; clone wasteful
 *   ≤ 64 KB (dirty blocks)     clone or transfer, either is fine
 *   control messages           clone
 *
 * Browser SAB needs COOP/COEP (`crossOriginIsolated`). Vite's dev/preview
 * headers already set both. When they are off, this module falls back to
 * ArrayBuffer + transfer and never pretends the SAB path is live.
 *
 * This file is DOM-free. The default runner is inline (same-thread partitions)
 * so `sim` stays importable in the browser bundle. A Node `worker_threads`
 * backend can be injected by tests; a browser `Worker` backend can be injected
 * by `app`. Identity of 1/4/8 workers is a property of the KERNEL (pure
 * function of seed + cell index) plus apply-in-id-order, not of the backend.
 */

import { invariant } from '@ws/core';

export type TransferMode = 'sab' | 'transfer' | 'clone';

export interface WorkerCapabilities {
  readonly sharedArrayBuffer: boolean;
  readonly crossOriginIsolated: boolean;
  readonly recommended: (bytes: number) => TransferMode;
}

export function sharedArrayBufferAvailable(): boolean {
  return typeof SharedArrayBuffer === 'function';
}

/**
 * `crossOriginIsolated` exists only in window / dedicated-worker scopes.
 * Node tests report false, which is correct: Node SAB does not go through COOP.
 */
export function isCrossOriginIsolated(): boolean {
  const g = globalThis as { crossOriginIsolated?: boolean };
  return g.crossOriginIsolated === true;
}

export function detectCapabilities(): WorkerCapabilities {
  const sab = sharedArrayBufferAvailable();
  const coi = isCrossOriginIsolated();
  return {
    sharedArrayBuffer: sab,
    crossOriginIsolated: coi,
    recommended: (bytes: number) => recommendTransferMode(bytes, sab && (coi || isNode())),
  };
}

function isNode(): boolean {
  const g = globalThis as { process?: { versions?: { node?: string } } };
  return typeof g.process?.versions?.node === 'string';
}

/**
 * The decision table T-0013 still owed. Pure, so the browser on/off rows are
 * unit-tested without a browser.
 */
export function recommendTransferMode(
  bytes: number,
  sabUsable: boolean,
): TransferMode {
  if (bytes >= 8 * 1024 * 1024) return sabUsable ? 'sab' : 'transfer';
  if (bytes >= 256 * 1024) return sabUsable ? 'sab' : 'transfer';
  if (bytes >= 4 * 1024) return 'transfer';
  return 'clone';
}

export const COOP_COEP_TABLE: readonly {
  readonly coopCoep: 'on' | 'off';
  readonly sab: boolean;
  readonly l11: TransferMode;
  readonly tile1MB: TransferMode;
  readonly dirty8KB: TransferMode;
}[] = [
  { coopCoep: 'on', sab: true, l11: 'sab', tile1MB: 'sab', dirty8KB: 'transfer' },
  { coopCoep: 'off', sab: false, l11: 'transfer', tile1MB: 'transfer', dirty8KB: 'transfer' },
];

export interface Job {
  readonly id: number;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly seed: number;
}

export interface JobResult {
  readonly id: number;
  readonly start: number;
  readonly end: number;
  readonly digest: number;
  readonly buffer: Int32Array;
}

export type Kernel = (cell: number, seed: number) => number;

export interface PoolBackend {
  readonly name: string;
  run(jobs: readonly Job[], kernelSource: string | Kernel, cancel?: CancelToken): Promise<JobResult[]>;
}

/** Split [0, length) into `workers` contiguous tiles. Trailing empty tiles dropped. */
export function partitionRange(length: number, workers: number): { start: number; end: number }[] {
  invariant(workers >= 1 && workers <= 8, 'worker count is 1..8 (DEC-020)');
  invariant(length >= 0, 'partition length');
  const tile = Math.ceil(length / workers);
  const out: { start: number; end: number }[] = [];
  for (let w = 0; w < workers; w++) {
    const start = w * tile;
    const end = Math.min(length, start + tile);
    if (start >= end) break;
    out.push({ start, end });
  }
  return out;
}

/**
 * Apply results in job-id order. Completion order of the pool is invisible.
 * A missing id throws rather than silently permute the world.
 */
export function applyInIdOrder<T extends { id: number }>(results: readonly T[]): T[] {
  const copy = results.slice();
  copy.sort((a, b) => a.id - b.id);
  for (let i = 0; i < copy.length; i++) {
    invariant((copy[i] as T).id === i, `job ids must be 0..n-1 dense, missing ${String(i)}`);
  }
  return copy;
}

/** Mix32 kernel used by the T-0013 identity test. Pure in (seed, cell). */
export const MIX32: Kernel = (cell, seed) => {
  let x = (seed + Math.imul(cell, 0x9e3779b9)) >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x >>>= 0;
  x ^= x << 5;
  x >>>= 0;
  return x | 0;
};

export function runKernelRange(kernel: Kernel, start: number, end: number, seed: number, cancel?: CancelToken): Int32Array {
  const buf = new Int32Array(end - start);
  for (let i = start; i < end; i++) {
    if ((i & 1023) === 0 && cancel?.cancelled) throw new CancelledJobError();
    buf[i - start] = kernel(i, seed);
  }
  return buf;
}

export function digestI32(buf: Int32Array): number {
  let h = 2166136261;
  for (let i = 0; i < buf.length; i++) {
    h ^= (buf[i] as number) >>> 0;
    h = Math.imul(h, 16777619);
    h ^= i;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface CancelToken {
  cancelled: boolean;
}

export function createCancelToken(): CancelToken {
  return { cancelled: false };
}

export class CancelledJobError extends Error {
  constructor() { super('worker job cancelled'); this.name = 'CancelledJobError'; }
}

/**
 * Inline backend: partitions run on this thread. Still 1/4/8-identical because
 * the kernel is pure. Cancellation is checked between tiles, not mid-cell.
 */
export class InlineBackend implements PoolBackend {
  readonly name = 'inline';
  async run(jobs: readonly Job[], kernel: string | Kernel, cancel?: CancelToken): Promise<JobResult[]> {
    /* Yield before work so cancelAll() can cancel a just-issued request too. */
    await Promise.resolve();
    const k: Kernel = typeof kernel === 'function' ? kernel : MIX32;
    const out: JobResult[] = [];
    for (const job of jobs) {
      if (cancel?.cancelled) throw new CancelledJobError();
      const buffer = runKernelRange(k, job.start, job.end, job.seed, cancel);
      out.push({
        id: job.id,
        start: job.start,
        end: job.end,
        digest: digestI32(buffer),
        buffer,
      });
    }
    return out;
  }
}

export class WorkerPool {
  readonly workerCount: number;
  readonly backend: PoolBackend;
  private readonly active = new Set<CancelToken>();
  private wasCancelled = false;

  constructor(opts?: { workerCount?: number; backend?: PoolBackend }) {
    this.workerCount = opts?.workerCount ?? 4;
    invariant(this.workerCount >= 1 && this.workerCount <= 8, 'WorkerPool: 1..8 workers');
    this.backend = opts?.backend ?? new InlineBackend();
  }

  cancelAll(): void {
    this.wasCancelled = true;
    for (const token of this.active) token.cancelled = true;
  }

  get cancelled(): boolean {
    return this.wasCancelled;
  }

  /**
   * Fill `length` cells with `kernel`. Results concatenated in cell-index
   * order. 1, 4 or 8 workers produce bit-identical output.
   */
  async mapCells(length: number, seed: number, kernel: Kernel = MIX32): Promise<Int32Array> {
    const cancel = createCancelToken();
    this.active.add(cancel);
    const parts = partitionRange(length, this.workerCount);
    const jobs: Job[] = parts.map((p, id) => ({
      id,
      kind: 'cells',
      start: p.start,
      end: p.end,
      seed,
    }));
    try {
      const raw = await this.backend.run(jobs, kernel, cancel);
      if (cancel.cancelled) throw new CancelledJobError();
      const ordered = applyInIdOrder(raw);
      const out = new Int32Array(length);
      for (const r of ordered) out.set(r.buffer, r.start);
      return out;
    } finally {
      this.active.delete(cancel);
    }
  }
}

/**
 * Assemble a SAB-or-copy target from worker tiles. The MAIN thread writes the
 * destination; workers only produced the tiles. This is the "commit at the
 * scheduler boundary" rule in code.
 */
export function assembleTiles(
  dest: Int32Array,
  tiles: readonly JobResult[],
): void {
  const ordered = applyInIdOrder(tiles);
  for (const t of ordered) dest.set(t.buffer, t.start);
}
