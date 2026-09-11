#!/usr/bin/env node
/**
 * Boundary and determinism checker.
 *
 * This script is what gives DEC-011 and DEC-017 teeth. The project's founding
 * principle (Simulation State != Rendering State) survives about three months as
 * a convention; as a build failure it survives indefinitely.
 *
 * Checks:
 *   1. Package dependency rules  — sim must not import render, and vice versa.
 *   2. Platform purity           — core/data/sim must not touch the DOM or WebGPU.
 *   3. Determinism               — core/data/sim must not use non-deterministic
 *                                  sources of randomness or time (DEC-017).
 *   4. Runtime dependencies      — core/data/sim must have none at all (DEC-027).
 *   5. Renderer containment      — navigator.gpu only inside render/src/gpu.
 *
 * Exit code 1 on any violation. These are errors, not warnings.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = join(ROOT, 'packages');

/** DEC-011. `null` means the package may depend on anything. */
const ALLOWED_DEPS = {
  core: [],
  data: ['core'],
  sim: ['core', 'data'],
  render: ['core', 'data'],
  workers: ['core', 'data'],
  app: null,
  tools: null,
};

/** DEC-002 / DEC-011: these packages must run under plain Node. */
const PURE_PACKAGES = ['core', 'data', 'sim'];

const BANNED_PLATFORM = [
  [/\bwindow\./, 'window'],
  [/\bdocument\./, 'document'],
  [/\bnavigator\./, 'navigator'],
  [/\brequestAnimationFrame\b/, 'requestAnimationFrame'],
  [/\bGPUDevice\b|\bGPUBuffer\b|\bGPUTexture\b/, 'WebGPU types'],
];

/**
 * DEC-017, widened by T-0046 (AUDIT-V0 M9).
 *
 * The M0 checker caught only the three obvious spellings. PROTOCOL §6 claims
 * more than that as enforced, so either the checker grows or the protocol is
 * lying. It grows.
 */
