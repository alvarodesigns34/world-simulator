/**
 * Telemetry ring buffer (T-0017, DEC-024).
 *
 * Fixed-size, no allocation in the hot path once constructed. Timestamps are
 * supplied by the caller so this module stays legal in `core` (DEC-017 forbids
 * `performance.now` here). The app / renderer pass wall-clock microseconds in;
 * the simulation never reads them.
 *
 * Export is Chrome Trace Event JSON, which opens in Perfetto with no extra
 * tooling. Budget: QUALITY.telemetryOverheadMs = 0.2 ms/frame.
 */

export const ZONE = {
  FRAME: 0,
  INPUT: 1,
  SIM: 2,
  SELECT: 3,
  ENCODE: 4,
  GPU: 5,
  HUD: 6,
  SPIKE: 7,
} as const;

export type ZoneId = (typeof ZONE)[keyof typeof ZONE];

export const ZONE_NAME: readonly string[] = [
  'frame',
  'input',
  'simCommit',
  'lodSelect',
  'renderEncode',
  'gpu',
  'hud',
  'spike',
];

const SLOT_STRIDE = 4; // zone, startUs, durUs, frame

export interface TraceEvent {
  readonly name: string;
  readonly cat: string;
  readonly ph: 'X';
  readonly ts: number;
  readonly dur: number;
  readonly pid: 1;
  readonly tid: number;
  readonly args?: { frame: number };
}

export interface ChromeTrace {
  readonly traceEvents: TraceEvent[];
  readonly displayTimeUnit: 'ms';
  readonly otherData: {
    readonly engine: 'world-simulator';
    readonly milestone: 'M1';
  };
}

/**
 * Fixed-capacity ring. `begin`/`end` write into a preallocated Float64Array.
 * `begin` returns a slot index; `end` fills duration. Nested zones are allowed
 * (the open stack is also preallocated).
 */
export class Telemetry {
  private readonly slots: Float64Array;
  private readonly capacity: number;
  private write = 0;
  private filled = 0;
  private readonly open: Int32Array;
  private openN = 0;
  private frame = 0;
  /** Frames whose wall time exceeded this (µs). Default 33 ms. */
  spikeUs: number;

  constructor(capacity = 8192, spikeMs = 33) {
    this.capacity = capacity;
    this.slots = new Float64Array(capacity * SLOT_STRIDE);
    this.open = new Int32Array(32);
    this.spikeUs = spikeMs * 1000;
  }

  get frameIndex(): number {
    return this.frame;
  }

  nextFrame(): void {
    this.frame++;
  }

  /**
   * Open a zone at `nowUs`. Returns a handle for `end`. Does not allocate.
   */
  begin(zone: ZoneId, nowUs: number): number {
    const i = this.write;
    const base = i * SLOT_STRIDE;
    this.slots[base] = zone;
    this.slots[base + 1] = nowUs;
    this.slots[base + 2] = 0;
    this.slots[base + 3] = this.frame;
    this.write = (i + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
    if (this.openN < this.open.length) {
      this.open[this.openN++] = i;
    }
    return i;
  }

  end(handle: number, nowUs: number): void {
    const base = handle * SLOT_STRIDE;
    const start = this.slots[base + 1] as number;
    this.slots[base + 2] = nowUs - start;
    if (this.openN > 0) this.openN--;
  }

  /** Record a complete sample in one call (GPU timestamps that arrive late). */
  record(zone: ZoneId, startUs: number, durUs: number): void {
    const i = this.write;
    const base = i * SLOT_STRIDE;
    this.slots[base] = zone;
    this.slots[base + 1] = startUs;
    this.slots[base + 2] = durUs;
    this.slots[base + 3] = this.frame;
    this.write = (i + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  /** Last recorded duration for a zone, or 0. Scans newest-first, bounded. */
  lastDurationUs(zone: ZoneId): number {
    const n = this.filled;
    for (let k = 1; k <= n; k++) {
      const i = (this.write - k + this.capacity) % this.capacity;
      const base = i * SLOT_STRIDE;
      if (this.slots[base] === zone) return this.slots[base + 2] as number;
    }
    return 0;
  }

  /** Count of recorded spikes in the ring. */
  spikeCount(): number {
    let n = 0;
    for (let k = 0; k < this.filled; k++) {
      const i = (this.write - 1 - k + this.capacity * 2) % this.capacity;
      const base = i * SLOT_STRIDE;
      if (this.slots[base] === ZONE.FRAME && (this.slots[base + 2] as number) > this.spikeUs) n++;
    }
    return n;
  }

  /** Chrome Trace Event JSON. Allocates only at export time, never per frame. */
  toChromeTrace(): ChromeTrace {
    const events: TraceEvent[] = [];
    const n = this.filled;
    const start = n === this.capacity ? this.write : 0;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % this.capacity;
      const base = i * SLOT_STRIDE;
      const zone = this.slots[base] as ZoneId;
      const dur = this.slots[base + 2] as number;
      if (dur <= 0) continue;
      events.push({
        name: ZONE_NAME[zone] ?? 'unknown',
        cat: zone === ZONE.GPU ? 'gpu' : 'cpu',
        ph: 'X',
        ts: this.slots[base + 1] as number,
        dur,
        pid: 1,
        tid: zone === ZONE.GPU ? 2 : 1,
        args: { frame: this.slots[base + 3] as number },
      });
    }
    return {
      traceEvents: events,
      displayTimeUnit: 'ms',
      otherData: { engine: 'world-simulator', milestone: 'M1' },
    };
  }

  toJSONString(): string {
    return JSON.stringify(this.toChromeTrace());
  }

  clear(): void {
    this.write = 0;
    this.filled = 0;
    this.openN = 0;
    this.frame = 0;
  }
}

/** Wall-clock µs. Lives at the call site so `core` never touches `performance`. */
export function usFromMs(ms: number): number {
  return ms * 1000;
}
