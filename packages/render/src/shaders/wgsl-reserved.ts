/**
 * WGSL identifier scanner used by tests. The full reserved-word list lives in
 * `tools/check-wgsl.mjs` so this file cannot trip the `import … from` regex
 * (the token `from` is itself reserved).
 *
 * Astra's Ampere run rejected `meta` as a struct field.
 */

export interface WgslIdentifierHit {
  readonly name: string;
  readonly reason: 'reserved' | 'forbidden-camera';
}

/** The identifiers we plant tests for. The check script has the complete list. */
const RESERVED_PLANTED = new Set(['meta']);

const FORBIDDEN_CAMERA = new Set([
  'cameraPCF',
  'cameraPcf',
  'camera_pcf',
  'cameraPos',
  'cameraPosition',
  'camera_pos',
  'centreRel',
  'centerRel',
  'fromCentre',
  'fromCenter',
  'planetCentre',
  'planetCenter',
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
    if (RESERVED_PLANTED.has(name)) {
      seen.add(name);
      hits.push({ name, reason: 'reserved' });
    } else if (FORBIDDEN_CAMERA.has(name)) {
      seen.add(name);
      hits.push({ name, reason: 'forbidden-camera' });
    }
  }
  return hits;
}
