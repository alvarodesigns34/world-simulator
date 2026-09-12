/**
 * Application shell — the COMPOSITION ROOT (DEC-011).
 *
 * This is the only place a `sim` object and a `render` object are in scope
 * together. `sim` does not know a camera exists; `render` cannot ask `sim` to
 * compute anything. Both facts are enforced by `pnpm run check:boundaries`.
 */

import {
  EARTH_CALENDAR,
  Telemetry,
  ZONE,
  budgets,
  duration,
  format,
  usFromMs,
  v3,
} from '@ws/core';
import { EARTH_GEOMETRY, cubeDim, cubeIndex, type QuadKey } from '@ws/data';
import {
  DESCENT,
  FieldOverlay,
  PlanetRenderer,
  acquireGpu,
  probeWindingConvention,
  cameraFromGeodetic,
  derive,
  descentCameraAt,
  dragOrbit,
  lookAtCentre,
  moveTangential,
  setAltitude,
  type CameraState,
  type DebugMode,
} from '@ws/render';
import { createWorld, sampleElevation, sunState } from '@ws/sim';
import { Hud } from './hud.js';

const PLANET = EARTH_GEOMETRY;
const VISUAL_FIELDS = ['elevation', 'plateId', 'crustAge', 'uplift', 'temperature', 'precip', 'humidity', 'ice'] as const;

function fail(message: string): void {
  const el = document.createElement('div');
  el.setAttribute(
    'style',
    'position:fixed;inset:0;display:grid;place-items:center;padding:2rem;' +
      'font:14px/1.6 system-ui,sans-serif;color:#d8e6ef;background:#070b0f;text-align:center',
  );
  el.innerHTML = `<div style="max-width:46ch"><h1 style="font-size:1.1rem;margin:0 0 .75rem">
    World Simulator cannot start</h1><p style="margin:0;opacity:.85">${message}</p></div>`;
  document.body.appendChild(el);
}

