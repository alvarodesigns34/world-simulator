import { format } from '@ws/core';
import { saveRecipe, saveSnapshot, type World } from '@ws/sim';

type Download = (filename: string, text: string, type?: string) => void;

/** M11 planet-native timeline controls. Scrubbing reads recorded history. */
export class TimelinePanel {
  readonly root: HTMLDivElement;
  private readonly time: HTMLSpanElement;
  private readonly status: HTMLSpanElement;
  private readonly scrub: HTMLInputElement;
  private readonly readout: HTMLSpanElement;
  private readonly world: World;

  constructor(parent: HTMLElement, world: World, download: Download) {
    this.world = world;
    this.root = document.createElement('div');
    this.root.setAttribute('style',
      'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:20;width:min(760px,calc(100vw - 40px));' +
      'color:#d8e7ef;background:linear-gradient(180deg,rgba(10,20,27,.88),rgba(4,10,14,.94));' +
      'border:1px solid rgba(130,180,205,.25);border-radius:14px;padding:10px 13px;backdrop-filter:blur(16px);' +
      'font:11px/1.3 ui-monospace,monospace;box-shadow:0 12px 44px rgba(0,0,0,.42)');
    this.root.innerHTML = `<div style="display:flex;gap:9px;align-items:center">
      <button data-act="play">Ⅱ</button><span data-role="time"></span>
      <select data-role="tier" title="Temporal regime">
        <option value="1">T0 REALTIME</option><option value="10000">T1 DAYS</option>
        <option value="10000000">T2 YEARS</option><option value="1000000000">T3 CENTURIES</option>
        <option value="100000000000">T4 PALEO</option>
      </select>
      <span data-role="status" style="margin-left:auto;color:#79b9d6">LIVE</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin-top:8px">
      <input data-role="scrub" type="range" min="0" max="0" value="0" step="1" aria-label="Recorded timeline">
      <span data-role="readout">history: waiting</span>
    </div>
    <div style="display:flex;gap:7px;margin-top:8px;align-items:center">
      <input data-role="years" type="number" min="1" value="1000000" style="width:105px" aria-label="Years to jump">
      <button data-act="jump">JUMP YEARS</button><button data-act="bookmark">BOOKMARK</button>
      <button data-act="recipe">RECIPE</button><button data-act="snapshot">SNAPSHOT</button>
    </div>`;
    parent.appendChild(this.root);
    this.time = this.pick('[data-role=time]');
    this.status = this.pick('[data-role=status]');
    this.scrub = this.pick('[data-role=scrub]');
    this.readout = this.pick('[data-role=readout]');
    const tier = this.pick<HTMLSelectElement>('[data-role=tier]');
    const years = this.pick<HTMLInputElement>('[data-role=years]');
    this.pick<HTMLButtonElement>('[data-act=play]').onclick = (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      if (world.scheduler.state === 'running') { world.apply({ kind: 'pause' }); button.textContent = '▶'; }
      else { world.apply({ kind: 'resume' }); button.textContent = 'Ⅱ'; }
    };
    tier.onchange = () => world.apply({ kind: 'setTimeScale', scale: Number(tier.value) });
    this.pick<HTMLButtonElement>('[data-act=jump]').onclick = () => {
      const n = Number(years.value);
      if (Number.isFinite(n) && n > 0) world.advanceDeepTime(n);
    };
    this.pick<HTMLButtonElement>('[data-act=bookmark]').onclick = () => {
      world.apply({ kind: 'bookmark', label: `Year ${String(world.scheduler.time.year)}` });
    };
    this.pick<HTMLButtonElement>('[data-act=recipe]').onclick = () => download('world.recipe.json', saveRecipe(world));
    this.pick<HTMLButtonElement>('[data-act=snapshot]').onclick = () => download('world.snapshot.json', saveSnapshot(world));
    this.scrub.oninput = () => this.showHistorical(Number(this.scrub.value));
  }

  update(): void {
    this.time.textContent = format(this.world.scheduler.time, this.world.calendar);
    const samples = this.world.history.samples('population');
    this.scrub.max = String(Math.max(0, samples.length - 1));
    if (this.status.textContent === 'LIVE') this.scrub.value = this.scrub.max;
  }

  private showHistorical(index: number): void {
    const population = this.world.history.samples('population');
    const temperature = this.world.history.samples('temperature');
    const p = population[index];
    const t = temperature[index];
    if (p === undefined) return;
    this.status.textContent = index === population.length - 1 ? 'LIVE' : 'HISTORY VIEW · RECORDED SNAPSHOT';
    this.status.style.color = index === population.length - 1 ? '#79b9d6' : '#e0bd73';
    this.readout.textContent = `Y${String(p.time.year)} · pop ${p.value.toPrecision(4)} · ${t === undefined ? '—' : `${t.value.toFixed(2)} K`}`;
  }

  private pick<T extends HTMLElement = HTMLSpanElement>(selector: string): T {
    const element = this.root.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error(`timeline element missing: ${selector}`);
    return element as T;
  }
}
