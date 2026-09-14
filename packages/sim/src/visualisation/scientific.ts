/** M12 descriptor-driven scientific access to authoritative world state. */

import { cubeDim, cubeIndex } from '@ws/data';
import { CIV } from '../civilisation/system.js';
import { COMMODITY, endowmentAt } from '../economy/index.js';
import type { World } from '../world.js';

export type ScientificFieldKind = 'continuous' | 'categorical' | 'vector';
export type ScientificGrid = 'cubesphere' | 'geodesic';

export interface ScientificFieldDescriptor {
  readonly id: string;
  readonly label: string;
  readonly subsystem: string;
  readonly units: string;
  readonly kind: ScientificFieldKind;
  readonly grid: ScientificGrid;
  readonly domain: readonly [number, number];
  readonly ramp: string;
  readonly interpolation: 'linear' | 'nearest' | 'mode' | 'vector';
  readonly categories?: Readonly<Record<number, string>>;
  readonly formatter?: (value: number) => string;
  /**
   * The `FieldStore` field this visualises, when the descriptor id differs
   * from it (T-0098).
   *
   * M12's acceptance is "every registered field is visualisable". Checking that
   * by comparing LIST LENGTHS passes trivially and means nothing: the registry
   * and the descriptor set were both 32 and shared only 23 ids. Nine registered
   * fields had no descriptor and nine descriptors were derived views.
   *
   * `source` is what lets a coverage test compare the two structures instead of
   * their sizes. A vector descriptor lists both component fields.
   */
  readonly source?: readonly string[];
  /**
   * True for a view computed from world state that is not itself a registered
   * field — a legitimate thing to offer, but not evidence of registry coverage.
   */
  readonly derived?: true;
}

/**
 * Registered fields deliberately without a scientific descriptor.
 *
 * Each entry is a decision, not an omission, and the coverage test reads this
 * list rather than a count.
 */
export const SCIENTIFIC_EXCLUSIONS: Readonly<Record<string, string>> = Object.freeze({
  rotationAngle: 'A single-cell presentation counter for the planet spin debug '
    + 'readout, stored on a cube grid only because the FieldStore has no scalar '
    + 'kind. There is no spatial field here to visualise.',
});

export interface ScientificFieldView {
  readonly descriptor: ScientificFieldDescriptor;
  readonly values: ArrayLike<number>;
  readonly vectorV?: ArrayLike<number>;
  readonly level: number;
  readonly positions?: Float64Array;
}

const f = (descriptor: ScientificFieldDescriptor): ScientificFieldDescriptor => Object.freeze(descriptor);

