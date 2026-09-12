#!/usr/bin/env node
/**
 * CPU profile of the M1 selector across orbit / approach / surface / poles /
 * fast motion / stationary. No GPU in this environment — GPU columns are n/a.
 *
 * Run: node tools/bench/m1-profile.mjs
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const SCRIPT = `
import { it } from 'vitest';
import { budgets } from '@ws/core';
import { EARTH_GEOMETRY } from '@ws/data';
import { NodePool, cameraFromGeodetic, lookAtCentre, moveTangential, selectPatches } from '@ws/render';
import { v3 as vec } from '@ws/core';

const P = EARTH_GEOMETRY;
const W = 2560, H = 1440;
const ITER = 40;

function time(fn) {
  for (let i = 0; i < 4; i++) fn();
  const t0 = process.hrtime.bigint();
  let last;
  for (let i = 0; i < ITER; i++) last = fn();
  const t1 = process.hrtime.bigint();
  return { ms: Number(t1 - t0) / 1e6 / ITER, r: last };
}

it('profile', () => {
  const pool = new NodePool();
  const situations = [
    ['high orbit', { lat: 0.2, lon: 0.5, altitude: 4e7 }],
    ['low orbit', { lat: 0.2, lon: 0.5, altitude: 4e5 }],
    ['approach', { lat: 0.35, lon: 0.6, altitude: 8e4 }],
    ['near surface', { lat: 0.4, lon: 0.55, altitude: 2e3 }],
    ['surface', { lat: 0.4, lon: 0.55, altitude: 5 }],
    ['north pole', { lat: Math.PI / 2, lon: 0, altitude: 2e5 }],
    ['south pole', { lat: -Math.PI / 2, lon: 0, altitude: 2e5 }],
  ];
  const rows = [];
  for (const [name, g] of situations) {
    const cam = lookAtCentre(cameraFromGeodetic(g, P));
    const { ms, r } = time(() => selectPatches(cam, {
      planet: P, viewportWidth: W, viewportHeight: H, gpuTier: 'discrete',
      patchVerticesPerSide: 33, maxLevel: 12, pool,
    }));
    rows.push({
      name, alt: g.altitude, ms, vis: r.stats.visible, visN: r.stats.nodesVisited,
      h: r.stats.culledHorizon, f: r.stats.culledFrustum, tri: r.stats.triangles,
      maxL: r.stats.maxLevelReached, lod: r.stats.lodCounts, budget: r.stats.budgetPatches,
    });
  }
  let cam = lookAtCentre(cameraFromGeodetic({ lat: 0.2, lon: 0.4, altitude: 3e5 }, P));
  const t0 = process.hrtime.bigint();
  let last;
  for (let i = 0; i < ITER; i++) {
    cam = lookAtCentre(moveTangential(cam, vec(0, 0, 1), 0.04));
    last = selectPatches(cam, {
      planet: P, viewportWidth: W, viewportHeight: H, gpuTier: 'discrete',
      patchVerticesPerSide: 33, maxLevel: 12, pool,
    });
  }
  const t1 = process.hrtime.bigint();
  rows.push({
    name: 'fast motion', alt: 3e5, ms: Number(t1 - t0) / 1e6 / ITER,
    vis: last.stats.visible, visN: last.stats.nodesVisited,
    h: last.stats.culledHorizon, f: last.stats.culledFrustum, tri: last.stats.triangles,
    maxL: last.stats.maxLevelReached, lod: last.stats.lodCounts, budget: last.stats.budgetPatches,
  });
  const mem = process.memoryUsage();
  console.log('###PROF###' + JSON.stringify({
    rows, rss: mem.rss, heap: mem.heapUsed, pool: pool.size,
    budget: budgets.resolvePatchBudget({ pixelCount: W * H, gpuTier: 'discrete', patchVerticesPerSide: 33 }),
  }));
});
`;

const tmp = `${ROOT}packages/render/test/__bench_profile.test.ts`;
writeFileSync(tmp, SCRIPT);
let out = '';
try {
  out = execFileSync('npx', ['vitest', 'run', tmp, '--reporter=basic'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
execFileSync('rm', ['-f', tmp]);
const marker = out.indexOf('###PROF###');
if (marker < 0) {
  console.error(out);
  process.exit(1);
}
const payload = JSON.parse(out.slice(marker + 10, out.indexOf('\n', marker)));
const lines = [];
lines.push('# M1 CPU profile');
lines.push('');
lines.push(`Host: ${os.type()} ${os.release()} ${os.arch()}, ${os.cpus().length} x ${os.cpus()[0]?.model ?? '?'}`);
lines.push(`Node: ${process.version}`);
lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
lines.push(`Viewport: 2560×1440   patch 33×33   tier discrete   maxLevel 12`);
lines.push(`Resolved budget: ${payload.budget.maxVisiblePatches} patches, ${(payload.budget.maxTriangles / 1e6).toFixed(2)} M tris, ${payload.budget.pxPerTriangle.toFixed(2)} px/tri (${payload.budget.limitedBy})`);
lines.push(`RSS ${(payload.rss / 1e6).toFixed(0)} MB   heap ${(payload.heap / 1e6).toFixed(0)} MB   node pool ${payload.pool} entries`);
lines.push(`GPU: not present in this environment — Astra fills the GPU column.`);
lines.push('');
lines.push('| situation | altitude | select ms | patches | visited | H-cull | F-cull | tris | maxL | vs 1.0 ms budget |');
lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
for (const r of payload.rows) {
  const flag = r.ms > 1.0 ? 'OVER' : 'ok';
  lines.push(
    `| ${r.name} | ${r.alt.toExponential(1)} m | ${r.ms.toFixed(3)} | ${r.vis} | ${r.visN} | ${r.h} | ${r.f} | ${(r.tri / 1000).toFixed(0)}k | ${r.maxL} | ${flag} |`,
  );
}
lines.push('');
lines.push('Stationary vs the same camera on a subsequent call is the pool-warm number');
lines.push('(included in each row: the situation loop warms the pool as it goes).');
writeFileSync(`${ROOT}tools/bench/m1-profile.out.md`, lines.join('\n') + '\n');
console.log(lines.join('\n'));
