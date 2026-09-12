import { describe, expect, it } from 'vitest';
import {
  EARTH_CALENDAR,
  EPOCH,
  addDuration,
  addYears,
  compare,
  dayFraction,
  dayOfYear,
  diff,
  diffYears,
  duration,
  format,
  normalize,
  simTime,
  yearFraction,
  type Calendar,
} from '@ws/core';

const CAL: Calendar = EARTH_CALENDAR;
const SPY = CAL.secondsPerYear;

describe('SimTime normalisation', () => {
  it('holds the invariant 0 <= seconds < secondsPerYear', () => {
    for (const s of [0, 1, SPY - 1e-6, SPY, SPY + 1, -1, -SPY, -SPY - 1, 5 * SPY + 17]) {
      const t = normalize(0, s, CAL);
      expect(t.seconds).toBeGreaterThanOrEqual(0);
      expect(t.seconds).toBeLessThan(SPY);
      expect(Number.isSafeInteger(t.year)).toBe(true);
    }
  });

  it('carries and borrows exactly at the year boundary', () => {
    expect(normalize(0, SPY, CAL)).toEqual({ year: 1, seconds: 0 });
    expect(normalize(0, -1, CAL)).toEqual({ year: -1, seconds: SPY - 1 });
    expect(normalize(5, -SPY, CAL)).toEqual({ year: 4, seconds: 0 });
  });

  it('works for negative years (pre-epoch geological time)', () => {
    const t = simTime(-4_500_000_000, 0, CAL);
    expect(t.year).toBe(-4_500_000_000);
    expect(diffYears(EPOCH, t, CAL)).toBeCloseTo(4_500_000_000, 0);
  });
});

describe('SimTime arithmetic', () => {
  it('adds durations shorter than a year without leaving the year', () => {
    const t = addDuration(simTime(100, 0, CAL), duration(3600), CAL);
    expect(t).toEqual({ year: 100, seconds: 3600 });
  });

  it('splits whole years off a large duration so seconds never holds a huge value', () => {
    const t = addDuration(simTime(0, 0, CAL), duration(SPY * 1000 + 42), CAL);
    expect(t.year).toBe(1000);
    expect(t.seconds).toBeCloseTo(42, 6);
  });

  it('addYears keeps the sub-year position exactly', () => {
    const a = simTime(0, 12345.678, CAL);
    const b = addYears(a, 1_000_000, CAL);
    expect(b.year).toBe(1_000_000);
    expect(b.seconds).toBe(a.seconds); // exact, not approximate
  });

  it('diff and addDuration round-trip', () => {
    const a = simTime(1000, 500, CAL);
    const b = addDuration(a, duration(123456.75), CAL);
    expect(diff(b, a, CAL)).toBeCloseTo(123456.75, 6);
  });

  it('diffYears is safe at spans where diff is not', () => {
    const a = simTime(0, 0, CAL);
    const b = simTime(4_500_000_000, 0, CAL);
    expect(diffYears(b, a, CAL)).toBe(4_500_000_000);
    // 4.5e9 years in seconds exceeds MAX_SAFE_INTEGER, so diff() must refuse.
    expect(() => diff(b, a, CAL)).toThrow();
  });

  it('orders correctly', () => {
    const a = simTime(10, 5, CAL);
    const b = simTime(10, 6, CAL);
    const c = simTime(11, 0, CAL);
    expect(compare(a, b)).toBeLessThan(0);
    expect(compare(b, c)).toBeLessThan(0);
    expect(compare(a, a)).toBe(0);
  });
});

/**
 * DEC-014, the load-bearing claim. This is why SimTime is split at the year
 * rather than being a single f64 seconds-since-epoch counter.
 */
describe('SimTime precision at deep time', () => {
  const N = 1e7;
  const DT = 1 / 60;
  const EXACT = N * DT;

  it('accumulating 1e7 steps of 1/60 s at year 1e6 has sub-millisecond error', () => {
    let t = simTime(1_000_000, 0, CAL);
    const dt = duration(DT);
    for (let i = 0; i < N; i++) t = addDuration(t, dt, CAL);

    const elapsed = diffYears(t, simTime(1_000_000, 0, CAL), CAL) * SPY;
    const error = Math.abs(elapsed - EXACT);

    expect(error).toBeLessThan(1e-3); // measured: ~1.7e-5 s
  });

  it('beats a flat f64 seconds-since-epoch counter by more than a millionfold', () => {
    // Year-split.
    let t = simTime(1_000_000, 0, CAL);
    const dt = duration(DT);
    for (let i = 0; i < N; i++) t = addDuration(t, dt, CAL);
    const splitError = Math.abs(
      diffYears(t, simTime(1_000_000, 0, CAL), CAL) * SPY - EXACT,
    );

    // Flat counter at the same instant.
    const flat0 = 1_000_000 * SPY;
    let flat = flat0;
    for (let i = 0; i < N; i++) flat += DT;
    const flatError = Math.abs(flat - flat0 - EXACT);

    // The flat counter rounds every 1/60 s increment to 1/64 s at this
    // magnitude and silently loses 6.25% of all elapsed time.
    expect(flatError).toBeGreaterThan(1e4); // measured: ~1.04e4 s
    expect(splitError).toBeLessThan(flatError / 1e6);
  });

  it('keeps the year exact no matter how deep', () => {
    let t = simTime(0, 0, CAL);
    for (let i = 0; i < 1000; i++) t = addYears(t, 1_000_000, CAL);
    expect(t.year).toBe(1_000_000_000); // exact integer, no drift
    expect(t.seconds).toBe(0);
  });
});

describe('calendar helpers', () => {
  it('yearFraction spans [0,1)', () => {
    expect(yearFraction(simTime(0, 0, CAL), CAL)).toBe(0);
    expect(yearFraction(simTime(0, SPY / 2, CAL), CAL)).toBeCloseTo(0.5, 12);
  });

  it('dayOfYear and dayFraction decompose the year', () => {
    const t = simTime(0, 10 * 86400 + 6 * 3600, CAL);
    expect(dayOfYear(t, CAL)).toBe(10);
    expect(dayFraction(t, CAL)).toBeCloseTo(0.25, 12);
  });

  it('formats stably', () => {
    expect(format(simTime(2026, 10 * 86400 + 3661, CAL), CAL)).toBe('Y2026 D010 01:01:01');
  });
});
