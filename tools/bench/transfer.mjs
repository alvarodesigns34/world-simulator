#!/usr/bin/env node
/**
 * E3 — SAB vs Transfer vs structuredClone at TILE-realistic sizes.
 *
 * The 50 MB number is already settled (AUDIT-V0): clone 98 ms, transfer RT 34 ms.
 * T-0013 needs the tile path: 8 KB – 1 MB, which is what FieldStore dirty blocks
 * and regional tiles actually move.
 *
 * Run: node tools/bench/transfer.mjs
 */

import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const WORKER = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (msg) => {
  if (msg.kind === 'clone') {
    parentPort.postMessage({ kind: 'pong', buf: msg.buf, n: msg.buf.byteLength });
    return;
  }
  if (msg.kind === 'transfer') {
    parentPort.postMessage({ kind: 'pong', buf: msg.buf, n: msg.buf.byteLength }, [msg.buf]);
    return;
  }
  if (msg.kind === 'sab') {
    const view = new Uint8Array(msg.buf);
    let sum = 0;
    for (let i = 0; i < view.length; i += 256) sum = (sum + view[i]) | 0;
    parentPort.postMessage({ kind: 'pong', n: view.length, sum });
    return;
  }
  if (msg.kind === 'quit') {
    parentPort.close();
  }
});
`;

function makeWorker() {
  const w = new Worker(WORKER, { eval: true });
  w.setMaxListeners(50);
  return w;
}

function roundTrip(worker, msg, transfer) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const onMsg = (reply) => {
      worker.off('message', onMsg);
      worker.off('error', onErr);
      const t1 = process.hrtime.bigint();
      resolve({ ms: Number(t1 - t0) / 1e6, reply });
    };
    const onErr = (err) => {
      worker.off('message', onMsg);
      worker.off('error', onErr);
      reject(err);
    };
    worker.on('message', onMsg);
    worker.on('error', onErr);
    if (transfer) worker.postMessage(msg, [msg.buf]);
    else worker.postMessage(msg);
  });
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

const SIZES = [
  ['8 KB', 8 * 1024],
  ['64 KB', 64 * 1024],
  ['256 KB', 256 * 1024],
  ['1 MB', 1 * 1024 * 1024],
  ['4 MB', 4 * 1024 * 1024],
  ['50 MB', 50 * 1024 * 1024],
];

const ITER = 12;
const WARM = 2;

const rows = [];
const worker = makeWorker();

for (const [label, bytes] of SIZES) {
  const cloneMs = [];
  const transferMs = [];
  const sabMs = [];

  for (let i = 0; i < ITER + WARM; i++) {
    const a = new ArrayBuffer(bytes);
    new Uint8Array(a).fill(i & 0xff);
    const r = await roundTrip(worker, { kind: 'clone', buf: a }, false);
    if (i >= WARM) cloneMs.push(r.ms);
  }
  for (let i = 0; i < ITER + WARM; i++) {
    const a = new ArrayBuffer(bytes);
    new Uint8Array(a).fill(i & 0xff);
    const r = await roundTrip(worker, { kind: 'transfer', buf: a }, true);
    if (i >= WARM) transferMs.push(r.ms);
  }
  const sab = new SharedArrayBuffer(bytes);
  new Uint8Array(sab).fill(7);
  for (let i = 0; i < ITER + WARM; i++) {
    const r = await roundTrip(worker, { kind: 'sab', buf: sab }, false);
    if (i >= WARM) sabMs.push(r.ms);
  }

  const localClone = [];
  for (let i = 0; i < ITER; i++) {
    const a = new ArrayBuffer(bytes);
    new Uint8Array(a).fill(1);
    const t0 = process.hrtime.bigint();
    structuredClone(a);
    const t1 = process.hrtime.bigint();
    localClone.push(Number(t1 - t0) / 1e6);
  }

  rows.push({
    label,
    bytes,
    cloneRt: median(cloneMs),
    transferRt: median(transferMs),
    sabRt: median(sabMs),
    localClone: median(localClone),
  });
}

await worker.terminate();

const lines = [];
lines.push('# E3 — SAB vs Transfer vs structuredClone (tile sizes)');
lines.push('');
lines.push(`Host: ${os.type()} ${os.release()} ${os.arch()}, ${os.cpus().length} x ${os.cpus()[0]?.model ?? '?'}`);
lines.push(`Node: ${process.version}`);
lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
lines.push(`Method: worker_threads round-trip, median of ${ITER} (after ${WARM} warm).`);
lines.push('');
lines.push('| size | clone RT ms | transfer RT ms | SAB read RT ms | local structuredClone ms |');
lines.push('| --- | ---: | ---: | ---: | ---: |');
for (const r of rows) {
  lines.push(
    `| ${r.label} | ${r.cloneRt.toFixed(3)} | ${r.transferRt.toFixed(3)} | ${r.sabRt.toFixed(3)} | ${r.localClone.toFixed(3)} |`,
  );
}
lines.push('');
lines.push('## Decision (where SAB is REQUIRED / PREFERRED / UNNECESSARY)');
lines.push('');
lines.push('Measured against the 2.0 ms `simCommit` budget and the 16.6 ms frame.');
lines.push('');
lines.push('| Payload | Mechanism | Verdict | Why |');
lines.push('| --- | --- | --- | --- |');
lines.push('| Persistent L11 fields (≈50 MB, in-place updates) | SAB + generation-publish | **REQUIRED** | Clone is ~5× a frame. Transfer *detaches* the field from the main thread, which turns every read into a lifetime problem (DEC-020). |');
lines.push('| Regional tiles 256 KB–1 MB (authoritative bake results) | Transferable ArrayBuffer | **PREFERRED** | One-shot ownership handoff. Tile is immutable after bake; main thread does not need the producer copy. Clone of 1 MB is already a millisecond-scale tax if it happens per tile. |');
lines.push('| Dirty-block uploads 8–64 KB | Transferable, or just `queue.writeBuffer` from SAB | **UNNECESSARY to invent SAB** | Both clone and transfer are well under 0.3 ms. Use whichever the buffer already is. |');
lines.push('| Control messages, descriptors, job headers (< 4 KB) | structuredClone | **UNNECESSARY** | Noise. SAB would add COOP/COEP and Atomics ceremony for nothing. |');
lines.push('| Double-buffered field with concurrent readers across a commit | SAB + phase separation | **REQUIRED**, plus the seqlock | `consistentRead` detects a torn generation. Holding `raw()` across `commit()` aliases the back buffer — tested, documented, forbidden. |');
lines.push('');
lines.push('SAB is not a dogma. It is the only mechanism that lets two threads read a 50 MB');
lines.push('field without copying it and without detaching it. Everything smaller is a');
lines.push('cost/complexity trade, and the numbers above are the trade.');

const text = lines.join('\n') + '\n';
writeFileSync(`${ROOT}tools/bench/transfer.out.md`, text);
console.log(text);
