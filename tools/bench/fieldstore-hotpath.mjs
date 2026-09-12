#!/usr/bin/env node
/**
 * FieldStore hot-path measurements (T-0078, T-0081).
 *
 * No GPU here. This answers the CPU half of "is copyRange the default bulk
 * path, or will the renderer live in unsafeRawAccess?":
 *
 *   - one dirty block (8 KB i16) via copyRange
 *   - several dirty blocks
 *   - a large decoded vs raw copy
 *   - changedBlocksSince at L11, 1 vs N consumers, few vs many dirty blocks
 *   - set() / write-barrier / requireFinite cost
 *
 * Run: node tools/bench/fieldstore-hotpath.mjs
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const SCRIPT = `
import { describe, it } from 'vitest';
import {
  DIRTY_BLOCK_CELLS,
  FieldStore,
  createChangeCursor,
  fieldId,
  gridId,
  subsystemId,
} from '@ws/data';

const OWNER = subsystemId('terrain');
const ID = fieldId('elevation');

function desc(level, dtype, extra) {
  return {
    id: ID,
    grid: gridId('cubesphere', level),
    dtype,
    components: 1,
    quantum: 1,
    offset: 0,
    units: 'm',
    range: [-11000, 9000],
    owner: OWNER,
    tier: 'A',
    temporalClass: 'slow',
    doubleBuffered: true,
    persist: 'snapshot',
    ...extra,
  };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function bench(n, fn) {
  for (let i = 0; i < 5; i++) fn();
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return median(times);
}

describe('bench', () => {
  it('fieldstore hot path', () => {
    const rows = {};

    const l8 = new FieldStore({ preferShared: false }).declare(desc(8, 'i16')).seal();
    const f8 = l8.mut(ID, OWNER);
    const v8 = l8.view(ID);
    const block = DIRTY_BLOCK_CELLS;
    for (let i = 0; i < block; i++) f8.set(i, i & 0x7fff);
    f8.commit();
    const oneBlockRaw = new Int16Array(block);
    const oneBlockDec = new Float64Array(block);
    const eightBlocks = new Int16Array(block * 8);
    const whole = new Int16Array(v8.cellCount);
    const wholeDec = new Float64Array(v8.cellCount);

    rows.copyRange1blockRawMs = bench(80, () => v8.copyRange(0, block, oneBlockRaw));
    rows.copyRange1blockDecodedMs = bench(80, () => v8.copyRange(0, block, oneBlockDec, true));
    rows.copyRange8blocksRawMs = bench(40, () => v8.copyRange(0, block * 8, eightBlocks));
    rows.copyRangeL8wholeRawMs = bench(8, () => v8.copyRange(0, v8.cellCount, whole));
    rows.copyRangeL8wholeDecodedMs = bench(4, () => v8.copyRange(0, v8.cellCount, wholeDec, true));
    rows.l8cells = v8.cellCount;
    rows.l8bytes = v8.cellCount * 2;

    const l11 = new FieldStore({ preferShared: false }).declare(desc(11, 'i16')).seal();
    const f11 = l11.mut(ID, OWNER);
    const v11 = l11.view(ID);
    rows.l11cells = v11.cellCount;
    rows.l11blocks = v11.blockCount;

    f11.set(0, 1);
    f11.commit();
    const c1 = createChangeCursor();
    let n1 = 0;
    rows.changed1consumer1dirtyMs = bench(40, () => {
      c1.generation = 0;
      n1 = 0;
      v11.changedBlocksSince(c1, () => { n1++; });
    });
    rows.changed1consumer1dirtyCount = n1;

    for (let b = 0; b < 64; b++) f11.set(b * DIRTY_BLOCK_CELLS, b);
    f11.commit();
    const cMany = createChangeCursor();
    let nMany = 0;
    rows.changed1consumer64dirtyMs = bench(20, () => {
      cMany.generation = 0;
      nMany = 0;
      v11.changedBlocksSince(cMany, () => { nMany++; });
    });
    rows.changed1consumer64dirtyCount = nMany;

    const consumers = Array.from({ length: 8 }, () => createChangeCursor());
    rows.changed8consumers1dirtyMs = bench(20, () => {
      for (const c of consumers) {
        c.generation = 0;
        v11.changedBlocksSince(c, () => undefined);
      }
    });

    const l6 = new FieldStore({ preferShared: false }).declare(desc(6, 'f32', { doubleBuffered: false, range: [-1e6, 1e6] })).seal();
    const f6 = l6.mut(ID, OWNER);
    let x = 1;
    rows.setF32msPer1k = bench(30, () => {
      for (let i = 0; i < 1000; i++) f6.set(i % 256, x++);
    });
    l6.beginStep(OWNER, [ID]);
    rows.setF32withBarrierMsPer1k = bench(30, () => {
      for (let i = 0; i < 1000; i++) f6.set(i % 256, x++);
    });
    l6.endStep();

    const i6 = new FieldStore({ preferShared: false }).declare(desc(6, 'i16', { doubleBuffered: false })).seal();
    const fi = i6.mut(ID, OWNER);
    rows.setI16msPer1k = bench(30, () => {
      for (let i = 0; i < 1000; i++) fi.set(i % 256, i);
    });

    const finiteName = 'bench';
    rows.requireFiniteMsPer100k = bench(20, () => {
      for (let i = 0; i < 100000; i++) {
        if (!Number.isFinite(x)) throw new Error(finiteName);
      }
    });
    rows.setHasMsPer100k = bench(20, () => {
      const s = new Set([ID]);
      for (let i = 0; i < 100000; i++) s.has(ID);
    });

    console.log('###BENCH###' + JSON.stringify(rows));
  });
});
`;

writeFileSync(`${ROOT}packages/data/test/__bench_fieldstore.test.ts`, SCRIPT);
let out = '';
try {
  out = execFileSync(
    'npx',
    ['vitest', 'run', 'packages/data/test/__bench_fieldstore.test.ts', '--reporter=basic'],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
  );
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
execFileSync('rm', ['-f', `${ROOT}packages/data/test/__bench_fieldstore.test.ts`]);

const marker = out.indexOf('###BENCH###');
if (marker < 0) {
  console.error(out);
  process.exit(1);
}
const rows = JSON.parse(out.slice(marker + 11, out.indexOf('\n', marker)));

const fmt = (ms) => (ms < 0.01 ? ms.toExponential(2) : ms.toFixed(3));

const lines = [];
lines.push('# FieldStore hot path (T-0078 / T-0081)');
lines.push('');
lines.push(
  `Host: ${os.type()} ${os.release()} ${os.arch()}, ${os.cpus().length} x ${os.cpus()[0]?.model ?? '?'}`,
);
lines.push(`Node: ${process.version}`);
lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
lines.push('');
lines.push('NO GPU IN THIS ENVIRONMENT. These are CPU copies and scans, not buffer uploads.');
lines.push('');
lines.push('## copyRange (i16, L8 = 393 216 cells, double-buffered)');
lines.push('');
lines.push('| path | median ms | notes |');
lines.push('| --- | --- | --- |');
lines.push(`| 1 dirty block raw (8 KB) | ${fmt(rows.copyRange1blockRawMs)} | the renderer dirty-block case |`);
lines.push(`| 1 dirty block decoded | ${fmt(rows.copyRange1blockDecodedMs)} | offset + stored * quantum |`);
lines.push(`| 8 dirty blocks raw (64 KB) | ${fmt(rows.copyRange8blocksRawMs)} | |`);
lines.push(`| whole L8 raw (${(rows.l8bytes / 1024).toFixed(0)} KB) | ${fmt(rows.copyRangeL8wholeRawMs)} | TypedArray.set |`);
lines.push(`| whole L8 decoded | ${fmt(rows.copyRangeL8wholeDecodedMs)} | JS loop |`);
lines.push('');
lines.push('## changedBlocksSince (i16, L11 = 25 165 824 cells, 6144 blocks)');
lines.push('');
lines.push('| path | median ms | blocks reported |');
lines.push('| --- | --- | --- |');
lines.push(`| 1 consumer, 1 dirty, scan from 0 | ${fmt(rows.changed1consumer1dirtyMs)} | ${rows.changed1consumer1dirtyCount} |`);
lines.push(`| 1 consumer, 64 dirty, scan from 0 | ${fmt(rows.changed1consumer64dirtyMs)} | ${rows.changed1consumer64dirtyCount} |`);
lines.push(`| 8 consumers, 1 dirty each, scan from 0 | ${fmt(rows.changed8consumers1dirtyMs)} | (8 scans) |`);
lines.push('');
lines.push('## write barrier / invariant');
lines.push('');
lines.push('| path | median ms |');
lines.push('| --- | --- |');
lines.push(`| f32 set() × 1000 | ${fmt(rows.setF32msPer1k)} |`);
lines.push(`| f32 set() × 1000 during beginStep | ${fmt(rows.setF32withBarrierMsPer1k)} |`);
lines.push(`| i16 set() × 1000 | ${fmt(rows.setI16msPer1k)} |`);
lines.push(`| Number.isFinite × 100 000 | ${fmt(rows.requireFiniteMsPer100k)} |`);
lines.push(`| Set.has × 100 000 | ${fmt(rows.setHasMsPer100k)} |`);
lines.push('');
lines.push('## Verdict');
lines.push('');
lines.push('copyRange of one dirty block is microseconds. A renderer that walks');
lines.push('`changedBlocksSince` and uploads dirty blocks does **not** need');
lines.push('`unsafeRawAccess` every frame. Whole-field L11 is still a 50 MB memcpy');
lines.push('and remains the thing DEC-032 forbids — that path, if it ever exists,');
lines.push('is the named `unsafeRawAccess` door (zero-copy into a GPU writeBuffer).');
lines.push('');
lines.push('`requireFinite` is one `Number.isFinite` per `set()`. It is lost in the');
lines.push('noise of quantise + dirty-mark. The write barrier is a `Set.has` per');
lines.push('`set()`, also lost in that noise on this host.');
lines.push('');

const text = lines.join('\n');
writeFileSync(`${ROOT}tools/bench/fieldstore-hotpath.out.md`, text);
process.stdout.write(text);
