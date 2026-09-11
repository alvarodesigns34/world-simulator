/**
 * Debug overlay (T-0019, DEC-026).
 *
 * A technical instrument, not a dashboard. It exists to make M2-M8 debuggable:
 * every number here is one somebody will need when a patch is in the wrong
 * place, a budget is blown, or the LOD selector is thrashing.
 *
 * Shows: patch boundaries and LOD level (via renderer debug modes), active
 * patch count, culling counts, camera altitude, frame time, and the RESOLVED
 * budget — which matters because DEC-032 made the budget a function of the
 * device, so "what am I allowed to spend here" is no longer a constant anyone
 * can read off a document.
 */

import { budgets } from '@ws/core';
import type { FrameStats } from '@ws/render';

export interface HudInput {
  readonly stats: FrameStats;
  readonly frameMs: number;
  readonly gpuTier: budgets.GpuTier;
  readonly adapter: string;
  readonly patchVerticesPerSide: number;
  readonly debugMode: string;
  readonly sharedMemory: boolean;
  readonly simTime: string;
}

const STYLE = `
position:fixed;top:0;left:0;padding:8px 10px;margin:0;
font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
color:#cfe3ef;background:rgba(6,10,14,.82);border-right:1px solid #1d2a35;
border-bottom:1px solid #1d2a35;white-space:pre;pointer-events:none;
text-shadow:0 1px 0 #000;min-width:280px;z-index:10;
`;

export class Hud {
  private readonly el: HTMLPreElement;
  private frames = 0;
  private accum = 0;
  private fps = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('pre');
    this.el.setAttribute('style', STYLE.replace(/\n/g, ''));
    parent.appendChild(this.el);
  }

  update(input: HudInput): void {
    this.frames++;
    this.accum += input.frameMs;
    if (this.accum >= 500) {
      this.fps = (this.frames * 1000) / this.accum;
      this.frames = 0;
      this.accum = 0;
    }

    const s = input.stats;
    const budget = budgets.resolvePatchBudget({
      pixelCount: 1,
      gpuTier: input.gpuTier,
      patchVerticesPerSide: input.patchVerticesPerSide,
    });

    const mainBudget = budgets.MAIN_THREAD.total;
    const cpu = s.cpuSelectMs + s.cpuEncodeMs;

    this.el.textContent = [
      `WORLD SIMULATOR  M1 planet engine`,
      `${input.adapter}`,
      `tier ${input.gpuTier}   SAB ${input.sharedMemory ? 'yes' : 'no'}`,
      ``,
      `frame      ${input.frameMs.toFixed(2)} ms   ${this.fps.toFixed(0)} fps`,
      `cpu        ${cpu.toFixed(2)} ms  ${bar(cpu, mainBudget)}`,
      `  select   ${s.cpuSelectMs.toFixed(2)} ms`,
      `  encode   ${s.cpuEncodeMs.toFixed(2)} ms`,
      ``,
      `altitude   ${formatDistance(s.altitude)}`,
      `near       ${s.cameraNear.toFixed(3)} m`,
      `sim time   ${input.simTime}`,
      ``,
      `patches    ${s.drawnPatches} / ${s.budgetPatches}  ${bar(s.drawnPatches, s.budgetPatches)}`,
      `triangles  ${(s.triangles / 1000).toFixed(0)}k   ${budget.trianglesPerPatch}/patch`,
      `patch size ${input.patchVerticesPerSide}x${input.patchVerticesPerSide}`,
      `max level  ${s.maxLevelReached}`,
      `visited    ${s.nodesVisited}`,
      `culled     horizon ${s.culledHorizon}  frustum ${s.culledFrustum}`,
      s.budgetExhausted ? `BUDGET EXHAUSTED` : ``,
      ``,
      `view       ${input.debugMode}   [1] shaded [2] lod [3] patches`,
      `           [W/S] altitude  [drag] orbit  [P] pole sweep`,
    ]
      .filter((l) => l !== '')
      .join('\n');
  }
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
