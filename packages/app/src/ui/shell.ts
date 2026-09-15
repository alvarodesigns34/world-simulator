/**
 * The product interface (T-0164).
 *
 * WHAT THIS REPLACES. The only interface the application had was a monospaced
 * block of engineering readouts — frame times, patch counts, winding
 * convention, pool hit rates — plus a line of bracketed key hints. It is a good
 * instrument and it is still here, behind F3. It was never an interface: to use
 * the simulator you had to already know fifteen hotkeys, and nothing on screen
 * told you the world had a timeline, layers, features or anything to select.
 *
 * WHAT THIS IS. Four regions, each answering one question:
 *
 *   top bar     what is this world and what is time doing?
 *   left rail   what can I look at, and where can I go?
 *   inspector   what is HERE?
 *   timeline    where am I in this world's history?
 *
 * Everything reachable by hotkey is also reachable by clicking something
 * labelled, which is the actual acceptance criterion: a user should not have to
 * memorise anything to find out what the application does.
 *
 * SEPARATION. The shell owns no world state and no camera. It renders what it
 * is given and calls back; `main.ts` remains the only place `sim` and `render`
 * meet (DEC-011).
 */

import { installTheme } from './theme.js';

export interface LayerOption {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
}

export interface FeatureOption {
  readonly id: string;
  readonly label: string;
  /** Why the world chose this place. Shown when it is known. */
  hint?: string;
  /** False when the world has nothing to put here yet. */
  available?: boolean;
}

export interface ShellCallbacks {
  onPlayPause(): void;
  onSpeed(scale: number): void;
  onLayer(id: string): void;
  onFeature(id: string): void;
  onSunMode(): void;
  onScrub(fraction: number): void;
  onResumeLive(): void;
  onBookmark(): void;
  onDeepTime(years: number): void;
  onSave(kind: 'recipe' | 'snapshot'): void;
  onScreenshot(): void;
  onDiagnostics(): void;
  onPreset(id: string): void;
}

export interface TopState {
  readonly worldName: string;
  readonly simTime: string;
  readonly regime: string;
  readonly timeScale: number;
  readonly paused: boolean;
  readonly sunModeLabel: string;
  readonly altitudeLabel: string;
}

export interface InspectorState {
  readonly title: string;
  readonly subtitle?: string;
  readonly rows: readonly (readonly [string, string])[];
  readonly empty?: string;
}

export interface TimelineState {
  readonly label: string;
  readonly inHistory: boolean;
  readonly fraction: number;
  readonly rangeLabel: string;
  readonly marks: readonly { readonly at: number; readonly bookmark: boolean; readonly title: string }[];
}

/** Time scales offered as named tiers rather than as a raw multiplier. */
export const SPEED_TIERS: readonly { readonly label: string; readonly scale: number; readonly hint: string }[] = [
  { label: 'Real time', scale: 1, hint: 'seconds' },
  { label: 'Days', scale: 1e4, hint: 'hours to days' },
  { label: 'Years', scale: 1e7, hint: 'weeks to months' },
  { label: 'Centuries', scale: 1e9, hint: 'years to centuries' },
  { label: 'Deep time', scale: 1e11, hint: 'millennia' },
];

const el = (tag: string, cls?: string, html?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (cls !== undefined) node.className = cls;
  if (html !== undefined) node.innerHTML = html;
  return node;
};

export class Shell {
  readonly root: HTMLDivElement;
  private readonly topTime: HTMLElement;
  private readonly topRegime: HTMLElement;
  private readonly topAltitude: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly speedSelect: HTMLSelectElement;
  private readonly sunButton: HTMLButtonElement;
  private readonly layerList: HTMLElement;
  private readonly featureList: HTMLElement;
  private readonly inspector: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly inspectorPanel: HTMLElement;
  private readonly timelineLabel: HTMLElement;
  private readonly timelineBadge: HTMLElement;
  private readonly timelineRange: HTMLInputElement;
  private readonly timelineRangeLabel: HTMLElement;
  private readonly timelineMarks: HTMLElement;
  private readonly liveButton: HTMLButtonElement;
  private readonly deepYears: HTMLInputElement;
  private readonly toast: HTMLElement;
  private toastTimer = 0;
  private activeLayer = '';

