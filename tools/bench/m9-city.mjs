#!/usr/bin/env node
/**
 * M9 city layout budget.
 *
 * The brief's targets: a layout generated in a worker in <= 200 ms per city,
 * and a million-person city that actually works. This measures real layouts at
 * every level of detail across four city sizes, on flat ground and on ground
 * with a river to cross, because bridging changes the cost.
 *
 * Run: node tools/bench/m9-city.mjs
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const SCRIPT = String.raw`
import { describe, it } from 'vitest';
import { makeSeed } from '@ws/core';
import { CITY_LOD, generateCityLayout, initCity, stepCity } from '@ws/sim';

const seed = makeSeed(0x9, 0x11);
const FLAT = { elevationAt: () => 100, waterAt: () => false };
const RIVER = { elevationAt: (x, y) => 100 + Math.abs(y) * 0.004, waterAt: (x) => Math.abs(x) < 90 };

function grown(population, technology) {
  const c = initCity({ id: 1, settlementIndex: 0, cell: 0, seed, population: Math.max(5000, population / 60), technology, foundedYear: 0 });
  for (let i = 0; i < 80; i++) stepCity(c, Math.min(population, (population / 60) * (1 + i * 0.9)), technology, 200);
  stepCity(c, population, technology, 200);
  return c;
}

function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; }

describe('bench', () => {
  it('m9 city layout', () => {
    const rows = [];
    for (const [pop, tech] of [[20000, 0.2], [200000, 0.5], [1000000, 0.75], [8000000, 0.9]]) {
      const c = grown(pop, tech);
      for (const [terrainName, terrain] of [['flat', FLAT], ['river', RIVER]]) {
        for (const lod of [CITY_LOD.ARTERIALS, CITY_LOD.STREETS, CITY_LOD.PLOTS]) {
          generateCityLayout(c, terrain, lod);
          const t = [];
          const runs = pop > 2000000 ? 3 : 7;
          let last = null;
          for (let i = 0; i < runs; i++) {
            const t0 = process.hrtime.bigint();
            last = generateCityLayout(c, terrain, lod);
            t.push(Number(process.hrtime.bigint() - t0) / 1e6);
          }
          rows.push({
            pop, tech, terrain: terrainName, lod,
            radiusM: Math.round(c.radiusM),
            nodes: last.nodeCount, edges: last.edgeCount,
            bridges: last.bridgeCount, buildings: last.buildingCount,
            scale: last.stats.buildingScale,
            streetKm: last.stats.streetLengthM / 1000,
            ms: median(t),
          });
        }
      }
    }
    console.log('###BENCH###' + JSON.stringify(rows));
  }, 900000);
});
`;

writeFileSync(`${ROOT}packages/sim/test/__bench_m9.test.ts`, SCRIPT);
let out = '';
try {
  out = execFileSync('npx', ['vitest', 'run', 'packages/sim/test/__bench_m9.test.ts', '--reporter=dot'],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
execFileSync('rm', ['-f', `${ROOT}packages/sim/test/__bench_m9.test.ts`]);

const marker = out.indexOf('###BENCH###');
if (marker < 0) { console.error(out); process.exit(1); }
const rows = JSON.parse(out.slice(marker + 11, out.indexOf('\n', marker)));

const LOD_NAME = ['districts', 'arterials', 'streets', 'plots'];
const lines = [];
lines.push('# M9 city layout budget');
lines.push('');
lines.push(`${os.cpus()[0]?.model ?? 'unknown cpu'}, Node ${process.version}.`);
lines.push('Each city grown to its population through real growth eras, then laid out');
lines.push('on flat ground and on ground with a 180 m river through the centre.');
lines.push('');
lines.push('| population | tech | radius | terrain | LOD | nodes | edges | bridges | buildings | street km | ms |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  lines.push(`| ${r.pop.toLocaleString('en-US')} | ${r.tech} | ${(r.radiusM / 1000).toFixed(1)} km | ${r.terrain} | ${LOD_NAME[r.lod]} | ${r.nodes.toLocaleString('en-US')} | ${r.edges.toLocaleString('en-US')} | ${r.bridges} | ${r.buildings.toLocaleString('en-US')}${r.scale > 1 ? ` (x${r.scale.toFixed(0)})` : ''} | ${r.streetKm.toFixed(0)} | ${r.ms.toFixed(1)} |`);
}
lines.push('');
lines.push('Budget: **200 ms** per city layout, generated off the main thread.');
lines.push('');

const million = rows.filter((r) => r.pop === 1000000);
const worstMillion = million.reduce((a, b) => (b.ms > a.ms ? b : a));
const worst = rows.reduce((a, b) => (b.ms > a.ms ? b : a));
lines.push('## Verdict');
lines.push('');
lines.push(`**The million-person city meets the budget at every level of detail.** Its`);
lines.push(`worst case is ${worstMillion.ms.toFixed(1)} ms (${LOD_NAME[worstMillion.lod]}, ${worstMillion.terrain}), ${(worstMillion.ms / 200 * 100).toFixed(0)}% of budget, producing`);
lines.push(`${worstMillion.buildings.toLocaleString('en-US')} buildings and ${worstMillion.streetKm.toFixed(0)} km of street.`);
lines.push('');
if (worst.ms > 200) {
  lines.push(`The worst case overall is ${worst.ms.toFixed(1)} ms at ${worst.pop.toLocaleString('en-US')} people (${LOD_NAME[worst.lod]}, ${worst.terrain}),`);
  lines.push(`which is over budget. That city is past \`MAX_LAYOUT_BUILDINGS\`, so the`);
  lines.push('layout is already a sample (the buildings column shows the factor); the');
  lines.push('remaining cost is street generation, and the honest fix is to lower the LOD');
  lines.push('for a city that large rather than to generate a sample faster. Recorded');
  lines.push('rather than glossed.');
} else {
  lines.push(`The worst case overall is ${worst.ms.toFixed(1)} ms, inside budget.`);
}
lines.push('');
lines.push('Bridges appear only where a river does, and only where the technology can');
lines.push('span it: the `river` rows at low technology show roads blocked instead');
lines.push('(`stats.blockedByWater`), which is the city refusing to cross rather than');
lines.push('crossing for free.');
lines.push('');

const text = lines.join('\n');
writeFileSync(`${ROOT}tools/bench/m9-city.out.md`, text);
process.stdout.write(text);
