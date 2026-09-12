#!/usr/bin/env node
/**
 * E1 (partial) — patch size sweep: 17x17 vs 33x33 vs 65x65.
 *
 * WHAT THIS MEASURES AND WHAT IT DOES NOT.
 *
 * There is no GPU in this environment, so this measures the half of E1 that is
 * CPU and arithmetic: triangle counts, pixels per triangle, the resolved budget
 * from DEC-032, and the CPU cost of LOD selection at each patch size. The GPU
 * half — actual rasterisation cost, and whether the small-triangle cliff bites
 * as hard as the arithmetic says — still needs real hardware and is still open.
 *
 * Grok should treat the CPU-selection numbers here as a baseline to beat and the
 * GPU column as work to do.
 *
 * Run: node tools/bench/patch-size.mjs
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
void createRequire;

// Run the measurement inside vitest so the TS path aliases resolve.
const SCRIPT = `
import { describe, it } from 'vitest';
import { budgets } from '@ws/core';
import { EARTH_GEOMETRY } from '@ws/data';
import { cameraFromGeodetic, lookAtCentre, selectPatches } from '@ws/render';

const P = EARTH_GEOMETRY;
const RES = [
  ['1080p', 1920, 1080],
  ['1440p', 2560, 1440],
  ['2160p', 3840, 2160],
];
const SIZES = [17, 33, 65];
const TIERS = ['discrete', 'integrated', 'floor'];
const ALTS = [2e3, 5e4, 1e6, 2e7];

describe('bench', () => {
  it('patch size sweep', () => {
    const rows = [];
    for (const [resName, w, h] of RES) {
      for (const n of SIZES) {
        for (const tier of TIERS) {
          const b = budgets.resolvePatchBudget({
            pixelCount: w * h, gpuTier: tier, patchVerticesPerSide: n,
          });
          let totalMs = 0, totalVis = 0, totalVisited = 0, samples = 0, maxLevel = 0;
          for (const alt of ALTS) {
            const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.31, lon: 0.62, altitude: alt }, P));
            // warm
            for (let i = 0; i < 3; i++) selectPatches(cam, {
              planet: P, viewportWidth: w, viewportHeight: h, gpuTier: tier,
              patchVerticesPerSide: n, maxLevel: 12,
            });
            const t0 = process.hrtime.bigint();
            let r;
            const ITER = 30;
            for (let i = 0; i < ITER; i++) {
              r = selectPatches(cam, {
                planet: P, viewportWidth: w, viewportHeight: h, gpuTier: tier,
                patchVerticesPerSide: n, maxLevel: 12,
              });
            }
            const t1 = process.hrtime.bigint();
            totalMs += Number(t1 - t0) / 1e6 / ITER;
            totalVis += r.stats.visible;
            totalVisited += r.stats.nodesVisited;
            maxLevel = Math.max(maxLevel, r.stats.maxLevelReached);
            samples++;
          }
          rows.push({
            res: resName, n, tier,
            budgetPatches: b.maxVisiblePatches,
            trisPerPatch: b.trianglesPerPatch,
            maxTris: b.maxTriangles,
            pxPerTri: b.pxPerTriangle,
            avgVisible: Math.round(totalVis / samples),
            avgVisited: Math.round(totalVisited / samples),
            avgSelectMs: totalMs / samples,
            maxLevel,
          });
        }
      }
    }
    console.log('###BENCH###' + JSON.stringify(rows));
  });
});
`;

writeFileSync(`${ROOT}packages/render/test/__bench_patch.test.ts`, SCRIPT);
let out = '';
try {
  out = execFileSync(
    'npx',
    ['vitest', 'run', 'packages/render/test/__bench_patch.test.ts', '--reporter=basic'],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
  );
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
execFileSync('rm', ['-f', `${ROOT}packages/render/test/__bench_patch.test.ts`]);

const marker = out.indexOf('###BENCH###');
if (marker < 0) {
  console.error(out);
  process.exit(1);
}
const rows = JSON.parse(out.slice(marker + 11, out.indexOf('\n', marker)));

const lines = [];
lines.push('# E1 (partial) — patch size sweep');
lines.push('');
lines.push(`Host: ${os.type()} ${os.release()} ${os.arch()}, ${os.cpus().length} x ${os.cpus()[0]?.model ?? '?'}`);
lines.push(`Node: ${process.version}`);
lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
lines.push('');
lines.push('NO GPU IN THIS ENVIRONMENT. Rasterisation cost is NOT measured here.');
lines.push('These are the CPU-selection and arithmetic halves of E1.');
lines.push('');
lines.push('| res | patch | tier | budget | tris/patch | max tris | px/tri | visible | visited | select ms | maxLvl |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  lines.push(
    `| ${r.res} | ${r.n}x${r.n} | ${r.tier} | ${r.budgetPatches} | ${r.trisPerPatch} | ` +
      `${(r.maxTris / 1e6).toFixed(2)}M | ${r.pxPerTri.toFixed(2)} | ${r.avgVisible} | ` +
      `${r.avgVisited} | ${r.avgSelectMs.toFixed(3)} | ${r.maxLevel} |`,
  );
}
lines.push('');

// The headline comparison at the primary tier/resolution.
const primary = rows.filter((r) => r.res === '1440p' && r.tier === 'discrete');
lines.push('## At 1440p, discrete tier');
lines.push('');
for (const r of primary) {
  lines.push(
    `- **${r.n}x${r.n}**: ${r.budgetPatches} patches, ${(r.maxTris / 1e6).toFixed(2)} M triangles ` +
      `at ${r.pxPerTri.toFixed(2)} px/tri; selection ${r.avgSelectMs.toFixed(3)} ms ` +
      `(${r.avgVisited} nodes visited)`,
  );
}
lines.push('');
lines.push('## Reading');
lines.push('');
lines.push('- All three sizes land at the same triangle budget, because DEC-032 derives');
lines.push('  the patch count from the pixel-area floor. A bigger patch buys fewer patches.');
lines.push('- The real difference is CPU: a smaller patch means MORE nodes to traverse and');
lines.push('  more instances to write, for the same triangles. That is the trade E1 must');
lines.push('  settle, and it needs the GPU half to be conclusive.');
lines.push('- The v0 configuration (65x65, 1000 patches) is absent from this table because');
lines.push('  resolvePatchBudget will not produce it: at 1440p it is 0.45 px/triangle.');

const outPath = `${ROOT}tools/bench/patch-size.out.md`;
writeFileSync(outPath, lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`\nWritten to tools/bench/patch-size.out.md`);
