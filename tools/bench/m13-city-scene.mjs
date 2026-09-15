#!/usr/bin/env node
/**
 * M13 city render preparation budget (T-0101).
 *
 * The cost measured here is the per-frame CPU work between "the world has a
 * city" and "the GPU has instances": LOD selection, camera-relative transform,
 * street and building instancing, and the nearest-first cap. It is main-thread
 * work inside the frame, so its budget is a frame slice, not the 200 ms a
 * layout gets in a worker.
 *
 * Layouts come from the real M9 generator at each level of detail, so the
 * geometry is a real city's, not a synthetic one.
 *
 * Run: node tools/bench/m13-city-scene.mjs
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
import { buildCityScene, CITY_INSTANCE_FLOATS } from '@ws/render';

const seed = makeSeed(0x9, 0x11);
const R = 6371000;
const TERRAIN = { elevationAt: (x, y) => 100 + Math.abs(y) * 0.002, waterAt: (x) => Math.abs(x) < 70 };

function grown(population, technology) {
  const c = initCity({ id: 1, settlementIndex: 0, cell: 0, seed, population: Math.max(5000, population / 60), technology, foundedYear: 0 });
  for (let i = 0; i < 80; i++) stepCity(c, Math.min(population, (population / 60) * (1 + i * 0.9)), technology, 200);
  stepCity(c, population, technology, 200);
  return c;
}

/* A frame on the +Z pole. Any frame does; the arithmetic is the same. */
const FRAME = { ox: 0, oy: 0, oz: R, ex: 1, ey: 0, ez: 0, nx: 0, ny: 1, nz: 0, ux: 0, uy: 0, uz: 1 };

function geometryOf(layout) {
  const tint = new Float32Array(Math.max(1, layout.districtCount) * 3).fill(0.6);
  return {
    frame: FRAME, radiusM: layout.radiusM,
    nodeXY: layout.nodeXY, nodeZ: layout.nodeZ, nodeCount: layout.nodeCount,
    edges: layout.edges, edgeClass: layout.edgeClass, edgeCount: layout.edgeCount,
    bridgeEdges: layout.bridgeEdges, bridgeCount: layout.bridgeCount,
    buildings: layout.buildings, buildingDistrict: layout.buildingDistrict,
    buildingCount: layout.buildingCount, districtTint: tint,
  };
}

function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; }

describe('bench', () => {
  it('m13 city scene', () => {
    const rows = [];
    const buffer = new Float32Array(200000 * CITY_INSTANCE_FLOATS);
    for (const [pop, tech] of [[200000, 0.5], [1000000, 0.75], [8000000, 0.9]]) {
      const city = grown(pop, tech);
      const r = Math.max(1, city.radiusM);
      for (const [tier, lod, relative] of [
        ['aggregate', CITY_LOD.DISTRICTS, 80],
        ['arterial', CITY_LOD.ARTERIALS, 20],
        ['street', CITY_LOD.STREETS, 4],
        ['building', CITY_LOD.PLOTS, 0.8],
      ]) {
        const layout = generateCityLayout(city, TERRAIN, lod);
        const geometry = geometryOf(layout);
        const d = r * relative;
        const cam = { camX: 0, camY: 0, camZ: R + d };
        const input = { ...cam, cities: [geometry], links: [], maxInstances: 200000 };
        let scene = buildCityScene(input, buffer);
        const t = [];
        for (let i = 0; i < 7; i++) {
          const t0 = process.hrtime.bigint();
          scene = buildCityScene(input, buffer);
          t.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }
        rows.push({
          pop, tier, radiusKm: r / 1000,
          layoutBuildings: layout.buildingCount,
          instances: scene.stats.instances,
          buildings: scene.stats.buildings,
          streets: scene.stats.streets,
          dropped: scene.stats.buildingsDropped,
          bytes: scene.stats.instances * CITY_INSTANCE_FLOATS * 4,
          ms: median(t),
        });
      }
    }
    console.log('###BENCH###' + JSON.stringify(rows));
  }, 900000);
});
`;

writeFileSync(`${ROOT}packages/render/test/__bench_m13.test.ts`, SCRIPT);
let out = '';
try {
  out = execFileSync('npx', ['vitest', 'run', 'packages/render/test/__bench_m13.test.ts', '--reporter=dot'],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
execFileSync('rm', ['-f', `${ROOT}packages/render/test/__bench_m13.test.ts`]);

const marker = out.indexOf('###BENCH###');
if (marker < 0) { console.error(out); process.exit(1); }
const rows = JSON.parse(out.slice(marker + 11, out.indexOf('\n', marker)));

const lines = [];
lines.push('# M13 city render preparation');
lines.push('');
lines.push(`${os.cpus()[0]?.model ?? 'unknown cpu'}, Node ${process.version}.`);
lines.push('Real M9 layouts; the measured work is `buildCityScene` alone — LOD choice,');
lines.push('camera-relative transform, instancing and the nearest-first building cap.');
lines.push('Buffer reused across frames, so a steady state allocates nothing.');
lines.push('');
lines.push('| population | radius | tier | layout buildings | instances | drawn buildings | capped | upload | ms |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  lines.push(`| ${r.pop.toLocaleString('en-US')} | ${r.radiusKm.toFixed(1)} km | ${r.tier} | ${r.layoutBuildings.toLocaleString('en-US')} | ${r.instances.toLocaleString('en-US')} | ${r.buildings.toLocaleString('en-US')} | ${r.dropped.toLocaleString('en-US')} | ${(r.bytes / 1e6).toFixed(2)} MB | ${r.ms.toFixed(2)} |`);
}
lines.push('');
const worst = rows.reduce((a, b) => (b.ms > a.ms ? b : a));
lines.push('## Verdict');
lines.push('');
lines.push(`Worst case ${worst.ms.toFixed(2)} ms (${worst.tier} tier, ${worst.pop.toLocaleString('en-US')} people),`);
lines.push(`${worst.instances.toLocaleString('en-US')} instances and ${(worst.bytes / 1e6).toFixed(2)} MB uploaded.`);
lines.push('');
if (worst.ms > 8) {
  lines.push('That is more than half a 16.7 ms frame. Recorded, not glossed: the cap');
  lines.push('is the lever, and it is a render decision that changes no world state.');
} else {
  lines.push('Inside a 16.7 ms frame with room for the terrain pass.');
}
lines.push('');
lines.push('The `capped` column is the honesty column: those buildings exist in the');
lines.push('city and are not drawn. The city is unchanged; the frame is a sample of it.');
lines.push('');

const md = lines.join('\n');
writeFileSync(`${ROOT}tools/bench/m13-city-scene.out.md`, md);
console.log(md);