export const SCIENTIFIC_FIELDS: readonly ScientificFieldDescriptor[] = [
  f({ id: 'elevation', label: 'Elevation', subsystem: 'geology', units: 'm', kind: 'continuous', grid: 'cubesphere', domain: [-8000, 8000], ramp: 'terrain', interpolation: 'linear' }),
  f({ id: 'plateId', label: 'Plate', subsystem: 'geology', units: 'id', kind: 'categorical', grid: 'cubesphere', domain: [0, 255], ramp: 'categories', interpolation: 'nearest' }),
  f({ id: 'boundaryType', label: 'Plate boundary', subsystem: 'geology', units: 'class', kind: 'categorical', grid: 'cubesphere', domain: [0, 3], ramp: 'boundaries', interpolation: 'nearest', categories: { 0: 'interior', 1: 'divergent', 2: 'convergent', 3: 'transform' } }),
  f({ id: 'crustThickness', label: 'Crust thickness', subsystem: 'geology', units: 'km', kind: 'continuous', grid: 'cubesphere', domain: [0, 80], ramp: 'magma', interpolation: 'linear' }),
  f({ id: 'crustAge', label: 'Crust age', subsystem: 'geology', units: 'Myr', kind: 'continuous', grid: 'cubesphere', domain: [0, 400], ramp: 'age', interpolation: 'linear' }),
  f({ id: 'uplift', label: 'Uplift', subsystem: 'geology', units: 'm', kind: 'continuous', grid: 'cubesphere', domain: [0, 9000], ramp: 'magma', interpolation: 'linear' }),
  f({ id: 'volcanism', label: 'Volcanic activity', subsystem: 'geology', units: 'relative', kind: 'continuous', grid: 'cubesphere', domain: [0, 1], ramp: 'magma', interpolation: 'linear' , derived: true }),
  f({ id: 'geologicStress', label: 'Crustal stress', subsystem: 'geology', units: 'relative', kind: 'continuous', grid: 'cubesphere', domain: [0, 1], ramp: 'magma', interpolation: 'linear' , derived: true }),
  f({ id: 'temperature', label: 'Surface temperature', subsystem: 'climate', units: 'K', kind: 'continuous', grid: 'geodesic', domain: [220, 320], ramp: 'temperature', interpolation: 'linear' }),
  f({ id: 'precip', label: 'Precipitation', subsystem: 'climate', units: 'kg/m²/s', kind: 'continuous', grid: 'geodesic', domain: [0, 3e-7], ramp: 'water', interpolation: 'linear' }),
  f({ id: 'humidity', label: 'Specific humidity', subsystem: 'climate', units: 'kg/kg', kind: 'continuous', grid: 'geodesic', domain: [0, 0.03], ramp: 'water', interpolation: 'linear' }),
  f({ id: 'wind', label: 'Wind', subsystem: 'climate', units: 'm/s', kind: 'vector', grid: 'geodesic', domain: [0, 100], ramp: 'wind', interpolation: 'vector', source: ['windU', 'windV'] }),
  f({ id: 'ice', label: 'Sea ice', subsystem: 'climate', units: 'fraction', kind: 'continuous', grid: 'geodesic', domain: [0, 1], ramp: 'ice', interpolation: 'linear' }),
  f({ id: 'soilMoisture', label: 'Soil moisture', subsystem: 'hydrology', units: 'm', kind: 'continuous', grid: 'cubesphere', domain: [0, 0.35], ramp: 'water', interpolation: 'linear' }),
  f({ id: 'runoff', label: 'Runoff', subsystem: 'hydrology', units: 'm/s', kind: 'continuous', grid: 'cubesphere', domain: [0, 1e-5], ramp: 'water', interpolation: 'linear' }),
  f({ id: 'riverDischarge', label: 'River discharge', subsystem: 'hydrology', units: 'm³/s', kind: 'continuous', grid: 'cubesphere', domain: [0, 1e6], ramp: 'water', interpolation: 'linear' }),
  f({ id: 'basin', label: 'Drainage basin', subsystem: 'hydrology', units: 'id', kind: 'categorical', grid: 'cubesphere', domain: [-1, 32767], ramp: 'categories', interpolation: 'nearest', source: ['basinId'] }),
  f({ id: 'snowpack', label: 'Snow water equivalent', subsystem: 'hydrology', units: 'm', kind: 'continuous', grid: 'cubesphere', domain: [0, 10], ramp: 'ice', interpolation: 'linear' }),
  f({ id: 'glacier', label: 'Glacier thickness', subsystem: 'hydrology', units: 'm', kind: 'continuous', grid: 'cubesphere', domain: [0, 5000], ramp: 'ice', interpolation: 'linear' }),
  f({ id: 'seaDepth', label: 'Sea depth', subsystem: 'ocean', units: 'm', kind: 'continuous', grid: 'cubesphere', domain: [0, 11000], ramp: 'depth', interpolation: 'linear', source: ['waterDepth'] }),
  f({ id: 'biome', label: 'Biome', subsystem: 'biosphere', units: 'class', kind: 'categorical', grid: 'cubesphere', domain: [0, 15], ramp: 'biomes', interpolation: 'nearest' }),
  f({ id: 'npp', label: 'Net primary productivity', subsystem: 'biosphere', units: 'kg/m²/yr', kind: 'continuous', grid: 'cubesphere', domain: [0, 20], ramp: 'vegetation', interpolation: 'linear' }),
  f({ id: 'biomass', label: 'Biomass', subsystem: 'biosphere', units: 'kg/m²', kind: 'continuous', grid: 'cubesphere', domain: [0, 50], ramp: 'vegetation', interpolation: 'linear' , derived: true }),
  f({ id: 'vegetation', label: 'Vegetation density', subsystem: 'biosphere', units: 'fraction', kind: 'continuous', grid: 'cubesphere', domain: [0, 1], ramp: 'vegetation', interpolation: 'linear' }),
  f({ id: 'habitability', label: 'Habitability', subsystem: 'civilisation', units: 'fraction', kind: 'continuous', grid: 'cubesphere', domain: [0, 1], ramp: 'habitability', interpolation: 'linear' }),
  f({ id: 'settlementPop', label: 'Population density', subsystem: 'civilisation', units: 'people/cell', kind: 'continuous', grid: 'cubesphere', domain: [0, 4e6], ramp: 'population', interpolation: 'linear' }),
  f({ id: 'territory', label: 'Territory', subsystem: 'civilisation', units: 'polity', kind: 'categorical', grid: 'cubesphere', domain: [-1, 32767], ramp: 'categories', interpolation: 'nearest' }),
  f({ id: 'technology', label: 'Technology', subsystem: 'civilisation', units: 'index', kind: 'continuous', grid: 'cubesphere', domain: [0, 1], ramp: 'technology', interpolation: 'linear' , derived: true }),
  f({ id: 'civStress', label: 'Civilisation stress', subsystem: 'civilisation', units: 'relative', kind: 'continuous', grid: 'cubesphere', domain: [0, 4], ramp: 'magma', interpolation: 'linear' , derived: true }),
  /* T-0098: these four are REGISTERED fields that had no descriptor, so M12's
     "every registered field is visualisable" was not literally true. */
  f({ id: 'crustType', label: 'Crust type', subsystem: 'geology', units: 'class', kind: 'categorical', grid: 'cubesphere', domain: [0, 1], ramp: 'categories', interpolation: 'nearest', categories: { 0: 'oceanic', 1: 'continental' } }),
  f({ id: 'oceanMask', label: 'Ocean mask', subsystem: 'ocean', units: 'bool', kind: 'categorical', grid: 'cubesphere', domain: [0, 1], ramp: 'categories', interpolation: 'nearest', categories: { 0: 'land', 1: 'ocean' } }),
  f({ id: 'flowAccumulation', label: 'Flow accumulation', subsystem: 'hydrology', units: 'm2', kind: 'continuous', grid: 'cubesphere', domain: [0, 6e14], ramp: 'discharge', interpolation: 'linear' }),
  f({ id: 'population', label: 'Faunal density', subsystem: 'biosphere', units: 'density', kind: 'continuous', grid: 'cubesphere', domain: [0, 100], ramp: 'population', interpolation: 'linear' }),
  f({ id: 'oreRichness', label: 'Ore richness', subsystem: 'economy', units: 'fraction', kind: 'continuous', grid: 'cubesphere', domain: [0, 1], ramp: 'ore', interpolation: 'linear' }),
  f({ id: 'landUse', label: 'Land use', subsystem: 'economy', units: 'fraction', kind: 'continuous', grid: 'cubesphere', domain: [0, 1], ramp: 'landuse', interpolation: 'linear' , derived: true }),
  f({ id: 'pollution', label: 'Pollution', subsystem: 'economy', units: 'relative', kind: 'continuous', grid: 'cubesphere', domain: [0, 5e7], ramp: 'pollution', interpolation: 'linear' }),
];

