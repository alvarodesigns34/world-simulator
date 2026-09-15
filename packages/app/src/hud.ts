/**
 * Debug overlay (T-0019, DEC-026). Engineering instrument, not a dashboard.
 *
 * Toggle with ` or H. All numbers are there because somebody will need them
 * when a patch is in the wrong place, a budget is blown, or the selector
 * thrashes. Aesthetics are not a goal.
 */

import { budgets } from '@ws/core';
import type { FrameStats } from '@ws/render';

export interface HudInput {
  readonly stats: FrameStats;
  readonly frameMs: number;
  readonly cpuMs: number;
  readonly gpuTier: budgets.GpuTier;
  readonly adapter: string;
  readonly patchVerticesPerSide: number;
  readonly debugMode: string;
  readonly sharedMemory: boolean;
  /** Result of the T-0062 front-face probe. Shown so a wrong convention reads
   *  as a line of text rather than as an unexplained black screen. */
  readonly winding: string;
  readonly culling: string;
  readonly simTime: string;
  readonly telemetryUs: number;
  readonly spikeCount: number;
  readonly deviceLost: string | null;
  readonly lastGpuError: string | null;
  readonly tracing: boolean;
  /** Current cinematic shot, with whether the world aimed it. */
  readonly shot?: string;
  readonly regime?: string;
  readonly timeScale?: number;
  readonly seaLevel?: number;
  readonly meanT?: number;
  readonly visualField?: string;
  /** M13 city pass: instances drawn, buildings capped, build cost. */
  readonly city?: { instances: number; buildings: number; dropped: number; ms: number } | null;
}

const STYLE = `
position:fixed;top:0;left:0;padding:8px 10px;margin:0;
font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
color:#cfe3ef;background:rgba(6,10,14,.82);border-right:1px solid #1d2a35;
border-bottom:1px solid #1d2a35;white-space:pre;pointer-events:none;
text-shadow:0 1px 0 #000;min-width:300px;z-index:10;
`;

