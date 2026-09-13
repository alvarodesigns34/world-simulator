import type { FieldOverlay } from '@ws/render';
import {
  SCIENTIFIC_FIELDS,
  compareFields,
  exportFieldJson,
  exportRasterLike,
  exportSeriesCsv,
  geodesicCrossSection,
  scientificField,
  verticalProfile,
  type ScientificFieldView,
  type World,
} from '@ws/sim';

type Download = (filename: string, text: string, type?: string) => void;

/** Compact M12 instrument panel; all plots read state/history, never replay. */
export class ScientificPanel {
  readonly root: HTMLDivElement;
  private readonly plot: HTMLCanvasElement;
  private readonly readout: HTMLDivElement;
  private readonly points: { lat: number; lon: number }[] = [];
  private captured: ScientificFieldView | undefined;
  private lastHistorySize = -1;

  constructor(parent: HTMLElement, private readonly world: World, overlay: FieldOverlay, download: Download) {
    this.root = document.createElement('div');
    this.root.setAttribute('style',
      'position:fixed;right:8px;top:8px;z-index:20;width:300px;color:#d8e7ef;background:rgba(5,12,17,.9);' +
      'border:1px solid rgba(130,180,205,.25);border-radius:10px;padding:9px;font:10px/1.35 ui-monospace,monospace');
    this.root.innerHTML = `<div style="letter-spacing:.12em;color:#78bad8">SCIENTIFIC INSTRUMENT</div>
      <select data-role="field" style="width:100%;margin:7px 0"></select>
      <div style="display:flex;gap:4px;flex-wrap:wrap"><button data-act="json">JSON</button><button data-act="raster">RASTER-LIKE</button>
      <button data-act="csv">SERIES CSV</button><button data-act="capture">CAPTURE ERA A</button><button data-act="compare">COMPARE B−A</button></div>
      <canvas data-role="plot" width="282" height="84" style="width:282px;height:84px;margin-top:7px;background:#071018"></canvas>
      <div data-role="readout" style="margin-top:5px;color:#abc8d7">Click two points on the map overlay for a geodesic cross-section.</div>`;
    parent.appendChild(this.root);
    const select = this.pick<HTMLSelectElement>('[data-role=field]');
    for (const field of SCIENTIFIC_FIELDS) {
      const option = document.createElement('option');
      option.value = field.id;
      option.textContent = `${field.subsystem} · ${field.label} [${field.units}]`;
      select.appendChild(option);
    }
    select.value = world.visualField;
    select.onchange = () => world.apply({ kind: 'setVisualField', field: select.value });
    this.plot = this.pick<HTMLCanvasElement>('[data-role=plot]');
    this.readout = this.pick<HTMLDivElement>('[data-role=readout]');
    this.pick<HTMLButtonElement>('[data-act=json]').onclick = () => download(`${world.visualField}.json`, exportFieldJson(scientificField(world, world.visualField)));
    this.pick<HTMLButtonElement>('[data-act=raster]').onclick = () => {
      const view = scientificField(world, world.visualField);
      if (view.descriptor.grid === 'cubesphere') download(`${world.visualField}.ws-raster.json`, exportRasterLike(view));
      else this.readout.textContent = 'Raster-like export currently requires a cube-sphere field.';
    };
    this.pick<HTMLButtonElement>('[data-act=csv]').onclick = () => download('world-history.csv',
      exportSeriesCsv(world, ['population', 'temperature', 'pollution']), 'text/csv');
    this.pick<HTMLButtonElement>('[data-act=capture]').onclick = () => {
      const view = scientificField(world, world.visualField);
      this.captured = { ...view, values: Float64Array.from(view.values),
        ...(view.vectorV === undefined ? {} : { vectorV: Float64Array.from(view.vectorV) }) };
      this.readout.textContent = `Era A captured: ${view.descriptor.label}`;
    };
    this.pick<HTMLButtonElement>('[data-act=compare]').onclick = () => {
      if (this.captured === undefined) { this.readout.textContent = 'Capture era A first.'; return; }
      const delta = compareFields(this.captured, scientificField(world, world.visualField));
      let lo = Infinity; let hi = -Infinity; let changed = 0;
      for (const value of delta) { lo = Math.min(lo, value); hi = Math.max(hi, value); if (value !== 0) changed++; }
      this.readout.textContent = `A/B difference · min ${lo.toPrecision(4)} · max ${hi.toPrecision(4)} · changed ${String(changed)}`;
    };
    overlay.canvas.addEventListener('click', () => {
      const p = overlay.probeLonLat;
      if (p === null) return;
      this.points.push({ ...p });
      const profile = verticalProfile(world, p.lat, p.lon);
      this.readout.textContent = `Point profile · surface ${profile.surfaceElevationM.toFixed(0)} m · atmosphere ${String(profile.atmosphere.length)} reduced levels`;
      if (this.points.length === 2) {
        const section = geodesicCrossSection(world, this.points[0]!, this.points[1]!, 96);
        this.drawSection(section.map((s) => s.elevationM));
        this.readout.textContent = `Geodesic section ${(section.at(-1)!.distanceM / 1000).toFixed(0)} km · 96 samples`;
        this.points.length = 0;
      }
    });
  }

  update(): void {
    const n = this.world.history.samples('population').length;
    if (n === this.lastHistorySize) return;
    this.lastHistorySize = n;
    this.drawHistory();
  }

  private drawHistory(): void {
    const ctx = this.plot.getContext('2d');
    if (ctx === null) return;
    ctx.clearRect(0, 0, this.plot.width, this.plot.height);
    const series = ['population', 'temperature', 'pollution'] as const;
    const colours = ['#e8bf66', '#e97963', '#9f7bd8'];
    for (let k = 0; k < series.length; k++) {
      const samples = this.world.history.samples(series[k]!);
      if (samples.length < 2) continue;
      let lo = Infinity; let hi = -Infinity;
      for (const s of samples) { lo = Math.min(lo, s.value); hi = Math.max(hi, s.value); }
      ctx.strokeStyle = colours[k]!; ctx.beginPath();
      samples.forEach((s, i) => {
        const x = i / (samples.length - 1) * (this.plot.width - 1);
        const y = this.plot.height - 1 - (s.value - lo) / Math.max(1e-12, hi - lo) * (this.plot.height - 1);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  private drawSection(values: readonly number[]): void {
    const ctx = this.plot.getContext('2d');
    if (ctx === null) return;
    ctx.clearRect(0, 0, this.plot.width, this.plot.height);
    const lo = Math.min(...values); const hi = Math.max(...values);
    ctx.strokeStyle = '#a8d8e8'; ctx.beginPath();
    values.forEach((v, i) => {
      const x = i / (values.length - 1) * (this.plot.width - 1);
      const y = this.plot.height - 1 - (v - lo) / Math.max(1, hi - lo) * (this.plot.height - 1);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  private pick<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error(`scientific element missing: ${selector}`);
    return element as T;
  }
}
