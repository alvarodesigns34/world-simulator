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
  cinematicFrameAt,
  CINEMATIC_DURATION_SECONDS,
  derive,
  descentCameraAt,
  dragOrbit,
  lookAtCentre,
  moveTangential,
  setAltitude,
  presentationSunDirection,
  SUN_MODE,
  SUN_MODE_LABEL,
  type CameraState,
  type CinematicTargets,
  type DebugMode,
  type SunMode,
} from '@ws/render';
import {
  CITY_LOD,
  SCIENTIFIC_FIELDS,
  cinematicTargets,
  cityLayout,
  cityTerrainSampler,
  createWorld,
  largestCity,
  lodForDistance,
  sampleElevation,
  scientificField,
  sunState,
} from '@ws/sim';
import { CitySceneAdapter } from './city-scene-adapter.js';
import { FrameCapture, captureStats, captureToDataUrl } from './capture.js';
import { probeWorld } from './probe.js';
import { createHeightPageSampler, createTerrainResidual } from './terrain-source.js';
import { Hud } from './hud.js';
import { openOpfsTileStore } from './opfs.js';
import { sampleStreamedTile, TileStreamer } from './tile-streamer.js';
import { TimelinePanel } from './timeline-panel.js';
import { ScientificPanel } from './scientific-panel.js';

const PLANET = EARTH_GEOMETRY;

/**
 * How deep the visible terrain ladder goes (T-0151).
 *
 * It was `DESCENT.maxLevel` — 12 — a constant that belongs to the M1 descent
 * trace, while authoritative tiles run to L18. With four corner heights per
 * patch the cap cost nothing, because splitting added no detail; now that a
 * patch carries real elevations, the cap is what stops the ground developing
 * as you approach it. 15 is where the authoritative octave ladder falls below
 * a metre for a world at geology L8, so refining further would subdivide a
 * surface that has nothing left to say. Everything finer than this is surface
 * material, not geometry.
 */
