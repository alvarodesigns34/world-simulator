#!/usr/bin/env node
/**
 * Self-test for the boundary checker.
 *
 * A check that has never been seen to fail is not a check. M0's acceptance
 * criteria require proving that `check:boundaries` actually rejects a violation,
 * so this plants three temporary violations, asserts each is caught, and removes
 * them.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHECKER = join(ROOT, 'tools', 'check-boundaries.mjs');

const CASES = [
  {
    name: 'DEC-011: data importing a package it may not depend on',
    file: join(ROOT, 'packages/data/src/__selftest_dep.ts'),
    // Split so this file's own source never contains a literal violation.
    source: `import { x } from '@ws/${'render'}';\nexport const y = x;\n`,
    expect: 'DEC-011',
  },
  {
    name: 'DEC-017: non-deterministic randomness in a pure package',
    file: join(ROOT, 'packages/core/src/__selftest_rand.ts'),
    source: `export const r = Math["rando" + "m"] ? Math.rand${'om'}() : 0;\n`,
    expect: 'DEC-017',
  },
  {
    name: 'DEC-011: DOM access in a pure package',
    file: join(ROOT, 'packages/core/src/__selftest_dom.ts'),
    source: `export const w = (globalThis as never as { win${'dow'}: { innerWidth: number } }).win${'dow'}.innerWidth;\n`,
    expect: 'must not use',
  },
  // T-0046 (AUDIT-V0 M9): the three cases the M0 checker missed.
  {
    name: 'DEC-017: quoted-property Math["random"]',
    file: join(ROOT, 'packages/core/src/__selftest_qrand.ts'),
    source: `export const r: number = (Math as never as Record<string, () => number>)["rand${'om'}"]();\n`,
    expect: 'DEC-017',
  },
  {
    name: 'DEC-017: sort() without a comparator',
    file: join(ROOT, 'packages/core/src/__selftest_sort.ts'),
    source: `export const xs = [3, 1, 2].so${'rt'}();\n`,
    expect: 'DEC-017',
  },
  {
    name: 'DEC-017: Map iterated in insertion order',
    file: join(ROOT, 'packages/core/src/__selftest_mapiter.ts'),
    source:
      `const m = new Map<string, number>();\n` +
      `export function total(): number {\n` +
      `  let s = 0;\n` +
      `  for (const [, v] of m) s += v;\n` +
      `  return s;\n` +
      `}\n`,
    expect: 'DEC-017',
  },
  {
    name: 'DEC-018: native Math.sin in @tier A code',
    file: join(ROOT, 'packages/core/src/__selftest_tiera.ts'),
    source: `/** @tier A */\nexport const s = Math.s${'in'}(1);\n`,
    expect: 'DEC-018',
  },
];

let failures = 0;

function runChecker() {
  try {
    execFileSync('node', [CHECKER], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// Baseline: the repository as it stands must pass.
const baseline = runChecker();
if (baseline.code !== 0) {
  console.error('SELFTEST ABORTED: the checker already fails on a clean tree.\n' + baseline.out);
  process.exit(1);
}

for (const c of CASES) {
  writeFileSync(c.file, c.source);
  const r = runChecker();
  rmSync(c.file, { force: true });

  if (r.code === 0) {
    console.error(`  FAIL  not caught: ${c.name}`);
    failures++;
  } else if (!r.out.includes(c.expect)) {
    console.error(`  FAIL  caught but wrong reason (expected '${c.expect}'): ${c.name}`);
    console.error(r.out);
    failures++;
  } else {
    console.log(`  ok    caught: ${c.name}`);
  }
}

// Make sure we left nothing behind.
for (const c of CASES) {
  if (existsSync(c.file)) {
    console.error(`  FAIL  selftest left ${c.file} behind`);
    failures++;
  }
}

if (runChecker().code !== 0) {
  console.error('  FAIL  the tree does not pass again after cleanup');
  failures++;
}

if (failures > 0) {
  console.error(`\n${failures} self-test failure(s): the boundary checker is not protecting us.`);
  process.exit(1);
}
console.log('Boundary checker self-test OK — violations are rejected.');
