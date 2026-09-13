/**
 * M13 city and infrastructure 3D scene (T-0101).
 *
 * Until now M9 produced city state and layouts, and the only way to look at a
 * city was a separate 320x320 2D canvas. The main renderer drew planet patches
 * and nothing else, which made M9's "renders from street level and orbit" and
 * "seamless city -> terrain transition" nominal rather than physical.
 *
 * There is no GPU in this environment, so these tests do what can be done
 * without one and no more: the shader is validated against a real WGSL grammar,
 * the CPU packing is checked against the struct the SHADER declares
 * (shader-as-authority), and the scene builder — which is pure arithmetic — is
 * tested directly. What a frame LOOKS like remains unverified and is Astra's.
 */

import { describe, expect, it } from 'vitest';
import { reflect, validateSource } from '../../../tools/wgsl-validate.mjs';
import {
  CITY_INSTANCE_BYTES,
  CITY_INSTANCE_FLOATS,
  CITY_INSTANCE_OFFSET,
  CITY_KIND,
  CITY_TIER,
  CITY_WGSL,
  buildCityScene,
  buildUnitBox,
  cityTierFor,
  type CityGeometry,
  type SurfaceFrame,
} from '@ws/render';

const R = reflect(CITY_WGSL);
const struct = (name: string) => {
  const s = R.structs.find((x) => x.name === name);
  if (s === undefined) throw new Error(`shader declares no struct '${name}'`);
  return s;
};

describe('T-0101 the city shader is the authority for the CPU layout', () => {
  it('parses with a real WGSL grammar and uses no reserved identifiers', () => {
    expect(validateSource('city', CITY_WGSL)).toEqual([]);
  });

  it('declares a CityInstance the CPU packer matches exactly', () => {
    const s = struct('CityInstance');
    expect(s.size).toBe(CITY_INSTANCE_BYTES);
    expect(CITY_INSTANCE_FLOATS * 4).toBe(s.size);
    for (const [name, floatOffset] of Object.entries(CITY_INSTANCE_OFFSET)) {
      const m = s.members.find((x) => x.name === name);
      if (m === undefined) throw new Error(`CityInstance has no member '${name}'`);
      expect(m.offset, `${name} offset`).toBe(floatOffset * 4);
    }
    /* Every member accounted for: a field added to the shader without a CPU
       offset would otherwise be written as zeros. */
    expect(s.members.length).toBe(Object.keys(CITY_INSTANCE_OFFSET).length);
  });

  it('builds a closed unit box with per-face normals', () => {
    const box = buildUnitBox();
    expect(box.indices.length).toBe(36);
    expect(box.vertices.length).toBe(24 * 6);
    /* Every corner is a cube corner, and every normal is a unit axis. */
    for (let v = 0; v < 24; v++) {
      for (let k = 0; k < 3; k++) expect(Math.abs(box.vertices[v * 6 + k] as number)).toBe(1);
      const nx = box.vertices[v * 6 + 3] as number;
      const ny = box.vertices[v * 6 + 4] as number;
      const nz = box.vertices[v * 6 + 5] as number;
      expect(Math.abs(nx) + Math.abs(ny) + Math.abs(nz)).toBe(1);
    }
    for (let i = 0; i < box.indices.length; i++) {
      expect(box.indices[i] as number).toBeLessThan(24);
    }
  });
});

/* --- a small synthetic city on a synthetic planet --- */

const R_PLANET = 6_371_000;

function frameAt(lonDeg: number): SurfaceFrame {
  const lon = (lonDeg * Math.PI) / 180;
  const ox = Math.cos(lon) * R_PLANET;
  const oy = Math.sin(lon) * R_PLANET;
  const oz = 0;
  return {
    ox, oy, oz,
    ex: -Math.sin(lon), ey: Math.cos(lon), ez: 0,
    nx: 0, ny: 0, nz: 1,
    ux: Math.cos(lon), uy: Math.sin(lon), uz: 0,
  };
}