function download(filename: string, text: string, type = 'application/json'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function main(): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('style', 'position:fixed;inset:0;width:100%;height:100%;display:block');
  document.body.appendChild(canvas);
  document.body.setAttribute('style', 'margin:0;background:#05080b;overflow:hidden');

  const gpu = await acquireGpu();
  if (!gpu.ok) {
    fail(gpu.message);
    return;
  }

  const context = canvas.getContext('webgpu');
  if (context === null) {
    fail('The canvas would not give a WebGPU context.');
    return;
  }
  context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque' });

  const world = createWorld({
    climateN: 4,
    terrainLevel: 8,
    genesis: { steps: 120 },
  });

  const winding = await probeWindingConvention(gpu.device);

  let patchN: number = budgets.QUALITY.patchVerticesPerSide;
  const makeRenderer = (): PlanetRenderer =>
    new PlanetRenderer(gpu, {
      planet: PLANET,
      patchVerticesPerSide: patchN,
      maxLevel: DESCENT.maxLevel,
      winding,
    });
  let renderer = makeRenderer();
  const elevationSampler = (key: QuadKey) => {
    const n = cubeDim(key.level);
    const h = (x: number, y: number): number => {
      const xx = x < 0 ? 0 : x >= n ? n - 1 : x;
      const yy = y < 0 ? 0 : y >= n ? n - 1 : y;
      if (key.level === world.geology.level) {
        return world.geology.elevationM[cubeIndex(key.face, key.level, xx, yy)] as number;
      }
      return sampleElevation(world.geology, world.seed, key.face, key.level, xx, yy);
    };
    return { h00: h(key.x, key.y), h10: h(key.x + 1, key.y), h01: h(key.x, key.y + 1), h11: h(key.x + 1, key.y + 1) };
  };
  renderer.seaLevel = world.ocean.seaLevel;
  renderer.elevationAt = elevationSampler;

  const hud = new Hud(document.body);
  const overlay = new FieldOverlay(document.body);
  const telemetry = new Telemetry(16_384, budgets.QUALITY.maxFrameMsDuringDescent);

  let cam: CameraState = lookAtCentre(
    cameraFromGeodetic({ lat: 0.35, lon: 0.6, altitude: 12_000_000 }, PLANET),
  );
  let debugMode: DebugMode = 'shaded';
  let poleSweep = false;
  let descentT = -1;
  const autoDescent = new URLSearchParams(location.search).has('descent');
  if (autoDescent) descentT = 0;

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => {
    dragging = false;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || descentT >= 0) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    const alt = derive(cam, PLANET).altitude;
    const rate = (1e-3 * Math.min(1, alt / 1e6 + 0.02)) / 1;
    cam = dragOrbit(cam, -dx * rate, dy * rate);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (descentT >= 0) return;
      e.preventDefault();
      const d = derive(cam, PLANET);
      const next = Math.max(2, d.altitude * Math.exp(e.deltaY * 0.0012));
      cam = setAltitude(cam, next, PLANET);
    },
    { passive: false },
  );

  window.addEventListener('keydown', (e) => {
    const d = derive(cam, PLANET);
    if (e.key === '1') debugMode = 'shaded';
    if (e.key === '2') debugMode = 'lod';
    if (e.key === '3') debugMode = 'patches';
    if (e.key === '4') debugMode = 'height';
    if ((e.key === 'w' || e.key === 'W') && descentT < 0) {
      cam = setAltitude(cam, Math.max(2, d.altitude * 0.7), PLANET);
    }
    if ((e.key === 's' || e.key === 'S') && descentT < 0) {
      cam = setAltitude(cam, d.altitude * 1.4, PLANET);
    }
    if (e.key === 'p' || e.key === 'P') poleSweep = !poleSweep;
    if (e.key === '`' || e.key === 'h' || e.key === 'H') hud.toggle();
    if (e.key === 'v' || e.key === 'V') overlay.visible = !overlay.visible;
    if (e.key === 'c' || e.key === 'C') {
      const i = VISUAL_FIELDS.indexOf(world.visualField as (typeof VISUAL_FIELDS)[number]);
      const next = VISUAL_FIELDS[(i + 1) % VISUAL_FIELDS.length] as string;
      world.apply({ kind: 'setVisualField', field: next });
    }
    if (e.key === '=' || e.key === '+') world.apply({ kind: 'setTimeScale', scale: world.timeScale * 10 });
    if (e.key === '-' || e.key === '_') world.apply({ kind: 'setTimeScale', scale: Math.max(1, world.timeScale / 10) });
    if (e.key === 't' || e.key === 'T') {
      descentT = 0;
      telemetry.clear();
    }
    if (e.key === 'g' || e.key === 'G') {
      download(`ws-m4-trace-seed${DESCENT.seed.toString(16)}.json`, telemetry.toJSONString());
    }
    if (e.key === '[' || e.key === ']') {
      const sizes = [17, 33, 65];
      const i = sizes.indexOf(patchN);
      patchN = sizes[Math.min(sizes.length - 1, Math.max(0, i + (e.key === ']' ? 1 : -1)))] as number;
      renderer.destroy();
      renderer = makeRenderer();
      renderer.debugMode = debugMode;
      renderer.seaLevel = world.ocean.seaLevel;
      renderer.elevationAt = elevationSampler;
    }
  });

  let width = 1;
  let height = 1;
  const resize = (): void => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    canvas.width = width;
    canvas.height = height;
  };
  resize();
  window.addEventListener('resize', resize);

  let last = performance.now();
  const frame = (): void => {
    const now = performance.now();
    const frameMs = now - last;
    const wallDt = Math.min(0.1, frameMs / 1000);
    last = now;
    telemetry.nextFrame();
    const tel0 = performance.now();
    const hFrame = telemetry.begin(ZONE.FRAME, usFromMs(now));

    const hSim = telemetry.begin(ZONE.SIM, usFromMs(performance.now()));
    world.scheduler.advance(duration(wallDt * world.timeScale));
    telemetry.end(hSim, usFromMs(performance.now()));

    const sun = sunState(world.scheduler.time, world.calendar);
    renderer.sunDirection = v3(sun.sunPcf.x, sun.sunPcf.y, sun.sunPcf.z);

    if (descentT >= 0) {
      descentT += wallDt;
      cam = descentCameraAt(descentT, PLANET);
      if (descentT >= DESCENT.durationSeconds) {
        download(`ws-m1-descent-seed${DESCENT.seed.toString(16)}.json`, telemetry.toJSONString());
        descentT = -1;
      }
    } else if (poleSweep) {
      cam = moveTangential(cam, v3(0, 1, 0), wallDt * 0.25);
      cam = lookAtCentre(cam);
    }

    renderer.debugMode = debugMode;
    const stats = renderer.render(cam, context.getCurrentTexture().createView(), width, height);
    telemetry.record(ZONE.SELECT, usFromMs(now), usFromMs(stats.cpuSelectMs));
    telemetry.record(ZONE.ENCODE, usFromMs(now), usFromMs(stats.cpuEncodeMs));
    if (stats.gpuFrameMs >= 0) {
      telemetry.record(ZONE.GPU, usFromMs(now), usFromMs(stats.gpuFrameMs));
    }

    const overlayField = overlayFieldOf(world);
    overlay.draw(overlayField);

    const cpuMs = stats.cpuSelectMs + stats.cpuEncodeMs;
    const telUs = usFromMs(performance.now() - tel0);
    hud.update({
      stats,
      frameMs,
      cpuMs,
      gpuTier: gpu.tier,
      adapter: gpu.adapterInfo,
      patchVerticesPerSide: patchN,
      debugMode,
      sharedMemory: world.store.usingSharedMemory,
      winding: `${winding.observed} (${winding.frontFace})`,
      culling: winding.fallbackNoCull ? 'off (probe unavailable)' : 'back',
      simTime: format(world.scheduler.time, EARTH_CALENDAR),
      telemetryUs: telUs,
      spikeCount: telemetry.spikeCount(),
      deviceLost: gpu.lostReason(),
      lastGpuError: gpu.lastUncapturedError(),
      tracing: descentT >= 0,
      regime: world.climate.regime,
      timeScale: world.timeScale,
      seaLevel: world.ocean.seaLevel,
      meanT: meanOf(world.climate.T),
      visualField: world.visualField,
    });

    telemetry.end(hFrame, usFromMs(performance.now()));
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function meanOf(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] as number;
  return s / a.length;
}