  constructor(parent: HTMLElement, cb: ShellCallbacks, options: {
    readonly layers: readonly LayerOption[];
    readonly features: readonly FeatureOption[];
    readonly presets: readonly LayerOption[];
  }) {
    installTheme();
    this.root = el('div', 'ws-root') as HTMLDivElement;

    /* ---------- top bar ---------- */
    const top = el('div', 'ws-panel ws-topbar');
    const brand = el('div', 'ws-brand');
    brand.append(
      el('span', 'ws-brand-mark', 'WORLD SIMULATOR'),
      el('span', 'ws-label ws-hide-sm', 'Genesis'),
    );
    this.playButton = el('button', 'ws-btn ws-btn-icon') as HTMLButtonElement;
    this.playButton.title = 'Pause or resume the simulation (Space)';
    this.playButton.addEventListener('click', () => { cb.onPlayPause(); });

    this.speedSelect = el('select', 'ws-select') as HTMLSelectElement;
    this.speedSelect.title = 'How fast simulated time runs';
    for (const tier of SPEED_TIERS) {
      const option = document.createElement('option');
      option.value = String(tier.scale);
      option.textContent = tier.label;
      this.speedSelect.appendChild(option);
    }
    this.speedSelect.addEventListener('change', () => { cb.onSpeed(Number(this.speedSelect.value)); });

    this.topTime = el('span', 'ws-big');
    this.topRegime = el('span', 'ws-label');
    this.topAltitude = el('span', 'ws-value ws-dim ws-hide-sm');

    this.sunButton = el('button', 'ws-btn ws-hide-sm') as HTMLButtonElement;
    this.sunButton.title = 'Where the light comes from. The simulated sun is the world’s own; the others are study lights and change nothing about the world. (L)';
    this.sunButton.addEventListener('click', () => { cb.onSunMode(); });

    const shot = el('button', 'ws-btn ws-btn-quiet ws-hide-sm', 'Screenshot') as HTMLButtonElement;
    shot.addEventListener('click', () => { cb.onScreenshot(); });
    const diag = el('button', 'ws-btn ws-btn-quiet', 'Diagnostics') as HTMLButtonElement;
    diag.title = 'Engineering overlay: frame time, patches, LOD, buffers (F3)';
    diag.addEventListener('click', () => { cb.onDiagnostics(); });

    const timeGroup = el('div');
    timeGroup.style.display = 'flex';
    timeGroup.style.flexDirection = 'column';
    timeGroup.append(this.topTime, this.topRegime);

    top.append(brand, this.playButton, this.speedSelect, timeGroup,
      el('div', 'ws-spacer'), this.topAltitude, this.sunButton, shot, diag);

    /* ---------- left rail ---------- */
    this.rail = el('div', 'ws-panel ws-rail');
    this.layerList = el('div', 'ws-group-items');
    this.featureList = el('div', 'ws-group-items');
    const presetList = el('div', 'ws-group-items');

    for (const layer of options.layers) {
      const item = el('button', 'ws-item') as HTMLButtonElement;
      item.dataset.layer = layer.id;
      item.append(el('span', undefined, layer.label));
      if (layer.hint !== undefined) item.append(el('span', 'ws-hint', layer.hint));
      item.addEventListener('click', () => { cb.onLayer(layer.id); });
      this.layerList.appendChild(item);
    }
    for (const feature of options.features) {
      const item = el('button', 'ws-item') as HTMLButtonElement;
      item.dataset.feature = feature.id;
      item.append(el('span', undefined, feature.label));
      item.append(el('span', 'ws-hint', ''));
      item.addEventListener('click', () => { cb.onFeature(feature.id); });
      this.featureList.appendChild(item);
    }
    for (const preset of options.presets) {
      const item = el('button', 'ws-item') as HTMLButtonElement;
      item.append(el('span', undefined, preset.label));
      if (preset.hint !== undefined) item.append(el('span', 'ws-hint', preset.hint));
      item.addEventListener('click', () => { cb.onPreset(preset.id); });
      presetList.appendChild(item);
    }

    this.rail.append(
      group('View', this.layerList),
      group('Go to', this.featureList),
      group('World', presetList),
    );

    /* ---------- inspector ---------- */
    this.inspectorPanel = el('div', 'ws-panel ws-inspector');
    this.inspector = el('div');
    const inspectorHead = el('div', 'ws-label', 'Inspector');
    this.inspectorPanel.append(inspectorHead, this.inspector);

    /* ---------- timeline ---------- */
    const timeline = el('div', 'ws-panel ws-timeline');
    this.timelineLabel = el('span', 'ws-big');
    this.timelineBadge = el('span', 'ws-badge is-live', 'Live');
    this.timelineRangeLabel = el('span', 'ws-label');
    const head = el('div', 'ws-timeline-head');
    head.append(this.timelineLabel, this.timelineBadge, el('div', 'ws-spacer'), this.timelineRangeLabel);

    this.timelineRange = el('input', 'ws-range') as HTMLInputElement;
    this.timelineRange.type = 'range';
    this.timelineRange.min = '0';
    this.timelineRange.max = '1000';
    this.timelineRange.value = '1000';
    this.timelineRange.setAttribute('aria-label', 'Historical time');
    this.timelineRange.addEventListener('input', () => {
      cb.onScrub(Number(this.timelineRange.value) / 1000);
    });
    this.timelineMarks = el('div', 'ws-marks');
    const track = el('div', 'ws-track');
    track.append(this.timelineMarks, this.timelineRange);

    this.liveButton = el('button', 'ws-btn', 'Return to now') as HTMLButtonElement;
    this.liveButton.addEventListener('click', () => { cb.onResumeLive(); });
    const bookmark = el('button', 'ws-btn ws-btn-quiet', 'Bookmark') as HTMLButtonElement;
    bookmark.addEventListener('click', () => { cb.onBookmark(); });
    this.deepYears = el('input', 'ws-input') as HTMLInputElement;
    this.deepYears.type = 'number';
    this.deepYears.min = '1';
    this.deepYears.value = '1000000';
    this.deepYears.style.width = '92px';
    this.deepYears.setAttribute('aria-label', 'Years to jump');
    const jump = el('button', 'ws-btn ws-btn-quiet', 'Deep-time jump') as HTMLButtonElement;
    jump.title = 'Geological fast-forward. Civilisation and economy are advanced as an approximated envelope for the duration, which is a declared reduction.';
    jump.addEventListener('click', () => { cb.onDeepTime(Number(this.deepYears.value)); });
    const recipe = el('button', 'ws-btn ws-btn-quiet ws-hide-sm', 'Save recipe') as HTMLButtonElement;
    recipe.addEventListener('click', () => { cb.onSave('recipe'); });
    const snapshot = el('button', 'ws-btn ws-btn-quiet ws-hide-sm', 'Save snapshot') as HTMLButtonElement;
    snapshot.addEventListener('click', () => { cb.onSave('snapshot'); });

    const foot = el('div', 'ws-timeline-foot');
    foot.append(this.liveButton, bookmark, el('div', 'ws-spacer'), this.deepYears, jump, recipe, snapshot);
    timeline.append(head, track, foot);

    this.toast = el('div', 'ws-panel ws-toast');

    this.root.append(top, this.rail, this.inspectorPanel, timeline, this.toast);
    parent.appendChild(this.root);
  }