const BANNED_DETERMINISM = [
  [/\bMath\.random\b/, 'Math.random (DEC-017: use hashU64 with an explicit key)'],
  // Quoted-property access evades the dotted form entirely.
  // Quoted-property access evades the dotted form, however it is reached.
  [/\[\s*['"`]random['"`]\s*\]\s*\(/, '["random"]() (DEC-017: quoted access is still Math.random)'],
  [/\bglobalThis\s*\.\s*Math\s*\.\s*random\b/, 'globalThis.Math.random (DEC-017)'],
  [/\bDate\.now\b/, 'Date.now (DEC-017: sim time comes from SimTime)'],
  [/\bperformance\s*\.\s*now\b/, 'performance.now (DEC-017: use telemetry, not sim logic)'],
  [/\bperformance\s*\[\s*['"`]now/, 'performance["now"] (DEC-017)'],
  [/\bnew Date\b/, 'new Date (DEC-017)'],
  [/\bcrypto\s*\.\s*getRandomValues\b/, 'crypto.getRandomValues (DEC-017)'],
  [/\bcrypto\s*\.\s*randomUUID\b/, 'crypto.randomUUID (DEC-017)'],
  // A sort with no comparator is locale/implementation-defined for non-strings
  // and is a classic silent order dependence. DEC-017 requires a total order.
  [/\.sort\s*\(\s*\)/, '.sort() without an explicit comparator (DEC-017: reductions fold in key order)'],
  [/\bMath\.max\s*\(\s*\.\.\./, 'Math.max(...spread) over a large array (stack overflow risk; also hides order)'],
];

/**
 * Tier-A code (DEC-018) must not use native transcendentals: Math.sin/exp/pow
 * are implementation-defined and not bit-exact across engines. Only files that
 * opt in with the marker below are checked, because Tier B/C legitimately use
 * them and `stableMath` does not exist yet (R-11, T-0021).
 */
const TIER_A_MARKER = '@tier A';
const BANNED_TIER_A = [
  [/\bMath\.(sin|cos|tan|asin|acos|atan|atan2|exp|log|log2|log10|pow|cbrt|sinh|cosh|tanh)\b/,
   'native Math transcendental in @tier A code (DEC-018: use stableMath)'],
  [/\*\*/, 'exponentiation operator in @tier A code (DEC-018: ** on non-integers is Math.pow)'],
];

/** DEC-027: zero runtime dependencies in core/data/sim. */
const ZERO_DEP_PACKAGES = ['core', 'data', 'sim'];

const violations = [];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(p, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** Strips line and block comments so a rule name in prose is not a violation. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;

function report(file, line, message) {
  violations.push(`${relative(ROOT, file)}${line ? `:${line}` : ''}  ${message}`);
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

const packageNames = existsSync(PACKAGES)
  ? readdirSync(PACKAGES).filter((d) => statSync(join(PACKAGES, d)).isDirectory()).sort()
  : [];

for (const pkg of packageNames) {
  const allowed = ALLOWED_DEPS[pkg];
  if (allowed === undefined) {
    violations.push(`packages/${pkg}  unknown package — add it to ALLOWED_DEPS in tools/check-boundaries.mjs (DEC-011 requires an ADR)`);
    continue;
  }

  // 4. Runtime dependency policy (DEC-027).
  if (ZERO_DEP_PACKAGES.includes(pkg)) {
    const manifest = join(PACKAGES, pkg, 'package.json');
    if (existsSync(manifest)) {
      const deps = JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {};
      for (const dep of Object.keys(deps)) {
        const bare = dep.replace(/^@ws\//, '');
        if (!dep.startsWith('@ws/')) {
          report(manifest, 0, `DEC-027: '${pkg}' must have zero runtime dependencies, found '${dep}'`);
        } else if (allowed !== null && !allowed.includes(bare)) {
          report(manifest, 0, `DEC-011: '${pkg}' may not depend on '${bare}'`);
        }
      }
    }
  }

  for (const file of walk(join(PACKAGES, pkg, 'src'))) {
    const raw = readFileSync(file, 'utf8');
    const src = stripComments(raw);

    // 1. Dependency rules.
    if (allowed !== null) {
      for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1];
        const ws = /^@ws\/([a-z]+)/.exec(spec);
        if (!ws) {
          if (!spec.startsWith('.') && !spec.startsWith('node:')) {
            report(file, lineOf(src, m.index), `DEC-027: '${pkg}' may not import external package '${spec}'`);
          }
          continue;
        }
        const target = ws[1];
        if (target !== pkg && !allowed.includes(target)) {
          report(file, lineOf(src, m.index), `DEC-011: '${pkg}' may not import '@ws/${target}' (allowed: ${allowed.join(', ') || 'nothing'})`);
        }
      }
    }

    // 2 & 3. Purity and determinism.
    if (PURE_PACKAGES.includes(pkg)) {
      for (const [re, name] of [...BANNED_PLATFORM, ...BANNED_DETERMINISM]) {
        const m = re.exec(src);
        if (m) report(file, lineOf(src, m.index), `'${pkg}' must not use ${name}`);
      }
      // Insertion-order iteration over a Map/Set is order-dependent and is the
      // determinism hole a regex can most easily miss. Rather than guessing from
      // the variable's NAME (which fails the moment someone calls it `m`), find
      // identifiers actually constructed as `new Map`/`new Set` in this file and
      // flag iteration over those.
      //
      // Limits, stated honestly: this sees one file and no types. A collection
      // received as a parameter or returned from another module is invisible to
      // it. That residue is a review item, not a mechanical one — PROTOCOL §6
      // says so rather than pretending otherwise.
      const collections = new Set();
      for (const m of src.matchAll(
        /(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b/g,
      )) {
        collections.add(m[1]);
      }
      if (collections.size > 0) {
        const names = [...collections].join('|');
        const iterRe = new RegExp(
          `(?:for\\s*\\([^)]*\\bof\\s+(${names})\\b` +
            `|\\b(${names})\\.(?:forEach|keys|values|entries)\\s*\\(` +
            `|\\[\\s*\\.\\.\\.\\s*(${names})\\s*\\])`,
          'g',
        );
        for (const m of src.matchAll(iterRe)) {
          const lineNo = lineOf(src, m.index);
          const prev = (raw.split('\n')[lineNo - 2] ?? '') + (raw.split('\n')[lineNo - 1] ?? '');
          if (prev.includes('deterministic-order:')) continue;
          const name = m[1] ?? m[2] ?? m[3];
          report(
            file,
            lineNo,
            `'${pkg}' iterates '${name}' in insertion order (DEC-017). Sort by an explicit ` +
              `key before folding, or annotate with '// deterministic-order: <why>'`,
          );
        }
      }
    }

    // 3b. Tier-A transcendental ban, opt-in per file.
    if (raw.includes(TIER_A_MARKER)) {
      for (const [re, name] of BANNED_TIER_A) {
        const m = re.exec(src);
        if (m) report(file, lineOf(src, m.index), `${name}`);
      }
    }

    // 5. Renderer containment (DEC-003).
    if (pkg === 'render' && !file.includes(`${sep}gpu${sep}`)) {
      const m = /\bnavigator\.gpu\b/.exec(src);
      if (m) report(file, lineOf(src, m.index), 'DEC-003: navigator.gpu is only permitted inside render/src/gpu/');
    }
  }
}

if (violations.length > 0) {
  console.error('\nBoundary violations:\n');
  for (const v of violations) console.error(`  ${v}`);
  console.error(`\n${violations.length} violation(s). These are errors, not warnings.`);
  console.error('See agent/DECISIONS.md (DEC-011, DEC-017, DEC-027) and agent/PROTOCOL.md §6.\n');
  process.exit(1);
}

console.log(`Boundaries OK — checked ${packageNames.length} package(s): ${packageNames.join(', ')}`);
