import { format } from '@ws/core';
import { TimelineNavigator, absoluteSeconds, saveRecipe, saveSnapshot, type World } from '@ws/sim';

type Download = (filename: string, text: string, type?: string) => void;

/**
 * M11 planet-native timeline controls.
 *
 * Scrubbing RESTORES THE WORLD (T-0095). The previous version read the recorded
 * population and temperature series, wrote a label reading
 * "HISTORY VIEW · RECORDED SNAPSHOT", and left the planet exactly where it was:
 * no field, no city, no scheduler slot moved. The slider now drives a
 * `TimelineNavigator`, which restores the nearest checkpoint and replays the
 * command log forward, so the visible planet really is the selected instant.
 *
 * The panel deliberately does not offer branching. While in history the world
 * is a reconstruction and does not advance; RESUME returns to the live head
 * exactly. Simulating onward from a past instant is a different operation with
 * different semantics, and offering it here ambiguously would be worse than not
 * offering it.
 */
export class TimelinePanel {
  readonly root: HTMLDivElement;
  /**
   * The product interface drives the same navigator through this panel, so
   * there is exactly one timeline implementation and the debug controls and
   * the product controls cannot disagree about where in history the world is
   * (T-0164). The panel's own DOM is hidden by default and comes back with the
   * diagnostics overlay.
   */
  private readonly time: HTMLSpanElement;
  private readonly status: HTMLSpanElement;
  private readonly scrub: HTMLInputElement;
  private readonly readout: HTMLSpanElement;
  private readonly world: World;
  private readonly nav: TimelineNavigator;
  /** Scrub positions are simulated seconds; the range is 0..STEPS. */
  private static readonly STEPS = 1000;

  constructor(parent: HTMLElement, world: World, download: Download, nav?: TimelineNavigator) {
    this.world = world;
    this.nav = nav ?? new TimelineNavigator(world);
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
      <input data-role="scrub" type="range" min="0" max="1000" value="1000" step="1" aria-label="Historical time">
      <span data-role="readout">history: waiting</span>
    </div>
    <div style="display:flex;gap:7px;margin-top:8px;align-items:center">
      <input data-role="years" type="number" min="1" value="1000000" style="width:105px" aria-label="Years to jump">
      <button data-act="jump" title="Geological fast-forward. Civilisation and economy are approximated as an envelope for the duration.">DEEP-TIME JUMP</button><button data-act="bookmark">BOOKMARK</button>
      <button data-act="live">RESUME LIVE</button>
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
      if (Number.isFinite(n) && n > 0) world.advanceDeepTimeApproximate(n);
    };
    this.pick<HTMLButtonElement>('[data-act=bookmark]').onclick = () => {
      world.apply({ kind: 'bookmark', label: `Year ${String(world.scheduler.time.year)}` });
    };
    this.pick<HTMLButtonElement>('[data-act=recipe]').onclick = () => download('world.recipe.json', saveRecipe(world));
    this.pick<HTMLButtonElement>('[data-act=snapshot]').onclick = () => download('world.snapshot.json', saveSnapshot(world));
    this.pick<HTMLButtonElement>('[data-act=live]').onclick = () => this.resumeLive();
    this.scrub.oninput = () => { this.scrubToFraction(Number(this.scrub.value) / TimelinePanel.STEPS); };
  }

  /** Called after each live advance so history has something to return to. */
  record(): void {
    this.nav.record();
  }

  get inHistory(): boolean { return this.nav.mode === 'history'; }

  /** Where the scrub sits, 0 at the earliest reachable instant and 1 at the live head. */
  get fraction(): number {
    const earliest = this.nav.earliestReachable();
    const latest = this.nav.latestReachable();
    if (!(latest > earliest)) return 1;
    const now = absoluteSeconds(this.world.scheduler.time, this.world.calendar.secondsPerYear);
    return Math.max(0, Math.min(1, (now - earliest) / (latest - earliest)));
  }

  /** History markers as fractions of the reachable range, for the product timeline. */
  marks(): readonly { at: number; bookmark: boolean; title: string }[] {
    const earliest = this.nav.earliestReachable();
    const latest = this.nav.latestReachable();
    if (!(latest > earliest)) return [];
    const span = latest - earliest;
    const out: { at: number; bookmark: boolean; title: string }[] = [];
    for (const mark of this.world.history.bookmarks()) {
      const t = absoluteSeconds(mark.time, this.world.calendar.secondsPerYear);
      out.push({ at: Math.max(0, Math.min(1, (t - earliest) / span)), bookmark: true, title: mark.label });
    }
    /* Only the events worth a tick: a thousand routine markers is a smear. */
    for (const event of this.world.history.events()) {
      if (event.importance < 0.75) continue;
      const t = absoluteSeconds(event.time, this.world.calendar.secondsPerYear);
      out.push({ at: Math.max(0, Math.min(1, (t - earliest) / span)), bookmark: false, title: event.label });
      if (out.length > 64) break;
    }
    return out;
  }

  bookmarkNow(): void {
    this.world.history.bookmark(this.world.scheduler.time, `Mark ${format(this.world.scheduler.time, this.world.calendar)}`);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  resumeLive(): void {
    this.nav.returnToLive();
    this.scrub.value = String(TimelinePanel.STEPS);
    this.status.textContent = 'LIVE';
    this.status.style.color = '#79b9d6';
    this.readout.textContent = 'history: live';
  }

  scrubToFraction(fraction: number): void {
    const earliest = this.nav.earliestReachable();
    const latest = this.nav.latestReachable();
    if (!(latest > earliest)) { this.readout.textContent = 'history: not yet recorded'; return; }
    /* The rightmost stop is the live head. Going through scrubTo would enter
       history, freeze the world, and still say LIVE. */
    if (fraction >= 1 - 1e-9) { this.resumeLive(); return; }
    const target = earliest + (latest - earliest) * Math.max(0, Math.min(1, fraction));

    const result = this.nav.scrubTo(target);
    const live = this.nav.mode === 'live';
    this.status.textContent = live ? 'LIVE' : 'HISTORY · WORLD RESTORED';
    this.status.style.color = live ? '#79b9d6' : '#e0bd73';

    const population = this.world.civilisation.totalPopulation;
    const replayed = result.replayedSeconds / this.world.calendar.secondsPerYear;
    this.readout.textContent =
      `Y${String(result.time.year)} · pop ${population.toPrecision(4)}`
      + ` · replayed ${replayed < 1 ? '0' : replayed.toExponential(2)} yr`;
  }

  update(): void {
    this.time.textContent = format(this.world.scheduler.time, this.world.calendar);
    if (this.nav.mode !== 'live') return;
    /* Live: the handle tracks the head, and the reachable window is whatever
       the checkpoint store currently holds. */
    this.scrub.value = String(TimelinePanel.STEPS);
    const earliest = this.nav.earliestReachable();
    const latest = absoluteSeconds(this.world.scheduler.time, this.world.calendar.secondsPerYear);
    const span = (latest - earliest) / this.world.calendar.secondsPerYear;
    this.readout.textContent = span > 0
      ? `history: ${span.toExponential(2)} yr · ${String(this.nav.store.count)} checkpoints`
      : 'history: waiting';
  }

  private pick<T extends HTMLElement = HTMLSpanElement>(selector: string): T {
    const element = this.root.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error(`timeline element missing: ${selector}`);
    return element as T;
  }
}