const BY_ID = new Map(SCIENTIFIC_FIELDS.map((descriptor) => [descriptor.id, descriptor] as const));
const scratch = new WeakMap<World, Map<string, Float64Array>>();

export function scientificField(world: World, id: string): ScientificFieldView {
  const descriptor = BY_ID.get(id);
  if (descriptor === undefined) throw new Error(`unknown scientific field '${id}'`);
  const cube = (values: ArrayLike<number>, level = world.hydrology.level): ScientificFieldView => ({ descriptor, values, level });
  const geo = (values: ArrayLike<number>, vectorV?: ArrayLike<number>): ScientificFieldView => ({ descriptor, values, ...(vectorV === undefined ? {} : { vectorV }), level: world.climate.n, positions: world.climate.grid.positions });
  switch (id) {
    case 'elevation': return cube(world.geology.elevationM, world.geology.level);
    case 'plateId': return cube(world.geology.plateId, world.geology.level);
    case 'boundaryType': return cube(world.geology.boundaryType, world.geology.level);
    case 'crustThickness': return cube(world.geology.crustThicknessKm, world.geology.level);
    case 'crustAge': return cube(world.geology.crustAgeMyr, world.geology.level);
    case 'uplift': return cube(world.geology.upliftM, world.geology.level);
    case 'crustType': return cube(world.geology.crustType, world.geology.level);
    case 'oceanMask': return cube(world.ocean.mask, world.geology.level);
    case 'flowAccumulation': return cube(world.hydrology.contributingAreaM2);
    case 'population': return cube(world.biosphere.populationDensity, world.biosphere.level);
    case 'volcanism': return cube(world.dynamicGeology.volcanicActivity, world.dynamicGeology.coarse.level);
    case 'geologicStress': return cube(world.dynamicGeology.stress, world.dynamicGeology.coarse.level);
    case 'temperature': return geo(world.climate.T);
    case 'precip': return geo(world.climate.precipMean);
    case 'humidity': return geo(world.climate.q);
    case 'wind': return geo(world.climate.u, world.climate.v);
    case 'ice': return geo(world.climate.ice);
    case 'soilMoisture': return cube(world.hydrology.soilMoistureM);
    case 'runoff': return cube(world.hydrology.runoffMps);
    case 'riverDischarge': return cube(world.hydrology.dischargeM3s);
    case 'basin': return cube(world.hydrology.basinId);
    case 'snowpack': return cube(world.hydrology.snowpackM);
    case 'glacier': return cube(world.hydrology.glacierM);
    case 'seaDepth': return cube(resampleOcean(world));
    case 'biome': return cube(world.biosphere.biome);
    case 'npp': return cube(world.biosphere.nppKgM2Yr);
    case 'biomass': return cube(world.biosphere.biomassKgM2);
    case 'vegetation': return cube(world.biosphere.vegetationDensity);
    case 'habitability': return cube(world.habitability.suitability);
    case 'settlementPop': return cube(polityField(world, CIV.population, true));
    case 'territory': return cube(world.civilisation.claim);
    case 'technology': return cube(polityField(world, CIV.technology, false));
    case 'civStress': return cube(polityField(world, CIV.stress, false));
    case 'oreRichness': return cube(resourceField(world));
    case 'landUse': return cube(slotField(world, world.economy.landUse));
    case 'pollution': return cube(world.economy.pollution);
    default: throw new Error(`field '${id}' is registered but has no provider`);
  }
}

