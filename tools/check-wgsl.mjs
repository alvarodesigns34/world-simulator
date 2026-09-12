#!/usr/bin/env node
/**
 * WGSL gate. Parses every shader with a real WGSL grammar, then applies the
 * identifier rules the grammar cannot express. See tools/wgsl-validate.mjs for
 * what this does and does not guarantee.
 */
import { validateAll } from './wgsl-validate.mjs';

const { problems, reflected } = validateAll();

if (problems.length > 0) {
  console.error('\nWGSL validation failed:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\n${problems.length} problem(s).\n`);
  process.exit(1);
}

const names = Object.keys(reflected);
const structs = names.flatMap((n) => reflected[n].structs.map((s) => `${s.name}(${s.size}B)`));
console.log(`WGSL OK — parsed ${names.length} shader(s); structs: ${structs.join(', ') || 'none'}`);
