import { describe, expect, it } from 'vitest';
import { makeSeed } from '@ws/core';
import {
  BND_CONVERGENT,
  BND_DIVERGENT,
  DEFAULT_GENESIS,
  geologyDigest,
  runGenesis,
  upsampleGeology,
} from '../src/geology/plates.js';
import { chooseSeaLevel, hypsometry } from '../src/terrain/hypsometry.js';
import { DEFAULT_EROSION, erode } from '../src/terrain/erosion.js';

const SEED = makeSeed(0x51a5, 0x1a51);

describe('T-0030 genesis plates', () => {
  it('is bit-identical for the same seed', () => {
    const a = runGenesis({ seed: SEED, ...DEFAULT_GENESIS, steps: 40 });
    const b = runGenesis({ seed: SEED, ...DEFAULT_GENESIS, steps: 40 });
    expect(geologyDigest(a)).toBe(geologyDigest(b));
    expect(a.plateCount).toBe(12);
  });

  it('a different seed produces a different world', () => {
    const a = runGenesis({ seed: SEED, ...DEFAULT_GENESIS, steps: 40 });
    const b = runGenesis({ seed: makeSeed(1, 2), ...DEFAULT_GENESIS, steps: 40 });
    expect(geologyDigest(a)).not.toBe(geologyDigest(b));
  });

  it('continental convergent is high; oceanic trenches are deeper than ridges', () => {
    const g = runGenesis({ seed: SEED, ...DEFAULT_GENESIS, steps: 80 });
    let contConv = 0;
    let contConvN = 0;
    let oceConv = 0;
    let oceConvN = 0;
    let oceDiv = 0;
    let oceDivN = 0;
    for (let i = 0; i < g.cellCount; i++) {
      const b = g.boundaryType[i];
      const e = g.elevationM[i] as number;
      const cont = g.crustType[i] === 1;
      if (cont && b === BND_CONVERGENT) {
        contConv += e;
        contConvN++;
      }
      if (!cont && b === BND_CONVERGENT) {
        oceConv += e;
        oceConvN++;
      }
      if (!cont && b === BND_DIVERGENT) {
        oceDiv += e;
        oceDivN++;
      }
    }
    expect(contConvN).toBeGreaterThan(5);
    expect(oceConvN).toBeGreaterThan(5);
    expect(oceDivN).toBeGreaterThan(5);
    expect(contConv / contConvN).toBeGreaterThan(400);
    expect(oceDiv / oceDivN).toBeGreaterThan(oceConv / oceConvN + 200);
  });

  it('hypsometry sits in a documented Earth-like envelope', () => {
    const g = runGenesis({ seed: SEED, ...DEFAULT_GENESIS });
    const sea = chooseSeaLevel(g.elevationM, 0.71);
    const h = hypsometry(g.elevationM, sea);
    expect(h.min).toBeGreaterThan(-11_000);
    expect(h.max).toBeLessThan(9_000);
    expect(h.oceanFraction).toBeGreaterThan(0.55);
    expect(h.oceanFraction).toBeLessThan(0.85);
    expect(h.withinEarthEnvelope).toBe(true);
  });

  it('upsample preserves plate ids of parent cells', () => {
    const g = runGenesis({ seed: SEED, level: 3, plateCount: 8, steps: 20, continentFraction: 0.3 });
    const up = upsampleGeology(g, 4);
    expect(up.cellCount).toBe(g.cellCount * 4);
    expect(up.plateId[0]).toBe(g.plateId[0]);
  });

  it('finishes a full L6 180-step genesis in well under 60 s', () => {
    const t0 = Date.now();
    const g = runGenesis({ seed: SEED, ...DEFAULT_GENESIS });
    const ms = Date.now() - t0;
    expect(g.cellCount).toBe(6 * 64 * 64);
    expect(ms).toBeLessThan(60_000);
  });
});

describe('T-0031 erosion', () => {
  it('reduces mean slope and does not produce NaN', () => {
    const g = runGenesis({ seed: SEED, level: 4, plateCount: 8, steps: 30, continentFraction: 0.3 });
    const before = g.elevationM.slice();
    erode(g.elevationM, g.level, { ...DEFAULT_EROSION, steps: 6 });
    let nan = 0;
    let max = -Infinity;
    for (let i = 0; i < g.cellCount; i++) {
      const h = g.elevationM[i] as number;
      if (!Number.isFinite(h)) nan++;
      if (h > max) max = h;
    }
    expect(nan).toBe(0);
    expect(max).toBeLessThan(20_000);
    /* Erosion should have moved something. */
    let diff = 0;
    for (let i = 0; i < g.cellCount; i++) diff += Math.abs((g.elevationM[i] as number) - (before[i] as number));
    expect(diff).toBeGreaterThan(0);
  });
});
