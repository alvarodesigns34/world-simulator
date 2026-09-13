import { describe, expect, it } from 'vitest';
import { arbitragePasses } from '../src/economy/system.js';

describe('M10 temporal LOD for local arbitrage', () => {
  it('derives propagation work from simulated time and bounds it by sparse graph diameter', () => {
    expect(arbitragePasses(1, 100)).toBe(3);
    expect(arbitragePasses(100, 100)).toBe(7);
    expect(arbitragePasses(500, 9)).toBe(8);
    expect(arbitragePasses(1e6, 10_000)).toBe(8);
  });
});
