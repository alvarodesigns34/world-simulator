import { afterEach, describe, expect, it } from 'vitest';
import { acquireGpu } from '@ws/render';

/**
 * timestamp-query is OPTIONAL. Advertising it on the adapter and then listing
 * it in requiredFeatures is how a flaky driver feature becomes "no-device"
 * and a black screen. The HUD flag must come from the device that exists.
 */
describe('acquireGpu: timestamp-query is optional', () => {
  const originalNav = (globalThis as { navigator?: unknown }).navigator;

  afterEach(() => {
    if (originalNav === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else (globalThis as { navigator?: unknown }).navigator = originalNav;
  });

  it('returns no-navigator-gpu under Node', async () => {
    delete (globalThis as { navigator?: unknown }).navigator;
    const r = await acquireGpu();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-navigator-gpu');
  });

  it('retries without timestamp-query when requiredFeatures rejects it', async () => {
    const device = {
      features: { has: (f: string) => f !== 'timestamp-query' },
      lost: Promise.resolve({ reason: 'unknown', message: '' }),
      addEventListener: () => undefined,
    };
    let calls = 0;
    const adapter = {
      features: { has: (f: string) => f === 'timestamp-query' },
      limits: { maxBufferSize: 1 << 20 },
      requestDevice: async (desc: { requiredFeatures: string[] }) => {
        calls++;
        if (desc.requiredFeatures.includes('timestamp-query')) {
          throw new Error('timestamp-query not allowed on this device');
        }
        return device;
      },
    };
    (globalThis as { navigator: unknown }).navigator = {
      gpu: {
        requestAdapter: async () => adapter,
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    };

    const r = await acquireGpu();
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    if (r.ok) expect(r.hasTimestampQuery).toBe(false);
  });

  it('reports hasTimestampQuery from the device, not the adapter', async () => {
    const device = {
      features: { has: (f: string) => f === 'timestamp-query' },
      lost: Promise.resolve({ reason: 'unknown', message: '' }),
      addEventListener: () => undefined,
    };
    const adapter = {
      features: { has: (f: string) => f === 'timestamp-query' },
      limits: { maxBufferSize: 1 << 30 },
      requestDevice: async () => device,
    };
    (globalThis as { navigator: unknown }).navigator = {
      gpu: {
        requestAdapter: async () => adapter,
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    };
    const r = await acquireGpu();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hasTimestampQuery).toBe(true);
  });
});
