import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import {
  FieldStore,
  fieldId,
  gridId,
  sharedMemoryAvailable,
  subsystemId,
  type FieldDescriptor,
} from '@ws/data';

const OWNER = subsystemId('terrain');

function desc(over: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    id: fieldId('elevation'),
    grid: gridId('cubesphere', 6),
    dtype: 'i16',
    components: 1,
    quantum: 1,
    offset: 0,
    units: 'm',
    range: [-11_000, 9_000],
    owner: OWNER,
    tier: 'A',
    temporalClass: 'slow',
    doubleBuffered: true,
    persist: 'snapshot',
    ...over,
  };
}

function workerEval(code: string, workerData: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData });
    w.once('message', (msg: unknown) => {
      void w.terminate();
      resolve(msg);
    });
    w.once('error', reject);
  });
}

describe('FieldStore generation-publish under concurrency', () => {
  it('exposes SAB handles when shared memory is on', () => {
    const s = new FieldStore().declare(desc({ grid: gridId('cubesphere', 6) })).seal();
    const h = s.share(fieldId('elevation'));
    expect(h.copies).toBe(2);
    expect(h.shared).toBe(sharedMemoryAvailable());
    expect(h.elems).toBeGreaterThan(0);
  });

  it('consistentRead reports torn=false on a quiet field', () => {
    const s = new FieldStore().declare(desc()).seal();
    const f = s.mut(fieldId('elevation'), OWNER);
    f.set(0, 42);
    f.commit();
    const r = f.consistentRead((raw, gen) => ({ v: raw[0] as number, gen }));
    expect(r.torn).toBe(false);
    expect(r.value.v).toBe(42);
    expect(r.generation).toBe(f.generation);
  });

  it('a held raw() view becomes the BACK buffer after the next commit (the SAB hazard)', () => {
    const s = new FieldStore().declare(desc()).seal();
    const f = s.mut(fieldId('elevation'), OWNER);
    f.set(0, 1);
    f.commit();
    const held = f.raw() as Int16Array;
    expect(held[0]).toBe(1);
    f.set(0, 2);
    f.commit();
    // `held` now aliases the writable back buffer. A subsequent write mutates it.
    f.set(0, 3);
    expect(held[0]).toBe(3);
    // The published front is still 2.
    expect(f.get(0)).toBe(2);
  });

  it('phase-separated workers see only committed generations (no torn publish)', async () => {
    if (!sharedMemoryAvailable()) return;
    const s = new FieldStore().declare(desc()).seal();
    const f = s.mut(fieldId('elevation'), OWNER);
    const h = f.handles();
    expect(h.shared).toBe(true);

    for (let i = 0; i < 256; i++) f.set(i, i);
    f.commit();
    const published = f.generation;

    const result = (await workerEval(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const data = new Int16Array(workerData.data);
      const ctrl = new Int32Array(workerData.control);
      const gen = Atomics.load(ctrl, 0);
      const copies = workerData.copies;
      const elems = workerData.elems;
      const front = gen % copies;
      const slice = data.subarray(front * elems, front * elems + 256);
      let ok = true;
      for (let i = 0; i < 256; i++) if (slice[i] !== i) ok = false;
      parentPort.postMessage({ gen, ok, first: slice[0], last: slice[255] });
      `,
      { data: h.data, control: h.control, copies: h.copies, elems: h.elems },
    )) as { gen: number; ok: boolean; first: number; last: number };

    expect(result.gen).toBe(published);
    expect(result.ok).toBe(true);
    expect(result.first).toBe(0);
    expect(result.last).toBe(255);
  });

  it('a concurrent reader using acquire-load can detect a torn generation and retry', async () => {
    if (!sharedMemoryAvailable()) return;
    const s = new FieldStore().declare(desc()).seal();
    const f = s.mut(fieldId('elevation'), OWNER);
    const h = f.handles();
    const flag = new SharedArrayBuffer(8);
    const flagI = new Int32Array(flag);

    const result = await new Promise<{ torn: number; stable: number }>((resolve, reject) => {
      const w = new Worker(
        `
        const { parentPort, workerData } = require('node:worker_threads');
        const data = new Int16Array(workerData.data);
        const ctrl = new Int32Array(workerData.control);
        const flag = new Int32Array(workerData.flag);
        const copies = workerData.copies;
        const elems = workerData.elems;
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0, 1);
        Atomics.wait(flag, 0, 1);
        let torn = 0;
        let stable = 0;
        while (Atomics.load(flag, 1) === 0) {
          const g0 = Atomics.load(ctrl, 0);
          const front = g0 % copies;
          const v = data[front * elems];
          const g1 = Atomics.load(ctrl, 0);
          if (g0 !== g1) torn++;
          else stable++;
          void v;
        }
        parentPort.postMessage({ torn, stable });
        `,
        { eval: true, workerData: { data: h.data, control: h.control, copies: h.copies, elems: h.elems, flag } },
      );
      w.once('error', reject);
      w.once('message', (msg: unknown) => {
        void w.terminate();
        resolve(msg as { torn: number; stable: number });
      });
      const deadline = Date.now() + 5000;
      while (Atomics.load(flagI, 0) !== 1) {
        Atomics.wait(flagI, 0, 0, 10);
        if (Date.now() > deadline) {
          reject(new Error('reader never became ready'));
          return;
        }
      }
      Atomics.store(flagI, 0, 2);
      Atomics.notify(flagI, 0, 1);
      for (let i = 0; i < 20_000; i++) {
        f.set(0, i & 0x7fff);
        f.commit();
      }
      Atomics.store(flagI, 1, 1);
    });

    expect(result.stable).toBeGreaterThan(0);
    expect(result.torn + result.stable).toBeGreaterThan(100);
  });

  it('1 vs N sequential publishers produce identical committed values (determinism of the protocol)', () => {
    const run = (commits: number): number[] => {
      const s = new FieldStore({ preferShared: true }).declare(desc()).seal();
      const f = s.mut(fieldId('elevation'), OWNER);
      for (let c = 0; c < commits; c++) {
        f.set(0, c * 3);
        f.commit();
      }
      return [f.generation, f.get(0)];
    };
    expect(run(8)).toEqual(run(8));
  });
});

describe('FieldStore: stale reads and invalid publication', () => {
  it('uncommitted writes are invisible', () => {
    const s = new FieldStore().declare(desc()).seal();
    const f = s.mut(fieldId('elevation'), OWNER);
    f.set(4, 100);
    expect(f.get(4)).toBe(0);
    f.commit();
    expect(f.get(4)).toBe(100);
  });

  it('single-buffered fields still bump generation so consumers can detect change', () => {
    const s = new FieldStore().declare(desc({ doubleBuffered: false })).seal();
    const f = s.mut(fieldId('elevation'), OWNER);
    const g0 = f.generation;
    f.set(1, 7);
    f.commit();
    expect(f.generation).toBe(g0 + 1);
    expect(f.get(1)).toBe(7);
  });

  it('ownership is still enforced after handles() is taken', () => {
    const s = new FieldStore().declare(desc()).seal();
    s.share(fieldId('elevation'));
    expect(() => s.mut(fieldId('elevation'), subsystemId('hydrology'))).toThrow(/owned by 'terrain'/);
  });
});
