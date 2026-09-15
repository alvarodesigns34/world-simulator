/**
 * Stateless, order-independent randomness (DEC-017).
 *
 * WHY THERE IS NO "RANDOM NUMBER GENERATOR" HERE.
 *
 * Terrain chunks are generated on demand, in whatever order the camera happens
 * to visit them, across a worker pool whose size depends on the user's machine.
 * Any randomness drawn from a stateful stream would therefore depend on WHEN and
 * WHERE a chunk was generated, and the same seed would produce a different world
 * on a different machine. Order-independence is not a nice property here; it is a
 * requirement imposed by streaming.
 *
 * So: every random value is a pure hash of an explicit key.
 *
 *     value = hash(worldSeed, domainId, ...coordinates)
 *
 * A local stateful generator IS permitted inside a single pure function whose
 * seed is fully determined by its inputs (e.g. an erosion pass over one chunk
 * seeded by hash(worldSeed, DOMAIN.EROSION, quadkey)) — the output is still a
 * pure function of the key. Use `sequence()` for that.
 *
 * BANNED in core/data/sim, enforced by tools/check-boundaries.mjs:
 * Math.random, Date.now, performance.now, new Date, crypto.getRandomValues.
 */

import { assertInteger } from '../assert.js';

/**
 * The world seed. 64 bits as a pair of u32, because JavaScript has no fast
 * native u64 and BigInt allocates.
 */
export interface Seed {
  readonly hi: number;
  readonly lo: number;
}

export function makeSeed(hi: number, lo: number): Seed {
  assertInteger(hi, 'seed.hi');
  assertInteger(lo, 'seed.lo');
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

/**
 * Domain separation. A compile-time constant per generator, so two generators
 * never collide on the same coordinate key. Values are arbitrary but must never
 * be reused or renumbered — doing so changes every existing world.
 */
export const DOMAIN = {
  TERRAIN_BASE: 0x01,
  TERRAIN_DETAIL: 0x02,
  EROSION: 0x03,
  PLATES: 0x04,
  VOLCANISM: 0x05,
  HYDROLOGY: 0x06,
  ATMOSPHERE: 0x07,
  OCEAN: 0x08,
  BIOME: 0x09,
  VEGETATION: 0x0a,
  POPULATION: 0x0b,
  SETTLEMENT: 0x0c,
  CITY_LAYOUT: 0x0d,
  ECONOMY: 0x0e,
  TEST: 0xff,
} as const;

export type DomainId = (typeof DOMAIN)[keyof typeof DOMAIN];

/**
 * `triple32` (Chris Wellons) — a bijective 32-bit integer hash with measured
 * avalanche bias below 0.0205, i.e. better than the MurmurHash3 finaliser. It is
 * exact on any platform because it uses only integer XOR, shift and Math.imul,
 * so it is Tier A (DEC-018) by construction.
 */
export function triple32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 17;
  h = Math.imul(h, 0xed5ad4bb);
  h ^= h >>> 11;
  h = Math.imul(h, 0xac4c1b51);
  h ^= h >>> 15;
  h = Math.imul(h, 0x31848bab);
  h ^= h >>> 14;
  return h >>> 0;
}

/**
 * Hash a seed plus an arbitrary key into a u32.
 *
 * Pure. No hidden state. Calling it a million times in any order gives the same
 * answers as calling it in any other order — which is the entire point.
 */
export function hashU32(seed: Seed, domain: DomainId, ...key: readonly number[]): number {
  let h = triple32(seed.lo ^ 0x9e3779b9);
  h = triple32((h ^ seed.hi) >>> 0);
  h = triple32((h ^ (domain >>> 0)) >>> 0);
  for (let i = 0; i < key.length; i++) {
    // `| 0` keeps negative coordinates well-defined rather than NaN-ing through
    // the unsigned conversion.
    h = triple32((h ^ triple32((key[i] as number) | 0)) >>> 0);
  }
  return h >>> 0;
}

/** Uniform in [0, 1). 2^-32 resolution — adequate for procedural generation. */
export function hashFloat01(seed: Seed, domain: DomainId, ...key: readonly number[]): number {
  return hashU32(seed, domain, ...key) * 2.3283064365386963e-10;
}

/** Uniform in [-1, 1). */
export function hashSigned(seed: Seed, domain: DomainId, ...key: readonly number[]): number {
  return hashFloat01(seed, domain, ...key) * 2 - 1;
}

/** Uniform integer in [lo, hi). */
export function hashInt(
  seed: Seed,
  domain: DomainId,
  lo: number,
  hi: number,
  ...key: readonly number[]
): number {
  const n = hi - lo;
  return lo + Math.floor(hashFloat01(seed, domain, ...key) * n);
}

/**
 * A 64-bit hash value as a pair of u32.
 *
 * WHY 64 BITS (T-0045, AUDIT-V0 M1). DEC-017 specified "splitmix64-style 64-bit
 * mixing"; M0 shipped only `hashU32`, which is a bug against an Accepted record,
 * not a new decision. At L11 there are 6·4^11 = 25 165 824 cells; keying every
 * one in 32 bits gives ~73 700 expected birthday collisions. That is harmless
 * per-tile (a few thousand keys) and unacceptable as a per-cell world-generation
 * stream, where a collision means two cells share a "random" value forever.
 *
 * At 64 bits the same 25.2 M keys expect ~1.7e-5 collisions.
 */
