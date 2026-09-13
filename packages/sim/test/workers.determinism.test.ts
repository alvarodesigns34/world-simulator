import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { sharedMemoryAvailable } from '@ws/data';

/**
 * T-0013 — Node 1 / 4 / 8 worker identity.
 *
 * The kernel is a pure function of (seed, cellIndex). Partitioning the same
 * SAB across 1, 4 or 8 workers must produce a bit-identical buffer, because
 * completion order is not result order: each worker writes its own cell range.
 *
 * Browser COOP/COEP on vs off is still open (T-0013 remainder). This is the
 * Node half of the acceptance criterion.
 */

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

function fillWithWorkers(workerCount: number, length: number, seed: number): Promise<Int32Array> {
  const sab = new SharedArrayBuffer(length * 4);
  const view = new Int32Array(sab);
  const tile = Math.ceil(length / workerCount);
  const workers: Worker[] = [];
  const jobs: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    const start = w * tile;
    const end = Math.min(length, start + tile);
    if (start >= end) break;
    const worker = new Worker(KERNEL, { eval: true, workerData: { sab, start, end, seed } });
    workers.push(worker);
    jobs.push(
      new Promise((resolve, reject) => {
        worker.once('message', () => resolve());
        worker.once('error', reject);
      }),
    );
  }
  return Promise.all(jobs).then(async () => {
    await Promise.all(workers.map((w) => w.terminate()));
    return Int32Array.from(view);
  });
}

function digest(buf: Int32Array): string {
  // Fold in index order so a permutation of writes cannot hide behind a xor.
  let h = 2166136261;
  for (let i = 0; i < buf.length; i++) {
    h ^= (buf[i] as number) >>> 0;
    h = Math.imul(h, 16777619);
    h ^= i;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

describe('T-0013: 1 / 4 / 8 workers produce identical results (Node)', () => {
  it('is skipped when SharedArrayBuffer is not available', () => {
    expect(typeof sharedMemoryAvailable).toBe('function');
  });

  it('1 vs 4 vs 8 workers fill the same SAB bit-identically', async () => {
    if (!sharedMemoryAvailable()) return;
    const N = 64 * 1024;
    const seed = 0x51a5_1a51;
    const a = await fillWithWorkers(1, N, seed);
    const b = await fillWithWorkers(4, N, seed);
    const c = await fillWithWorkers(8, N, seed);
    expect(a.length).toBe(N);
    expect(digest(a)).toBe(digest(b));
    expect(digest(b)).toBe(digest(c));
    for (let i = 0; i < N; i++) {
      if (a[i] !== b[i] || b[i] !== c[i]) {
        throw new Error(`mismatch at cell ${i}: 1=${String(a[i])} 4=${String(b[i])} 8=${String(c[i])}`);
      }
    }
  });

  it('a different seed produces a different digest (the kernel is not a constant)', async () => {
    if (!sharedMemoryAvailable()) return;
    const N = 4096;
    const a = await fillWithWorkers(4, N, 1);
    const b = await fillWithWorkers(4, N, 2);
    expect(digest(a)).not.toBe(digest(b));
  });
});
