/**
 * T-0151. The height page pool, and the packing the shader reads.
 *
 * These are structural: they assert the contract between the pool, the packed
 * material float and the WGSL that unpacks it. They do NOT assert that the
 * planet looks right — nothing in a test can — but a break here is a break the
 * eye would see as a blank or mis-shaded patch, and it is cheaper to catch it
 * from the shader's own declared layout than from a screenshot.
 */

import { describe, expect, it } from 'vitest';
import { reflect } from '../../../tools/wgsl-validate.mjs';
import { quadkey } from '@ws/data';
import { PAGE_STRIDE, packMaterial } from '../src/gpu/height-pool.js';
import { INSTANCE_OFFSET, PAGE_LANE } from '../src/gpu/layout.js';
import { FLOATS_PER_INSTANCE, packPatchInstance, patchCorners } from '../src/gpu/instance.js';
import { PLANET_WGSL } from '../src/shaders/planet.wgsl.js';
import { SKY_WGSL } from '../src/shaders/sky.wgsl.js';
import { EARTH_GEOMETRY } from '@ws/data';

/** The shader's own unpack, mirrored so the two cannot drift apart silently. */
function unpackMaterial(packed: number): readonly [number, number, number, number] {
  const veg = Math.floor(packed / 262144);
  const r1 = packed - veg * 262144;
  const snow = Math.floor(r1 / 4096);
  const r2 = r1 - snow * 4096;
  const water = Math.floor(r2 / 64);
  const weather = r2 - water * 64;
  return [veg / 63, snow / 63, water / 63, weather / 63];
}

describe('height page packing', () => {
  it('round-trips four fractions through one f32 within a quantisation step', () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      for (const s of [0, 0.33, 1]) {
        const packed = packMaterial(v, s, 1 - v, s * 0.5);
        const got = unpackMaterial(packed);
        expect(got[0]).toBeCloseTo(v, 1);
        expect(got[1]).toBeCloseTo(s, 1);
        expect(got[2]).toBeCloseTo(1 - v, 1);
        expect(got[3]).toBeCloseTo(s * 0.5, 1);
      }
    }
  });

  it('stays an exact integer, so f32 never rounds a channel into its neighbour', () => {
    for (let i = 0; i <= 63; i++) {
      const packed = packMaterial(i / 63, 1, 1, 1);
      expect(Number.isInteger(packed)).toBe(true);
      expect(packed).toBeLessThan(2 ** 24);
      expect(unpackMaterial(packed)[0] * 63).toBeCloseTo(i, 6);
    }
  });

  it('clamps out-of-range input rather than corrupting the neighbouring bits', () => {
    const low = unpackMaterial(packMaterial(-5, -1, -0.001, -9));
    const high = unpackMaterial(packMaterial(5, 2, 1.001, 99));
    expect(low).toEqual([0, 0, 0, 0]);
    expect(high).toEqual([1, 1, 1, 1]);
  });

  it('declares the same stride the shader indexes with', () => {
    expect(PAGE_STRIDE).toBe(2);
    expect(PLANET_WGSL).toMatch(/const PAGE_STRIDE : i32 = 2;/);
  });
});

describe('the page lane reaches the shader', () => {
  const R = reflect(PLANET_WGSL);
  const patch = R.structs.find((s) => s.name === 'PatchInstance');

  it('is a member of PatchInstance at the CPU offset', () => {
    const member = patch?.members.find((m) => m.name === 'page');
    expect(member).toBeDefined();
    expect(member?.offset).toBe(INSTANCE_OFFSET.page * 4);
    expect(member?.type).toBe('vec4');
  });

  it('binds a heights storage buffer the CPU knows about', () => {
    const heights = R.storage.find((s) => s.name === 'heights');
    expect(heights?.group).toBe(0);
    expect(heights?.binding).toBe(2);
  });

  it('packs -1 when no page is available, which is the shader fallback', () => {
    const buf = new Float32Array(FLOATS_PER_INSTANCE);
    packPatchInstance(buf, 0, patchCorners(quadkey.rootKey(0), EARTH_GEOMETRY.radius, { x: 0, y: 0, z: 0 }));
    expect(buf[INSTANCE_OFFSET.page + PAGE_LANE.index]).toBe(-1);
    expect(PLANET_WGSL).toMatch(/if \(pageIndex >= 0\)/);
  });

  it('carries spacing, side and skirt in the lanes the shader reads', () => {
    const buf = new Float32Array(FLOATS_PER_INSTANCE);
    packPatchInstance(buf, 0, {
      ...patchCorners(quadkey.rootKey(0), EARTH_GEOMETRY.radius, { x: 0, y: 0, z: 0 }),
      page: [7, 1234.5, 35, 42],
    });
    expect(buf[INSTANCE_OFFSET.page + PAGE_LANE.index]).toBe(7);
    expect(buf[INSTANCE_OFFSET.page + PAGE_LANE.spacingM]).toBe(1234.5);
    expect(buf[INSTANCE_OFFSET.page + PAGE_LANE.side]).toBe(35);
    expect(buf[INSTANCE_OFFSET.page + PAGE_LANE.skirtM]).toBe(42);
  });
});

describe('the sky pass', () => {
  it('declares its own uniforms rather than borrowing the planet lanes', () => {
    const R = reflect(SKY_WGSL);
    const u = R.uniforms.find((x) => x.typeName === 'SkyUniforms');
    expect(u?.group).toBe(0);
    expect(u?.binding).toBe(0);
    const s = R.structs.find((x) => x.name === 'SkyUniforms');
    expect(s?.members.map((m) => m.name)).toEqual(['forward', 'right', 'up', 'sun', 'radial']);
  });

  it('has a vertex and fragment entry point and no vec3 uniform member', () => {
    const R = reflect(SKY_WGSL);
    expect(R.vertexEntries.map((e) => e.name)).toContain('vs');
    expect(R.fragmentEntries.map((e) => e.name)).toContain('fs');
    const s = R.structs.find((x) => x.name === 'SkyUniforms');
    for (const m of s?.members ?? []) expect(m.type).not.toBe('vec3');
  });
});
