import { describe, expect, it } from 'vitest';
import { cubeIndex } from '@ws/data';
import {
  SCIENTIFIC_FIELDS,
  createWorld,
  exportFieldJson,
  exportRasterLike,
  geodesicCrossSection,
  importFieldJson,
  probeScientificField,
  scientificField,
  verticalProfile,
} from '../src/index.js';

const world = createWorld({ terrainLevel: 3, hydrologyLevel: 3, climateN: 2,
  genesis: { level: 3, plateCount: 7, steps: 8 }, erode: false });

describe('M12 scientific visualisation', () => {
  it('registers complete units, domains and category-safe interpolation', () => {
    expect(SCIENTIFIC_FIELDS.length).toBeGreaterThanOrEqual(30);
    for (const field of SCIENTIFIC_FIELDS) {
      expect(field.units.length).toBeGreaterThan(0);
      expect(field.domain[0]).toBeLessThan(field.domain[1]);
      if (field.kind === 'categorical') expect(['nearest', 'mode']).toContain(field.interpolation);
      else expect(field.interpolation).not.toBe('nearest');
      expect(() => scientificField(world, field.id)).not.toThrow();
    }
  });

  it('reports the exact authoritative value under a cube probe', () => {
    const result = probeScientificField(world, 'elevation', 0, 0);
    const possible = new Set(Array.from(world.geology.elevationM));
    expect(possible.has(result.value)).toBe(true);
    expect(result.formatted).toContain('m');
  });

  it('samples a spherical geodesic with exact endpoints and honest reduced profiles', () => {
    const section = geodesicCrossSection(world, { lat: 0, lon: 0 }, { lat: 0, lon: Math.PI / 2 }, 9);
    expect(section[0]?.fraction).toBe(0);
    expect(section.at(-1)?.fraction).toBe(1);
    expect(section.at(-1)?.distanceM).toBeCloseTo(Math.PI * 6_371_000 / 2, -2);
    expect(section.every((s) => Number.isFinite(s.elevationM + s.temperatureK))).toBe(true);
    expect(verticalProfile(world, 0, 0).model).toBe('reduced-column');
  });

  it('round-trips JSON and documented GeoTIFF-like values exactly', () => {
    const view = scientificField(world, 'boundaryType');
    const imported = importFieldJson(exportFieldJson(view));
    expect(Array.from(imported.values)).toEqual(Array.from(view.values));
    const raster = JSON.parse(exportRasterLike(view)) as { format: string; warning: string; values: number[] };
    expect(raster.format).toBe('WS-RASTER-LIKE-1');
    expect(raster.warning).toBe('This is not GeoTIFF.');
    expect(raster.values[cubeIndex(0, world.geology.level, 0, 0)]).toBe(view.values[0]);
  });
});
