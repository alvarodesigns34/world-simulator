/**
 * T-0096. Deep time is an approximation, and it has to say so and clean up.
 *
 * `transitionRegime` argues that civilisation must not run on geological ticks
 * because "a 100 kyr civilisation tick would skip the entire history of every
 * society". The deep-time path then set civilisation and economy to 1 Myr per
 * step — the same objection, ten times worse — while presenting itself as an
 * ordinary timeline jump. These tests pin the separation and, more importantly,
 * that a jump cannot leave the world integrating at a million years per step.
 */

import { describe, expect, it } from 'vitest';
import { makeSeed } from '@ws/core';
import { createWorld } from '@ws/sim';

function world() {
  return createWorld({
    seed: makeSeed(0x33, 0x91),
    genesis: { level: 4, steps: 16, plateCount: 7 },
    terrainLevel: 4, climateN: 3, erode: false,
  });
}

/** Cadence of a subsystem in simulated seconds, from the scheduler snapshot. */
function cadenceSeconds(w: ReturnType<typeof world>, id: string): number {
  const slot = w.scheduler.snapshot().slots.find((s) => s.id === id);
  expect(slot, `no scheduler slot '${id}'`).toBeDefined();
  const c = slot!.cadence;
  expect(c.kind).toBe('every');
  return c.kind === 'every' ? (c.dt as unknown as number) : NaN;
}

describe('T-0096 the paleo regime keeps civilisation on a civilisation cadence', () => {
  it('runs civilisation at 500 years while geology runs at 100 kyr', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    const y = w.calendar.secondsPerYear;
    expect(w.climate.regime).toBe('paleo');
    expect(cadenceSeconds(w, 'civilisation') / y).toBeCloseTo(500, 3);
    expect(cadenceSeconds(w, 'economy') / y).toBeCloseTo(500, 3);
    expect(cadenceSeconds(w, 'geology') / y).toBeCloseTo(100_000, 3);
  }, 60000);
});

describe('T-0096 the deep-time path is a declared approximation', () => {
  it('restores every cadence afterwards — no million-year civilisation step survives', () => {
    /* The hazard: a UI jump silently leaving civilisation integrating at 1 Myr
       per step for the rest of the session. */
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    const y = w.calendar.secondsPerYear;

    w.advanceDeepTimeApproximate(5e6);

    expect(cadenceSeconds(w, 'civilisation') / y).toBeCloseTo(500, 3);
    expect(cadenceSeconds(w, 'economy') / y).toBeCloseTo(500, 3);
    expect(cadenceSeconds(w, 'climate') / y).toBeCloseTo(100_000, 3);
    expect(cadenceSeconds(w, 'hydrology') / y).toBeCloseTo(100_000, 3);
    expect(cadenceSeconds(w, 'biosphere') / y).toBeCloseTo(100_000, 3);
    expect(cadenceSeconds(w, 'geology') / y).toBeCloseTo(100_000, 3);
  }, 120000);

  it('declares the reduced civilisation model rather than leaving full detail running', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    w.advanceDeepTimeApproximate(2e6);
    /* Paleo keeps aggregate detail; the point is that it is set deliberately by
       the deep-time path and not left at 'full' while stepping by megayears. */
    expect(w.civilisation.detail).toBe('aggregate');
  }, 120000);

  it('reverts to a fine regime cleanly after a jump', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    w.advanceDeepTimeApproximate(3e6);

    w.apply({ kind: 'setTimeScale', scale: 1 });
    const y = w.calendar.secondsPerYear;
    expect(w.climate.regime).toBe('explicit');
    expect(w.civilisation.detail).toBe('full');
    expect(cadenceSeconds(w, 'civilisation') / y).toBeCloseTo(1, 3);
    /* Geology stays on its fixed simulation-time cadence in every regime. */
    expect(cadenceSeconds(w, 'geology') / y).toBeCloseTo(100_000, 3);

    /* And the world still steps without exploding. */
    w.advance(3600);
    expect(Number.isFinite(w.civilisation.totalPopulation)).toBe(true);
    expect(Number.isFinite(w.climate.T[0] as number)).toBe(true);
  }, 120000);

  it('leaves no corrupt state: every published field stays finite', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    w.advanceDeepTimeApproximate(2e7);
    for (const [name, a] of [
      ['elevation', w.hydrology.elevationM],
      ['temperature', w.climate.T],
      ['soilMoisture', w.hydrology.soilMoistureM],
      ['npp', w.biosphere.nppKgM2Yr],
      ['pollution', w.economy.pollution],
      ['price', w.economy.price],
    ] as const) {
      for (let i = 0; i < a.length; i++) {
        if (!Number.isFinite(a[i] as number)) {
          throw new Error(`${name}[${String(i)}] is not finite after a deep-time jump`);
        }
      }
    }
  }, 180000);

  it('is deterministic and replays through the command log', () => {
    /* A deep-time jump is logged as a command; replaying the log must land on
       the same world, which is what makes the approximation reproducible even
       though it is an approximation. */
    const a = world();
    a.apply({ kind: 'setTimeScale', scale: 1e8 });
    a.advanceDeepTimeApproximate(4e6);

    const b = world();
    for (const entry of a.commands.entries) {
      if (entry.cmd.kind === 'advanceDeepTime') b.advanceDeepTimeApproximate(entry.cmd.years);
      else b.apply(entry.cmd);
    }
    expect(b.digest()).toBe(a.digest());
  }, 180000);

  it('records the jump in history as an approximation', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    w.advanceDeepTimeApproximate(1e6);
    const labels = w.history.events().map((e: { label: string }) => e.label);
    expect(labels.some((l: string) => l.toLowerCase().includes('approximation'))).toBe(true);
  }, 120000);
});
