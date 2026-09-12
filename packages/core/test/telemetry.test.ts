import { describe, expect, it } from 'vitest';
import { Telemetry, ZONE, ZONE_NAME } from '@ws/core';

describe('Telemetry ring buffer (T-0017, DEC-024)', () => {
  it('records begin/end without growing', () => {
    const t = new Telemetry(8);
    const a = t.begin(ZONE.SELECT, 1000);
    t.end(a, 1500);
    expect(t.lastDurationUs(ZONE.SELECT)).toBe(500);
  });

  it('wraps without allocating new slots — oldest is overwritten', () => {
    const t = new Telemetry(4);
    for (let i = 0; i < 10; i++) t.record(ZONE.FRAME, i * 16_000, 1_000 + i);
    expect(t.lastDurationUs(ZONE.FRAME)).toBe(1_009);
    const json = t.toChromeTrace();
    expect(json.traceEvents.length).toBe(4);
  });

  it('exports Perfetto-openable Chrome Trace Event JSON', () => {
    const t = new Telemetry(16);
    t.begin(ZONE.FRAME, 0);
    t.end(0, 16_600);
    t.record(ZONE.GPU, 100, 4_000);
    const doc = t.toChromeTrace();
    expect(doc.displayTimeUnit).toBe('ms');
    expect(doc.otherData.milestone).toBe('M1');
    const names = doc.traceEvents.map((e) => e.name);
    expect(names).toContain(ZONE_NAME[ZONE.FRAME]);
    expect(names).toContain('gpu');
    for (const e of doc.traceEvents) {
      expect(e.ph).toBe('X');
      expect(e.dur).toBeGreaterThan(0);
    }
    expect(() => JSON.parse(t.toJSONString())).not.toThrow();
  });

  it('counts spikes against a threshold', () => {
    const t = new Telemetry(32, 33);
    t.record(ZONE.FRAME, 0, 16_000);
    t.record(ZONE.FRAME, 16_000, 40_000);
    t.record(ZONE.FRAME, 56_000, 12_000);
    expect(t.spikeCount()).toBe(1);
  });

  it('frame index is a counter, not a timestamp', () => {
    const t = new Telemetry();
    expect(t.frameIndex).toBe(0);
    t.nextFrame();
    t.nextFrame();
    expect(t.frameIndex).toBe(2);
  });
});
