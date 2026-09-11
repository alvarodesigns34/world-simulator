#!/usr/bin/env node
/**
 * Deterministic 60 s orbit→surface trace. Same seed, same cameras, same numbers.
 * Run: node tools/bench/descent-trace.mjs
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const SCRIPT = `
import { it } from 'vitest';
import { EARTH_GEOMETRY, quadkey } from '@ws/data';
import {
  DESCENT, NodePool, createSelectWorkspace, derive, descentCameraAt,
  descentSampleTimes, descentSpeedMps, selectPatches,
} from '@ws/render';

const P = EARTH_GEOMETRY;

it('descent trace', () => {
  const hz = 10;
  const samples = [];
  let prev = new Set();
  let prevSplit = new Set();
  const pool = new NodePool();
  const workspace = createSelectWorkspace();
  for (const t of descentSampleTimes(hz)) {
    const cam = descentCameraAt(t, P);
    const d = derive(cam, P);
    const t0 = performance.now();
    const r = selectPatches(cam, {
      planet: P,
      viewportWidth: DESCENT.viewportWidth,
      viewportHeight: DESCENT.viewportHeight,
      gpuTier: DESCENT.gpuTier,
      patchVerticesPerSide: DESCENT.patchVerticesPerSide,
      maxLevel: DESCENT.maxLevel,
      previouslySplit: prevSplit,
      pool,
      workspace,
    });
    const t1 = performance.now();
    const ids = new Set(r.visible.map((n) => quadkey.packId(n.key)));
    let appeared = 0, disappeared = 0;
    for (const id of ids) if (!prev.has(id)) appeared++;
    for (const id of prev) if (!ids.has(id)) disappeared++;
    samples.push({
      t: +t.toFixed(3),
      altitude: d.altitude,
      speed: descentSpeedMps(t, P),
      lat: d.latitude,
      lon: d.longitude,
      visible: r.stats.visible,
      visited: r.stats.nodesVisited,
      culledHorizon: r.stats.culledHorizon,
      culledFrustum: r.stats.culledFrustum,
      triangles: r.stats.triangles,
      maxLevel: r.stats.maxLevelReached,
      selectMs: t1 - t0,
      budgetPatches: r.stats.budgetPatches,
      budgetExhausted: r.stats.budgetExhausted,
      lodCounts: r.stats.lodCounts,
      appeared,
      disappeared,
      poolHits: r.stats.poolHits,
      poolMisses: r.stats.poolMisses,
    });
    prev = ids;
    prevSplit = r.split;
  }
  console.log('###TRACE###' + JSON.stringify({ seed: DESCENT.seed, hz, samples, poolSize: pool.size }));
});
`;

const tmp = `${ROOT}packages/render/test/__bench_descent.test.ts`;
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

const marker = out.indexOf('###TRACE###');
if (marker < 0) {
  console.error(out);
  process.exit(1);
}
const payload = JSON.parse(out.slice(marker + 11, out.indexOf('\n', marker)));
writeFileSync(`${ROOT}tools/bench/descent-trace.json`, JSON.stringify(payload, null, 2));

const s = payload.samples;
const pick = [0, 12, 24, 32, 40, 50, 60];
const lines = [];
lines.push('# M1 descent trace');
lines.push('');
lines.push(`Host: ${os.type()} ${os.release()} ${os.arch()}, ${os.cpus().length} x ${os.cpus()[0]?.model ?? '?'}`);
lines.push(`Node: ${process.version}`);
lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
lines.push(`Seed: 0x${payload.seed.toString(16)}   ${s.length} samples @ ${payload.hz} Hz   node pool ${payload.poolSize}`);
lines.push(`Viewport: 2560×1440 discrete  patch 33×33  maxLevel 12`);
lines.push('');
lines.push('| t s | altitude | speed | patches | visited | tris | select ms | appear | disappear | maxL | H-cull | F-cull |');
lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const t of pick) {
  const row = s.find((x) => Math.abs(x.t - t) < 1e-6) ?? s.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  lines.push(
    `| ${row.t.toFixed(0)} | ${row.altitude.toExponential(2)} m | ${row.speed.toFixed(0)} m/s | ${row.visible} | ${row.visited} | ${(row.triangles / 1000).toFixed(0)}k | ${row.selectMs.toFixed(3)} | ${row.appeared} | ${row.disappeared} | ${row.maxLevel} | ${row.culledHorizon} | ${row.culledFrustum} |`,
  );
}
const maxSelect = Math.max(...s.map((x) => x.selectMs));
const maxAppear = Math.max(...s.map((x) => x.appeared));
const maxDisappear = Math.max(...s.map((x) => x.disappeared));
const exhausted = s.filter((x) => x.budgetExhausted).length;
const over1 = s.filter((x) => x.selectMs > 1).length;
lines.push('');
lines.push(`max select: ${maxSelect.toFixed(3)} ms   samples > 1.0 ms: ${over1}/${s.length}   max appear/frame: ${maxAppear}   max disappear/frame: ${maxDisappear}   budget-exhausted: ${exhausted}/${s.length}`);
lines.push('');
lines.push('t=0 appear=194 is the initial visible set, not a pop.');
lines.push('Reproduce: `pnpm run bench:descent` or in the running app press **T** (or `?descent`).');
lines.push('Same seed `0x51a51a51`, same keyframes, same cameras.');
writeFileSync(`${ROOT}tools/bench/descent-trace.out.md`, lines.join('\n') + '\n');
console.log(lines.join('\n'));
