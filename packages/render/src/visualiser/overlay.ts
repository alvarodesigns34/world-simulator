/**
 * Data-layer visualiser (T-0019). Equirectangular sample of a cube-sphere or
 * geodesic field, with colour ramp, legend and a probe.
 *
 * Lives in `render`. Reads numbers the app hands it — never a sim import.
 */

import { cubeDim, cubeFaceToUnitRaw, cubeIndex } from '@ws/data';
import { RAMPS, sampleRamp, type Ramp } from './ramps.js';

export interface OverlayField {
  readonly name: string;
  readonly values: ArrayLike<number>;
  readonly kind: 'cubesphere' | 'geodesic';
  readonly level: number;
  readonly positions?: Float64Array;
  readonly vectorV?: ArrayLike<number>;
  readonly metadata?: {
    readonly label: string;
    readonly units: string;
    readonly kind: 'continuous' | 'categorical' | 'vector';
    readonly domain: readonly [number, number];
    readonly categories?: Readonly<Record<number, string>>;
  };
}

export class FieldOverlay {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly w: number;
  private readonly h: number;
  probe: { lon: number; lat: number; value: number; name: string } | null = null;
  visible = true;
  /** Instrumented CPU cost of the most recent actual visualiser refresh. */
  cpuMs = 0;
  private lastDrawAt = -Infinity;
  private readonly geodesicLookup = new WeakMap<Float64Array, Int32Array>();

  constructor(parent: HTMLElement, width = 320, height = 160) {
    this.w = width;
    this.h = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.setAttribute(
      'style',
      'position:fixed;right:8px;bottom:8px;width:320px;height:160px;image-rendering:pixelated;border:1px solid #1d2a35;background:#070b0f;z-index:11',
    );
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d context');
    this.ctx = ctx;
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * this.w;
      const y = ((e.clientY - r.top) / r.height) * this.h;
      this.probeLonLat = { lon: (x / this.w) * 2 * Math.PI - Math.PI, lat: Math.PI / 2 - (y / this.h) * Math.PI };
    });
  }

  probeLonLat: { lon: number; lat: number } | null = null;

  draw(field: OverlayField): void {
    if (!this.visible) {
      this.canvas.style.display = 'none';
      return;
    }
    this.canvas.style.display = 'block';
    const now = performance.now();
    /* Scientific layers are slow state. Updating at 10 Hz keeps cursor probes
       responsive while making normal per-frame main-thread overhead tiny. */
    if (now - this.lastDrawAt < 100) return;
    this.lastDrawAt = now;
    const started = now;
    const ramp: Ramp = RAMPS[field.name] ?? (field.metadata === undefined ? RAMPS.elevation! : {
      name: field.metadata.label,
      units: field.metadata.units,
      min: field.metadata.domain[0],
      max: field.metadata.domain[1],
      stops: [[0, [16, 28, 48]], [0.5, [54, 162, 178]], [1, [244, 180, 78]]],
    });
    const img = this.ctx.createImageData(this.w, this.h);
    let probeVal = 0;
    let probeSet = false;
    for (let py = 0; py < this.h; py++) {
      const lat = Math.PI / 2 - ((py + 0.5) / this.h) * Math.PI;
      const cz = Math.sin(lat);
      const cr = Math.cos(lat);
      for (let px = 0; px < this.w; px++) {
        const lon = ((px + 0.5) / this.w) * 2 * Math.PI - Math.PI;
        const cx = cr * Math.cos(lon);
        const cy = cr * Math.sin(lon);
        const v = this.sampleField(field, cx, cy, cz, py * this.w + px);
        const [r, g, b] = field.metadata?.kind === 'categorical' ? categoryColour(v) : sampleRamp(ramp, v);
        const i = (py * this.w + px) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
        if (this.probeLonLat) {
          const dlon = lon - this.probeLonLat.lon;
          const dlat = lat - this.probeLonLat.lat;
          if (!probeSet || dlon * dlon + dlat * dlat < 1e-4) {
            probeVal = v;
            probeSet = true;
          }
        }
      }
    }
    this.ctx.putImageData(img, 0, 0);
    if (field.metadata?.kind === 'vector' && field.vectorV !== undefined) this.drawVectors(field);
    this.ctx.fillStyle = '#cfe3ef';
    this.ctx.font = '10px ui-monospace,monospace';
    const label = field.metadata?.label ?? ramp.name;
    const units = field.metadata?.units ?? ramp.units;
    const domain = field.metadata?.domain ?? [ramp.min, ramp.max] as const;
    this.ctx.fillText(`${label}  ${String(domain[0])}–${String(domain[1])} ${units}`, 6, 12);
    if (field.metadata?.kind === 'categorical' && field.metadata.categories !== undefined) {
      const entries = Object.entries(field.metadata.categories).slice(0, 5);
      this.ctx.fillText(entries.map(([id, name]) => `${id}:${name}`).join(' · '), 6, 25);
    }
    if (this.probeLonLat && probeSet) {
      this.probe = { ...this.probeLonLat, value: probeVal, name: field.name };
      const category = field.metadata?.categories?.[Math.trunc(probeVal)];
      this.ctx.fillText(`probe ${category ?? probeVal.toFixed(3)} ${units}`, 6, this.h - 6);
    }
    this.cpuMs = performance.now() - started;
  }

  private drawVectors(field: OverlayField): void {
    this.ctx.strokeStyle = 'rgba(235,248,255,.72)';
    this.ctx.lineWidth = 0.75;
    for (let py = 10; py < this.h; py += 16) {
      const lat = Math.PI / 2 - ((py + 0.5) / this.h) * Math.PI;
      const cr = Math.cos(lat);
      for (let px = 10; px < this.w; px += 20) {
        const lon = ((px + 0.5) / this.w) * 2 * Math.PI - Math.PI;
        const x = cr * Math.cos(lon);
        const y = cr * Math.sin(lon);
        const z = Math.sin(lat);
        const pixel = py * this.w + px;
        const u = this.sampleField(field, x, y, z, pixel);
        const v = this.sampleField({ ...field, values: field.vectorV! }, x, y, z, pixel);
        const magnitude = Math.sqrt(u * u + v * v);
        if (!(magnitude > 1e-9)) continue;
        const scale = Math.min(6, 1 + magnitude * 0.12) / magnitude;
        this.ctx.beginPath();
        this.ctx.moveTo(px, py);
        this.ctx.lineTo(px + u * scale, py - v * scale);
        this.ctx.stroke();
      }
    }
  }

  private sampleField(field: OverlayField, x: number, y: number, z: number, pixel: number): number {
    if (field.kind === 'geodesic' && field.positions !== undefined) {
      let lookup = this.geodesicLookup.get(field.positions);
      if (lookup === undefined) {
        lookup = buildGeodesicLookup(field.positions, this.w, this.h, field.values.length);
        this.geodesicLookup.set(field.positions, lookup);
      }
      return field.values[lookup[pixel] as number] as number;
    }
    return sampleField(field, x, y, z);
  }
}

