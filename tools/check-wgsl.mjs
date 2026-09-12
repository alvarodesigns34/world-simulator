#!/usr/bin/env node
/**
 * Cheap WGSL identifier gate. Does not compile shaders (that needs a GPU).
 * Catches reserved-word identifiers (`meta`) and DEC-033 camera-PCF names
 * in packages/render/src/shaders/*.ts template strings.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHADER_DIR = join(ROOT, 'packages/render/src/shaders');

const RESERVED = new Set([
  'NULL', 'Self', 'abstract', 'active', 'alignas', 'alignof', 'as', 'asm',
  'asm_fragment', 'async', 'attribute', 'auto', 'await', 'become',
  'binding_array', 'cast', 'catch', 'class', 'co_await', 'co_return',
  'co_yield', 'coherent', 'column_major', 'common', 'compile',
  'compile_fragment', 'concept', 'const_cast', 'consteval', 'constexpr',
  'constinit', 'crate', 'debugger', 'decltype', 'delete', 'demote',
  'demote_to_helper', 'do', 'dynamic_cast', 'enum', 'explicit', 'export',
  'extends', 'extern', 'external', 'fallthrough', 'filter', 'final',
  'finally', 'friend', 'from', 'fxgroup', 'get', 'goto', 'groupshared',
  'highp', 'impl', 'implements', 'import', 'inline', 'instanceof',
  'interface', 'layout', 'lowp', 'macro', 'macro_rules', 'match', 'mediump',
  'meta', 'mod', 'module', 'move', 'mut', 'mutable', 'namespace', 'new',
  'nil', 'noexcept', 'noinline', 'nointerpolation', 'noperspective', 'null',
  'nullptr', 'of', 'operator', 'package', 'packoffset', 'partition', 'pass',
  'payload', 'pixel_center_integer', 'precise', 'precision', 'premerge',
  'priv', 'protected', 'pub', 'public', 'readonly', 'ref', 'regardless',
  'register', 'reinterpret_cast', 'require', 'resource', 'restrict', 'self',
  'set', 'shared', 'sizeof', 'smooth', 'snorm', 'static', 'static_assert',
  'static_cast', 'std', 'subroutine', 'super', 'target', 'template', 'this',
  'thread_local', 'throw', 'trait', 'try', 'type', 'typedef', 'typeid',
  'typename', 'typeof', 'union', 'unless', 'unorm', 'unsafe', 'unsized',
  'use', 'using', 'varying', 'virtual', 'volatile', 'wgsl', 'where', 'with',
  'writeonly', 'yield',
]);

const FORBIDDEN_CAMERA = new Set([
  'cameraPCF', 'cameraPcf', 'camera_pcf', 'cameraPos', 'cameraPosition',
  'camera_pos', 'centreRel', 'centerRel', 'fromCentre', 'fromCenter',
  'planetCentre', 'planetCenter',
]);

function extractTemplates(src) {
  const out = [];
  const re = /\/\*\s*wgsl\s*\*\/\s*`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

function identifiers(wgsl) {
  const noBlock = wgsl.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const noLine = noBlock.replace(/\/\/.*$/gm, ' ');
  const noStrings = noLine.replace(/"([^"\\]|\\.)*"/g, ' ');
  return noStrings.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
}

let failed = 0;
for (const name of readdirSync(SHADER_DIR)) {
  if (!name.endsWith('.ts') || name.includes('reserved')) continue;
  const src = readFileSync(join(SHADER_DIR, name), 'utf8');
  for (const tmpl of extractTemplates(src)) {
    const seen = new Set();
    for (const id of identifiers(tmpl)) {
      if (seen.has(id)) continue;
      if (RESERVED.has(id)) {
        console.error(`${name}: reserved WGSL identifier '${id}'`);
        failed++;
        seen.add(id);
      } else if (FORBIDDEN_CAMERA.has(id)) {
        console.error(`${name}: DEC-033-forbidden identifier '${id}'`);
        failed++;
        seen.add(id);
      }
    }
  }
}

if (failed > 0) {
  console.error(`WGSL identifier check failed (${failed} unique illegal id(s)).`);
  process.exit(1);
}
console.log('WGSL identifier check OK');
