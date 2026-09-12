/**
 * Colour ramps for the data-layer visualiser (T-0019).
 *
 * Engineering instrument. Each ramp is a documented mapping from a physical
 * range to sRGB, used by the overlay and by tests (so a legend cannot silently
 * drift from the pixels).
 */

export interface Ramp {
  readonly name: string;
  readonly units: string;
  readonly min: number;
  readonly max: number;
  readonly stops: readonly (readonly [number, readonly [number, number, number]])[];
}

export const RAMPS: Readonly<Record<string, Ramp>> = {
  elevation: {
    name: 'elevation',
    units: 'm',
    min: -8000,
    max: 8000,
    stops: [
      [0, [8, 20, 48]],
      [0.35, [18, 72, 110]],
      [0.5, [210, 196, 140]],
      [0.62, [62, 110, 48]],
      [0.8, [120, 100, 72]],
      [1, [245, 248, 250]],
    ],
  },
  plateId: {
    name: 'plateId',
    units: 'id',
    min: 0,
    max: 12,
    stops: [
      [0, [40, 70, 140]],
      [0.33, [40, 140, 90]],
      [0.66, [180, 80, 50]],
      [1, [160, 50, 140]],
    ],
  },
  crustAge: {
    name: 'crustAge',
    units: 'Myr',
    min: 0,
    max: 180,
    stops: [
      [0, [255, 255, 180]],
      [0.5, [220, 80, 40]],
      [1, [40, 20, 80]],
    ],
  },
  uplift: {
    name: 'uplift',
    units: 'm',
    min: 0,
    max: 8000,
    stops: [
      [0, [20, 20, 24]],
      [1, [220, 70, 40]],
    ],
  },
  temperature: {
    name: 'temperature',
    units: 'K',
    min: 220,
    max: 310,
    stops: [
      [0, [40, 50, 160]],
      [0.5, [240, 240, 240]],
      [1, [180, 30, 30]],
    ],
  },
  precip: {
    name: 'precip',
    units: 'kg/m2/s',
    min: 0,
    max: 3e-7,
    stops: [
      [0, [30, 20, 10]],
      [1, [40, 160, 220]],
    ],
  },
  humidity: {
    name: 'humidity',
    units: 'kg/kg',
    min: 0,
    max: 0.02,
    stops: [
      [0, [20, 20, 24]],
      [1, [80, 180, 120]],
    ],
  },
  ice: {
    name: 'ice',
    units: 'frac',
    min: 0,
    max: 1,
    stops: [
      [0, [12, 24, 48]],
      [1, [230, 240, 255]],
    ],
  },
};

export function sampleRamp(ramp: Ramp, value: number): readonly [number, number, number] {
  const t = (value - ramp.min) / (ramp.max - ramp.min);
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  const stops = ramp.stops;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1] as (typeof stops)[number];
    const b = stops[i] as (typeof stops)[number];
    if (u <= b[0]) {
      const span = b[0] - a[0];
      const f = span <= 0 ? 0 : (u - a[0]) / span;
      return [
        a[1][0] + (b[1][0] - a[1][0]) * f,
        a[1][1] + (b[1][1] - a[1][1]) * f,
        a[1][2] + (b[1][2] - a[1][2]) * f,
      ];
    }
  }
  const last = stops[stops.length - 1] as (typeof stops)[number];
  return last[1];
}