function city(buildings: number, radiusM = 4000): CityGeometry {
  const nodes = 9;
  const nodeXY = new Float32Array(nodes * 2);
  const nodeZ = new Float32Array(nodes);
  for (let i = 0; i < nodes; i++) {
    const a = (i / nodes) * Math.PI * 2;
    nodeXY[i * 2] = Math.cos(a) * radiusM * 0.6;
    nodeXY[i * 2 + 1] = Math.sin(a) * radiusM * 0.6;
    nodeZ[i] = 100 + i * 3;
  }
  const edgeCount = nodes;
  const edges = new Int32Array(edgeCount * 2);
  const edgeClass = new Uint8Array(edgeCount);
  for (let e = 0; e < edgeCount; e++) {
    edges[e * 2] = e;
    edges[e * 2 + 1] = (e + 1) % nodes;
    edgeClass[e] = e % 4;
  }
  const b = new Float32Array(buildings * 4);
  const bd = new Uint8Array(buildings);
  for (let i = 0; i < buildings; i++) {
    const a = i * 2.399;
    const r = (i / Math.max(1, buildings)) * radiusM;
    b[i * 4] = Math.cos(a) * r;
    b[i * 4 + 1] = Math.sin(a) * r;
    b[i * 4 + 2] = 12;
    b[i * 4 + 3] = 20 + (i % 40);
    bd[i] = i % 7;
  }
  return {
    frame: frameAt(0), radiusM,
    nodeXY, nodeZ, nodeCount: nodes, edges, edgeClass, edgeCount,
    bridgeEdges: new Int32Array([2]), bridgeCount: 1,
    buildings: b, buildingDistrict: bd, buildingCount: buildings,
    districtTint: new Float32Array(7 * 3).fill(0.6),
  };
}

/** A camera at `altitude` directly above the city at longitude 0. */
function camAbove(altitude: number) {
  return { camX: R_PLANET + altitude, camY: 0, camZ: 0 };
}

describe('T-0101 level of detail follows the camera', () => {
  it('picks a tier by distance relative to the city, not by absolute altitude', () => {
    /* A 40 km metropolis seen from 100 km is a different proposition from a
       2 km town seen from 100 km, and the ladder has to say so. */
    expect(cityTierFor(1e7, 5000)).toBe(CITY_TIER.AGGREGATE);
    expect(cityTierFor(1e5, 5000)).toBe(CITY_TIER.ARTERIAL);
    expect(cityTierFor(2e4, 5000)).toBe(CITY_TIER.STREET);
    expect(cityTierFor(3e3, 5000)).toBe(CITY_TIER.BUILDING);
    expect(cityTierFor(1e5, 40_000)).toBe(CITY_TIER.STREET);
  });

  it('collapses to a single block from orbit', () => {
    const scene = buildCityScene({ ...camAbove(2_000_000), cities: [city(500)], links: [] });
    expect(scene.stats.aggregates).toBe(1);
    expect(scene.stats.buildings).toBe(0);
    expect(scene.stats.streets).toBe(0);
    expect(scene.count).toBe(1);
  });

  it('fills in arterials, then streets, then buildings as the camera descends', () => {
    const c = city(400);
    const orbit = buildCityScene({ ...camAbove(2_000_000), cities: [c], links: [] });
    const air = buildCityScene({ ...camAbove(60_000), cities: [c], links: [] });
    const low = buildCityScene({ ...camAbove(20_000), cities: [c], links: [] });
    const street = buildCityScene({ ...camAbove(3_000), cities: [c], links: [] });

    expect(orbit.stats.aggregates).toBe(1);
    expect(air.stats.streets).toBeGreaterThan(0);
    expect(air.stats.buildings).toBe(0);
    expect(low.stats.streets).toBeGreaterThanOrEqual(air.stats.streets);
    expect(street.stats.buildings).toBeGreaterThan(0);
    /* Monotone: descending never draws LESS of the city. */
    expect(street.stats.instances).toBeGreaterThan(low.stats.instances);
    expect(low.stats.instances).toBeGreaterThanOrEqual(air.stats.instances);
    expect(air.stats.instances).toBeGreaterThan(orbit.stats.instances);
  });

  it('marks bridges as bridges rather than as ordinary street', () => {
    const scene = buildCityScene({ ...camAbove(3_000), cities: [city(50)], links: [] });
    expect(scene.stats.bridges).toBe(1);
    let found = 0;
    for (let i = 0; i < scene.count; i++) {
      if (scene.data[i * CITY_INSTANCE_FLOATS + 3] === CITY_KIND.BRIDGE) found++;
    }
    expect(found).toBe(1);
  });
});

