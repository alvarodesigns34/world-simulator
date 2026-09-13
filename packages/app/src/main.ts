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
  drawCityPlan,
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
import {
  CIV,
  COMMODITY,
  CITY_LOD,
  cityLayout,
  cityTerrainSampler,
  createWorld,
  endowmentAt,
  largestCity,
  lodForDistance,
  sampleElevation,
  sunState,
} from '@ws/sim';
import { Hud } from './hud.js';
import { openOpfsTileStore } from './opfs.js';
import { sampleStreamedTile, TileStreamer } from './tile-streamer.js';

const PLANET = EARTH_GEOMETRY;
const VISUAL_FIELDS = [
  'elevation', 'plateId', 'boundaryType', 'crustAge', 'crustThickness', 'uplift',
  'temperature', 'precip', 'humidity', 'wind', 'ice',
  'basin', 'flowAccumulation', 'runoff', 'soilMoisture', 'riverDischarge', 'snowpack', 'glacier',
  'biome', 'vegetation', 'npp', 'population',
  'habitability', 'settlementPop', 'territory', 'pollution', 'oreRichness',
] as const;

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

  const tileStorage = await openOpfsTileStore('ws-tiles-v2-integrated');
  const world = createWorld({
    climateN: 4,
    terrainLevel: 8,
    genesis: { steps: 120 },
    tileStorage,
  });
  const tileStreamer = new TileStreamer(world.tiles, world.geology, world.seed, world.ocean.seaLevel);

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
    const streamed = key.level >= 11 ? tileStreamer.request(key) : undefined;
    if (streamed) {
      return {
        h00: sampleStreamedTile(streamed, key, 0, 0),
        h10: sampleStreamedTile(streamed, key, 1, 0),
        h01: sampleStreamedTile(streamed, key, 0, 1),
        h11: sampleStreamedTile(streamed, key, 1, 1),
      };
    }
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
  const surfaceSampler = (key: QuadKey): readonly [number, number, number, number] => {
    const level = world.hydrology.level;
    const delta = key.level - level;
    const dim = cubeDim(level);
    const x = delta >= 0 ? key.x >> delta : Math.min(dim - 1, (key.x << -delta) + (1 << Math.max(0, -delta - 1)));
    const y = delta >= 0 ? key.y >> delta : Math.min(dim - 1, (key.y << -delta) + (1 << Math.max(0, -delta - 1)));
    const i = cubeIndex(key.face, level, x, y);
    const vegetation = world.biosphere.vegetationDensity[i] as number;
    const river = Math.min(1, (world.hydrology.dischargeM3s[i] as number) / 5000);
    const lake = world.hydrology.ocean[i] === 0 && (world.hydrology.filledM[i] as number) - (world.hydrology.elevationM[i] as number) > 0.5 ? 1 : 0;
    return [vegetation, river, lake, (world.biosphere.biome[i] as number) / 15];
  };
  renderer.surfaceAt = surfaceSampler;

  const hud = new Hud(document.body);
  const overlay = new FieldOverlay(document.body);

  /* M9 city plan panel. Off by default — it is an instrument, not chrome — and
     toggled with `y`. Drawn from the layout cache, so opening it costs one
     generation and then nothing. */
  const cityCanvas = document.createElement('canvas');
  cityCanvas.width = 320;
  cityCanvas.height = 320;
  cityCanvas.setAttribute(
    'style',
    'position:fixed;right:8px;bottom:176px;width:320px;height:320px;image-rendering:pixelated;' +
      'border:1px solid #1d2a35;background:#070b0f;z-index:11;display:none',
  );
  document.body.appendChild(cityCanvas);
  let cityVisible = false;
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
    if (e.key === 'y' || e.key === 'Y') {
      cityVisible = !cityVisible;
      cityCanvas.style.display = cityVisible ? 'block' : 'none';
    }
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
      renderer.surfaceAt = surfaceSampler;
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
  window.addEventListener('pagehide', () => tileStreamer.dispose());

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
    tileStreamer.beginFrame(world.dynamicGeology.generation, world.ocean.seaLevel);
    const stats = renderer.render(cam, context.getCurrentTexture().createView(), width, height);
    tileStreamer.endFrame();
    telemetry.record(ZONE.SELECT, usFromMs(now), usFromMs(stats.cpuSelectMs));
    telemetry.record(ZONE.ENCODE, usFromMs(now), usFromMs(stats.cpuEncodeMs));
    if (stats.gpuFrameMs >= 0) {
      telemetry.record(ZONE.GPU, usFromMs(now), usFromMs(stats.gpuFrameMs));
    }

    const overlayField = overlayFieldOf(world);
    overlay.draw(overlayField);

    if (cityVisible) drawLargestCity(world, cityCanvas, derive(cam, PLANET).altitude);

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
  if (name === 'wind') return { name, values: world.climate.u, kind: 'geodesic', level: world.climate.n, positions: world.climate.grid.positions };
  if (name === 'plateId') return { name, values: world.geology.plateId, kind: 'cubesphere', level: world.geology.level };
  if (name === 'crustAge') return { name, values: world.geology.crustAgeMyr, kind: 'cubesphere', level: world.geology.level };
  if (name === 'uplift') return { name, values: world.geology.upliftM, kind: 'cubesphere', level: world.geology.level };
  if (name === 'boundaryType') return { name, values: world.geology.boundaryType, kind: 'cubesphere', level: world.geology.level };
  if (name === 'crustThickness') return { name, values: world.geology.crustThicknessKm, kind: 'cubesphere', level: world.geology.level };
  if (name === 'basin') return { name, values: world.hydrology.basinId, kind: 'cubesphere', level: world.hydrology.level };
  if (name === 'flowAccumulation') return { name, values: world.hydrology.contributingAreaM2, kind: 'cubesphere', level: world.hydrology.level };
  if (name === 'runoff') return { name, values: world.hydrology.runoffMps, kind: 'cubesphere', level: world.hydrology.level };
  if (name === 'soilMoisture') return { name, values: world.hydrology.soilMoistureM, kind: 'cubesphere', level: world.hydrology.level };
  if (name === 'riverDischarge') return { name, values: world.hydrology.dischargeM3s, kind: 'cubesphere', level: world.hydrology.level };
  if (name === 'snowpack') return { name, values: world.hydrology.snowpackM, kind: 'cubesphere', level: world.hydrology.level };
  if (name === 'glacier') return { name, values: world.hydrology.glacierM, kind: 'cubesphere', level: world.hydrology.level };
  if (name === 'biome') return { name, values: world.biosphere.biome, kind: 'cubesphere', level: world.biosphere.level };
  if (name === 'vegetation') return { name, values: world.biosphere.vegetationDensity, kind: 'cubesphere', level: world.biosphere.level };
  if (name === 'npp') return { name, values: world.biosphere.nppKgM2Yr, kind: 'cubesphere', level: world.biosphere.level };
  if (name === 'population') return { name, values: world.biosphere.populationDensity, kind: 'cubesphere', level: world.biosphere.level };
  /* M8/M10 layers. These are what make civilisation and its economy visible on
     the globe: where people can live, where they do, whose land it is, what is
     under it, and what they are putting into the air. */
  if (name === 'habitability') return { name, values: world.habitability.suitability, kind: 'cubesphere', level: world.habitability.level };
  if (name === 'settlementPop') return { name, values: settlementPopField(world), kind: 'cubesphere', level: world.civilisation.level };
  if (name === 'territory') return { name, values: world.civilisation.claim, kind: 'cubesphere', level: world.civilisation.level };
  if (name === 'pollution') return { name, values: world.economy.pollution, kind: 'cubesphere', level: world.economy.level };
  if (name === 'oreRichness') return { name, values: oreField(world), kind: 'cubesphere', level: world.economy.level };
  return { name: 'elevation', values: world.geology.elevationM, kind: 'cubesphere', level: world.geology.level };
}

