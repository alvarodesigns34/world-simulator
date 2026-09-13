import { describe, expect, it } from 'vitest';
import { reflect, validateSource } from '../../../tools/wgsl-validate.mjs';
import {
  BINDINGS,
  ENTRY_POINTS,
  INSTANCE_BYTES,
  INSTANCE_FLOATS,
  INSTANCE_OFFSET,
  UNIFORM_BYTES,
  UNIFORM_OFFSET,
  VERTEX_ATTR,
} from '../src/gpu/layout.js';
import { FLOATS_PER_INSTANCE, patchCorners } from '../src/gpu/instance.js';
import { cameraFromGeodetic, lookAtCentre } from '../src/camera/state.js';
import { selectPatches } from '../src/lod/select.js';
import { EARTH_GEOMETRY } from '@ws/data';
import { PLANET_WGSL } from '../src/shaders/planet.wgsl.js';

/**
 * THE CPU↔GPU CONTRACT (T-0061).
 *
 * Astra's Ampere pass found four defects that a green TypeScript build could
 * not see, because the CPU and the shader agreed only by convention. This suite
 * parses the WGSL with a real grammar and asserts the CPU constants against
 * what the shader ACTUALLY declares — shader-as-authority, not the reverse.
 *
 * If someone adds a field to `PatchInstance`, or reorders the uniform members,
 * or renames an entry point, these fail before a GPU ever sees it.
 */

const R = reflect(PLANET_WGSL);
const struct = (name: string) => {
  const s = R.structs.find((x) => x.name === name);
  if (s === undefined) throw new Error(`shader declares no struct '${name}'`);
  return s;
};
const member = (structName: string, memberName: string) => {
  const m = struct(structName).members.find((x) => x.name === memberName);
  if (m === undefined) throw new Error(`${structName} has no member '${memberName}'`);
  return m;
};

describe('WGSL parses and is free of the identifier classes that broke Ampere', () => {
  it('parses with a real WGSL grammar, not a regex', () => {
    expect(validateSource('planet', PLANET_WGSL)).toEqual([]);
  });

  it('declares exactly the entry points the pipeline asks for', () => {
    expect(R.vertexEntries.map((e) => e.name)).toContain(ENTRY_POINTS.vertex);
    expect(R.fragmentEntries.map((e) => e.name)).toContain(ENTRY_POINTS.fragment);
  });
});

describe('Uniforms: WGSL layout matches the CPU staging array', () => {
  it('is 112 bytes — mat4x4 + vec4 + vec4 + vec4, no padding', () => {
    expect(struct('Uniforms').size).toBe(UNIFORM_BYTES);
    expect(struct('Uniforms').align).toBe(16);
  });

  it.each([
    ['viewProj', UNIFORM_OFFSET.viewProj, 'mat4x4'],
    ['sunDirection', UNIFORM_OFFSET.sunDirection, 'vec4'],
    ['params', UNIFORM_OFFSET.params, 'vec4'],
    ['camK', UNIFORM_OFFSET.camK, 'vec4'],
  ])('member %s sits at CPU float offset %i and is %s', (name, floatOffset, type) => {
    const m = member('Uniforms', name);
    expect(m.offset).toBe(floatOffset * 4);
    expect(m.type).toBe(type);
  });

  it('has no vec3 member — the classic WGSL alignment trap', () => {
    for (const m of struct('Uniforms').members) expect(m.type).not.toBe('vec3');
  });

  it('is bound where the pipeline binds it', () => {
    const u = R.uniforms.find((x) => x.typeName === 'Uniforms');
    expect(u?.group).toBe(0);
    expect(u?.binding).toBe(BINDINGS.uniforms);
  });
});

describe('PatchInstance: WGSL layout matches the CPU packer', () => {
  it('matches the storage array stride after adding simulation surface state', () => {
    expect(struct('PatchInstance').size).toBe(INSTANCE_BYTES);
    expect(struct('PatchInstance').align).toBe(16);
    const s = struct('PatchInstance');
    expect(Math.ceil(s.size / s.align) * s.align).toBe(s.size);
  });

  it('matches FLOATS_PER_INSTANCE, the number the packer strides by', () => {
    expect(INSTANCE_FLOATS).toBe(FLOATS_PER_INSTANCE);
    expect(struct('PatchInstance').size).toBe(FLOATS_PER_INSTANCE * 4);
  });

  it.each([
    ['c00', INSTANCE_OFFSET.c00],
    ['c10', INSTANCE_OFFSET.c10],
    ['c01', INSTANCE_OFFSET.c01],
    ['c11', INSTANCE_OFFSET.c11],
    ['elev', INSTANCE_OFFSET.elev],
  ])('corner %s sits at CPU float offset %i', (name, floatOffset) => {
    const m = member('PatchInstance', name);
    expect(m.offset).toBe(floatOffset * 4);
    expect(m.type).toBe('vec4');
  });

  it('declares its members in the order the packer writes them', () => {
    expect(struct('PatchInstance').members.map((m) => m.name)).toEqual(['c00', 'c10', 'c01', 'c11', 'elev', 'surface']);
  });

  it('has exactly six members — another would silently shift the stride', () => {
    expect(struct('PatchInstance').members).toHaveLength(6);
  });

  it('is bound where the pipeline binds it', () => {
    const s = R.storage.find((x) => x.name === 'instances');
    expect(s?.group).toBe(0);
    expect(s?.binding).toBe(BINDINGS.instances);
  });
});