export interface ProbeResult { readonly field: string; readonly value: number; readonly vectorV?: number; readonly formatted: string }

export function probeScientificField(world: World, id: string, lat: number, lon: number): ProbeResult {
  const view = scientificField(world, id);
  const unit = { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) };
  const index = nearestIndex(view, unit.x, unit.y, unit.z);
  const value = view.values[index] as number;
  const vectorV = view.vectorV?.[index] as number | undefined;
  const formatted = view.descriptor.formatter?.(value) ?? `${formatValue(value)} ${view.descriptor.units}`;
  return { field: id, value, ...(vectorV === undefined ? {} : { vectorV }), formatted };
}

export interface CrossSectionSample {
  readonly fraction: number;
  readonly distanceM: number;
  readonly lat: number;
  readonly lon: number;
  readonly elevationM: number;
  readonly seaDepthM: number;
  readonly crustThicknessKm: number;
  readonly temperatureK: number;
}

export function geodesicCrossSection(world: World, a: { lat: number; lon: number }, b: { lat: number; lon: number }, count = 128): readonly CrossSectionSample[] {
  if (count < 2) throw new Error('cross-section requires at least two samples');
  const p = latLonUnit(a.lat, a.lon);
  const q = latLonUnit(b.lat, b.lon);
  const omega = Math.acos(clamp(p.x * q.x + p.y * q.y + p.z * q.z, -1, 1));
  const sinOmega = Math.sin(omega);
  const out: CrossSectionSample[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const u = sinOmega < 1e-12 ? normalise({ x: p.x * (1 - t) + q.x * t, y: p.y * (1 - t) + q.y * t, z: p.z * (1 - t) + q.z * t })
      : { x: (p.x * Math.sin((1 - t) * omega) + q.x * Math.sin(t * omega)) / sinOmega,
          y: (p.y * Math.sin((1 - t) * omega) + q.y * Math.sin(t * omega)) / sinOmega,
          z: (p.z * Math.sin((1 - t) * omega) + q.z * Math.sin(t * omega)) / sinOmega };
    const lat = Math.asin(clamp(u.z, -1, 1));
    const lon = Math.atan2(u.y, u.x);
    out.push({ fraction: t, distanceM: omega * 6_371_000 * t, lat, lon,
      elevationM: probeScientificField(world, 'elevation', lat, lon).value,
      seaDepthM: probeScientificField(world, 'seaDepth', lat, lon).value,
      crustThicknessKm: probeScientificField(world, 'crustThickness', lat, lon).value,
      temperatureK: probeScientificField(world, 'temperature', lat, lon).value });
  }
  return out;
}