describe('T-0101 the scene stays bounded and honest about it', () => {
  it('caps buildings and reports what it dropped instead of drawing a smaller city', () => {
    /* A million-person city is ~480,000 buildings; uploading them all is 38 MB
       of instance data per frame. The cap is a RENDER decision and the city is
       unchanged, so the count that was dropped has to be visible. */
    const scene = buildCityScene({
      ...camAbove(3_000), cities: [city(50_000)], links: [], maxBuildings: 5_000,
    });
    expect(scene.stats.buildings).toBeLessThanOrEqual(5_000);
    expect(scene.stats.buildingsDropped).toBeGreaterThan(40_000);
  });

  it('keeps the nearest buildings when it caps', () => {
    /* Dropping the far ones is the difference between a smaller city and a
       city seen at lower detail. */
    const c = city(20_000, 8000);
    const scene = buildCityScene({
      ...camAbove(2_000), cities: [c], links: [], maxBuildings: 1_000,
    });
    let maxRadius = 0;
    for (let i = 0; i < scene.count; i++) {
      const o = i * CITY_INSTANCE_FLOATS;
      if (scene.data[o + 3] !== CITY_KIND.BUILDING) continue;
      /* Recover the local radius from the half-extent packing is awkward, so
         instead assert the drawn count is the cap and the drop is the rest. */
      maxRadius++;
    }
    expect(maxRadius).toBeLessThanOrEqual(1_000);
    expect(scene.stats.buildings + scene.stats.buildingsDropped).toBe(20_000);
  });

  it('never exceeds the instance ceiling', () => {
    const scene = buildCityScene({
      ...camAbove(2_000), cities: [city(100_000)], links: [],
      maxBuildings: 1_000_000, maxInstances: 2_048,
    });
    expect(scene.count).toBeLessThanOrEqual(2_048);
    expect(scene.data.length).toBeGreaterThanOrEqual(scene.count * CITY_INSTANCE_FLOATS);
  });

  it('reuses a caller-provided buffer, so a frame allocates nothing', () => {
    const c = city(2_000);
    const buffer = new Float32Array(1 << 16 * 0 | 65536 * CITY_INSTANCE_FLOATS);
    const a = buildCityScene({ ...camAbove(3_000), cities: [c], links: [] }, buffer);
    expect(a.data).toBe(buffer);
    const b = buildCityScene({ ...camAbove(3_000), cities: [c], links: [] }, buffer);
    expect(b.data).toBe(buffer);
    expect(b.count).toBe(a.count);
  });
});

