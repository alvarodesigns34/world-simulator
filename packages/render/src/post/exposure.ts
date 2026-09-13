/**
 * Exposure adaptation (M13, T-0103).
 *
 * WHAT THIS FIXES. M13's acceptance says "exposure adaptation is smooth across
 * the full orbit -> surface luminance range". What the shader had was
 * `rgb = rgb * 1.18` — a constant gain with no state, no adaptation and no
 * dependence on the scene. Flying from the sunlit limb into night, or from
 * orbit down to a street, changed nothing about exposure. That criterion could
 * not have been evaluated, because the system it describes did not exist.
 *
 * WHAT IT IS. A first-order lag on the scene's key luminance, with asymmetric
 * time constants, driving a single exposure scalar into the uniform buffer.
 * That is the standard model and it is the one the eye follows: adapting TO a
 * brighter scene is fast (a fraction of a second), adapting to a darker one is
 * slow (seconds and then minutes). Symmetric adaptation is the thing that makes
 * a night flight look like a bug.
 *
 * WHAT IT IS NOT — AND THIS IS THE HONEST PART. The luminance driving it is an
 * ANALYTIC ESTIMATE from the sun geometry and the camera's altitude, not a
 * measurement of the rendered frame. A measured version needs a luminance
 * histogram compute pass and a GPU readback, which is a real piece of work and
 * is not claimed here. The estimate is a good one — it is computed from the
 * same sun direction and altitude the shader lights the frame with — but it
 * cannot see a bright city at night or a dark storm at noon. Documented rather
 * than glossed; `docs/RENDERING.md` says the same.
 *
 * SIMULATION STATE != RENDERING STATE. This is presentation state living in the
 * renderer. It is driven by wall-clock seconds, never by simulated time, and no
 * simulation result can depend on it — `render` cannot reach `sim` at all, and
 * the mechanical boundary check enforces that.
 */

/** Relative luminance of a scene lit by a sun straight overhead. */
const FULL_DAY = 1;
/** Airglow and starlight: the floor a night side never falls below. */
const NIGHT_FLOOR = 0.0022;
/** Below this the exposure model would divide by ~0. */
const LUMINANCE_FLOOR = 1e-4;

export interface ExposureOptions {
  /** Seconds to reach ~63% of the way to a BRIGHTER scene. */
  readonly tauLightSeconds?: number;
  /** Seconds to reach ~63% of the way to a DARKER scene. Slower, as in an eye. */
  readonly tauDarkSeconds?: number;
  /** Middle grey the exposure maps the adapted luminance onto. */
  readonly keyValue?: number;
  readonly minExposure?: number;
  readonly maxExposure?: number;
}

export interface ExposureState {
  /** The luminance the viewer is currently adapted to. */
  adapted: number;
  /** Gain the shader multiplies by. Derived from `adapted`. */
  exposure: number;
  readonly tauLight: number;
  readonly tauDark: number;
  readonly key: number;
  readonly min: number;
  readonly max: number;
}

export function createExposureState(options: ExposureOptions = {}): ExposureState {
  const state: ExposureState = {
    adapted: 0.35,
    exposure: 1,
    tauLight: Math.max(1e-4, options.tauLightSeconds ?? 0.45),
    tauDark: Math.max(1e-4, options.tauDarkSeconds ?? 2.6),
    key: options.keyValue ?? 0.42,
    min: options.minExposure ?? 0.55,
    max: options.maxExposure ?? 4.5,
  };
  state.exposure = exposureFor(state, state.adapted);
  return state;
}

/**
 * Key luminance of the scene the camera is looking at.
 *
 * Two terms, both physical in origin:
 *
 *   SUN GEOMETRY. `sunDotUp` is the cosine of the sun's angle from the local
 *   vertical under the camera. Above the horizon the surface is lit roughly in
 *   proportion to it; below it, light does not stop at once — twilight falls
 *   off over a few degrees, which is why the exponential tail matters and why a
 *   hard `max(0, ...)` produces a visible snap at the terminator.
 *
 *   HOW MUCH OF THE FRAME IS PLANET. From 26,000 km the planet is a bright
 *   disc against black space and the frame's average luminance is far below the
 *   surface's own. At 350 m the planet fills everything. The solid angle the
 *   planet subtends is the honest way to express that, and it is what makes an
 *   orbit -> street descent a real luminance range rather than a constant.
 */
export function sceneKeyLuminance(
  sunDotUp: number, altitudeM: number, planetRadiusM: number,
): number {
  const s = clamp(sunDotUp, -1, 1);
  /* Direct illumination above the horizon; a smooth twilight tail below it.
     0.09 rad ~ 5 degrees of civil twilight. */
  const lit = s > 0 ? 0.12 + 0.88 * s : 0.12 * Math.exp(s / 0.09);
  /* Fraction of the hemisphere in front of the camera that is planet. At the
     surface this is 1/2 (the ground fills the lower half); far away it goes as
     the solid angle of the disc. */
  const r = Math.max(1, planetRadiusM);
  const d = r + Math.max(0, altitudeM);
  const sinTheta = Math.min(1, r / d);
  const cover = 0.5 * (1 - Math.sqrt(Math.max(0, 1 - sinTheta * sinTheta)));
  return clamp(NIGHT_FLOOR + FULL_DAY * lit * (0.35 + 1.3 * cover), LUMINANCE_FLOOR, 4);
}

/**
 * Advance the adaptation by `dtSeconds` of WALL CLOCK toward `target`.
 *
 * A first-order lag integrated exactly rather than as `state += (target -
 * state) * k`: with the exponential form the result of one 1 s step and of ten
 * 0.1 s steps are the same number, so exposure does not depend on frame rate.
 * That is the property the test asserts, and it is the one a naive
 * implementation silently fails — the same class of mistake as a simulation
 * step that depends on how the caller chunked it.
 */
export function adaptExposure(state: ExposureState, target: number, dtSeconds: number): number {
  const t = Number.isFinite(target) ? Math.max(LUMINANCE_FLOOR, target) : state.adapted;
  const dt = Number.isFinite(dtSeconds) ? Math.max(0, Math.min(60, dtSeconds)) : 0;
  if (dt > 0) {
    const tau = t > state.adapted ? state.tauLight : state.tauDark;
    const alpha = 1 - Math.exp(-dt / tau);
    state.adapted += (t - state.adapted) * alpha;
  }
  state.exposure = exposureFor(state, state.adapted);
  return state.exposure;
}

/** Jump straight to full adaptation. Used when a cut makes a lag wrong. */
export function snapExposure(state: ExposureState, target: number): number {
  state.adapted = Math.max(LUMINANCE_FLOOR, Number.isFinite(target) ? target : state.adapted);
  state.exposure = exposureFor(state, state.adapted);
  return state.exposure;
}

function exposureFor(state: ExposureState, adapted: number): number {
  const e = state.key / Math.max(LUMINANCE_FLOOR, adapted);
  return clamp(e, state.min, state.max);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
