/**
 * Geodetic <-> PCF (DEC-006).
 *
 * +Z is the rotation axis (north pole), +X pierces the prime meridian at the
 * equator. Spherical reference surface.
 */

import { assertFinite } from '@ws/core';
import type { Geodetic, PCF, PlanetGeometry } from './frames.js';

export function geodeticToPcf(g: Geodetic, planet: PlanetGeometry): PCF {
  const r = planet.radius + g.altitude;
  const cosLat = Math.cos(g.lat);
  return {
    x: r * cosLat * Math.cos(g.lon),
    y: r * cosLat * Math.sin(g.lon),
    z: r * Math.sin(g.lat),
  };
}

export function pcfToGeodetic(p: PCF, planet: PlanetGeometry): Geodetic {
  const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  assertFinite(r, 'pcfToGeodetic radius');
  if (r === 0) return { lat: 0, lon: 0, altitude: -planet.radius };
  return {
    lat: Math.asin(Math.min(1, Math.max(-1, p.z / r))),
    lon: Math.atan2(p.y, p.x),
    altitude: r - planet.radius,
  };
}

/** Great-circle distance along the reference sphere, metres. */
export function surfaceDistance(a: Geodetic, b: Geodetic, planet: PlanetGeometry): number {
  const dLat = b.lat - a.lat;
  const dLon = b.lon - a.lon;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat) * Math.cos(b.lat) * Math.sin(dLon / 2) ** 2;
  return 2 * planet.radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const DEG = Math.PI / 180;

export function degrees(radians: number): number {
  return radians / DEG;
}