const TERRAIN_MAX_LEVEL = 15;
const VISUAL_FIELDS = SCIENTIFIC_FIELDS.map((field) => field.id);

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

  /*
   * OFFSCREEN MODE (T-0150). `?offscreen=1` skips canvas configuration and
   * presents nothing; frames are produced on demand through `wsCapture`.
   *
   * This is not a convenience. Some environments — notably headless Chromium
   * on SwiftShader — render WebGPU perfectly into a texture but LOSE THE
   * DEVICE when a canvas context is configured, because there is no
   * compositor surface behind it. Without this switch the renderer cannot be
   * looked at there at all, and "the tests pass" becomes the only available
   * evidence. Same device, same pipelines, same shaders: only the presentation
   * surface differs.
   */
  const offscreen = new URLSearchParams(location.search).has('offscreen');
  let context: GPUCanvasContext | null = null;
  if (!offscreen) {
    context = canvas.getContext('webgpu');
    if (context === null) {
      fail('The canvas would not give a WebGPU context.');
      return;
    }
    context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque' });
  } else {
    canvas.style.display = 'none';
  }

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
  /*
   * The height field the patch grid is actually shaped by (T-0151). Without it
   * the renderer falls back to four corner heights per patch, which is the
   * defect this whole pass exists to remove.
   */
  const heightPage = createHeightPageSampler({
    geology: world.geology, seed: world.seed,
    hydrology: world.hydrology, biosphere: world.biosphere, economy: world.economy,
  });
  const terrainResidual = createTerrainResidual(world.geology.level);
  const makeRenderer = (): PlanetRenderer =>
    new PlanetRenderer(gpu, {
      planet: PLANET,
      patchVerticesPerSide: patchN,
      maxLevel: TERRAIN_MAX_LEVEL,
      winding,
      heightPage,
      terrainResidual,
      /*
       * A finer screen-space error target than the 4 px default (T-0151).
       * With four corner heights per patch, splitting bought nothing and a
       * loose target was free; now that a patch carries real elevations and
       * per-vertex material, refinement is what reveals the ground, and 2.5 px
       * is where a coastline stops being a staircase.
       */
      screenSpaceErrorPx: 2.5,
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
    /* The fourth channel is presentation forcing, but it comes exclusively
       from authoritative simulated weather and pollution. */
    const weather = Math.min(1, (world.hydrology.runoffMps[i] as number) / 3e-7);
    const pollution = Math.min(1, (world.economy.pollution[i] as number) / 2e7);
    return [vegetation, river, lake, Math.min(1, weather * 0.7 + pollution * 0.3)];
  };
  renderer.surfaceAt = surfaceSampler;
  /*
   * Snow and glaciers, from M5's authoritative fields.
   *
   * M6's acceptance claims visible seasonal snow cover; until now the shader
   * had no cryosphere at all, so nothing on screen moved when the snow line
   * did. These are cover FRACTIONS derived from water-equivalent depth — the
   * simulation owns the depth, the renderer decides what a depth looks like.
   */
  const cryoSampler = (key: QuadKey): readonly [number, number, number, number] => {
    const level = world.hydrology.level;
    const delta = key.level - level;
    const dim = cubeDim(level);
    const x = delta >= 0 ? key.x >> delta : Math.min(dim - 1, (key.x << -delta) + (1 << Math.max(0, -delta - 1)));
    const y = delta >= 0 ? key.y >> delta : Math.min(dim - 1, (key.y << -delta) + (1 << Math.max(0, -delta - 1)));
    const i = cubeIndex(key.face, level, x, y);
    /* 5 cm of water equivalent hides the ground; 20 m of ice is opaque. */
    const snow = Math.min(1, Math.max(0, ((world.hydrology.snowpackM[i] as number) - 0.02) / 0.28));
    const glacier = Math.min(1, (world.hydrology.glacierM[i] as number) / 20);
    return [snow, glacier, 0, 0];
  };
  renderer.cryoAt = cryoSampler;

  /* M13 city and infrastructure geometry. The adapter is the only thing in the
     process that reads a `sim` city and writes a `render` instance; the
     renderer receives a batch of boxes and knows nothing else about it. */
  const cityScene = new CitySceneAdapter({ radiusM: PLANET.radius });

  const hud = new Hud(document.body);
  const overlay = new FieldOverlay(document.body);
  const timeline = new TimelinePanel(document.body, world, download);
  const science = new ScientificPanel(document.body, world, overlay, download);

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
  /* On by default: M9 and M13 both claim a city you can fly into, so the
     default path has to be the one that shows it. `u` turns it off. */
  let cities3d = true;
  const telemetry = new Telemetry(16_384, budgets.QUALITY.maxFrameMsDuringDescent);

  /*
   * OPEN ON A LIT PLANET (T-0153).
   *
   * The camera used to start at a fixed latitude and longitude with no regard
   * for where the sun was, and at year zero the sun was behind the planet: the
   * application opened on an unlit disc, a black ball with a faint rim. Every
   * other visual system — terrain relief, ocean, atmosphere, snow — was
   * invisible behind that one fact, and the honest reading of "it looks like a
   * low-detail technical globe" starts here.
   *
   * The opening shot is now placed from the world's own sun position: high
   * over the day side, offset toward the terminator so the relief is lit from
   * the side rather than flat-on, which is when topography reads.
   */
  const openingSun = sunState(world.scheduler.time, world.calendar).sunPcf;
  const openingLat = Math.asin(Math.max(-1, Math.min(1, openingSun.z /
    Math.hypot(openingSun.x, openingSun.y, openingSun.z)))) * 0.55 + 0.25;
  const openingLon = Math.atan2(openingSun.y, openingSun.x) + 0.55;
  let cam: CameraState = lookAtCentre(
    cameraFromGeodetic({ lat: openingLat, lon: openingLon, altitude: 12_000_000 }, PLANET),
  );
  let debugMode: DebugMode = 'shaded';
  let sunMode: SunMode = SUN_MODE.REAL;
  let poleSweep = false;
  let descentT = -1;
  let cinematicT = -1;
  let cinematicShot = '';
  /* The world's own answer to what each shot is about, resolved once when the
     programme starts so the camera path is stable for the whole take. */
  let cinematicAim: CinematicTargets = {};
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
    if (!dragging || descentT >= 0 || cinematicT >= 0) return;
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
      if (descentT >= 0 || cinematicT >= 0) return;
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
    if (e.key === 'u' || e.key === 'U') cities3d = !cities3d;
    if (e.key === 'l' || e.key === 'L') {
      const order: SunMode[] = [SUN_MODE.REAL, SUN_MODE.RAKING, SUN_MODE.NOON];
      sunMode = order[(order.indexOf(sunMode) + 1) % order.length] as SunMode;
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
      cinematicT = -1;
      telemetry.clear();
    }
    if (e.key === 'k' || e.key === 'K') {
      cinematicT = cinematicT < 0 ? 0 : -1;
      descentT = -1;
      cinematicShot = '';
      /* Aim the programme at THIS world. A role the world cannot fill is left
         out, and the keyframe falls back to its literal coordinates — which the
         frame reports, so a fallback take is never logged as a world tour. */
      cinematicAim = cinematicT >= 0 ? aimFromWorld(world) : {};
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
      renderer.cryoAt = cryoSampler;
      renderer.cinematic = true;
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
    /* While the timeline is scrubbed into history the world is a
       reconstruction of a past instant, so it must not advance — otherwise the
       user would be simulating a branch they did not ask for (T-0095). */
    if (!timeline.inHistory && world.scheduler.state === 'running') {
      world.advance(wallDt * world.timeScale);
      timeline.record();
    }
    telemetry.end(hSim, usFromMs(performance.now()));

    const sun = sunState(world.scheduler.time, world.calendar);
    /* The world's sun always drives the simulation; `sunMode` only decides
       what the VIEWER is lit by (T-0159). */
    renderer.sunDirection = presentationSunDirection(
      sunMode, v3(sun.sunPcf.x, sun.sunPcf.y, sun.sunPcf.z), cam.position);

    let cinematicLabel = '';
    if (cinematicT >= 0) {
      cinematicT += wallDt;
      const shot = cinematicFrameAt(cinematicT, PLANET, cinematicAim);
      cam = shot.camera;
      /* Says out loud whether the shot was aimed by the world or fell back to
         its literal coordinates. A fallback take is a camera path, not a tour
         of this planet, and the recording should not be able to hide that. */
      cinematicLabel = `${shot.shot}${shot.fromWorld ? ' — world-aimed' : ' — fallback aim'}`;
      if (shot.shot !== cinematicShot) {
        cinematicShot = shot.shot;
        world.apply({ kind: 'setTimeScale', scale: shot.timeScale });
        if (shot.field !== undefined) world.apply({ kind: 'setVisualField', field: shot.field });
      }
      overlay.visible = cinematicT >= 142 && cinematicT <= 166;
      renderer.cinematic = !overlay.visible;
      if (cinematicT >= CINEMATIC_DURATION_SECONDS) {
        download('ws-m13-cinematic-trace.json', telemetry.toJSONString());
        cinematicT = -1;
        renderer.cinematic = true;
      }
    } else if (descentT >= 0) {
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
    /* Cities are geometry, not chrome: they belong in the planet's pass and its
       depth buffer. Suppressed while a scientific overlay is up, where built
       structures would sit on top of the field being read. */
    const built = cities3d && !overlay.visible
      ? cityScene.build(world, cam.position)
      : null;
    renderer.cityScene = built === null ? null : built.scene;
    tileStreamer.beginFrame(world.dynamicGeology.generation, world.ocean.seaLevel);
    const stats = context === null
      ? renderer.lastStats()
      : renderer.render(cam, context.getCurrentTexture().createView(), width, height);
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
      tracing: descentT >= 0 || cinematicT >= 0,
      ...(cinematicLabel === '' ? {} : { shot: cinematicLabel }),
      regime: world.climate.regime,
      timeScale: world.timeScale,
      seaLevel: world.ocean.seaLevel,
      meanT: meanOf(world.climate.T),
      visualField: world.visualField,
      city: built === null ? null : {
        instances: built.stats.instances,
        buildings: built.stats.buildings,
        dropped: built.stats.buildingsDropped,
        ms: built.buildMs,
      },
    });
    timeline.update();
    science.update();

    telemetry.end(hFrame, usFromMs(performance.now()));
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  /*
   * Screenshot, and the visual-QA instrument (T-0150).
   *
   * Renders through the real renderer into an offscreen target and reads it
   * back, which is both "save an image of this view" and the only way to SEE
   * the output in an environment whose browser cannot present a WebGPU canvas
   * to the compositor.
   */
  const capture = new FrameCapture(gpu.device, gpu.format);
  const shoot = async (w = width, h = height): Promise<string> =>
    captureToDataUrl(await capture.capture(renderer, cam, Math.max(16, w | 0), Math.max(16, h | 0)));
  (window as unknown as Record<string, unknown>).wsCapture = shoot;
  (window as unknown as Record<string, unknown>).wsPixelStats = async (
    w = width, h = height,
  ): Promise<unknown> =>
    captureStats(await capture.capture(renderer, cam, Math.max(16, w | 0), Math.max(16, h | 0)));
  /*
   * FEATURE NAVIGATION (T-0158).
   *
   * The camera could be moved, but there was no way to move it TO anything:
   * descending from a fixed opening shot lands on open ocean, which is most of
   * the planet, and a user looking for the city the simulation grew had no
   * means of finding it. This flies to features the WORLD chose — the same
   * selection the cinematic uses (`cinematicTargets`), not a second
   * incompatible one.
   */
  (window as unknown as Record<string, unknown>).wsProbe = (
    lat?: number, lon?: number,
  ): unknown => {
    const d = derive(cam, PLANET);
    return probeWorld(world, lat ?? d.latitude, lon ?? d.longitude, PLANET);
  };
  (window as unknown as Record<string, unknown>).wsSunMode = (mode: string): string => {
    const valid = Object.values(SUN_MODE) as string[];
    if (valid.includes(mode)) sunMode = mode as SunMode;
    return SUN_MODE_LABEL[sunMode];
  };
  (window as unknown as Record<string, unknown>).wsFlyTo = (
    role: string, altitudeM?: number,
  ): unknown => {
    const targets = cinematicTargets(world, PLANET) as Record<string, {
      lat: number; lon: number; cell: number; why: string } | undefined>;
    const target = targets[role];
    if (target === undefined) return { ok: false, role, reason: 'the world has no such feature yet' };
    descentT = -1;
    cinematicT = -1;
    poleSweep = false;
    cam = lookAtCentre(cameraFromGeodetic(
      { lat: target.lat, lon: target.lon, altitude: altitudeM ?? 60_000 }, PLANET));
    return { ok: true, role, lat: target.lat, lon: target.lon, why: target.why };
  };
  (window as unknown as Record<string, unknown>).wsState = () => ({
    altitudeM: derive(cam, PLANET).altitude,
    simTime: format(world.scheduler.time, EARTH_CALENDAR),
    cities: world.cities.cities.length,
    settlements: world.civilisation.store.count,
    population: world.civilisation.totalPopulation,
    visualField: world.visualField,
    seaLevel: world.ocean.seaLevel,
    render: renderer.lastStats(),
  });
}

