/**
 * Application shell — the COMPOSITION ROOT (DEC-011).
 *
 * This is the only place a `sim` object and a `render` object are in scope
 * together. `sim` does not know a camera exists; `render` cannot ask `sim` to
 * compute anything. Both facts are enforced by `pnpm run check:boundaries`.
 */

import { DAY, EARTH_CALENDAR, budgets, duration, format, simTime, v3, vnorm } from '@ws/core';
import { EARTH_GEOMETRY, FieldStore, fieldId, gridId, subsystemId } from '@ws/data';
import {
  PlanetRenderer,
  acquireGpu,
  cameraFromGeodetic,
  derive,
  lookAtCentre,
  moveTangential,
  setAltitude,
  type CameraState,
  type DebugMode,
} from '@ws/render';
import { Scheduler, type Subsystem } from '@ws/sim';
import { Hud } from './hud.js';

const PLANET = EARTH_GEOMETRY;

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

/**
 * A placeholder subsystem so the scheduler is exercised end to end at M1.
 * It advances a "planet rotation" field and nothing else — no geology, no
 * climate. The point is that the wiring is real, not that the physics is.
 */
function makeRotationSubsystem(store: FieldStore): Subsystem {
  const owner = subsystemId('planetRotation');
  const f = store.mut(fieldId('rotationAngle'), owner);
  return {
    id: owner,
    phase: 'Derived',
    cadence: { kind: 'every', dt: DAY },
    reads: [],
    writes: [fieldId('rotationAngle')],
    step: (ctx) => {
      const turns = ctx.step % 360;
      f.set(0, turns);
      f.commit();
    },
  };
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

  // --- simulation side -----------------------------------------------------
  const store = new FieldStore()
    .declare({
      id: fieldId('rotationAngle'),
      grid: gridId('cubesphere', 6),
      dtype: 'i16',
      components: 1,
      quantum: 1,
      offset: 0,
      units: 'deg',
      range: [0, 360],
      owner: subsystemId('planetRotation'),
      tier: 'A',
      temporalClass: 'slow',
      doubleBuffered: false,
      persist: 'snapshot',
    })
    .seal();

  const scheduler = new Scheduler({
    calendar: EARTH_CALENDAR,
    startTime: simTime(0, 0, EARTH_CALENDAR),
    store,
  })
    .register(makeRotationSubsystem(store))
    .build();

  // --- rendering side ------------------------------------------------------
  let patchN: number = budgets.QUALITY.patchVerticesPerSide;
  let renderer = new PlanetRenderer(gpu, { planet: PLANET, patchVerticesPerSide: patchN });
  const hud = new Hud(document.body);

  let cam: CameraState = lookAtCentre(
    cameraFromGeodetic({ lat: 0.35, lon: 0.6, altitude: 12_000_000 }, PLANET),
  );
  let debugMode: DebugMode = 'shaded';
  let poleSweep = false;

  // --- input ---------------------------------------------------------------
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
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    // Rotation rate scales smoothly with altitude — no branch, no mode.
    const alt = derive(cam, PLANET).altitude;
    const rate = (1e-3 * Math.min(1, alt / 1e6 + 0.02)) / 1;
    cam = moveTangential(cam, v3(0, 0, 1), -dx * rate);
    const axis = vnorm(v3(-cam.position.y, cam.position.x, 0));
    cam = moveTangential(cam, axis, dy * rate);
    cam = lookAtCentre(cam);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
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
    if (e.key === 'w' || e.key === 'W') cam = setAltitude(cam, Math.max(2, d.altitude * 0.7), PLANET);
    if (e.key === 's' || e.key === 'S') cam = setAltitude(cam, d.altitude * 1.4, PLANET);
    if (e.key === 'p' || e.key === 'P') poleSweep = !poleSweep;
    if (e.key === '[' || e.key === ']') {
      // Patch size is a knob (DEC-032), so it is adjustable at runtime and the
      // HUD shows the effect immediately. E1 decides the default.
      const sizes = [17, 33, 65];
      const i = sizes.indexOf(patchN);
      patchN = sizes[Math.min(sizes.length - 1, Math.max(0, i + (e.key === ']' ? 1 : -1)))] as number;
      renderer.destroy();
      renderer = new PlanetRenderer(gpu, { planet: PLANET, patchVerticesPerSide: patchN });
      renderer.debugMode = debugMode;
    }
  });

  // --- resize --------------------------------------------------------------
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

  // --- frame loop ----------------------------------------------------------
  let last = performance.now();
  const frame = (): void => {
    const now = performance.now();
    const wallDt = Math.min(0.1, (now - last) / 1000);
    last = now;

    // Simulation advances in SIM time; rendering is wall-clock. Decoupled.
    scheduler.advance(duration(wallDt * 86400));

    if (poleSweep) {
      cam = moveTangential(cam, v3(0, 1, 0), wallDt * 0.25);
      cam = lookAtCentre(cam);
    }

    renderer.debugMode = debugMode;
    const stats = renderer.render(cam, context.getCurrentTexture().createView(), width, height);

    hud.update({
      stats,
      frameMs: now - last + (performance.now() - now),
      gpuTier: gpu.tier,
      adapter: gpu.adapterInfo,
      patchVerticesPerSide: patchN,
      debugMode,
      sharedMemory: store.usingSharedMemory,
      simTime: format(scheduler.time, EARTH_CALENDAR),
    });

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
