/**
 * Simulation time (DEC-014).
 *
 * WHY THIS SHAPE. Time must span a 1/60 s render step and a 10^6-year tectonic
 * step, and it must be EXACT, because determinism and replay depend on two runs
 * agreeing on what time it is.
 *
 * A single f64 seconds-since-epoch counter fails:
 *     10^6 years = 3.15576e13 s ->  1 ulp = 3.90625 ms (docs said 7.8 ms = x*EPSILON, not ulp)
 *     10^9 years = 3.156e16 s  ->  1 ulp = 4.0 s
 * Measured: accumulating 1e7 steps of 1/60 s at year 1e6 loses 10 417 s on a flat
 * counter (each increment rounds to 1/64) versus 1.7e-5 s with the year split.
 * Increments smaller than the ulp are silently discarded, so two runs that took
 * different step sizes to reach the same instant disagree about where they are.
 *
 * Splitting at the YEAR keeps `year` an exact integer (safe to +/-9e15, which is
 * 10^6x deeper than any geology we will run) and `seconds` inside a single year,
 * where max magnitude 3.156e7 gives 1 ulp ~= 7.0e-9 s. Sub-microsecond exactness
 * forever.
 *
 * The year is also the system's natural period (axial tilt, seasons, orbit), so
 * the split point is physically meaningful, not merely numerically convenient.
 *
 * ALL time arithmetic goes through this module (PROTOCOL §6.5).
 */

import { assert, assertFinite, assertInteger } from '../assert.js';

/** Seconds. f64. Branded to keep it distinct from bare numbers at call sites. */
export type Duration = number & { readonly __brand: 'Duration' };

export function duration(seconds: number): Duration {
  assertFinite(seconds, 'duration');
  return seconds as Duration;
}

export const SECOND = duration(1);
export const MINUTE = duration(60);
export const HOUR = duration(3600);
export const DAY = duration(86400);

/**
 * Planet-specific time parameters, fixed at world creation and stored in the
 * save. A `SimTime` is meaningless without the calendar it was normalised
 * against; changing `secondsPerYear` invalidates a world.
 */
export interface Calendar {
  readonly secondsPerYear: number;
  readonly secondsPerDay: number;
}

/** Earth-like defaults. 365.25 days of 86400 s. */
export const EARTH_CALENDAR: Calendar = {
  secondsPerYear: 365.25 * 86400,
  secondsPerDay: 86400,
};

export interface SimTime {
  /** Exact integer. Signed; negative is before epoch. */
  readonly year: number;
  /** f64, normalised to [0, calendar.secondsPerYear). */
  readonly seconds: number;
}

export const EPOCH: SimTime = { year: 0, seconds: 0 };

/**
 * Carries/borrows `seconds` into `year` so the result satisfies the invariant
 * `0 <= seconds < secondsPerYear`.
 */
export function normalize(year: number, seconds: number, cal: Calendar): SimTime {
  assertFinite(year, 'year');
  assertFinite(seconds, 'seconds');
  const spy = cal.secondsPerYear;

  let y = year;
  let s = seconds;

  if (s < 0 || s >= spy) {
    const carry = Math.floor(s / spy);
    y += carry;
    s -= carry * spy;
    // The subtraction above can land exactly on the boundary (or a hair outside)
    // when |s| was large enough that `carry * spy` rounded. Fix it up rather than
    // letting a denormalised value escape.
    if (s >= spy) {
      y += 1;
      s -= spy;
    } else if (s < 0) {
      y -= 1;
      s += spy;
    }
  }

  assertInteger(y, 'normalised year');
  assert(s >= 0 && s < spy, `normalised seconds out of range: ${String(s)}`);
  return { year: y, seconds: s };
}

export function simTime(year: number, seconds: number, cal: Calendar): SimTime {
  return normalize(year, seconds, cal);
}

/**
 * Advance by a duration.
 *
 * Note the precision characteristic: for |d| within one year the result carries
 * the full ~4 ns resolution of `seconds`. For a very large `d` the coarseness is
 * already present in `d` itself (a Duration of 1e13 s has a 2 ms ulp), not
 * introduced here — `year` never degrades.
 */
export function addDuration(t: SimTime, d: Duration, cal: Calendar): SimTime {
  const spy = cal.secondsPerYear;
  if (d >= spy || d <= -spy) {
    // Split whole years off first so `seconds` never has to hold a huge value.
    const wholeYears = Math.trunc(d / spy);
    const rest = d - wholeYears * spy;
    return normalize(t.year + wholeYears, t.seconds + rest, cal);
  }
  return normalize(t.year, t.seconds + d, cal);
}

export function addYears(t: SimTime, years: number, cal: Calendar): SimTime {
  assertInteger(years, 'years');
  return normalize(t.year + years, t.seconds, cal);
}

/**
 * `a - b` as a Duration.
 *
 * Asserts when the span exceeds f64 integer exactness in seconds
 * (~2.85e8 years). Beyond that a Duration cannot represent the answer and the
 * caller wants `diffYears` instead.
 */
export function diff(a: SimTime, b: SimTime, cal: Calendar): Duration {
  const dy = a.year - b.year;
  assert(
    Math.abs(dy) * cal.secondsPerYear <= Number.MAX_SAFE_INTEGER,
    'diff() span exceeds f64 second-exactness; use diffYears()',
  );
  return duration(dy * cal.secondsPerYear + (a.seconds - b.seconds));
}

/** Fractional years between two instants. Safe at any span. */
export function diffYears(a: SimTime, b: SimTime, cal: Calendar): number {
  return a.year - b.year + (a.seconds - b.seconds) / cal.secondsPerYear;
}

export function compare(a: SimTime, b: SimTime): number {
  if (a.year !== b.year) return a.year < b.year ? -1 : 1;
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  return 0;
}

export function equals(a: SimTime, b: SimTime): boolean {
  return a.year === b.year && a.seconds === b.seconds;
}

export function isBefore(a: SimTime, b: SimTime): boolean {
  return compare(a, b) < 0;
}

/** Position within the year, in [0, 1). Drives seasons and insolation. */
export function yearFraction(t: SimTime, cal: Calendar): number {
  return t.seconds / cal.secondsPerYear;
}

/** Day of year, 0-based integer. */
export function dayOfYear(t: SimTime, cal: Calendar): number {
  return Math.floor(t.seconds / cal.secondsPerDay);
}

/** Position within the day, in [0, 1). Drives the day/night cycle. */
export function dayFraction(t: SimTime, cal: Calendar): number {
  const s = t.seconds % cal.secondsPerDay;
  return s / cal.secondsPerDay;
}

export function format(t: SimTime, cal: Calendar): string {
  const d = dayOfYear(t, cal);
  const rem = t.seconds - d * cal.secondsPerDay;
  const hh = Math.floor(rem / 3600);
  const mm = Math.floor((rem - hh * 3600) / 60);
  const ss = Math.floor(rem - hh * 3600 - mm * 60);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `Y${t.year} D${p(d, 3)} ${p(hh)}:${p(mm)}:${p(ss)}`;
}