/**
 * The world's own answer to what each cinematic shot is about.
 *
 * `sim` chooses the features (highest land, largest river, biggest city,
 * busiest built link); `render` knows only two numbers per role. This is the
 * translation, and like every other sim -> render handoff it lives in the
 * composition root.
 */
function aimFromWorld(world: ReturnType<typeof createWorld>): CinematicTargets {
  const t = cinematicTargets(world, PLANET);
  const out: Record<string, { lat: number; lon: number }> = {};
  for (const [role, point] of Object.entries(t)) {
    if (point !== undefined) out[role] = { lat: point.lat, lon: point.lon };
  }
  return out as CinematicTargets;
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
  vectorV?: ArrayLike<number>;
  metadata: {
    label: string;
    units: string;
    kind: 'continuous' | 'categorical' | 'vector';
    domain: readonly [number, number];
    categories?: Readonly<Record<number, string>>;
  };
} {
  const view = scientificField(world, world.visualField);
  const d = view.descriptor;
  return {
    name: d.id,
    values: view.values,
    kind: d.grid,
    level: view.level,
    ...(view.positions === undefined ? {} : { positions: view.positions }),
    ...(view.vectorV === undefined ? {} : { vectorV: view.vectorV }),
    metadata: { label: d.label, units: d.units, kind: d.kind, domain: d.domain,
      ...(d.categories === undefined ? {} : { categories: d.categories }) },
  };
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

void main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
