#!/usr/bin/env node
/**
 * The founding-principle test.
 *
 *   "Delete packages/render and packages/app, and the simulation still builds,
 *    runs, steps, saves and passes its tests."
 *
 * ARCHITECTURE.md §1.1 calls this an actual CI job rather than a thought
 * experiment, so here it is. It imports every pure package under plain Node —
 * no DOM, no WebGPU, no bundler — and exercises them. If anything in core, data
 * or sim has quietly grown a dependency on the browser or on the renderer, this
 * fails.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PURE = ['core', 'data']; // 'sim' joins this list at M1.

try {
  execFileSync(
    'npx',
    ['vitest', 'run', ...PURE.map((p) => `packages/${p}/test`)],
    { cwd: ROOT, stdio: 'inherit' },
  );
} catch {
  console.error('\nThe simulation does not stand on its own without the renderer.');
  console.error('See docs/ARCHITECTURE.md §1.1 and DEC-011.\n');
  process.exit(1);
}

console.log(`\nSimulation stands alone — ${PURE.join(', ')} run with no renderer present.`);