  setTop(state: TopState): void {
    this.topTime.textContent = state.simTime;
    this.topRegime.textContent = `${state.regime} regime`;
    this.topAltitude.textContent = state.altitudeLabel;
    this.playButton.textContent = state.paused ? '▶' : '❙❙';
    this.playButton.setAttribute('aria-label', state.paused ? 'Resume' : 'Pause');
    this.sunButton.textContent = state.sunModeLabel;
    const nearest = SPEED_TIERS.reduce((best, t) =>
      Math.abs(Math.log10(t.scale) - Math.log10(Math.max(1, state.timeScale)))
        < Math.abs(Math.log10(best.scale) - Math.log10(Math.max(1, state.timeScale))) ? t : best,
    SPEED_TIERS[0] as (typeof SPEED_TIERS)[number]);
    if (this.speedSelect.value !== String(nearest.scale)) this.speedSelect.value = String(nearest.scale);
  }

  setLayer(id: string): void {
    if (this.activeLayer === id) return;
    this.activeLayer = id;
    for (const node of this.layerList.querySelectorAll('[data-layer]')) {
      node.classList.toggle('is-active', (node as HTMLElement).dataset.layer === id);
    }
  }

  setFeatures(features: readonly FeatureOption[]): void {
    for (const node of this.featureList.querySelectorAll('[data-feature]')) {
      const item = node as HTMLButtonElement;
      const found = features.find((f) => f.id === item.dataset.feature);
      const available = found?.available !== false;
      item.disabled = !available;
      item.style.opacity = available ? '1' : '0.38';
      const hint = item.querySelector('.ws-hint');
      if (hint !== null) hint.textContent = available ? (found?.hint ?? '') : 'none yet';
      item.title = available
        ? (found?.hint ?? '')
        : 'This world has not produced one of these yet.';
    }
  }