function buildGeodesicLookup(positions: Float64Array, width: number, height: number, count: number): Int32Array {
  const lookup = new Int32Array(width * height);
  for (let py = 0; py < height; py++) {
    const lat = Math.PI / 2 - ((py + 0.5) / height) * Math.PI;
    const z = Math.sin(lat);
    const radius = Math.cos(lat);
    for (let px = 0; px < width; px++) {
      const lon = ((px + 0.5) / width) * 2 * Math.PI - Math.PI;
      const x = radius * Math.cos(lon);
      const y = radius * Math.sin(lon);
      let best = 0;
      let bestDot = -2;
      for (let i = 0; i < count; i++) {
        const dot = x * (positions[i * 3] as number) + y * (positions[i * 3 + 1] as number) + z * (positions[i * 3 + 2] as number);
        if (dot > bestDot) { bestDot = dot; best = i; }
      }
      lookup[py * width + px] = best;
    }
  }
  return lookup;
}

/** Stable palette from the category id; adjacent ids do not interpolate. */
function categoryColour(value: number): readonly [number, number, number] {
  const id = Math.trunc(value);
  if (id < 0) return [18, 23, 29];
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return [55 + (h & 0x9f), 55 + ((h >>> 8) & 0x9f), 55 + ((h >>> 16) & 0x9f)];
}

function sampleField(field: OverlayField, x: number, y: number, z: number): number {
  if (field.kind === 'geodesic' && field.positions) {
    let best = 0;
    let bestDot = -2;
    const p = field.positions;
    const n = field.values.length;
    for (let i = 0; i < n; i++) {
      const d = x * (p[i * 3] as number) + y * (p[i * 3 + 1] as number) + z * (p[i * 3 + 2] as number);
      if (d > bestDot) {
        bestDot = d;
        best = i;
      }
    }
    return field.values[best] as number;
  }
  const face = dominantFace(x, y, z);
  const uv = faceUv(face, x, y, z);
  const dim = cubeDim(field.level);
  const xi = Math.min(dim - 1, Math.max(0, Math.floor(uv.u * dim)));
  const yi = Math.min(dim - 1, Math.max(0, Math.floor(uv.v * dim)));
  return field.values[cubeIndex(face, field.level, xi, yi)] as number;
}

function dominantFace(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  if (ax >= ay && ax >= az) return x >= 0 ? 0 : 1;
  if (ay >= az) return y >= 0 ? 2 : 3;
  return z >= 0 ? 4 : 5;
}

function faceUv(face: number, x: number, y: number, z: number): { u: number; v: number } {
  const p = cubeFaceToUnitRaw(face, 0.5, 0.5);
  void p;
  /* Inverse of DEC-035 table, matching seams.ts unitToFaceUnclamped. */
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let a = 0;
  let b = 0;
  if (face === 0) {
    a = y / ax;
    b = z / ax;
  } else if (face === 1) {
    a = -y / ax;
    b = z / ax;
  } else if (face === 2) {
    a = x / ay;
    b = -z / ay;
  } else if (face === 3) {
    a = x / ay;
    b = z / ay;
  } else if (face === 4) {
    a = x / az;
    b = y / az;
  } else {
    a = x / az;
    b = -y / az;
  }
  const QUARTER_PI = Math.PI / 4;
  const u = (Math.atan(Math.min(1, Math.max(-1, a))) / QUARTER_PI + 1) * 0.5;
  const v = (Math.atan(Math.min(1, Math.max(-1, b))) / QUARTER_PI + 1) * 0.5;
  return { u, v };
}
