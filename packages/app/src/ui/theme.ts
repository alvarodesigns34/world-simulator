/**
 * The design system (T-0164).
 *
 * WHY A SYSTEM AND NOT STYLING. The interface was a monospaced `<pre>` of
 * engineering readouts, declared in its own source as "engineering instrument,
 * not a dashboard" and "aesthetics are not a goal" — which was the right call
 * for an instrument and the wrong one for the only interface the application
 * has. Restyling that block would have produced a prettier instrument. What
 * was missing is a second thing: a product interface, with its own vocabulary,
 * so the instrument can go back to being an instrument behind a key.
 *
 * The vocabulary is small on purpose: four surfaces, one accent, a type scale
 * of four sizes, spacing on a 4 px grid. Sober, scientific, cinematic — a
 * dark instrument panel a planet sits in front of, not a game HUD. No
 * saturated palette, no glow, no monospace outside the diagnostics overlay
 * where monospace is the point.
 *
 * Plain DOM and CSS. A framework would be a dependency for a dozen panels.
 */

export const THEME_CSS = `
:root {
  --ws-bg: #05080b;
  --ws-surface-1: rgba(12, 18, 24, 0.82);
  --ws-surface-2: rgba(18, 26, 34, 0.92);
  --ws-surface-3: rgba(26, 36, 46, 0.96);
  --ws-line: rgba(132, 168, 192, 0.18);
  --ws-line-strong: rgba(132, 168, 192, 0.34);
  --ws-text: #dce8f0;
  --ws-text-dim: #93a8b8;
  --ws-text-faint: #64798a;
  --ws-accent: #6fd3e8;
  --ws-accent-dim: rgba(111, 211, 232, 0.16);
  --ws-warn: #e8b16f;
  --ws-space-1: 4px;
  --ws-space-2: 8px;
  --ws-space-3: 12px;
  --ws-space-4: 16px;
  --ws-space-5: 24px;
  --ws-radius: 10px;
  --ws-radius-sm: 6px;
  --ws-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  --ws-font: "Inter var", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --ws-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
}

.ws-root, .ws-root * { box-sizing: border-box; }
.ws-root {
  position: fixed; inset: 0; z-index: 20; pointer-events: none;
  font-family: var(--ws-font); color: var(--ws-text);
  font-size: 13px; line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
.ws-root > * { pointer-events: auto; }

/* ---- surfaces ---- */
.ws-panel {
  background: var(--ws-surface-1);
  border: 1px solid var(--ws-line);
  border-radius: var(--ws-radius);
  backdrop-filter: blur(18px) saturate(1.1);
  box-shadow: var(--ws-shadow);
}

/* ---- type ---- */
.ws-title { font-size: 13px; font-weight: 600; letter-spacing: 0.01em; }
.ws-label {
  font-size: 10px; font-weight: 600; letter-spacing: 0.09em;
  text-transform: uppercase; color: var(--ws-text-faint);
}
.ws-value { font-size: 13px; font-variant-numeric: tabular-nums; }
.ws-big { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ws-dim { color: var(--ws-text-dim); }
.ws-faint { color: var(--ws-text-faint); }
.ws-num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }

/* ---- controls ---- */
.ws-btn {
  appearance: none; border: 1px solid var(--ws-line);
  background: var(--ws-surface-2); color: var(--ws-text);
  font: inherit; font-size: 12px;
  padding: 6px 11px; border-radius: var(--ws-radius-sm);
  cursor: pointer; transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  display: inline-flex; align-items: center; gap: var(--ws-space-2); white-space: nowrap;
}
.ws-btn:hover { background: var(--ws-surface-3); border-color: var(--ws-line-strong); }
.ws-btn:focus-visible { outline: 2px solid var(--ws-accent); outline-offset: 2px; }
.ws-btn[aria-pressed="true"], .ws-btn.is-active {
  background: var(--ws-accent-dim); border-color: var(--ws-accent); color: var(--ws-accent);
}
.ws-btn:disabled { opacity: 0.4; cursor: default; }
.ws-btn-icon { padding: 6px 8px; min-width: 32px; justify-content: center; }
.ws-btn-quiet { background: transparent; border-color: transparent; color: var(--ws-text-dim); }
.ws-btn-quiet:hover { background: var(--ws-surface-2); color: var(--ws-text); }

.ws-select {
  appearance: none; border: 1px solid var(--ws-line);
  background: var(--ws-surface-2); color: var(--ws-text);
  font: inherit; font-size: 12px; padding: 6px 26px 6px 10px;
  border-radius: var(--ws-radius-sm); cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--ws-text-dim) 50%),
                    linear-gradient(135deg, var(--ws-text-dim) 50%, transparent 50%);
  background-position: calc(100% - 14px) 12px, calc(100% - 9px) 12px;
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
}
.ws-select:focus-visible { outline: 2px solid var(--ws-accent); outline-offset: 2px; }

.ws-range { appearance: none; background: transparent; height: 18px; cursor: pointer; width: 100%; }
.ws-range::-webkit-slider-runnable-track {
  height: 3px; border-radius: 2px;
  background: linear-gradient(90deg, var(--ws-accent) var(--ws-fill, 100%), var(--ws-line-strong) var(--ws-fill, 100%));
}
.ws-range::-webkit-slider-thumb {
  appearance: none; width: 13px; height: 13px; margin-top: -5px;
  border-radius: 50%; background: var(--ws-text); border: 2px solid var(--ws-bg);
}
.ws-range:focus-visible { outline: 2px solid var(--ws-accent); outline-offset: 3px; }

.ws-input {
  border: 1px solid var(--ws-line); background: var(--ws-surface-2); color: var(--ws-text);
  font: inherit; font-size: 12px; padding: 5px 8px; border-radius: var(--ws-radius-sm);
  font-variant-numeric: tabular-nums;
}

/* ---- layout ---- */
.ws-topbar {
  position: absolute; top: var(--ws-space-3); left: var(--ws-space-3); right: var(--ws-space-3);
  display: flex; align-items: center; gap: var(--ws-space-3);
  padding: var(--ws-space-2) var(--ws-space-3);
}
.ws-topbar .ws-spacer { flex: 1 1 auto; }
.ws-brand { display: flex; align-items: baseline; gap: var(--ws-space-2); }
.ws-brand-mark { font-weight: 600; letter-spacing: 0.06em; font-size: 12px; }

.ws-rail {
  position: absolute; left: var(--ws-space-3); top: 74px;
  width: 210px; max-height: calc(100vh - 210px); overflow-y: auto;
  padding: var(--ws-space-3);
  display: flex; flex-direction: column; gap: var(--ws-space-3);
}
.ws-group { display: flex; flex-direction: column; gap: var(--ws-space-1); }
.ws-group-items { display: flex; flex-direction: column; gap: 2px; }
.ws-item {
  appearance: none; border: 1px solid transparent; background: transparent;
  color: var(--ws-text-dim); font: inherit; font-size: 12px; text-align: left;
  padding: 5px 8px; border-radius: var(--ws-radius-sm); cursor: pointer;
  display: flex; align-items: center; justify-content: space-between; gap: var(--ws-space-2);
  transition: background 110ms ease, color 110ms ease;
}
.ws-item:hover { background: var(--ws-surface-2); color: var(--ws-text); }
.ws-item.is-active { background: var(--ws-accent-dim); color: var(--ws-accent); }
.ws-item:focus-visible { outline: 2px solid var(--ws-accent); outline-offset: 1px; }
.ws-item .ws-hint { font-size: 10px; color: var(--ws-text-faint); }

.ws-inspector {
  position: absolute; right: var(--ws-space-3); top: 74px;
  width: 268px; max-height: calc(100vh - 210px); overflow-y: auto;
  padding: var(--ws-space-3);
  display: flex; flex-direction: column; gap: var(--ws-space-3);
}
.ws-rows { display: grid; grid-template-columns: auto 1fr; gap: 3px var(--ws-space-3); align-items: baseline; }
.ws-rows dt { font-size: 11px; color: var(--ws-text-faint); white-space: nowrap; }
.ws-rows dd { margin: 0; font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }

.ws-timeline {
  position: absolute; left: 50%; bottom: var(--ws-space-3); transform: translateX(-50%);
  width: min(880px, calc(100vw - 2 * var(--ws-space-3)));
  padding: var(--ws-space-3) var(--ws-space-4);
  display: flex; flex-direction: column; gap: var(--ws-space-2);
}
.ws-timeline-head { display: flex; align-items: center; gap: var(--ws-space-3); }
.ws-track { position: relative; padding-top: 2px; }
.ws-marks { position: absolute; inset: 0; pointer-events: none; }
.ws-mark { position: absolute; top: 2px; width: 2px; height: 9px; border-radius: 1px; background: var(--ws-text-faint); opacity: 0.75; }
.ws-mark.is-bookmark { background: var(--ws-accent); opacity: 1; }
.ws-timeline-foot { display: flex; align-items: center; gap: var(--ws-space-2); flex-wrap: wrap; }

.ws-badge {
  font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 3px 7px; border-radius: 999px; border: 1px solid var(--ws-line-strong); color: var(--ws-text-dim);
}
.ws-badge.is-live { color: var(--ws-accent); border-color: var(--ws-accent); }
.ws-badge.is-history { color: var(--ws-warn); border-color: var(--ws-warn); }

.ws-toast {
  position: absolute; left: 50%; top: 72px; transform: translateX(-50%);
  padding: var(--ws-space-2) var(--ws-space-4); font-size: 12px;
  opacity: 0; transition: opacity 200ms ease; pointer-events: none;
}
.ws-toast.is-on { opacity: 1; }

.ws-legend { display: flex; align-items: center; gap: var(--ws-space-2); }
.ws-legend-ramp { height: 8px; flex: 1; border-radius: 4px; border: 1px solid var(--ws-line); }

/* ---- responsive: the rails collapse before they overlap the planet ---- */
@media (max-width: 1100px) {
  .ws-rail { width: 176px; }
  .ws-inspector { width: 232px; }
}
@media (max-width: 860px) {
  .ws-rail, .ws-inspector { display: none; }
  .ws-rail.is-open, .ws-inspector.is-open {
    display: flex; top: 68px; bottom: 150px; max-height: none;
    left: var(--ws-space-3); right: var(--ws-space-3); width: auto;
  }
  .ws-topbar { flex-wrap: wrap; gap: var(--ws-space-2); }
  .ws-timeline { width: calc(100vw - 2 * var(--ws-space-3)); }
}
@media (max-width: 560px) {
  .ws-hide-sm { display: none !important; }
}
`;

let injected = false;

/** Inject the stylesheet once. Idempotent so a re-created shell is cheap. */
export function installTheme(doc: Document = document): void {
  if (injected && doc.getElementById('ws-theme') !== null) return;
  const style = doc.createElement('style');
  style.id = 'ws-theme';
  style.textContent = THEME_CSS;
  doc.head.appendChild(style);
  injected = true;
}