  setInspector(state: InspectorState): void {
    this.inspector.replaceChildren();
    const title = el('div', 'ws-title');
    title.textContent = state.title;
    this.inspector.append(title);
    if (state.subtitle !== undefined) {
      const sub = el('div', 'ws-value ws-faint');
      sub.textContent = state.subtitle;
      this.inspector.append(sub);
    }
    if (state.rows.length === 0) {
      const empty = el('div', 'ws-value ws-faint');
      empty.textContent = state.empty ?? 'Click the planet to inspect a place.';
      empty.style.marginTop = '8px';
      this.inspector.append(empty);
      return;
    }
    const list = el('dl', 'ws-rows');
    list.style.marginTop = '8px';
    for (const [k, v] of state.rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      list.append(dt, dd);
    }
    this.inspector.append(list);
  }

  setTimeline(state: TimelineState): void {
    this.timelineLabel.textContent = state.label;
    this.timelineBadge.textContent = state.inHistory ? 'History' : 'Live';
    this.timelineBadge.className = `ws-badge ${state.inHistory ? 'is-history' : 'is-live'}`;
    this.timelineRangeLabel.textContent = state.rangeLabel;
    this.liveButton.disabled = !state.inHistory;
    if (document.activeElement !== this.timelineRange) {
      this.timelineRange.value = String(Math.round(state.fraction * 1000));
    }
    this.timelineRange.style.setProperty('--ws-fill', `${(state.fraction * 100).toFixed(1)}%`);
    /* Event markers, rebuilt only when the set changes: this runs every frame. */
    const signature = state.marks.map((m) => `${m.at.toFixed(4)}:${String(m.bookmark)}`).join(',');
    if (this.timelineMarks.dataset.signature !== signature) {
      this.timelineMarks.dataset.signature = signature;
      this.timelineMarks.replaceChildren();
      for (const mark of state.marks) {
        const node = el('div', `ws-mark${mark.bookmark ? ' is-bookmark' : ''}`);
        node.style.left = `calc(${(mark.at * 100).toFixed(2)}% - 1px)`;
        node.title = mark.title;
        this.timelineMarks.appendChild(node);
      }
    }
  }

  say(message: string, ms = 2600): void {
    this.toast.textContent = message;
    this.toast.classList.add('is-on');
    if (this.toastTimer !== 0) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toast.classList.remove('is-on'); }, ms) as unknown as number;
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }
}

function group(label: string, body: HTMLElement): HTMLElement {
  const wrap = el('div', 'ws-group');
  wrap.append(el('div', 'ws-label', label), body);
  return wrap;
}
