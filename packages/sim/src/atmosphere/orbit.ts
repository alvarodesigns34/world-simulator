/**
 * Planet orientation, orbit, seasons (M3). Deterministic in SimTime.
 *
 * PCF = Rz(theta) * PCI  (DEC-006). Axial tilt is a PCI rotation about +X
 * of the orbital plane, applied to the sun direction, not to the planet mesh.
 */

import { dayFraction, yearFraction, type Calendar, type SimTime } from '@ws/core';
import { cos, sin } from '@ws/core';
import { pci, type PCI } from '@ws/data';

export interface OrbitParams {
  readonly axialTilt: number;
  readonly solarDay: number;
  readonly yearSeconds: number;
  readonly solarConstant: number;
}

export const EARTH_ORBIT: OrbitParams = {
  axialTilt: 0.409092804, /* 23.44° */
  solarDay: 86400,
  yearSeconds: 31_556_925.216,
  solarConstant: 1361,
};

export interface SunState {
  readonly theta: number;
  readonly anomaly: number;
  readonly declination: number;
  readonly sunPci: PCI;
  readonly sunPcf: { x: number; y: number; z: number };
}

export function sunState(t: SimTime, cal: Calendar, orbit: OrbitParams = EARTH_ORBIT): SunState {
  const frac = yearFraction(t, cal);
  const anomaly = frac * 2 * 3.141592653589793 - 3.141592653589793 * 0.007;
  const theta = dayFraction(t, cal) * 2 * 3.141592653589793;
  const tilt = orbit.axialTilt;
  const declination = tilt * sin(anomaly);
  /* Sun in PCI: orbital plane XY, +X at equinox. Tilted by axialTilt about X. */
  const sx = cos(anomaly);
  const sy = sin(anomaly);
  const sunPci = pci(sx, sy * cos(tilt), sy * sin(tilt));
  /* PCF = Rz(theta) * PCI, so PCI = Rz(-theta) * PCF, PCF = Rz(theta)*PCI:
       x' =  c x + s y
       y' = -s x + c y   wait DEC-006: PCF = Rz(theta)*PCI
       frames.ts pcfToPci: x' = c x + s y, y' = -s x + c y  that's PCI from PCF
       pciToPcf: x' = c x - s y, y' = s x + c y
  */
  const c = cos(theta);
  const s = sin(theta);
  const sunPcf = {
    x: c * sunPci.x - s * sunPci.y,
    y: s * sunPci.x + c * sunPci.y,
    z: sunPci.z,
  };
  return { theta, anomaly, declination, sunPci, sunPcf };
}