export interface ReducedVerticalProfile {
  readonly model: 'reduced-column';
  readonly note: string;
  readonly surfaceElevationM: number;
  readonly atmosphere: readonly { altitudeM: number; temperatureK: number }[];
  readonly ocean: readonly { depthM: number; temperatureK: number }[];
  readonly crust: readonly { depthKm: number; layer: string }[];
}

export function verticalProfile(world: World, lat: number, lon: number): ReducedVerticalProfile {
  const elevation = probeScientificField(world, 'elevation', lat, lon).value;
  const surfaceT = probeScientificField(world, 'temperature', lat, lon).value;
  const seaDepth = probeScientificField(world, 'seaDepth', lat, lon).value;
  const crust = probeScientificField(world, 'crustThickness', lat, lon).value;
  return {
    model: 'reduced-column',
    note: 'The simulator has a one-layer atmosphere and mixed-layer ocean; this profile shows that reduced state without invented layers.',
    surfaceElevationM: elevation,
    atmosphere: [0, 2000, 5000, 10000].map((altitudeM) => ({ altitudeM, temperatureK: Math.max(180, surfaceT - 0.0065 * altitudeM) })),
    ocean: seaDepth > 0 ? [{ depthM: 0, temperatureK: surfaceT }, { depthM: seaDepth, temperatureK: world.hydrology.referenceOceanTemperatureK }] : [],
    crust: [{ depthKm: 0, layer: 'surface' }, { depthKm: crust, layer: 'mantle boundary (reduced)' }],
  };
}

export function compareFields(a: ScientificFieldView, b: ScientificFieldView): Float64Array {
  if (a.descriptor.id !== b.descriptor.id || a.values.length !== b.values.length) throw new Error('era comparison field mismatch');
  const out = new Float64Array(a.values.length);
  for (let i = 0; i < out.length; i++) out[i] = a.descriptor.kind === 'categorical'
    ? ((a.values[i] as number) === (b.values[i] as number) ? 0 : 1)
    : (b.values[i] as number) - (a.values[i] as number);
  return out;
}

export function exportFieldJson(view: ScientificFieldView): string {
  return JSON.stringify({ format: 'ws-scientific-field-v1', descriptor: view.descriptor, level: view.level,
    values: Array.from(view.values), ...(view.vectorV === undefined ? {} : { vectorV: Array.from(view.vectorV) }) });
}

export function importFieldJson(text: string): ScientificFieldView {
  const parsed = JSON.parse(text) as { format?: string; descriptor?: ScientificFieldDescriptor; level?: number; values?: number[]; vectorV?: number[] };
  if (parsed.format !== 'ws-scientific-field-v1' || parsed.descriptor === undefined || parsed.level === undefined || !Array.isArray(parsed.values)) {
    throw new Error('invalid scientific field JSON');
  }
  return { descriptor: parsed.descriptor, level: parsed.level, values: Float64Array.from(parsed.values),
    ...(parsed.vectorV === undefined ? {} : { vectorV: Float64Array.from(parsed.vectorV) }) };
}