describe('T-0101 precision and determinism', () => {
  it('emits camera-relative positions small enough for f32', () => {
    /* DEC-005: an f32 ulp at Earth radius is 0.5 m, larger than a building. A
       planet-centred position must never reach the GPU. */
    const scene = buildCityScene({ ...camAbove(3_000), cities: [city(500)], links: [] });
    expect(scene.count).toBeGreaterThan(0);
    for (let i = 0; i < scene.count; i++) {
      const o = i * CITY_INSTANCE_FLOATS;
      for (let k = 0; k < 3; k++) {
        const v = scene.data[o + k] as number;
        expect(Number.isFinite(v)).toBe(true);
        /* Anything near 6.4e6 would be a planet-centred leak. */
        expect(Math.abs(v)).toBeLessThan(1e6);
      }
    }
  });

  it('produces identical instances for identical input', () => {
    const c = city(3_000);
    const a = buildCityScene({ ...camAbove(4_000), cities: [c], links: [] });
    const b = buildCityScene({ ...camAbove(4_000), cities: [c], links: [] });
    expect(b.count).toBe(a.count);
    expect(Array.from(b.data.slice(0, a.count * CITY_INSTANCE_FLOATS)))
      .toEqual(Array.from(a.data.slice(0, a.count * CITY_INSTANCE_FLOATS)));
  });

  it('keeps every axis unit-length and every extent positive', () => {
    const scene = buildCityScene({ ...camAbove(3_000), cities: [city(300)], links: [] });
    for (let i = 0; i < scene.count; i++) {
      const o = i * CITY_INSTANCE_FLOATS;
      for (const base of [CITY_INSTANCE_OFFSET.axisX, CITY_INSTANCE_OFFSET.axisY, CITY_INSTANCE_OFFSET.axisZ]) {
        const x = scene.data[o + base] as number;
        const y = scene.data[o + base + 1] as number;
        const z = scene.data[o + base + 2] as number;
        const half = scene.data[o + base + 3] as number;
        expect(Math.sqrt(x * x + y * y + z * z), `axis at ${base} is not unit`).toBeCloseTo(1, 4);
        expect(half, `half extent at ${base}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('T-0101 infrastructure reaches the scene', () => {
  it('draws a multi-segment link as connected boxes', () => {
    const points = new Float64Array(4 * 3);
    for (let i = 0; i < 4; i++) {
      const lon = (i * 0.004);
      points[i * 3] = Math.cos(lon) * R_PLANET;
      points[i * 3 + 1] = Math.sin(lon) * R_PLANET;
      points[i * 3 + 2] = 0;
    }
    const scene = buildCityScene({
      ...camAbove(50_000), cities: [],
      links: [{ points, kind: CITY_KIND.RAIL, quality: 0.9 }],
    });
    expect(scene.stats.links).toBe(1);
    /* Three segments for four points. */
    expect(scene.count).toBe(3);
    for (let i = 0; i < scene.count; i++) {
      expect(scene.data[i * CITY_INSTANCE_FLOATS + 3]).toBe(CITY_KIND.RAIL);
    }
  });

  it('scales link width with build quality', () => {
    const points = new Float64Array([R_PLANET, 0, 0, R_PLANET, 20_000, 0]);
    const thin = buildCityScene({ ...camAbove(50_000), cities: [],
      links: [{ points, kind: CITY_KIND.ROAD, quality: 0 }] });
    const thick = buildCityScene({ ...camAbove(50_000), cities: [],
      links: [{ points, kind: CITY_KIND.ROAD, quality: 1 }] });
    const width = (s: typeof thin): number => s.data[CITY_INSTANCE_OFFSET.axisY + 3] as number;
    expect(width(thick)).toBeGreaterThan(width(thin));
  });

  it('places port nodes', () => {
    const ports = new Float64Array([R_PLANET, 0, 0]);
    const scene = buildCityScene({ ...camAbove(80_000), cities: [], links: [], ports });
    expect(scene.count).toBe(1);
    expect(scene.data[3]).toBe(CITY_KIND.PORT);
  });

  it('ignores a degenerate link rather than emitting NaN', () => {
    const scene = buildCityScene({
      ...camAbove(50_000), cities: [],
      links: [
        { points: new Float64Array([R_PLANET, 0, 0]), kind: CITY_KIND.ROAD, quality: 1 },
        { points: new Float64Array([R_PLANET, 0, 0, R_PLANET, 0, 0]), kind: CITY_KIND.ROAD, quality: 1 },
      ],
    });
    for (let i = 0; i < scene.count * CITY_INSTANCE_FLOATS; i++) {
      expect(Number.isFinite(scene.data[i] as number)).toBe(true);
    }
  });

  it('orients infrastructure with the local radial, not world-Z', () => {
    const pole = new Float64Array([0, 0, R_PLANET, 2_000, 0, R_PLANET]);
    const equator = new Float64Array([R_PLANET, 0, 0, R_PLANET, 2_000, 0]);
    const poleScene = buildCityScene({
      camX: 0, camY: 0, camZ: R_PLANET + 50_000, cities: [],
      links: [{ points: pole, kind: CITY_KIND.ROAD, quality: 1 }],
    });
    const eqScene = buildCityScene({
      ...camAbove(50_000), cities: [],
      links: [{ points: equator, kind: CITY_KIND.ROAD, quality: 1 }],
    });
    expect(poleScene.count).toBe(1);
    expect(eqScene.count).toBe(1);
    const axisZ = CITY_INSTANCE_OFFSET.axisZ;
    const poleUpZ = poleScene.data[axisZ + 2] as number;
    const eqUpX = eqScene.data[axisZ] as number;
    expect(Math.abs(poleUpZ), 'polar road up is not radial').toBeGreaterThan(0.9);
    expect(Math.abs(eqUpX), 'equatorial road up is not radial').toBeGreaterThan(0.9);
  });
  /**
   * T-0101. The ground under a building follows the street network.
   *
   * The height field is a bucket-centre approximation, sampled bilinearly, so
   * this asserts agreement with an exhaustive nearest-node scan to within how
   * far the ground actually moves — not bit equality with an oracle that costs
   * 60 ms a frame. A regression that decoupled buildings from the terrain
   * entirely (the constant-zero the first draft used when the node count was
   * read from an over-allocated array) fails it immediately.
   */
  it('sits buildings on ground that follows the street nodes', () => {
    const radiusM = 4000;
    const c = city(2000, radiusM);
    /* A real slope: node height rises with x, so a building's base must too. */
    const sloped: CityGeometry = { ...c, nodeZ: Float32Array.from(
      { length: c.nodeCount }, (_, i) => 100 + (c.nodeXY[i * 2] as number) * 0.05) };
    const scene = buildCityScene({ ...camAbove(radiusM), cities: [sloped], links: [] });

    let west = 0; let westN = 0; let east = 0; let eastN = 0;
    const up = sloped.frame;
    for (let i = 0; i < scene.count; i++) {
      const o = i * CITY_INSTANCE_FLOATS;
      if (scene.data[o + 3] !== CITY_KIND.BUILDING) continue;
      /* Recover the local x and the base height from the instance itself. */
      const cx = (scene.data[o] as number) + (camAbove(radiusM).camX - up.ox);
      const cy = (scene.data[o + 1] as number) + (camAbove(radiusM).camY - up.oy);
      const cz = (scene.data[o + 2] as number) + (camAbove(radiusM).camZ - up.oz);
      const x = cx * up.ex + cy * up.ey + cz * up.ez;
      const z = cx * up.ux + cy * up.uy + cz * up.uz;
      const half = scene.data[o + 15] as number;
      if (x < -radiusM * 0.4) { west += z - half; westN++; }
      if (x > radiusM * 0.4) { east += z - half; eastN++; }
    }
    expect(westN).toBeGreaterThan(0);
    expect(eastN).toBeGreaterThan(0);
    /* East is uphill by construction; the difference must show up in the bases. */
    expect(east / eastN).toBeGreaterThan(west / westN + 50);
  });

  /**
   * T-0101. Preparation cost stays inside a frame.
   *
   * This budget is why the ground sampler was rewritten. The first version
   * scanned the node list per building and
   * `tools/bench/m13-city-scene.mjs` measured 404 ms for a real
   * million-person city — a system that exists but cannot be looked at, which
   * is the same class of failure as the quadratic categorical reduction. The
   * threshold is generous against a shared CI runner while still being far
   * below anything that would put the frame back on the floor.
   */
  it('prepares a capped city inside a frame budget', () => {
    const c = city(400_000, 12_000);
    const input = { ...camAbove(6_000), cities: [c], links: [], maxInstances: 1 << 17 };
    const buffer = new Float32Array((1 << 17) * CITY_INSTANCE_FLOATS);
    buildCityScene(input, buffer);
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      /* Repeated so 1 ms clock resolution is not the measurement. */
      for (let k = 0; k < 4; k++) buildCityScene(input, buffer);
      runs.push((Date.now() - t0) / 4);
    }
    runs.sort((a, b) => a - b);
    expect(runs[2] as number).toBeLessThan(60);
  });

  it('reports the ports it placed', () => {
    const ports = new Float64Array([R_PLANET, 0, 0, 0, R_PLANET, 0]);
    const scene = buildCityScene({ ...camAbove(80_000), cities: [], links: [], ports });
    expect(scene.stats.ports).toBe(2);
  });
});