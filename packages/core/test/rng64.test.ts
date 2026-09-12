import { describe, expect, it } from 'vitest';
import { DOMAIN, hashFloat01x64, hashU64, makeSeed, splitmix64 } from '@ws/core';

const SEED = makeSeed(0xdeadbeef, 0x12345678);

/**
 * T-0045 / AUDIT-V0 M1. DEC-017 specified 64-bit mixing; M0 shipped only a
 * 32-bit hash. At L11 (25.2 M cells) a 32-bit per-cell key expects ~73 700
 * birthday collisions; 64 bits expects ~1.7e-5.
 */
describe('determinism: hashU64', () => {
  it('splitmix64 matches the canonical stream from a zero seed', () => {
    // The reference generator: x += 0x9e3779b97f4a7c15, then finalise.
    // These are the first three outputs of splitmix64 seeded with 0.
    const r1 = splitmix64(0x9e3779b9, 0x7f4a7c15);
    expect(r1.hi >>> 0).toBe(0xe220a839);
    expect(r1.lo >>> 0).toBe(0x7b1dcdaf);

    const r2 = splitmix64(0x3c6ef372, 0xfe94f82a);
    expect(r2.hi >>> 0).toBe(0x6e789e6a);
    expect(r2.lo >>> 0).toBe(0xa1b965f4);

    const r3 = splitmix64(0xdaa66d2c, 0x7ddf743f);
    expect(r3.hi >>> 0).toBe(0x06c45d18);
    expect(r3.lo >>> 0).toBe(0x8009454f);
  });

  /**
   * Stronger than fixed vectors: cross-check the 32-bit-halves arithmetic
   * against BigInt over a deterministic sweep. `bigint` is banned in shipped
   * sim code for speed (DEC-014), not in tests, and it is exact by construction,
   * which makes it the right oracle here.
   */
  it('agrees with a BigInt implementation across a deterministic sweep', () => {
    const M = (1n << 64n) - 1n;
    const finalise = (z0: bigint): bigint => {
      let z = z0 & M;
      z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
      z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
      return (z ^ (z >> 31n)) & M;
    };
    let st = 0x12345678;
    const nextU32 = (): number => {
      st = (Math.imul(st, 1103515245) + 12345) >>> 0;
      return st;
    };
    let mismatches = 0;
    for (let i = 0; i < 20_000; i++) {
      const hi = nextU32();
      const lo = nextU32();
      const got = splitmix64(hi, lo);
      const want = finalise((BigInt(hi) << 32n) | BigInt(lo));
      if ((got.hi >>> 0) !== Number(want >> 32n) || (got.lo >>> 0) !== Number(want & 0xffffffffn)) {
        mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });

  it('returns both halves inside u32', () => {
    let bad = 0;
    for (let i = 0; i < 1000; i++) {
      const h = hashU64(SEED, DOMAIN.TERRAIN_BASE, i);
      if (
        !Number.isInteger(h.hi) ||
        !Number.isInteger(h.lo) ||
        h.hi < 0 ||
        h.hi > 0xffffffff ||
        h.lo < 0 ||
        h.lo > 0xffffffff
      ) {
        bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it('is order-independent, like hashU32', () => {
    const keys: Array<[number, number]> = [];
    for (let x = 0; x < 60; x++) for (let y = 0; y < 60; y++) keys.push([x, y]);
    const fwd = new Map<string, string>();
    for (const [x, y] of keys) {
      const h = hashU64(SEED, DOMAIN.TERRAIN_BASE, x, y);
      fwd.set(`${x}:${y}`, `${h.hi}:${h.lo}`);
    }
    const rev = new Map<string, string>();
    for (const [x, y] of [...keys].reverse()) {
      const h = hashU64(SEED, DOMAIN.TERRAIN_BASE, x, y);
      rev.set(`${x}:${y}`, `${h.hi}:${h.lo}`);
    }
    expect(rev).toEqual(fwd);
  });

  /**
   * The reason hashU64 exists. 32-bit keys collide at L11 scale; 64-bit do not.
   */
  it('has no collisions where hashU32 would have thousands', () => {
    const N = 300_000;
    const seen = new Set<string>();
    for (let i = 0; i < N; i++) {
      const h = hashU64(SEED, DOMAIN.TERRAIN_BASE, i);
      seen.add(`${h.hi}:${h.lo}`);
    }
    expect(seen.size).toBe(N);

    // Expected 32-bit collisions over the same key count, for the record.
    const expected32 = (N * (N - 1)) / 2 / 2 ** 32;
    expect(expected32).toBeGreaterThan(10);
  });

  it('separates domains and seeds', () => {
    const a = hashU64(SEED, DOMAIN.TERRAIN_BASE, 7);
    const b = hashU64(SEED, DOMAIN.EROSION, 7);
    const c = hashU64(makeSeed(0xdeadbeef, 0x12345679), DOMAIN.TERRAIN_BASE, 7);
    expect(`${a.hi}:${a.lo}`).not.toBe(`${b.hi}:${b.lo}`);
    expect(`${a.hi}:${a.lo}`).not.toBe(`${c.hi}:${c.lo}`);
  });

  it('avalanches: one input bit flips ~half of the 64 output bits', () => {
    let total = 0;
    let n = 0;
    const popcount = (x: number): number => {
      let c = 0;
      let v = x >>> 0;
      while (v) {
        c += v & 1;
        v >>>= 1;
      }
      return c;
    };
    for (let i = 0; i < 400; i++) {
      const a = hashU64(SEED, DOMAIN.TEST, i);
      for (let bit = 0; bit < 32; bit++) {
        const b = hashU64(SEED, DOMAIN.TEST, i ^ (1 << bit));
        total += popcount((a.hi ^ b.hi) >>> 0) + popcount((a.lo ^ b.lo) >>> 0);
        n++;
      }
    }
    expect(total / n).toBeGreaterThan(31.0);
    expect(total / n).toBeLessThan(33.0);
  });

  it('hashFloat01x64 is uniform in [0,1) with 53-bit resolution', () => {
    const buckets = new Array<number>(10).fill(0);
    const N = 200_000;
    const seen = new Set<number>();
    let outOfRange = 0;
    for (let i = 0; i < N; i++) {
      const v = hashFloat01x64(SEED, DOMAIN.TEST, i);
      if (!(v >= 0 && v < 1)) outOfRange++;
      buckets[Math.floor(v * 10)] = (buckets[Math.floor(v * 10)] ?? 0) + 1;
      if (i < 50_000) seen.add(v);
    }
    expect(outOfRange).toBe(0);
    const expected = N / 10;
    const chi2 = buckets.reduce((acc, o) => acc + (o - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(21.67); // 1% critical value, 9 dof
    // 32-bit floats would collide here; 53-bit must not.
    expect(seen.size).toBe(50_000);
  });

  it('hashFloat01x64 division by 2^53 is exact on this engine', () => {
    const TWO53 = 2 ** 53;
    expect(TWO53).toBe(9007199254740992);
    let bad = 0;
    for (let i = 0; i < 10_000; i++) {
      const v = hashFloat01x64(SEED, DOMAIN.TEST, i);
      const back = v * TWO53;
      if (!Number.isInteger(back) || back < 0 || back >= TWO53 || back / TWO53 !== v) bad++;
    }
    expect(bad).toBe(0);
  });
});
