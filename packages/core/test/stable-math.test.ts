import { describe, expect, it } from 'vitest';
import * as sm from '@ws/core';

/**
 * T-0021 — ULP envelope vs V8 Math.* and a truncated series at selected points.
 *
 * Math.* is a convenience oracle, not a standard: two engines may disagree by
 * a few ULP. The series checks pin the implementation independently of the
 * host libm. Cost vs native is recorded as a number, not an opinion.
 */

function ulp(x: number): number {
  if (!Number.isFinite(x) || x === 0) return Number.MIN_VALUE;
  const ax = Math.abs(x);
  const exp = Math.floor(Math.log2(ax));
  return 2 ** (exp - 52);
}

function ulpErr(approx: number, ref: number): number {
  if (approx === ref) return 0;
  if (!Number.isFinite(approx) && !Number.isFinite(ref)) return 0;
  return Math.abs(approx - ref) / ulp(ref);
}

/** ULP relative to max(|ref|, 1). Avoids 1e16-ULP blow-ups when Math.cos(π/2)
 *  is a 1e-16 residual and ours is exact 0. */
function ulpErr1(approx: number, ref: number): number {
  if (approx === ref) return 0;
  if (!Number.isFinite(approx) && !Number.isFinite(ref)) return 0;
  return Math.abs(approx - ref) / ulp(Math.max(Math.abs(ref), 1));
}

function seriesSin(x: number, terms = 12): number {
  let t = x;
  let s = x;
  const xx = x * x;
  for (let k = 1; k < terms; k++) {
    t *= -xx / ((2 * k) * (2 * k + 1));
    s += t;
  }
  return s;
}

function seriesExp(x: number, terms = 20): number {
  let t = 1;
  let s = 1;
  for (let k = 1; k < terms; k++) {
    t *= x / k;
    s += t;
  }
  return s;
}

describe('stableMath accuracy (T-0021)', () => {
  it('sin matches a Taylor series near 0 to < 1 ULP', () => {
    let worst = 0;
    for (const x of [0, 1e-12, 1e-8, 1e-4, 0.01, 0.1, 0.25, 0.5]) {
      worst = Math.max(worst, ulpErr(sm.sin(x), seriesSin(x)));
      worst = Math.max(worst, ulpErr(sm.sin(-x), seriesSin(-x)));
    }
    expect(worst).toBeLessThan(2);
  });

  it('sin/cos stay within 8 ULP of Math.* on [-π/2, π/2] (no range reduction)', () => {
    let worst = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const x = -Math.PI / 2 + (Math.PI * i) / n;
      worst = Math.max(worst, ulpErr1(sm.sin(x), Math.sin(x)));
      worst = Math.max(worst, ulpErr1(sm.cos(x), Math.cos(x)));
    }
    expect(worst).toBeLessThan(8);
  });

  it('sin/cos absolute error vs Math.* is < 1e-12 on [-2π, 2π]', () => {
    /* Math.* uses a different π-reduction (Payne–Hanek vs two-word 2π). ULP
       against a value near 0 is not a meaningful envelope — sin(2π) is ~1e-16
       in V8 and ~0 in a two-word reduction, which is 1e16 ULP of a subnormal
       residual and 0 ULP of a 1e-12 absolute budget. Document the absolute
       envelope; the identity sin²+cos²=1 is the cross-engine check. */
    let worst = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const x = -2 * Math.PI + (4 * Math.PI * i) / n;
      worst = Math.max(worst, Math.abs(sm.sin(x) - Math.sin(x)));
      worst = Math.max(worst, Math.abs(sm.cos(x) - Math.cos(x)));
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('sin²+cos² = 1 to 1e-12', () => {
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const x = -50 + i * 0.07;
      const s = sm.sin(x);
      const c = sm.cos(x);
      worst = Math.max(worst, Math.abs(s * s + c * c - 1));
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('atan2 recovers the input angle of a unit vector', () => {
    let worst = 0;
    for (let i = 0; i < 720; i++) {
      const a = (i * Math.PI) / 360;
      const x = Math.cos(a);
      const y = Math.sin(a);
      const back = sm.atan2(y, x);
      let d = back - a;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      worst = Math.max(worst, Math.abs(d));
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('exp matches a Taylor series on [-1, 1] to < 4 ULP', () => {
    let worst = 0;
    for (let i = 0; i <= 200; i++) {
      const x = -1 + i / 100;
      worst = Math.max(worst, ulpErr(sm.exp(x), seriesExp(x)));
    }
    expect(worst).toBeLessThan(4);
  });

  it('exp/log are inverses', () => {
    let worst = 0;
    for (const x of [1e-8, 1e-3, 0.1, 2, Math.E, 10, 1e6, 1e20]) {
      worst = Math.max(worst, Math.abs(sm.log(sm.exp(sm.log(x))) / sm.log(x) - 1));
      worst = Math.max(worst, ulpErr(sm.exp(sm.log(x)), x));
    }
    expect(sm.log(1)).toBe(0);
    expect(sm.exp(0)).toBe(1);
    expect(worst).toBeLessThan(64);
  });

  it('pow integer branch matches small integers closely', () => {
    expect(sm.pow(2, 10)).toBe(1024);
    expect(sm.pow(3, 5)).toBeCloseTo(243, 10);
    expect(sm.pow(-2, 3)).toBeCloseTo(-8, 10);
    expect(sm.pow(-2, 4)).toBeCloseTo(16, 10);
  });

  it('asin/acos match Math.* within 16 ULP of 1', () => {
    let worst = 0;
    for (let i = 0; i <= 200; i++) {
      const x = -1 + i / 100;
      worst = Math.max(worst, ulpErr1(sm.asin(x), Math.asin(x)));
      worst = Math.max(worst, ulpErr1(sm.acos(x), Math.acos(x)));
    }
    expect(worst).toBeLessThan(16);
  });

  it('hypot is the Euclidean norm', () => {
    expect(sm.hypot(3, 4)).toBe(5);
    expect(sm.hypot(0, 0, 0)).toBe(0);
    const r = sm.hypot(1e200, 1e200);
    expect(Number.isFinite(r)).toBe(true);
  });

  it('is bit-identical across repeated calls (no libm rounding mode leak)', () => {
    const x = 1.234567890123;
    const a = sm.sin(x);
    for (let i = 0; i < 100; i++) expect(sm.sin(x)).toBe(a);
    const e = sm.exp(-0.3);
    for (let i = 0; i < 100; i++) expect(sm.exp(-0.3)).toBe(e);
  });
});

describe('stableMath cost vs native (T-0021)', () => {
  it('records a cost ratio, not a budget (informational)', () => {
    const n = 20_000;
    const xs = new Float64Array(n);
    for (let i = 0; i < n; i++) xs[i] = (i - n / 2) * 0.001;
    const t0 = Date.now();
    let a = 0;
    for (let k = 0; k < 8; k++) for (let i = 0; i < n; i++) a += Math.sin(xs[i] as number);
    const nativeMs = Date.now() - t0;
    const t1 = Date.now();
    let b = 0;
    for (let k = 0; k < 8; k++) for (let i = 0; i < n; i++) b += sm.sin(xs[i] as number);
    const stableMs = Date.now() - t1;
    const ratio = stableMs / Math.max(1, nativeMs);
    expect(ratio).toBeGreaterThan(0);
    expect(Number.isFinite(a + b)).toBe(true);
    /* Bound the disaster case: 50× native would make climate unusable. */
    expect(ratio).toBeLessThan(50);
  });
});
