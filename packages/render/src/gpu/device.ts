/**
 * WebGPU device acquisition (T-0010, DEC-003, DEC-032).
 *
 * WebGPU is the only backend; there is no WebGL2 fallback and none will be
 * written (DEC-003). What there IS is a clean, explicit failure: a user whose
 * browser or driver cannot run this gets a specific reason, not a blank canvas.
 *
 * Every WebGPU call in the project lives under `render/src/gpu/` — `navigator.gpu`
 * anywhere else is a boundary-checker error.
 */

import { budgets } from '@ws/core';

export type GpuUnavailableReason =
  | 'no-navigator-gpu'
  | 'no-adapter'
  | 'no-device'
  | 'device-lost';

export interface GpuUnavailable {
  readonly ok: false;
  readonly reason: GpuUnavailableReason;
  readonly message: string;
}

export interface GpuContext {
  readonly ok: true;
  readonly device: GPUDevice;
  readonly adapter: GPUAdapter;
  readonly format: GPUTextureFormat;
  readonly tier: budgets.GpuTier;
  readonly hasTimestampQuery: boolean;
  readonly adapterInfo: string;
  /** Populated if the device is lost after acquisition. HUD reads this. */
  lostReason(): string | null;
  lastUncapturedError(): string | null;
}

export type GpuAcquireResult = GpuContext | GpuUnavailable;

const MESSAGES: Readonly<Record<GpuUnavailableReason, string>> = {
  'no-navigator-gpu':
    'This browser does not expose WebGPU. World Simulator requires WebGPU: ' +
    'its terrain, ocean and atmosphere are built on compute shaders, which WebGL2 does not have. ' +
    'Chrome, Edge, Safari 26+ or Firefox with WebGPU enabled will work.',
  'no-adapter':
    'WebGPU is present but no graphics adapter was offered. This usually means the GPU is ' +
    'blocklisted by the driver, or the browser is running without hardware acceleration.',
  'no-device':
    'A WebGPU adapter was found but the device could not be created. The driver may be out of date.',
  'device-lost': 'The WebGPU device was lost. Reloading usually recovers it.',
};

/**
 * Guess a hardware tier (DEC-032 amendment 2).
 *
 * Adapters do not report performance, so this reads what hints exist and errs
 * DOWNWARD: guessing too low costs some quality, guessing too high costs the
 * frame budget. Overridable, and the HUD shows which tier is active so a wrong
 * guess is visible rather than mysterious.
 */
export function inferTier(adapter: GPUAdapter, info?: GPUAdapterInfo): budgets.GpuTier {
  const desc = `${info?.vendor ?? ''} ${info?.architecture ?? ''} ${info?.description ?? ''}`.toLowerCase();
  if (/nvidia|radeon rx|geforce|rtx|arc a/.test(desc)) return 'discrete';
  if (/apple/.test(desc)) return 'integrated';
  if (/iris|uhd|hd graphics|adreno|mali|powervr/.test(desc)) return 'floor';
  const maxBuf = adapter.limits.maxBufferSize ?? 0;
  return maxBuf >= 1 << 30 ? 'integrated' : 'floor';
}

export async function acquireGpu(): Promise<GpuAcquireResult> {
  const nav = globalThis.navigator as Navigator | undefined;
  if (nav?.gpu === undefined) {
    return { ok: false, reason: 'no-navigator-gpu', message: MESSAGES['no-navigator-gpu'] };
  }

  const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (adapter === null) {
    return { ok: false, reason: 'no-adapter', message: MESSAGES['no-adapter'] };
  }

  const wantTimestamp = adapter.features.has('timestamp-query');
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({
      requiredFeatures: wantTimestamp ? (['timestamp-query'] as GPUFeatureName[]) : [],
    });
  } catch {
    return { ok: false, reason: 'no-device', message: MESSAGES['no-device'] };
  }

  let lost: string | null = null;
  let lastError: string | null = null;
  void device.lost.then((info) => {
    lost = `${info.reason}: ${info.message}`;
  });
  device.addEventListener('uncapturederror', (ev) => {
    ev.preventDefault();
    lastError = ev.error.message;
  });

  const info = (adapter as { info?: GPUAdapterInfo }).info;
  return {
    ok: true,
    device,
    adapter,
    format: nav.gpu.getPreferredCanvasFormat(),
    tier: inferTier(adapter, info),
    hasTimestampQuery: wantTimestamp,
    adapterInfo: info
      ? `${info.vendor ?? '?'} / ${info.architecture ?? '?'} ${info.description ?? ''}`.trim()
      : 'unknown adapter',
    lostReason: () => lost,
    lastUncapturedError: () => lastError,
  };
}

export function unavailableMessage(reason: GpuUnavailableReason): string {
  return MESSAGES[reason];
}
