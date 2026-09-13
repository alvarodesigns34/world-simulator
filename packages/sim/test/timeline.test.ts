import { describe, expect, it } from 'vitest';
import { EARTH_CALENDAR, makeSeed } from '@ws/core';
import {
  HistoryStore,
  WORLD_HISTORY_SERIES,
  createWorld,
  loadSnapshot,
  migrateSave,
  replayRecipe,
  saveRecipe,
  saveSnapshot,
} from '../src/index.js';

const options = {
  seed: makeSeed(0x11, 0x13), terrainLevel: 3, hydrologyLevel: 3,
  climateN: 2, genesis: { level: 3, plateCount: 7, steps: 8 }, erode: false,
};

describe('M11 timeline, replay and saves', () => {
  it('keeps every adjacent T0-T4 transition and T0->T4->T0 finite', () => {
    const world = createWorld(options);
    const regimes = ['explicit', 'synoptic', 'climatology', 'paleo',
      'climatology', 'synoptic', 'explicit', 'paleo', 'explicit'] as const;
    for (const regime of regimes) {
      world.apply({ kind: 'setRegime', regime });
      expect(world.climate.regime).toBe(regime);
      expect(world.civilisation.totalPopulation).toBeGreaterThanOrEqual(0);
      expect(world.economy.stock.every(Number.isFinite)).toBe(true);
      expect(world.hydrology.soilMoistureM.every(Number.isFinite)).toBe(true);
    }
    /* A direct regime command is authoritative too; the next climate tick must
       not silently reclassify it from the unrelated timeScale scalar. */
    world.apply({ kind: 'setRegime', regime: 'paleo' });
    world.advance(100_000 * EARTH_CALENDAR.secondsPerYear);
    expect(world.climate.regime).toBe('paleo');
    world.apply({ kind: 'setRegime', regime: 'explicit' });
    world.advance(3600);
    expect(world.climate.regime).toBe('explicit');
  });

  it('replays seed + command log to the exact Tier-A digest under 100 kB', () => {
    const world = createWorld(options);
    world.apply({ kind: 'setRegime', regime: 'climatology' });
    world.advance(EARTH_CALENDAR.secondsPerYear * 3);
    world.apply({ kind: 'bookmark', label: 'three years' });
    const recipe = saveRecipe(world);
    expect(recipe.length).toBeLessThan(100_000);
    expect(replayRecipe(recipe).digest()).toBe(world.digest());
  });

  it('round-trips a snapshot and continues bit-identically', () => {
    const world = createWorld(options);
    world.apply({ kind: 'setRegime', regime: 'climatology' });
    world.advance(EARTH_CALENDAR.secondsPerYear * 2);
    const loaded = loadSnapshot(saveSnapshot(world));
    expect(loaded.digest()).toBe(world.digest());
    world.advance(EARTH_CALENDAR.secondsPerYear);
    loaded.advance(EARTH_CALENDAR.secondsPerYear);
    expect(loaded.digest()).toBe(world.digest());
  });

  it('migrates v1 recipes and rejects unknown schemas loudly', () => {
    const legacy = JSON.stringify({ kind: 'recipe', schema: 1, seed: [0x11, 0x13], options,
      commands: [{ cmd: { kind: 'setRegime', regime: 'synoptic' } }] });
    expect(JSON.parse(migrateSave(legacy)).schema).toBe(2);
    expect(() => migrateSave('{"kind":"snapshot","schema":99}')).toThrow(/unsupported save schema 99/);
  });

  it('bounds and decimates old history while preserving recent detail', () => {
    const history = new HistoryStore(WORLD_HISTORY_SERIES, 8, 4, 16);
    for (let i = 0; i < 100; i++) history.record({ year: i, seconds: 0 }, {
      population: i, settlements: i, cities: i, temperature: 280, seaLevel: 0,
      ice: 0, biomass: 1, trade: 0, production: 0, pollution: 0,
    });
    const samples = history.samples('population');
    expect(samples.length).toBeLessThanOrEqual(32);
    expect(samples.at(-1)?.value).toBe(99);
    expect(samples.some((sample) => sample.span > 1)).toBe(true);
  });
});