function overlayFieldOf(world: ReturnType<typeof createWorld>): {
  name: string;
  values: ArrayLike<number>;
  kind: 'cubesphere' | 'geodesic';
  level: number;
  positions?: Float64Array;
} {
  const name = world.visualField;
  if (name === 'temperature') return { name, values: world.climate.T, kind: 'geodesic', level: world.climate.n, positions: world.climate.grid.positions };
  if (name === 'precip') return { name, values: world.climate.precip, kind: 'geodesic', level: world.climate.n, positions: world.climate.grid.positions };
  if (name === 'humidity') return { name, values: world.climate.q, kind: 'geodesic', level: world.climate.n, positions: world.climate.grid.positions };
  if (name === 'ice') return { name, values: world.climate.ice, kind: 'geodesic', level: world.climate.n, positions: world.climate.grid.positions };
  if (name === 'plateId') return { name, values: world.geology.plateId, kind: 'cubesphere', level: world.geology.level };
  if (name === 'crustAge') return { name, values: world.geology.crustAgeMyr, kind: 'cubesphere', level: world.geology.level };
  if (name === 'uplift') return { name, values: world.geology.upliftM, kind: 'cubesphere', level: world.geology.level };
  return { name: 'elevation', values: world.geology.elevationM, kind: 'cubesphere', level: world.geology.level };
}

void main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
