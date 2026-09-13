/**
 * @tier A
 *
 * Energy-balance radiation + land/ocean heat capacity (M3 foundation for M4).
 *
 *   C dT/dt = (1 − α) Q − εσ T⁴ + ∇·(κ ∇T)
 *
 * C is small over land, large over ocean. Ice albedo feedback is applied when
 * a sea-ice fraction is provided. Lapse: T_surf − 6.5 K/km * max(0, z).
 */

export const SIGMA = 5.670374419e-8;
export const LAPSE_K_PER_M = 0.0065;
export const C_LAND = 1.0e7; /* J / K / m²  ~ 0.3 m equivalent water */
export const C_OCEAN = 2.0e8; /* mixed-layer ~ 50 m */
export const EMISSIVITY = 0.61; /* longwave leak, calibrated to ~288 K */
export const ALBEDO_OCEAN = 0.08;
export const ALBEDO_LAND = 0.25;
export const ALBEDO_ICE = 0.6;

export function albedo(ocean: number, ice: number): number {
  if (ice > 0.15) return ALBEDO_ICE * ice + ALBEDO_OCEAN * (1 - ice) * ocean + ALBEDO_LAND * (1 - ice) * (1 - ocean);
  return ALBEDO_OCEAN * ocean + ALBEDO_LAND * (1 - ocean);
}

export function olr(T: number): number {
  /* Integer power in the hottest climate loop. Multiplication is exact-tier
     arithmetic and avoids two stableMath transcendentals per cell. */
  const t2 = T * T;
  return EMISSIVITY * SIGMA * t2 * t2;
}

export function heatCapacity(ocean: number, ice: number): number {
  if (ice > 0.5) return C_LAND * 2;
  return C_OCEAN * ocean + C_LAND * (1 - ocean);
}

export function equilibriumT(Q: number, alpha: number): number {
  const abs = (1 - alpha) * Q;
  if (abs <= 0) return 180;
  return Math.sqrt(Math.sqrt(abs / (EMISSIVITY * SIGMA)));
}

export function lapse(Ts: number, elevM: number): number {
  const z = elevM > 0 ? elevM : 0;
  return Ts - LAPSE_K_PER_M * z;
}
