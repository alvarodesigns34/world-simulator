/**
 * WGSL identifier rules — THE single source of truth (T-0060).
 *
 * Astra's Ampere run rejected `meta` as a struct field name and left a black
 * canvas. The lesson is not "ban meta"; it is that a green TypeScript build
 * says nothing about whether WGSL compiles.
 *
 * This module previously held one word (`meta`) while `tools/check-wgsl.mjs`
 * held the full list — two sources of truth for one rule, where the test-facing
 * copy knew 1/170th of it. A shader using `layout`, `filter` or `sample` would
 * have passed the test and failed the tool. Both now import from here.
 *
 * The tool consumes this file directly (Node strips the types), so there is no
 * build step and no copy to drift.
 */

export interface WgslIdentifierHit {
  readonly name: string;
  readonly reason: 'reserved' | 'forbidden-camera';
}

/**
 * W3C WGSL reserved words. Reserved words parse fine as identifiers, so a WGSL
 * grammar will NOT catch them — which is why this list still exists alongside
 * the real parser in `tools/wgsl-validate.mjs`.
 */
export const WGSL_RESERVED: ReadonlySet<string> = new Set([
  'NULL', 'Self', 'abstract', 'active', 'alignas', 'alignof',
  'as', 'asm', 'asm_fragment', 'async', 'attribute', 'auto',
  'await', 'become', 'binding_array', 'cast', 'catch', 'class',
  'co_await', 'co_return', 'co_yield', 'coherent', 'column_major', 'common',
  'compile', 'compile_fragment', 'concept', 'const_cast', 'consteval', 'constexpr',
  'constinit', 'crate', 'debugger', 'decltype', 'delete', 'demote',
  'demote_to_helper', 'do', 'dynamic_cast', 'enum', 'explicit', 'export',
  'extends', 'extern', 'external', 'fallthrough', 'filter', 'final',
  'finally', 'friend', 'from', 'fxgroup', 'get', 'goto',
  'groupshared', 'highp', 'impl', 'implements', 'import', 'inline',
  'instanceof', 'interface', 'layout', 'lowp', 'macro', 'macro_rules',
  'match', 'mediump', 'meta', 'mod', 'module', 'move',
  'mut', 'mutable', 'namespace', 'new', 'nil', 'noexcept',
  'noinline', 'nointerpolation', 'noperspective', 'null', 'nullptr', 'of',
  'operator', 'package', 'packoffset', 'partition', 'pass', 'payload',
  'pixel_center_integer', 'precise', 'precision', 'premerge', 'priv', 'protected',
  'pub', 'public', 'readonly', 'ref', 'regardless', 'register',
  'reinterpret_cast', 'require', 'resource', 'restrict', 'self', 'set',
  'shared', 'sizeof', 'smooth', 'snorm', 'static', 'static_assert',
  'static_cast', 'std', 'subroutine', 'super', 'target', 'template',
  'this', 'thread_local', 'throw', 'trait', 'try', 'type',
  'typedef', 'typeid', 'typename', 'typeof', 'union', 'unless',
  'unorm', 'unsafe', 'unsized', 'use', 'using', 'varying',
  'virtual', 'volatile', 'wgsl', 'where', 'with', 'writeonly',
  'yield',
]);

/**
 * Identifiers that indicate a planet-scale f32 reconstruction has returned
 * (DEC-033 rule 1). The shader must never hold a planet-centred position: at
 * Earth radius one f32 ulp is 0.5 m, and `centreRel + dir * R` cancels two
 * 6.4e6-magnitude terms to produce a small one, which is the worst case for it.
 */
export const DEC033_FORBIDDEN: ReadonlySet<string> = new Set([
  'cameraPCF', 'cameraPcf', 'camera_pcf', 'cameraPos', 'cameraPosition',
  'camera_pos', 'centreRel', 'centerRel', 'fromCentre', 'fromCenter',
  'planetCentre', 'planetCenter',
]);

/** Strip line and block comments, then string literals, then scan. */
export function scanWgslIdentifiers(source: string): string[] {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const noLine = noBlock.replace(/\/\/.*$/gm, ' ');
  const noStrings = noLine.replace(/"([^"\\]|\\.)*"/g, ' ');
  const ids: string[] = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noStrings)) !== null) ids.push(m[0]);
  return ids;
}

export function findIllegalWgslIdentifiers(source: string): WgslIdentifierHit[] {
  const hits: WgslIdentifierHit[] = [];
  const seen = new Set<string>();
  for (const name of scanWgslIdentifiers(source)) {
    if (seen.has(name)) continue;
    if (WGSL_RESERVED.has(name)) {
      seen.add(name);
      hits.push({ name, reason: 'reserved' });
    } else if (DEC033_FORBIDDEN.has(name)) {
      seen.add(name);
      hits.push({ name, reason: 'forbidden-camera' });
    }
  }
  return hits;
}