/**
 * Time-series export, CSV.
 *
 * EXPORT ONLY, and deliberately so (T-0099). This is a tabular view of recorded
 * HISTORY — one row per (series, sample) — not a serialisation of a spatial
 * field, and there is no `importSeriesCsv` because there is nothing coherent to
 * import into: the rows describe a trajectory the world has already taken, and
 * writing them back would not reconstruct the state that produced them.
 *
 * M12's blanket "export -> import -> identical values" therefore applies to the
 * two FIELD formats — `ws-scientific-field-v1` and `WS-RASTER-LIKE-1` — and not
 * to this one. Saying so is more useful than a round-trip that pretends.
 */
export function exportSeriesCsv(world: World, ids: readonly string[]): string {
  const rows = ['series,year,seconds,value,units,span'];
  for (const id of ids) {
    const descriptor = world.history.descriptors().find((d) => d.id === id);
    if (descriptor === undefined) throw new Error(`unknown history series '${id}'`);
    for (const sample of world.history.samples(id)) rows.push(`${id},${String(sample.time.year)},${String(sample.time.seconds)},${String(sample.value)},${descriptor.units},${String(sample.span)}`);
  }
  return rows.join('\n');
}

/**
 * Documented raster container: JSON header + exact row-major values.
 *
 * **This is not GeoTIFF**, and the warning is carried inside the payload so a
 * file that escapes into a GIS workflow says so itself. Real GeoTIFF — with a
 * CRS, tie points and IFD tags — remains deferred; a tangent-warped cube-sphere
 * has no standard CRS to declare, which is the actual obstacle rather than the
 * encoding work.
 */
export function exportRasterLike(view: ScientificFieldView): string {
  if (view.descriptor.grid !== 'cubesphere') throw new Error('raster-like export currently supports cube-sphere fields');
  return JSON.stringify({ format: 'WS-RASTER-LIKE-1', warning: 'This is not GeoTIFF.', grid: 'tangent-cubesphere',
    level: view.level, descriptor: view.descriptor, values: Array.from(view.values) });
}

/**
 * Read a `WS-RASTER-LIKE-1` container back (T-0099).
 *
 * M12's acceptance says "export -> import -> identical values". That held for
 * the JSON field format and was simply untrue for the raster one, which had no
 * reader at all. Rather than weaken the claim, the reader exists: values come
 * back bit-identical because they were written as exact decimal doubles, and
 * the test asserts identity rather than closeness.
 */
export function importRasterLike(text: string): ScientificFieldView {
  const parsed = JSON.parse(text) as {
    format?: string; grid?: string; level?: number;
    descriptor?: ScientificFieldDescriptor; values?: number[];
  };
  if (parsed.format !== 'WS-RASTER-LIKE-1') {
    throw new Error(`expected WS-RASTER-LIKE-1, got '${String(parsed.format ?? 'nothing')}'`);
  }
  if (parsed.grid !== 'tangent-cubesphere') {
    throw new Error(`unsupported raster grid '${String(parsed.grid ?? 'missing')}'`);
  }
  if (parsed.descriptor === undefined || parsed.level === undefined || !Array.isArray(parsed.values)) {
    throw new Error('WS-RASTER-LIKE-1 payload is missing descriptor, level or values');
  }
  /* A cube grid has exactly 6 * 4^level cells; a payload of any other length is
     not the raster it claims to be. */
  const expected = 6 * 4 ** parsed.level;
  if (parsed.values.length !== expected) {
    throw new Error(
      `WS-RASTER-LIKE-1 at level ${String(parsed.level)} must hold ${String(expected)} `
      + `cells, got ${String(parsed.values.length)}`);
  }
  return { descriptor: parsed.descriptor, level: parsed.level, values: Float64Array.from(parsed.values) };
}

function polityField(world: World, component: (typeof CIV)[keyof typeof CIV], perCell: boolean): Float64Array {
  const out = getScratch(world, `polity:${component as string}`, world.civilisation.cellCount);
  const values = world.civilisation.store.column(component);
  const territory = world.civilisation.store.column(CIV.territoryCells);
  for (let cell = 0; cell < out.length; cell++) {
    const owner = world.civilisation.claim[cell] as number;
    out[cell] = owner >= 0 && world.civilisation.store.aliveAt(owner)
      ? (values[owner] as number) / (perCell ? Math.max(1, territory[owner] as number) : 1) : 0;
  }
  return out;
}