export interface U64 {
  readonly hi: number;
  readonly lo: number;
}

/**
 * splitmix64 finaliser, exact in 32-bit halves.
 *
 * The reference constants are 0xbf58476d1ce4e5b9 and 0x94d049bb133111eb with
 * shifts of 30, 27 and 31. Implemented with Math.imul-based 64x64 multiplication
 * over u32 halves, so it uses only integer operations and is Tier A (DEC-018) on
 * any platform.
 */
function mul64(ah: number, al: number, bh: number, bl: number): U64 {
  // Split each 32-bit half into 16-bit limbs so every partial product fits in
  // an f64 mantissa exactly.
  const a0 = al & 0xffff;
  const a1 = al >>> 16;
  const b0 = bl & 0xffff;
  const b1 = bl >>> 16;

  const p00 = a0 * b0;
  const p01 = a0 * b1;
  const p10 = a1 * b0;
  const p11 = a1 * b1;

  const mid = p01 + p10;
  const midLo = (mid & 0xffff) * 0x10000;
  // Carry out of the low 32 bits, as an exact integer.
  const loSum = p00 + midLo;
  const lo = loSum >>> 0;
  const carry = Math.floor(loSum / 0x100000000) + (mid > 0xffff ? Math.floor(mid / 0x10000) : 0);

  // High word: a_lo*b_hi + a_hi*b_lo (mod 2^32) + p11 + carry.
  const hi = (Math.imul(al, bh) + Math.imul(ah, bl) + p11 + carry) >>> 0;
  return { hi, lo };
}

function xorShr64(h: number, l: number, n: number): U64 {
  let sh: number;
  let sl: number;
  if (n < 32) {
    sh = h >>> n;
    sl = n === 0 ? l : ((l >>> n) | (h << (32 - n))) >>> 0;
  } else {
    sh = 0;
    sl = h >>> (n - 32);
  }
  return { hi: (h ^ sh) >>> 0, lo: (l ^ sl) >>> 0 };
}

/** splitmix64's finalising mix, applied to a 64-bit state. */
export function splitmix64(hi: number, lo: number): U64 {
  let z = xorShr64(hi >>> 0, lo >>> 0, 30);
  z = mul64(z.hi, z.lo, 0xbf58476d, 0x1ce4e5b9);
  z = xorShr64(z.hi, z.lo, 27);
  z = mul64(z.hi, z.lo, 0x94d049bb, 0x133111eb);
  return xorShr64(z.hi, z.lo, 31);
}

const GOLDEN_GAMMA_HI = 0x9e3779b9;
const GOLDEN_GAMMA_LO = 0x7f4a7c15;

/** Add a 64-bit constant to a 64-bit value, wrapping at 2^64. */
function add64(ah: number, al: number, bh: number, bl: number): U64 {
  const loSum = (al >>> 0) + (bl >>> 0);
  const lo = loSum >>> 0;
  const carry = loSum >= 0x100000000 ? 1 : 0;
  return { hi: ((ah >>> 0) + (bh >>> 0) + carry) >>> 0, lo };
}

/**
 * 64-bit stateless hash of a seed plus an arbitrary key — the function DEC-017
 * actually specified. Same purity and order-independence guarantees as
 * `hashU32`; use this wherever the key space approaches or exceeds ~10^5 values,
 * which means anything per-cell at L11 or finer.
 */
export function hashU64(seed: Seed, domain: DomainId, ...key: readonly number[]): U64 {
  let st = add64(seed.hi, seed.lo, GOLDEN_GAMMA_HI, GOLDEN_GAMMA_LO);
  let h = splitmix64(st.hi, st.lo);
  st = add64(h.hi, h.lo, 0, domain >>> 0);
  h = splitmix64(st.hi, st.lo);
  for (let i = 0; i < key.length; i++) {
    st = add64(h.hi, h.lo, GOLDEN_GAMMA_HI, ((key[i] as number) | 0) >>> 0);
    h = splitmix64(st.hi, st.lo);
  }
  return h;
}

/**
 * Uniform in [0, 1) with 53 bits of resolution, from `hashU64`.
 *
 * Prefer this over `hashFloat01` for per-cell world generation: `hashFloat01`
 * has 2^-32 resolution and a 32-bit key space.
 */
export function hashFloat01x64(
  seed: Seed,
  domain: DomainId,
  ...key: readonly number[]
): number {
  const h = hashU64(seed, domain, ...key);
  // 53 bits: 21 high bits + 32 low bits, scaled to [0,1).
  return ((h.hi >>> 11) * 0x100000000 + (h.lo >>> 0)) / 9007199254740992;
}

/**
 * A local stateful sequence, seeded purely from a key.
 *
 * Legitimate ONLY inside a pure function whose inputs fully determine the key
 * (DEC-017 rule 4). If two call sites can reach the same sequence in different
 * orders, this is the wrong tool — use `hashU32` with explicit coordinates.
 */
export function sequence(seed: Seed, domain: DomainId, ...key: readonly number[]): () => number {
  let state = hashU32(seed, domain, ...key);
  return () => {
    state = triple32((state + 0x9e3779b9) >>> 0);
    return state * 2.3283064365386963e-10;
  };
}