export class Hud {
  private readonly el: HTMLPreElement;
  private frames = 0;
  private accum = 0;
  private fps = 0;
  visible = true;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('pre');
    this.el.setAttribute('style', STYLE.replace(/\n/g, ''));
    parent.appendChild(this.el);
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  /**
   * The diagnostics overlay is OFF by default (T-0164). It was the only
   * interface the application had; it is now the engineering one, behind F3,
   * and the product interface is what opens.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.el.style.display = visible ? 'block' : 'none';
  }

  get shown(): boolean { return this.visible; }

  update(input: HudInput): void {
    this.frames++;
    this.accum += input.frameMs;
    if (this.accum >= 500) {
      this.fps = (this.frames * 1000) / this.accum;
      this.frames = 0;
      this.accum = 0;
    }
    if (!this.visible) return;

    const s = input.stats;
    const budget = budgets.resolvePatchBudget({
      pixelCount: s.pixelCount,
      gpuTier: input.gpuTier,
      patchVerticesPerSide: input.patchVerticesPerSide,
    });
    const mainBudget = budgets.MAIN_THREAD.total;
    const lodBudget = budgets.MAIN_THREAD.zones.lodTraversal ?? 1.0;
    const gpuStr = s.gpuFrameMs < 0 ? 'n/a (no timestamp-query)' : `${s.gpuFrameMs.toFixed(2)} ms`;
    const lod = formatLod(s.lodCounts);
    const pxTri = s.triangles > 0 ? s.pixelCount / s.triangles : 0;

    this.el.textContent = [
      `WORLD SIMULATOR  M4`,
      `${input.adapter}`,
      `tier ${input.gpuTier}   SAB ${input.sharedMemory ? 'yes' : 'no'}   trace ${input.tracing ? 'ON' : 'off'}`,
      input.shot ? `shot       ${input.shot}` : ``,
      `winding    ${input.winding}   cull ${input.culling}`,
      input.deviceLost ? `DEVICE LOST  ${input.deviceLost}` : ``,
      input.lastGpuError ? `GPU ERROR    ${input.lastGpuError}` : ``,
      ``,
      `FPS        ${this.fps.toFixed(0)}`,
      `frame      ${input.frameMs.toFixed(2)} ms  ${bar(input.frameMs, 16.6)}`,
      `cpu        ${input.cpuMs.toFixed(2)} ms  ${bar(input.cpuMs, mainBudget)}`,
      `  select   ${s.cpuSelectMs.toFixed(2)} ms  ${bar(s.cpuSelectMs, lodBudget)}`,
      `  encode   ${s.cpuEncodeMs.toFixed(2)} ms`,
      `gpu        ${gpuStr}`,
      `telemetry  ${input.telemetryUs.toFixed(0)} µs   spikes ${input.spikeCount}`,
      ``,
      `altitude   ${formatDistance(s.altitude)}`,
      `speed      ${formatSpeed(s.cameraSpeed)}`,
      `near       ${s.cameraNear.toFixed(3)} m`,
      `sim time   ${input.simTime}`,
      input.regime ? `regime     ${input.regime}  scale ${input.timeScale ?? 1}` : ``,
      input.meanT !== undefined ? `mean T     ${input.meanT.toFixed(1)} K   sea ${input.seaLevel?.toFixed(0) ?? '—'} m` : ``,
      input.visualField ? `field      ${input.visualField}` : ``,
      `exposure   ${input.stats.exposure.toFixed(2)}x   scene L ${input.stats.sceneLuminance.toFixed(3)}`,
      input.city
        ? `city 3D    ${input.city.instances} inst  ${input.city.buildings} bldg` +
          `${input.city.dropped > 0 ? ` (+${input.city.dropped} capped)` : ''}  ${input.city.ms.toFixed(1)} ms`
        : ``,
      ``,
      `patches    ${s.drawnPatches} / ${s.budgetPatches}  ${bar(s.drawnPatches, s.budgetPatches)}`,
      `triangles  ${(s.triangles / 1000).toFixed(0)}k   ${budget.trianglesPerPatch}/patch   ${pxTri.toFixed(2)} px/tri`,
      `patch size ${input.patchVerticesPerSide}x${input.patchVerticesPerSide}`,
      `budget     ${budget.limitedBy}   τ=${budget.screenSpaceErrorPx}px`,
      `max level  ${s.maxLevelReached}`,
      `LOD        ${lod}`,
      `visited    ${s.nodesVisited}   pool hit ${s.poolHits} miss ${s.poolMisses}`,
      `culled     horizon ${s.culledHorizon}  frustum ${s.culledFrustum}`,
      s.budgetExhausted ? `BUDGET EXHAUSTED` : ``,
      ``,
      `[1] shaded  [2] lod  [3] patches  [4] height`,
      `[W/S] alt  [drag] orbit  [C] field  [V] overlay  [+/-] time`,
      `[P] pole    [T] descent  [G] export trace  [\`] HUD  [[][]] patch`,
    ]
      .filter((l) => l !== '')
      .join('\n');
  }
}

function formatLod(counts: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i] as number;
    if (n > 0) parts.push(`L${i}:${n}`);
  }
  return parts.length === 0 ? '—' : parts.join(' ');
}

function bar(value: number, max: number, width = 16): string {
  const frac = max <= 0 ? 0 : Math.min(1.5, value / max);
  const filled = Math.round(Math.min(1, frac) * width);
  const over = frac > 1;
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}]${over ? ' OVER' : ''}`;
}

function formatDistance(m: number): string {
  if (Math.abs(m) < 1000) return `${m.toFixed(1)} m`;
  if (Math.abs(m) < 1e6) return `${(m / 1000).toFixed(2)} km`;
  return `${(m / 1000).toFixed(0)} km`;
}

function formatSpeed(mps: number): string {
  if (!Number.isFinite(mps) || mps <= 0) return '0';
  if (mps < 1000) return `${mps.toFixed(1)} m/s`;
  return `${(mps / 1000).toFixed(2)} km/s`;
}
