/**
 * `hashWorldState` (T-0022, DEC-017). A 32-bit fold of the fields that *are*
 * the world: elevation, plates, climate T/q/ice, sea level, sim time.
 *
 * Used as the gold for same-seed / reversed-order / 1-4-8-worker identity.
 * Not a cryptographic hash.
 */

import { hashU64, type Seed, type SimTime } from '@ws/core';
import type { GeologyState } from './geology/plates.js';
import type { ClimateState } from './climate/solver.js';

export function hashWorldState(args: {
  readonly seed: Seed;
  readonly geology: GeologyState;
  readonly climate?: ClimateState;
  readonly seaLevel: number;
  readonly time: SimTime;
}): number {
  let h = hashU64(args.seed, 0xff, args.geology.level, args.seaLevel | 0, args.time.year).lo;
  const g = args.geology;
  const stride = Math.max(1, (g.cellCount / 4096) | 0);
  for (let i = 0; i < g.cellCount; i += stride) {
    const q = Math.round((g.elevationM[i] as number) * 10) | 0;
    h ^= Math.imul(q + (g.plateId[i] as number) * 131, 16777619);
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  }
  const c = args.climate;
  if (c) {
    for (let i = 0; i < c.grid.cellCount; i += Math.max(1, (c.grid.cellCount / 2048) | 0)) {
      const t = Math.round((c.T[i] as number) * 100) | 0;
      const q = Math.round((c.q[i] as number) * 1e6) | 0;
      h ^= Math.imul(t + q, 16777619);
      h = Math.imul(h ^ (h >>> 13), 0x846ca68b);
    }
    h ^= c.steps;
  }
  return h >>> 0;
}
