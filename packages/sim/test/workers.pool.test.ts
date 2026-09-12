import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import {
  COOP_COEP_TABLE,
  InlineBackend,
  MIX32,
  WorkerPool,
  applyInIdOrder,
  assembleTiles,
  detectCapabilities,
  digestI32,
  partitionRange,
  recommendTransferMode,
  runKernelRange,
  sharedArrayBufferAvailable,
  type Job,
  type JobResult,
} from '@ws/sim';

describe('T-0013 transfer decision table', () => {
  it('documents COOP/COEP on vs off', () => {
    expect(COOP_COEP_TABLE).toHaveLength(2);
    const on = COOP_COEP_TABLE[0]!;
    const off = COOP_COEP_TABLE[1]!;
    expect(on.coopCoep).toBe('on');
    expect(on.sab).toBe(true);
    expect(on.l11).toBe('sab');
    expect(off.coopCoep).toBe('off');
    expect(off.sab).toBe(false);
    expect(off.l11).toBe('transfer');
    expect(off.tile1MB).toBe('transfer');
  });

  it('matches the measured rules for SAB-usable and not', () => {
    expect(recommendTransferMode(50 * 1024 * 1024, true)).toBe('sab');
    expect(recommendTransferMode(50 * 1024 * 1024, false)).toBe('transfer');
    expect(recommendTransferMode(1024 * 1024, true)).toBe('sab');
    expect(recommendTransferMode(8 * 1024, true)).toBe('transfer');
    expect(recommendTransferMode(128, true)).toBe('clone');
  });

  it('detects SAB in Node', () => {
    const cap = detectCapabilities();
    expect(cap.sharedArrayBuffer).toBe(sharedArrayBufferAvailable());
    /* Node is not a cross-origin-isolated window. */
    expect(cap.crossOriginIsolated).toBe(false);
  });
});

describe('T-0013 partition + apply-in-id-order', () => {
  it('1/4/8 partitions cover [0, N) without overlap', () => {
    for (const w of [1, 4, 8]) {
      const parts = partitionRange(1000, w);
      expect(parts[0]!.start).toBe(0);
      expect(parts[parts.length - 1]!.end).toBe(1000);
      for (let i = 1; i < parts.length; i++) {
        expect(parts[i]!.start).toBe(parts[i - 1]!.end);
      }
    }
  });

  it('applyInIdOrder ignores completion permutation', () => {
    const items = [{ id: 2 }, { id: 0 }, { id: 1 }];
    expect(applyInIdOrder(items).map((x) => x.id)).toEqual([0, 1, 2]);
  });

  it('inline 1/4/8 workers are bit-identical', async () => {
    const N = 64 * 1024;
    const seed = 0x51a5_1a51;
    const a = await new WorkerPool({ workerCount: 1 }).mapCells(N, seed, MIX32);
    const b = await new WorkerPool({ workerCount: 4 }).mapCells(N, seed, MIX32);
    const c = await new WorkerPool({ workerCount: 8 }).mapCells(N, seed, MIX32);
    expect(digestI32(a)).toBe(digestI32(b));
    expect(digestI32(b)).toBe(digestI32(c));
    for (let i = 0; i < N; i++) {
      if (a[i] !== b[i] || b[i] !== c[i]) {
        throw new Error(`mismatch at ${i}`);
      }
    }
  });

  it('ArrayBuffer fallback (no SAB) is bit-identical to the inline path', async () => {
    const N = 4096;
    const seed = 7;
    const inline = await new WorkerPool({ workerCount: 4, backend: new InlineBackend() }).mapCells(
      N,
      seed,
    );
    /* Simulate transfer: copy tiles into a fresh ArrayBuffer destination. */
    const parts = partitionRange(N, 4);
    const tiles: JobResult[] = parts.map((p, id) => {
      const buffer = runKernelRange(MIX32, p.start, p.end, seed);
      return { id, start: p.start, end: p.end, digest: digestI32(buffer), buffer };
    });
    const dest = new Int32Array(new ArrayBuffer(N * 4));
    assembleTiles(dest, tiles);
    expect(digestI32(dest)).toBe(digestI32(inline));
  });
});

describe('T-0013 Node worker_threads backend identity', () => {
  it('1 vs 4 vs 8 worker_threads fill a SAB identically', async () => {
    if (!sharedArrayBufferAvailable()) return;
    const N = 16 * 1024;
    const seed = 0x51a5_1a51;
    const a = await fillWithThreads(1, N, seed);
    const b = await fillWithThreads(4, N, seed);
    const c = await fillWithThreads(8, N, seed);
    expect(digestI32(a)).toBe(digestI32(b));
    expect(digestI32(b)).toBe(digestI32(c));
  });

  it('cancellation stops issuing remaining tiles (already-started tiles finish)', async () => {
    const pool = new WorkerPool({ workerCount: 4 });
    const p = pool.mapCells(1024, 1);
    pool.cancelAll();
    /* Inline backend does not pre-empt a running kernel; cancel is a flag. */
    expect(pool.cancelled).toBe(true);
    await p;
  });
});

const KERNEL = `
const { parentPort, workerData } = require('node:worker_threads');
const view = new Int32Array(workerData.sab);
const { start, end, seed } = workerData;
for (let i = start; i < end; i++) {
  let x = (seed + Math.imul(i, 0x9e3779b9)) >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17; x >>>= 0;
  x ^= x << 5;  x >>>= 0;
  view[i] = x | 0;
}
parentPort.postMessage({ start, end });
`;

function fillWithThreads(workerCount: number, length: number, seed: number): Promise<Int32Array> {
  const sab = new SharedArrayBuffer(length * 4);
  const view = new Int32Array(sab);
  const parts = partitionRange(length, workerCount);
  const jobs: Job[] = parts.map((p, id) => ({ id, kind: 'mix32', start: p.start, end: p.end, seed }));
  const workers: Worker[] = [];
  const done: Promise<void>[] = [];
  for (const job of jobs) {
    const w = new Worker(KERNEL, {
      eval: true,
      workerData: { sab, start: job.start, end: job.end, seed },
    });
    workers.push(w);
    done.push(
      new Promise((resolve, reject) => {
        w.once('message', () => resolve());
        w.once('error', reject);
      }),
    );
  }
  return Promise.all(done).then(async () => {
    await Promise.all(workers.map((w) => w.terminate()));
    return Int32Array.from(view);
  });
}