describe('vertex input: WGSL @location matches the vertex buffer layout', () => {
  it('takes one vec2 at the location the pipeline provides', () => {
    const vs = R.vertexEntries.find((e) => e.name === ENTRY_POINTS.vertex);
    const grid = vs?.inputs.find((i) => i.location === VERTEX_ATTR.shaderLocation);
    expect(grid).toBeDefined();
    expect(grid?.type).toBe('vec2');
  });

  it('float32x2 at stride 8 is exactly one vec2<f32>', () => {
    expect(VERTEX_ATTR.format).toBe('float32x2');
    expect(VERTEX_ATTR.arrayStride).toBe(8);
    expect(VERTEX_ATTR.offset).toBe(0);
  });

  it('has no other @location input the pipeline would have to supply', () => {
    const vs = R.vertexEntries.find((e) => e.name === ENTRY_POINTS.vertex);
    const located = vs?.inputs.filter((i) => i.location !== null && i.builtin === null) ?? [];
    expect(located).toHaveLength(1);
  });
});

/**
 * MAGNITUDES THAT REACH THE GPU (DEC-005, DEC-033).
 *
 * Grok removed the planet-centre reconstruction, so nothing of magnitude |camera|
 * is stored. But "no forbidden identifier" is a name check; what matters is the
 * arithmetic. These assert the numbers themselves, at every altitude from a
 * metre to high orbit.
 *
 * The invariant is scale-RELATIVE and that is the point. f32 error grows with
 * distance, but so does the size of a pixel, and both grow linearly — so the
 * ratio is constant. A fixed absolute bound would be the wrong contract.
 */
describe('worst-case f32 magnitudes reaching the shader', () => {
  const P = EARTH_GEOMETRY;

  it.each([1, 100, 1e4, 1e6, 1.2e7, 4e7])(
    'at %i m altitude, every corner is representable far below a pixel',
    (altitude) => {
      const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.3, lon: 0.6, altitude }, P));
      const sel = selectPatches(cam, {
        planet: P,
        viewportWidth: 2560,
        viewportHeight: 1440,
        gpuTier: 'discrete',
        patchVerticesPerSide: 33,
        maxLevel: 12,
      });
      expect(sel.visible.length).toBeGreaterThan(0);

      let worstRatio = 0;
      for (const node of sel.visible) {
        const c = patchCorners(node.key, P.radius, cam.position);
        for (const corner of [c.c00, c.c10, c.c01, c.c11]) {
          const d = Math.hypot(corner.x, corner.y, corner.z);
          if (d === 0) continue;
          // f32 quantisation at this magnitude.
          const ulp = 2 ** (Math.floor(Math.log2(d)) - 23);
          // What one pixel spans laterally at the same distance.
          const pixel = (d * 2 * Math.tan(cam.fovY / 2)) / 1440;
          worstRatio = Math.max(worstRatio, ulp / pixel);
        }
      }
      // Position error stays under a thousandth of a pixel at every scale.
      expect(worstRatio).toBeLessThan(1e-3);
    },
  );

  it('no corner component ever approaches planet radius when near the surface', () => {
    const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.2, lon: 1.1, altitude: 2 }, P));
    const sel = selectPatches(cam, {
      planet: P,
      viewportWidth: 2560,
      viewportHeight: 1440,
      gpuTier: 'discrete',
      patchVerticesPerSide: 33,
      maxLevel: 12,
    });
    for (const node of sel.visible) {
      const c = patchCorners(node.key, P.radius, cam.position);
      for (const corner of [c.c00, c.c10, c.c01, c.c11]) {
        // The horizon at 2 m altitude is ~5 km away; nothing may be planet-scale.
        expect(Math.hypot(corner.x, corner.y, corner.z)).toBeLessThan(1e6);
      }
    }
  });

  /**
   * Tangent vectors are corner differences, so they cancel. The LOD rule bounds
   * how bad that can get: a patch is only kept far away if its screen-space
   * error is small, which bounds patchSize/distance from below. Without that
   * argument a tiny patch at orbital distance would give a garbage normal.
   */
  it('corner differences keep enough relative precision for the normal', () => {
    for (const altitude of [1e3, 1e6, 4e7]) {
      const cam = lookAtCentre(cameraFromGeodetic({ lat: 0.3, lon: 0.6, altitude }, P));
      const sel = selectPatches(cam, {
        planet: P,
        viewportWidth: 2560,
        viewportHeight: 1440,
        gpuTier: 'discrete',
        patchVerticesPerSide: 33,
        maxLevel: 12,
      });
      for (const node of sel.visible) {
        const c = patchCorners(node.key, P.radius, cam.position);
        const d = Math.hypot(c.c00.x, c.c00.y, c.c00.z);
        const edge = Math.hypot(c.c10.x - c.c00.x, c.c10.y - c.c00.y, c.c10.z - c.c00.z);
        const ulp = 2 ** (Math.floor(Math.log2(Math.max(d, 1))) - 23);
        // Relative error of the tangent stays far below a milliradian.
        expect(ulp / Math.max(edge, 1e-9)).toBeLessThan(1e-3);
      }
    }
  });
});