function slotField(world: World, values: ArrayLike<number>): Float64Array {
  const out = getScratch(world, 'slot', world.civilisation.cellCount);
  for (let cell = 0; cell < out.length; cell++) {
    const owner = world.civilisation.claim[cell] as number;
    out[cell] = owner >= 0 && world.civilisation.store.aliveAt(owner) ? values[owner] as number : 0;
  }
  return out;
}

function resourceField(world: World): Float64Array {
  const out = getScratch(world, 'ore', world.economy.cellCount);
  for (let i = 0; i < out.length; i++) out[i] = endowmentAt(world.economy.resources, i, COMMODITY.ORE);
  return out;
}

function resampleOcean(world: World): Float64Array {
  const out = getScratch(world, 'seaDepth', world.hydrology.cellCount);
  for (let i = 0; i < out.length; i++) out[i] = world.hydrology.ocean[i] !== 0 ? Math.max(0, world.hydrology.seaLevelM - (world.hydrology.elevationM[i] as number)) : 0;
  return out;
}

function getScratch(world: World, key: string, length: number): Float64Array {
  let fields = scratch.get(world);
  if (fields === undefined) { fields = new Map(); scratch.set(world, fields); }
  let out = fields.get(key);
  if (out === undefined || out.length !== length) { out = new Float64Array(length); fields.set(key, out); }
  return out;
}

function nearestIndex(view: ScientificFieldView, x: number, y: number, z: number): number {
  if (view.descriptor.grid === 'geodesic' && view.positions !== undefined) {
    let best = 0;
    let dot = -2;
    for (let i = 0; i < view.values.length; i++) {
      const d = x * (view.positions[i * 3] as number) + y * (view.positions[i * 3 + 1] as number) + z * (view.positions[i * 3 + 2] as number);
      if (d > dot) { dot = d; best = i; }
    }
    return best;
  }
  const face = dominantFace(x, y, z);
  const { u, v } = faceUv(face, x, y, z);
  const n = cubeDim(view.level);
  return cubeIndex(face, view.level, Math.min(n - 1, Math.max(0, Math.floor(u * n))), Math.min(n - 1, Math.max(0, Math.floor(v * n))));
}

function dominantFace(x: number, y: number, z: number): number {
  const ax = Math.abs(x); const ay = Math.abs(y); const az = Math.abs(z);
  if (ax >= ay && ax >= az) return x >= 0 ? 0 : 1;
  if (ay >= az) return y >= 0 ? 2 : 3;
  return z >= 0 ? 4 : 5;
}

function faceUv(face: number, x: number, y: number, z: number): { u: number; v: number } {
  const ax = Math.abs(x); const ay = Math.abs(y); const az = Math.abs(z);
  let a = 0; let b = 0;
  if (face === 0) { a = y / ax; b = z / ax; }
  else if (face === 1) { a = -y / ax; b = z / ax; }
  else if (face === 2) { a = x / ay; b = -z / ay; }
  else if (face === 3) { a = x / ay; b = z / ay; }
  else if (face === 4) { a = x / az; b = y / az; }
  else { a = x / az; b = -y / az; }
  return { u: (Math.atan(clamp(a, -1, 1)) / (Math.PI / 4) + 1) * 0.5,
    v: (Math.atan(clamp(b, -1, 1)) / (Math.PI / 4) + 1) * 0.5 };
}

function latLonUnit(lat: number, lon: number): { x: number; y: number; z: number } {
  const c = Math.cos(lat); return { x: c * Math.cos(lon), y: c * Math.sin(lon), z: Math.sin(lat) };
}
function normalise(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const n = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); return { x: v.x / n, y: v.y / n, z: v.z / n };
}
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function formatValue(value: number): string { return Math.abs(value) >= 1e5 || (Math.abs(value) > 0 && Math.abs(value) < 1e-3) ? value.toExponential(3) : value.toFixed(3); }
