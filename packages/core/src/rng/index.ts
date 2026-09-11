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
