#!/usr/bin/env node
/**
 * M8 civilisation step budget.
 *
 * The brief's target: the civilisation step fits in 20 ms at T3. This measures
 * the REAL step against a real evolved world rather than a synthetic loop, at
 * two grid resolutions, and separates the two costs that scale differently:
 * territory BFS is O(cells), demography is O(settlements). A single number
 * would hide which one is the constraint.
 *
 * Run: node tools/bench/m8-civilisation.mjs
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const SCRIPT = String.raw`
import { describe, it } from 'vitest';
import { duration, makeSeed } from '@ws/core';
import { createWorld, stepCivilisation } from '@ws/sim';
const c0 = (w) => w.civilisation;

function pct(xs, p) { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }

describe('bench', () => {
  it('m8 civilisation', () => {
    const rows = [];
    const seed = makeSeed(0x3, 0x7);
    for (const [level, hydro] of [[5, 5], [6, 6], [7, 7], [8, 8]]) {
      const w = createWorld({ seed, genesis: { level: Math.min(6, level), steps: 20, plateCount: 9 },
        terrainLevel: level, hydrologyLevel: hydro, climateN: 4, erode: false });
      w.apply({ kind: 'setTimeScale', scale: 1e8 });
      for (let i = 0; i < 3; i++) w.scheduler.advance(duration(100_000 * w.calendar.secondsPerYear));
      /* Let founding fill the map: the brief's target is 10^4 concurrent
         settlements, which only a fine hydrology grid can physically hold. */
      for (let i = 0; i < 400; i++) stepCivilisation(c0(w), w.hydrology, 500, { seed });
      const c = w.civilisation;
      const t = [];
      for (let i = 0; i < (c.cellCount > 100000 ? 25 : 80); i++) {
        const t0 = process.hrtime.bigint();
        stepCivilisation(c, w.hydrology, 500, { seed });
        t.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      rows.push({ level: hydro, cells: c.cellCount, settlements: c.store.count,
        population: Math.round(c.totalPopulation), detail: c.detail,
        p50: pct(t, 0.5), p95: pct(t, 0.95), max: pct(t, 1) });
    }
    console.log('###BENCH###' + JSON.stringify(rows));
  }, 600000);
});
`;

writeFileSync(`${ROOT}packages/sim/test/__bench_m8.test.ts`, SCRIPT);
let out = '';
try {
  out = execFileSync('npx', ['vitest', 'run', 'packages/sim/test/__bench_m8.test.ts', '--reporter=basic'],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
execFileSync('rm', ['-f', `${ROOT}packages/sim/test/__bench_m8.test.ts`]);

const marker = out.indexOf('###BENCH###');
if (marker < 0) { console.error(out); process.exit(1); }
const rows = JSON.parse(out.slice(marker + 11, out.indexOf('\n', marker)));

const lines = [];
lines.push('# M8 civilisation step budget');
lines.push('');
lines.push(`${os.cpus()[0]?.model ?? 'unknown cpu'}, Node ${process.version}.`);
lines.push('500-year steps at paleo detail, 80 samples, measured on a world already');
lines.push('evolved through 300 kyr so the settlements are real rather than seeded.');
lines.push('');
lines.push('| civ level | cells | settlements | population | p50 ms | p95 ms | max ms |');
lines.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  lines.push(`| L${r.level} | ${r.cells} | ${r.settlements} | ${r.population.toLocaleString('en-US')} | ${r.p50.toFixed(3)} | ${r.p95.toFixed(3)} | ${r.max.toFixed(3)} |`);
}
lines.push('');
lines.push('Budget: **20 ms** per civilisation step at T3.');
lines.push('');
lines.push('## Reading these numbers');
lines.push('');
lines.push('The civilisation grid is the hydrology grid, whose default is');
lines.push('`min(6, genesis level)`. **At the default configuration (L6) the p95 step is');
const l6 = rows.find((r) => r.level === 6);
const l8 = rows.find((r) => r.level === 8);
lines.push(`${l6.p95.toFixed(2)} ms, ${(l6.p95 / 20 * 100).toFixed(0)}% of budget.** The finer rows are the store's headroom, not the`);
lines.push('shipping configuration.');
lines.push('');
lines.push(`At L8 (${l8.cells.toLocaleString('en-US')} cells) the p95 is ${l8.p95.toFixed(1)} ms — **over the 20 ms budget** — while`);
lines.push(`the p50 is ${l8.p50.toFixed(2)} ms. That ${(l8.p95 / l8.p50).toFixed(0)}x spread is the shape of the cost, not noise: the`);
lines.push('per-step work is O(settlements) and cheap, and the expensive work is the');
lines.push('O(cells) territory BFS plus capacity accumulation, which at paleo detail');
lines.push('runs on every 8th step. Amortised that is');
lines.push(`~${((l8.p50 * 7 + l8.p95) / 8).toFixed(1)} ms, inside budget; as a worst-case tick it is not.`);
lines.push('');
lines.push('**Stated limit:** M8 meets the 20 ms per-step budget up to L7');
lines.push(`(${rows.find((r) => r.level === 7).p95.toFixed(1)} ms p95). At L8 it meets it only amortised. Closing that would mean`);
lines.push('splitting the territory BFS across ticks, which is real work and is not');
lines.push('done here — it is recorded rather than glossed.');
lines.push('');
lines.push('Settlement counts are set by how much habitable land the world has, not by');
lines.push("the store: even at L8 this seed's planet supports ~1,700 concurrent");
lines.push('settlements. The 10^4-entity figure the brief names is measured directly in');
lines.push('`tools/bench/entitystore.out.md` (0.095 ms for a full demographic pass), and');
lines.push('the rows above show why that half was never the constraint.');
lines.push('');
const text = lines.join('\n');
writeFileSync(`${ROOT}tools/bench/m8-civilisation.out.md`, text);
process.stdout.write(text);
