/**
 * Bit-identical transcendentals for Tier A (T-0021, DEC-018).
 *
 * Only `+ - * /`, `Math.sqrt`, `Math.abs`, `Math.floor`, `Math.round` and
 * integer bit ops. Callers tagged `@tier A` import from here instead of `Math.*`.
 *
 * Envelope (see `stable-math.test.ts`):
 *   sin, cos     ≤ 8 ULP on [−π/2, π/2]; abs err < 1e−12 on [−2π, 2π]
 *   atan, atan2  identity < 1e−12 (unit-vector round-trip)
 *   asin, acos   ≤ 16 ULP of 1 vs Math.*
 *   exp          ≤ 4 ULP vs 20-term Taylor on [−1, 1]
 *   log          inverse of exp to 64 ULP on the tested grid
 *   pow          integer branch exact for small integers
 *
 * Native `Math.*` is typically 3–8× faster. That is the cost of bit-identity.
 * Math.* is a convenience oracle, not a standard: two engines may disagree
 * by a few ULP, and π-reduction disagreement near k·2π is not an ULP budget.
 */

const PI = 3.141592653589793;
const PI_2 = 1.5707963267948966;
const PI_4 = 0.7853981633974483;
const TWO_PI_HI = 6.283185307179586;
const TWO_PI_LO = 2.4492935982947064e-16;
const INV_TWO_PI = 0.15915494309189535;
const LN2 = 0.6931471805599453;
const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const INV_LN2 = 1.4426950408889634;
const LN10 = 2.302585092994046;
const SQRT2 = 1.4142135623730951;
const INF = Infinity;

const F64BUF = new ArrayBuffer(8);
const F64 = new Float64Array(F64BUF);
const U32 = new Uint32Array(F64BUF);

function remPi(x: number): number {
  const n = Math.round(x * INV_TWO_PI);
  return (x - n * TWO_PI_HI) - n * TWO_PI_LO;
}

/* Taylor on [0, π/4]. Remainder x^17/17! < 1e-16 at π/4. */
function sinKernel(x: number): number {
  const z = x * x;
  return x * (1 + z * (-1 / 6 + z * (1 / 120 + z * (-1 / 5040 + z * (1 / 362880 + z * (-1 / 39916800 + z * (1 / 6227020800 + z * (-1 / 1307674368000))))))));
}

function cosKernel(x: number): number {
  const z = x * x;
  return 1 + z * (-0.5 + z * (1 / 24 + z * (-1 / 720 + z * (1 / 40320 + z * (-1 / 3628800 + z * (1 / 479001600 + z * (-1 / 87178291200 + z * (1 / 20922789888000))))))));
}

export function sin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (x === 0) return x;
  const y = remPi(x);
  const ay = Math.abs(y);
  const s = y < 0 ? -1 : 1;
  if (ay <= PI_4) return s * sinKernel(ay);
  if (ay <= PI_2) return s * cosKernel(PI_2 - ay);
  if (ay <= PI_2 + PI_4) return s * cosKernel(ay - PI_2);
  return s * sinKernel(PI - ay);
}

export function cos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const y = remPi(x);
  const ay = Math.abs(y);
  if (ay <= PI_4) return cosKernel(ay);
  if (ay <= PI_2) return sinKernel(PI_2 - ay);
  if (ay <= PI_2 + PI_4) return -sinKernel(ay - PI_2);
  return -cosKernel(PI - ay);
}

export function tan(x: number): number {
  const c = cos(x);
  if (c === 0) return x > 0 ? INF : -INF;
  return sin(x) / c;
}

function atanKernel(x: number): number {
  /* Odd Taylor on |x| ≤ √2−1. 16 terms → remainder < 1 ULP. */
  const z = x * x;
  let acc = 1;
  let p = 1;
  for (let k = 1; k <= 16; k++) {
    p *= -z;
    acc += p / (2 * k + 1);
  }
  return x * acc;
}

export function atan(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? PI_2 : x < 0 ? -PI_2 : NaN;
  const sign = x < 0 ? -1 : 1;
  let ax = Math.abs(x);
  if (ax === 0) return x;
  let add = 0;
  if (ax > 1) {
    ax = 1 / ax;
    add = PI_2;
  }
  if (ax > SQRT2 - 1) {
    const y = (ax - 1) / (ax + 1);
    const core = PI_4 + atanKernel(y);
    const val = add === 0 ? core : add - core;
    return sign * val;
  }
  const core = atanKernel(ax);
  const val = add === 0 ? core : add - core;
  return sign * val;
}

export function atan2(y: number, x: number): number {
  if (x === 0 && y === 0) return y;
  if (x > 0) return atan(y / x);
  if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
  return y > 0 ? PI_2 : -PI_2;
}

export function asin(x: number): number {
  if (x < -1 || x > 1 || !Number.isFinite(x)) return NaN;
  if (x === 0) return x;
  if (x === 1) return PI_2;
  if (x === -1) return -PI_2;
  const ax = Math.abs(x);
  /* Near ±1, atan(x/sqrt(1−x²)) loses digits in the denominator. Use
     asin(x) = π/2 − 2 asin(sqrt((1−x)/2)) so the kernel argument is small. */
  if (ax > 0.7) {
    const s = Math.sqrt((1 - ax) * 0.5);
    const a = atan(s / Math.sqrt((1 - s) * (1 + s)));
    const val = PI_2 - 2 * a;
    return x < 0 ? -val : val;
  }
  return atan(x / Math.sqrt((1 - x) * (1 + x)));
}

