import { describe, expect, it } from 'vitest';
import {
  DOMAIN,
  hashFloat01,
  hashInt,
  hashSigned,
  hashU32,
  makeSeed,
  sequence,
  triple32,
} from '@ws/core';

const SEED = makeSeed(0xdeadbeef, 0x12345678);

describe('triple32', () => {
  it('is a bijection over u32 (no collisions in a large sample)', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200_000; i++) seen.add(triple32(i));
    expect(seen.size).toBe(200_000);
  });

  it('avalanches: flipping one input bit flips ~half the output bits', () => {
    let total = 0;
    let n = 0;
    for (let i = 0; i < 2000; i++) {
      const a = triple32(i);
      for (let bit = 0; bit < 32; bit++) {
        const b = triple32(i ^ (1 << bit));
        let flipped = 0;
        let x = (a ^ b) >>> 0;
        while (x) {
          flipped += x & 1;
          x >>>= 1;
        }
        total += flipped;
        n++;
      }
    }
    expect(total / n).toBeGreaterThan(15.0);
    expect(total / n).toBeLessThan(17.0);
  });
});

/**
 * DEC-017. Terrain chunks are generated in camera-visit order across a variable
 * number of workers, so order-independence is a requirement, not a nicety.
 */
describe('determinism: stateless hashing is order-independent', () => {
  it('produces identical values regardless of generation order', () => {
    const keys: Array<[number, number, number]> = [];
    for (let f = 0; f < 6; f++) {
      for (let x = 0; x < 20; x++) for (let y = 0; y < 20; y++) keys.push([f, x, y]);
    }

    const forward = new Map<string, number>();
    for (const [f, x, y] of keys) {
      forward.set(`${f}:${x}:${y}`, hashU32(SEED, DOMAIN.TERRAIN_BASE, f, x, y));
    }

    const reverse = new Map<string, number>();
    for (const [f, x, y] of [...keys].reverse()) {
      reverse.set(`${f}:${x}:${y}`, hashU32(SEED, DOMAIN.TERRAIN_BASE, f, x, y));
    }

    // Shuffled deterministically (no Math.random in this codebase).
    const shuffled = [...keys].sort(
      (a, b) => hashU32(SEED, DOMAIN.TEST, ...a) - hashU32(SEED, DOMAIN.TEST, ...b),
    );
    const scrambled = new Map<string, number>();
    for (const [f, x, y] of shuffled) {
      scrambled.set(`${f}:${x}:${y}`, hashU32(SEED, DOMAIN.TERRAIN_BASE, f, x, y));
    }

    expect(reverse).toEqual(forward);
    expect(scrambled).toEqual(forward);
  });

  it('separates domains: the same key in two domains gives unrelated values', () => {
    let collisions = 0;
    for (let i = 0; i < 10_000; i++) {
      if (hashU32(SEED, DOMAIN.TERRAIN_BASE, i) === hashU32(SEED, DOMAIN.EROSION, i)) {
        collisions++;
      }
    }
    expect(collisions).toBeLessThanOrEqual(1); // ~10000/2^32 expected, i.e. ~0
  });

  it('separates seeds: a different world seed gives a different world', () => {
    const other = makeSeed(0xdeadbeef, 0x12345679); // one bit apart
    let same = 0;
    for (let i = 0; i < 10_000; i++) {
      if (hashU32(SEED, DOMAIN.TERRAIN_BASE, i) === hashU32(other, DOMAIN.TERRAIN_BASE, i)) {
        same++;
      }
    }
    expect(same).toBeLessThanOrEqual(1);
  });

  it('handles negative coordinates without collapsing to a single value', () => {
    const values = new Set<number>();
    for (let i = -1000; i < 1000; i++) values.add(hashU32(SEED, DOMAIN.TEST, i));
    expect(values.size).toBe(2000);
  });
});

/**
 * Golden values. These pin the hash function: changing `triple32` or the key
 * mixing changes every world ever generated, so it must be a deliberate act with
 * a superseding ADR (DEC-017), not an accident.
 */
describe('determinism: golden hash values', () => {
  it('matches the recorded values', () => {
    expect(hashU32(SEED, DOMAIN.TERRAIN_BASE, 0, 0, 0)).toBe(GOLDEN.t000);
    expect(hashU32(SEED, DOMAIN.TERRAIN_BASE, 3, 17, 42)).toBe(GOLDEN.t31742);
    expect(hashU32(SEED, DOMAIN.EROSION, 1, 2, 3, 4, 5)).toBe(GOLDEN.e12345);
    expect(hashU32(makeSeed(0, 0), DOMAIN.TEST)).toBe(GOLDEN.zero);
  });
});

// Recorded 2026-09-11. Changing any of these means every world ever generated
// has changed — it requires a superseding ADR, never a silent re-baseline
// (DEC-017, DEC-023).
const GOLDEN = {
  t000: 136_863_692,
  t31742: 3_363_829_306,
  e12345: 3_645_189_501,
  zero: 2_327_670_990,
};

describe('derived distributions', () => {
  it('hashFloat01 stays in [0,1) and is roughly uniform', () => {
    const buckets = new Array<number>(10).fill(0);
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const v = hashFloat01(SEED, DOMAIN.TEST, i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)] = (buckets[Math.floor(v * 10)] ?? 0) + 1;
    }
    // Chi-square with 9 dof: 21.67 is the 1% critical value.
    const expected = N / 10;
    const chi2 = buckets.reduce((acc, o) => acc + (o - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(21.67);
  });

  it('hashSigned stays in [-1,1) with a near-zero mean', () => {
    let sum = 0;
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const v = hashSigned(SEED, DOMAIN.TEST, i);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(Math.abs(sum / N)).toBeLessThan(0.01);
  });

  it('hashInt covers its range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(hashInt(SEED, DOMAIN.TEST, 10, 20, i));
    expect(seen.size).toBe(10);
    for (const v of seen) expect(v).toBeGreaterThanOrEqual(10);
    for (const v of seen) expect(v).toBeLessThan(20);
  });
});

describe('sequence', () => {
  it('is a pure function of its key', () => {
    const a = sequence(SEED, DOMAIN.EROSION, 7, 9);
    const b = sequence(SEED, DOMAIN.EROSION, 7, 9);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('differs for a different key', () => {
    const a = sequence(SEED, DOMAIN.EROSION, 7, 9);
    const b = sequence(SEED, DOMAIN.EROSION, 7, 10);
    expect(a()).not.toBe(b());
  });
});
