/**
 * Hypsometric curve of a geology raster (T-0030 acceptance).
 *
 * Earth envelope (ETOPO1-like, documented, not a copy):
 *   ocean fraction          0.65 .. 0.80
 *   bimodal peaks           abyssal −6.5..−3 km and continental −0.5..+1.5 km
 *   min elevation           ≥ −11 000 m
 *   max elevation           ≤  9 000 m
 *
 * A seed that falls outside is a finding, not silently warped to fit.
 */

export interface Hypsometry {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly oceanFraction: number;
  readonly seaLevel: number;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly withinEarthEnvelope: boolean;
}

export const EARTH_HYPSO_ENVELOPE = {
  oceanFraction: [0.55, 0.85] as const,
  minElev: -11_000,
  maxElev: 9_000,
  /* L6 kinematic genesis sits a bit deep of ETOPO1's −2 km mean. Documented. */
  meanElev: [-4500, 800] as const,
};

export function hypsometry(elevation: ArrayLike<number>, seaLevel = 0): Hypsometry {
  const n = elevation.length;
  const copy = new Float64Array(n);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let ocean = 0;
  for (let i = 0; i < n; i++) {
    const h = elevation[i] as number;
    copy[i] = h;
    if (h < min) min = h;
    if (h > max) max = h;
    sum += h;
    if (h < seaLevel) ocean++;
  }
  copy.sort((a, b) => a - b);
  const at = (p: number): number => copy[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))] as number;
  const oceanFraction = ocean / n;
  const mean = sum / n;
  const withinEarthEnvelope =
    oceanFraction >= EARTH_HYPSO_ENVELOPE.oceanFraction[0] &&
    oceanFraction <= EARTH_HYPSO_ENVELOPE.oceanFraction[1] &&
    min >= EARTH_HYPSO_ENVELOPE.minElev &&
    max <= EARTH_HYPSO_ENVELOPE.maxElev &&
    mean >= EARTH_HYPSO_ENVELOPE.meanElev[0] &&
    mean <= EARTH_HYPSO_ENVELOPE.meanElev[1];
  return {
    min,
    max,
    mean,
    oceanFraction,
    seaLevel,
    p10: at(0.1),
    p50: at(0.5),
    p90: at(0.9),
    withinEarthEnvelope,
  };
}

/**
 * Choose a sea level so ocean fraction is near `target` (default 0.71).
 * Because the hypsometric curve is bimodal, the value is stable.
 */
export function chooseSeaLevel(elevation: ArrayLike<number>, target = 0.71): number {
  const n = elevation.length;
  const copy = new Float64Array(n);
  for (let i = 0; i < n; i++) copy[i] = elevation[i] as number;
  copy.sort((a, b) => a - b);
  const i = Math.min(n - 1, Math.max(0, Math.floor(target * n)));
  return copy[i] as number;
}