/**
 * Draw the planet's largest city into the panel.
 *
 * The level of detail follows the CAMERA's altitude, so flying down to a city
 * fills in its streets and then its buildings — the same LOD ladder the globe
 * renderer uses, applied to the plan. Nothing here is stored: the layout comes
 * from the cache and is regenerated if it was evicted (DEC-043).
 */
function drawLargestCity(
  world: ReturnType<typeof createWorld>,
  canvas: HTMLCanvasElement,
  altitudeM: number,
): void {
  const city = largestCity(world.cities);
  if (city === undefined) return;
  const requested = lodForDistance(altitudeM, Math.max(1, city.radiusM));
  const lod = requested > CITY_LOD.PLOTS ? CITY_LOD.PLOTS : requested;
  const layout = cityLayout(world.cities, city, world.hydrology, lod);
  drawCityPlan(canvas, layout, cityTerrainSampler(world.hydrology, city.cell));
}

/**
 * People per cell, spread over each polity's territory.
 *
 * Derived for display only — the authoritative population is per settlement,
 * not per cell, and nothing in the simulation reads this back.
 */
const popScratch = new Map<number, Float64Array>();
function settlementPopField(world: ReturnType<typeof createWorld>): Float64Array {
  const civ = world.civilisation;
  let out = popScratch.get(civ.cellCount);
  if (out === undefined) {
    out = new Float64Array(civ.cellCount);
    popScratch.set(civ.cellCount, out);
  }
  out.fill(0);
  const pop = civ.store.column(CIV.population);
  const terr = civ.store.column(CIV.territoryCells);
  for (let i = 0; i < civ.cellCount; i++) {
    const owner = civ.claim[i] as number;
    if (owner < 0 || !civ.store.aliveAt(owner)) continue;
    const cells = terr[owner] as number;
    if (cells > 0) out[i] = (pop[owner] as number) / cells;
  }
  return out;
}

const oreScratch = new Map<number, Float64Array>();
function oreField(world: ReturnType<typeof createWorld>): Float64Array {
  const r = world.economy.resources;
  let out = oreScratch.get(r.cellCount);
  if (out === undefined) {
    out = new Float64Array(r.cellCount);
    oreScratch.set(r.cellCount, out);
  }
  for (let i = 0; i < r.cellCount; i++) out[i] = endowmentAt(r, i, COMMODITY.ORE);
  return out;
}

void main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
