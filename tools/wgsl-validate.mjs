/**
 * WGSL validation library (T-0060).
 *
 * WHY THIS EXISTS. Astra's Ampere pass proved that a green TypeScript build says
 * nothing about whether the WGSL compiles: `meta` is a WGSL reserved word, the
 * shader module failed on the GPU, and the canvas went black. A regex over a
 * reserved-word list closes exactly that one hole and nothing else.
 *
 * So this does three complementary things, and it is honest about the boundary
 * between them:
 *
 *   1. PARSE the shader with `wgsl_reflect` — a real WGSL grammar. Catches
 *      syntax errors, malformed types, bad attributes. Cannot catch reserved
 *      words (they parse fine as identifiers) and does not type-check.
 *   2. RESERVED WORDS — the W3C list. This is the `meta` class of bug.
 *   3. DEC-033 identifiers — names that indicate a planet-scale f32
 *      reconstruction has come back.
 *
 * WHAT IT STILL DOES NOT GUARANTEE, stated plainly so nobody trusts it too far:
 * it is not a compiler. It will not catch a type mismatch, an out-of-range
 * binding, a missing `@location`, a uniform that exceeds a device limit, or a
 * driver-specific rejection. Only a real GPU does that — which is why
 * `windingProbe` exists and why Astra's pass is still required.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { WGSL_RESERVED, DEC033_FORBIDDEN } from '../packages/render/src/shaders/wgsl-reserved.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SHADER_DIR = join(ROOT, 'packages/render/src/shaders');

/** Pull every /* wgsl *​/ tagged template out of a .ts source file. */
export function extractTemplates(src) {
  const out = [];
  const re = /\/\*\s*wgsl\s*\*\/\s*`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

function stripComments(wgsl) {
  return wgsl.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
}

export function identifiers(wgsl) {
  return stripComments(wgsl).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
}

/**
 * Parse a WGSL source and return a plain, serialisable description of its
 * layout. Plain data on purpose: the test that compares WGSL against the CPU
 * packer must not depend on the parser's object model.
 *
 * Throws on a syntax error — that is the point.
 */
export function reflect(wgsl) {
  const r = new WgslReflect(wgsl);
  return {
    structs: r.structs.map((s) => ({
      name: s.name,
      size: s.size,
      align: s.align,
      members: s.members.map((m) => ({
        name: m.name,
        offset: m.offset,
        size: m.size,
        type: m.type?.name ?? '?',
      })),
    })),
    uniforms: r.uniforms.map((u) => ({
      name: u.name,
      group: u.group,
      binding: u.binding,
      typeName: u.type?.name ?? '?',
    })),
    storage: r.storage.map((s) => ({
      name: s.name,
      group: s.group,
      binding: s.binding,
      typeName: s.type?.name ?? '?',
    })),
    vertexEntries: r.entry.vertex.map((e) => ({
      name: e.name,
      inputs: e.inputs.map((i) => ({
        name: i.name,
        location: typeof i.location === 'number' ? i.location : null,
        type: i.type?.name ?? '?',
        builtin: i.locationType === 'builtin' ? String(i.location) : null,
      })),
    })),
    fragmentEntries: r.entry.fragment.map((e) => ({ name: e.name })),
    computeEntries: r.entry.compute.map((e) => ({ name: e.name })),
  };
}

/** Validate one WGSL source. Returns an array of human-readable problems. */
export function validateSource(label, wgsl) {
  const problems = [];

  // 1. Real parse.
  try {
    reflect(wgsl);
  } catch (err) {
    problems.push(`${label}: WGSL does not parse — ${err instanceof Error ? err.message : String(err)}`);
    // A file that does not parse cannot be meaningfully checked further.
    return problems;
  }

  // 2 & 3. Identifier rules the grammar cannot express.
  const seen = new Set();
  for (const id of identifiers(wgsl)) {
    if (seen.has(id)) continue;
    if (WGSL_RESERVED.has(id)) {
      problems.push(`${label}: reserved WGSL identifier '${id}' (this is the 'meta' class of bug)`);
      seen.add(id);
    } else if (DEC033_FORBIDDEN.has(id)) {
      problems.push(`${label}: DEC-033-forbidden identifier '${id}' — planet-scale f32 reconstruction`);
      seen.add(id);
    }
  }
  return problems;
}

/** Validate every shader in the shader directory. */
export function validateAll() {
  const problems = [];
  const reflected = {};
  for (const name of readdirSync(SHADER_DIR).sort()) {
    if (!name.endsWith('.ts') || name.includes('reserved')) continue;
    const src = readFileSync(join(SHADER_DIR, name), 'utf8');
    const templates = extractTemplates(src);
    if (templates.length === 0) continue;
    templates.forEach((tmpl, i) => {
      const label = templates.length > 1 ? `${name}[${i}]` : name;
      problems.push(...validateSource(label, tmpl));
      try {
        reflected[label] = reflect(tmpl);
      } catch {
        /* already reported */
      }
    });
  }
  return { problems, reflected };
}
