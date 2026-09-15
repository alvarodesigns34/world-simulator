/**
 * T-0099. M12 export/import: what round-trips, and what does not.
 *
 * The acceptance said "export -> import -> identical values" for everything.
 * That held for the JSON field format, was untrue for WS-RASTER-LIKE-1 (which
 * had no reader at all), and was never meaningful for the CSV series export.
 * These tests pin the contract that is now actually offered.
 */

import { describe, expect, it } from 'vitest';
import { makeSeed } from '@ws/core';
import {
  SCIENTIFIC_FIELDS,
  createWorld,
  exportFieldJson,
  exportRasterLike,
  exportSeriesCsv,
  importFieldJson,
  importRasterLike,
  scientificField,
} from '@ws/sim';

function world() {
  const w = createWorld({
    seed: makeSeed(0x2e, 0x77),
    genesis: { level: 3, steps: 10, plateCount: 6 },
    terrainLevel: 3, climateN: 2, erode: false,
  });
  w.apply({ kind: 'setTimeScale', scale: 1e8 });
  w.advance(100_000 * w.calendar.secondsPerYear);
  return w;
}

describe('T-0099 field formats round-trip exactly', () => {
  it('JSON: every descriptor returns bit-identical values', () => {
    const w = world();
    for (const d of SCIENTIFIC_FIELDS) {
      const view = scientificField(w, d.id);
      const back = importFieldJson(exportFieldJson(view));
      expect(back.descriptor.id, `${d.id}: descriptor lost`).toBe(d.id);
      expect(back.level, `${d.id}: level lost`).toBe(view.level);
      expect(back.values.length, `${d.id}: length lost`).toBe(view.values.length);
      for (let i = 0; i < view.values.length; i++) {
        /* Identity, not closeness: these are exact decimal doubles. */
        if ((back.values[i] as number) !== (view.values[i] as number)) {
          throw new Error(`${d.id}[${String(i)}] changed: ${String(view.values[i])} -> ${String(back.values[i])}`);
        }
      }
      if (view.vectorV !== undefined) {
        expect(back.vectorV, `${d.id}: vector component lost`).toBeDefined();
        for (let i = 0; i < view.vectorV.length; i++) {
          expect(back.vectorV![i]).toBe(view.vectorV[i]);
        }
      }
    }
  }, 120000);

  it('WS-RASTER-LIKE-1: every cube field returns bit-identical values', () => {
    /* The format had no reader. The claim is now true rather than softened. */
    const w = world();
    let checked = 0;
    for (const d of SCIENTIFIC_FIELDS) {
      if (d.grid !== 'cubesphere') continue;
      const view = scientificField(w, d.id);
      const back = importRasterLike(exportRasterLike(view));
      expect(back.level).toBe(view.level);
      expect(back.values.length).toBe(view.values.length);
      for (let i = 0; i < view.values.length; i++) {
        if ((back.values[i] as number) !== (view.values[i] as number)) {
          throw new Error(`${d.id}[${String(i)}] changed through the raster container`);
        }
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  }, 120000);

  it('WS-RASTER-LIKE-1 keeps saying it is not GeoTIFF', () => {
    const w = world();
    const text = exportRasterLike(scientificField(w, 'elevation'));
    const parsed = JSON.parse(text) as { format: string; warning: string; grid: string };
    expect(parsed.format).toBe('WS-RASTER-LIKE-1');
    expect(parsed.warning).toContain('not GeoTIFF');
    expect(parsed.grid).toBe('tangent-cubesphere');
  }, 60000);

  it('refuses a payload that is not the raster it claims to be', () => {
    const w = world();
    const view = scientificField(w, 'elevation');
    const good = JSON.parse(exportRasterLike(view)) as Record<string, unknown>;

    expect(() => importRasterLike(JSON.stringify({ ...good, format: 'GeoTIFF' }))).toThrow(/WS-RASTER-LIKE-1/);
    expect(() => importRasterLike(JSON.stringify({ ...good, grid: 'equirectangular' }))).toThrow(/grid/);
    /* A cube level has exactly 6*4^level cells; anything else is a different
       raster wearing this header. */
    expect(() => importRasterLike(JSON.stringify({ ...good, values: [1, 2, 3] }))).toThrow(/cells/);
    expect(() => importRasterLike(JSON.stringify({ format: 'WS-RASTER-LIKE-1', grid: 'tangent-cubesphere' })))
      .toThrow(/missing/);
  }, 60000);

  it('rejects a geodesic field rather than writing a cube header over it', () => {
    const w = world();
    expect(() => exportRasterLike(scientificField(w, 'temperature'))).toThrow(/cube-sphere/);
  }, 60000);
});

describe('T-0099 CSV is a time-series export, and only that', () => {
  it('emits recorded history with units, one row per sample', () => {
    const w = world();
    const csv = exportSeriesCsv(w, ['population', 'temperature']);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('series,year,seconds,value,units,span');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      const cells = line.split(',');
      expect(cells.length).toBe(6);
      expect(['population', 'temperature']).toContain(cells[0]);
      expect(Number.isFinite(Number(cells[3]))).toBe(true);
    }
  }, 60000);

  it('has no importer, by decision rather than by omission', async () => {
    /* CSV describes a trajectory the world has already taken. Writing the rows
       back would not reconstruct the state that produced them, so M12's
       round-trip claim covers the two FIELD formats and not this one. */
    const mod = await import('@ws/sim') as Record<string, unknown>;
    expect(typeof mod.exportSeriesCsv).toBe('function');
    expect(mod.importSeriesCsv).toBeUndefined();
    /* The field formats, which DO claim a round trip, both have readers. */
    expect(typeof mod.importFieldJson).toBe('function');
    expect(typeof mod.importRasterLike).toBe('function');
  });

  it('refuses an unknown series instead of emitting an empty column', () => {
    const w = world();
    expect(() => exportSeriesCsv(w, ['not-a-series'])).toThrow(/unknown history series/);
  }, 60000);
});
