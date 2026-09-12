import { describe, expect, it } from 'vitest';
import { PLANET_WGSL, FLOATS_PER_INSTANCE, findIllegalWgslIdentifiers } from '@ws/render';

describe('WGSL identifier gate (Ampere / DEC-033)', () => {
  it('rejects the reserved word that blacked the canvas: meta', () => {
    const hits = findIllegalWgslIdentifiers(`
      struct PatchInstance { originRel : vec4<f32>, meta : vec4<f32> };
    `);
    expect(hits.some((h) => h.name === 'meta' && h.reason === 'reserved')).toBe(true);
  });

  it('rejects a camera-PCF uniform name (DEC-033 rule 1)', () => {
    const hits = findIllegalWgslIdentifiers(`
      struct Uniforms { viewProj : mat4x4<f32>, cameraPCF : vec3<f32> };
    `);
    expect(hits.some((h) => h.name === 'cameraPCF' && h.reason === 'forbidden-camera')).toBe(
      true,
    );
  });

  it('rejects the centreRel reconstruction identifiers Ampere executed', () => {
    const hits = findIllegalWgslIdentifiers(`
      let centreRel = vec3<f32>(p.tangentU.w, p.tangentV.w, p.originRel.w);
      let fromCentre = onFace - centreRel;
    `);
    expect(hits.some((h) => h.name === 'centreRel' && h.reason === 'forbidden-camera')).toBe(true);
    expect(hits.some((h) => h.name === 'fromCentre' && h.reason === 'forbidden-camera')).toBe(true);
  });

  it('the planet shader contains no illegal identifiers', () => {
    expect(findIllegalWgslIdentifiers(PLANET_WGSL)).toEqual([]);
  });

  it('the planet shader does not reconstruct a planet-centred position', () => {
    expect(PLANET_WGSL).not.toMatch(/\bcentreRel\b/);
    expect(PLANET_WGSL).not.toMatch(/\bcenterRel\b/);
    expect(PLANET_WGSL).not.toMatch(/fromCentre/);
    expect(PLANET_WGSL).not.toMatch(/cameraPCF|cameraPos|camera_pcf/);
    expect(PLANET_WGSL).not.toMatch(/\bmeta\b/);
    expect(PLANET_WGSL).toMatch(/\bc00\b/);
    expect(PLANET_WGSL).toMatch(/\bc11\b/);
    expect(PLANET_WGSL).toMatch(/mix\(/);
  });

  it('PatchInstance is five vec4s matching FLOATS_PER_INSTANCE', () => {
    expect(FLOATS_PER_INSTANCE).toBe(20);
    const fields = PLANET_WGSL.match(/^\s+c\d\d\s*:/gm);
    expect(fields?.length).toBe(4);
    expect(PLANET_WGSL).toMatch(/\belev\b/);
  });
});