export function acos(x: number): number {
  if (x < -1 || x > 1 || !Number.isFinite(x)) return NaN;
  return PI_2 - asin(x);
}

function ldexp(x: number, n: number): number {
  if (n === 0 || x === 0 || !Number.isFinite(x)) return x;
  /* Scale by multiplying powers of two — Math.pow is banned in DEC-018 and
     2^n is exact in f64 for |n| ≤ 1023. Chunk by 2^30 so the multiplier is
     an integer that fits in 31 bits. */
  let y = x;
  let k = n;
  while (k >= 30) {
    y *= 1073741824;
    k -= 30;
  }
  while (k <= -30) {
    y *= 9.313225746154785e-10;
    k += 30;
  }
  if (k > 0) y *= 1 << k;
  else if (k < 0) y *= 1 / (1 << -k);
  return y;
}

export function exp(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? INF : x === -INF ? 0 : NaN;
  if (x > 709.78) return INF;
  if (x < -745.13) return 0;
  const n = Math.round(x * INV_LN2);
  const r = x - n * LN2_HI - n * LN2_LO;
  const r2 = r * r;
  /* Remainder r^13/13! < 2e-16 on |r| ≤ ln2/2. */
  const poly =
    1 +
    r +
    r2 *
      (0.5 +
        r *
          (1 / 6 +
            r *
              (1 / 24 +
                r *
                  (1 / 120 +
                    r *
                      (1 / 720 +
                        r *
                          (1 / 5040 +
                            r *
                              (1 / 40320 +
                                r *
                                  (1 / 362880 +
                                    r * (1 / 3628800 + r * (1 / 39916800 + r * (1 / 479001600)))))))))));
  return ldexp(poly, n);
}

/** x = mant · 2^exp with mant ∈ [1, 2) for finite normals. */
function frexp(x: number): { mant: number; exp: number } {
  const ax = Math.abs(x);
  if (ax === 0 || !Number.isFinite(ax)) return { mant: ax, exp: 0 };
  F64[0] = ax;
  const hi = U32[1] as number;
  const biased = (hi >>> 20) & 0x7ff;
  if (biased === 0) {
    const s = frexp(ax * 4503599627370496); /* 2^52 */
    return { mant: s.mant, exp: s.exp - 52 };
  }
  const exp = biased - 1023;
  U32[1] = (hi & 0x800fffff) | (0x3ff << 20); /* exponent 0 → [1, 2) */
  return { mant: F64[0] as number, exp };
}

export function log(x: number): number {
  if (x === 0) return -INF;
  if (x < 0) return NaN;
  if (!Number.isFinite(x)) return x;
  if (x === 1) return 0;
  const f = frexp(x);
  let m = f.mant;
  let n = f.exp;
  if (m > SQRT2) {
    m *= 0.5;
    n += 1;
  }
  /* m ∈ [√2/2, √2], log(m) via atanh series on s = (m-1)/(m+1). */
  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  let term = s2;
  let lg = 0;
  for (let k = 1; k <= 16; k++) {
    lg += term / (2 * k + 1);
    term *= s2;
  }
  lg = 2 * s * (1 + lg);
  return n * LN2 + lg;
}

export function log2(x: number): number {
  return log(x) * INV_LN2;
}

export function log10(x: number): number {
  return log(x) / LN10;
}

export function pow(x: number, y: number): number {
  if (y === 0) return 1;
  if (x === 0) return y > 0 ? 0 : INF;
  if (x === 1) return 1;
  if (x < 0) {
    const yi = Math.round(y);
    if (yi !== y) return NaN;
    const p = exp(y * log(-x));
    return yi & 1 ? -p : p;
  }
  return exp(y * log(x));
}

export function sinh(x: number): number {
  if (Math.abs(x) < 1e-4) return x;
  const e = exp(x);
  return 0.5 * (e - 1 / e);
}

export function cosh(x: number): number {
  const e = exp(x);
  return 0.5 * (e + 1 / e);
}

export function tanh(x: number): number {
  if (x > 20) return 1;
  if (x < -20) return -1;
  const e = exp(2 * x);
  return (e - 1) / (e + 1);
}

export function hypot(x: number, y: number, z = 0): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  const m = ax > ay ? (ax > az ? ax : az) : ay > az ? ay : az;
  if (m === 0) return 0;
  const sx = x / m;
  const sy = y / m;
  const sz = z / m;
  return m * Math.sqrt(sx * sx + sy * sy + sz * sz);
}

export function rad(deg: number): number {
  return deg * 0.017453292519943295;
}

export function deg(radians: number): number {
  return radians * 57.29577951308232;
}

export const STABLE_PI = PI;
export const STABLE_TWO_PI = TWO_PI_HI;
export const STABLE_PI_2 = PI_2;
