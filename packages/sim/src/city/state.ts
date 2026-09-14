/**
 * @tier A
 *
 * M9 city STATE. Read this file next to `layout.ts` — the split between them is
 * the founding principle applied to cities.
 *
 * WHAT IS AUTHORITATIVE (here): a few dozen numbers per city. Where it is, how
 * many people, how far it has spread, which districts exist and how developed
 * each is, which era of street pattern it grew in. This is what the simulation
 * integrates, what persistence stores, and what determinism hashes.
 *
 * WHAT IS DERIVED (layout.ts): every street, junction, bridge, plot and
 * building. Millions of them for a large city. They are a pure function of the
 * state here plus the terrain, regenerable at any LOD on demand, and NOTHING in
 * the simulation reads them back. A city can be discarded from memory entirely
 * and rebuilt identically.
 *
 * The test of that boundary is blunt: if deleting every layout in the world and
 * regenerating changes any simulation result, the boundary has been violated.
 * `city.test.ts` asserts exactly that.
 */

import { DOMAIN, cos, hashFloat01x64, hashU32, log10, pow, sin, type Seed } from '@ws/core';

/** Districts are a small closed set; their MIX is what makes cities differ. */
export const DISTRICT = {
  CORE: 0,
  COMMERCIAL: 1,
  RESIDENTIAL: 2,
  INDUSTRIAL: 3,
  PORT: 4,
  AGRICULTURAL: 5,
  MILITARY: 6,
} as const;

export const DISTRICT_COUNT = 7;
export type DistrictKind = (typeof DISTRICT)[keyof typeof DISTRICT];

/**
 * A city's district list is CAPPED.
 *
 * Each growth era seeds new districts and keeps the developed ones, so without
 * a cap the list grows without bound: a city that runs for a million years
 * accumulates thousands of districts, `nearestDistrict` becomes the layout's
 * dominant cost, and the authoritative state stops being small — which is the
 * one property that makes M9 affordable at planetary scale. A real city does
 * not gain a new quarter every century forever either; it redevelops the ones
 * it has.
 */
export const MAX_DISTRICTS = 40;

/**
 * Growth eras are capped for the same reason: the street plan stops gaining
 * distinguishable rings long before a city stops gaining people.
 */
export const MAX_ERA = 12;

export const DISTRICT_NAMES: readonly string[] = [
  'core', 'commercial', 'residential', 'industrial', 'port', 'agricultural', 'military',
];

/**
 * A district seed: a point the layout grows a district around.
 *
 * Authoritative because WHERE the industry is affects the economy (M10) and the
 * pollution field (M4). The polygon that industry occupies is not authoritative
 * — that is geometry.
 */
export interface DistrictSeed {
  readonly kind: DistrictKind;
  /** Local ENU metres from the city centre. */
  readonly x: number;
  readonly y: number;
  /** 0..1 build-out. Drives building density and height in the layout. */
  development: number;
}

export interface CityState {
  readonly id: number;
  /** The M8 settlement this city realises. */
  readonly settlementIndex: number;
  /** Cube cell of the city centre, on the civilisation grid. */
  readonly cell: number;
  readonly seed: Seed;
  readonly foundedYear: number;

  population: number;
  /** Built-up radius in metres. Hysteretic: cities do not shrink their streets. */
  radiusM: number;
  /** 0..1, inherited from the settlement. Sets street pattern era and heights. */
  technology: number;
  /** How many growth eras the city has completed; each adds a ring. */
  era: number;
  districts: DistrictSeed[];
  /**
   * Bumped whenever the authoritative state changes enough that a cached layout
   * is stale. The layout cache keys on it, so a layout is never silently wrong.
   */
  layoutGeneration: number;
}

/**
 * The share of a polity's people who live in towns at all.
 *
 * An M8 settlement is a POLITY holding a territory of continental cells, not a
 * city: at the civilisation grid's resolution one settlement can hold hundreds
 * of millions of people. Treating that number as a city population produced a
 * "city" of 553 million and a layout of 241 million buildings, which is not a
 * scale error in the renderer — it is a category error about what a settlement
 * is.
 *
 * Pre-industrial societies are ~5% urban because the agricultural surplus will
 * not feed more; industrial ones reach ~80%.
 */
export function urbanFraction(technology: number): number {
  return 0.04 + 0.76 * pow(Math.min(1, Math.max(0, technology)), 1.4);
}

/**
 * Share of a polity's urban population living in its largest city.
 *
 * Rank-size (Zipf) puts the primate city at roughly a quarter of the urban
 * total across a wide range of real societies; more in a centralised polity,
 * less in a networked one. M9 realises the primate city, so this is the share
 * that matters.
 */
export const PRIMATE_SHARE = 0.26;

/** City population implied by a settlement's population and technology. */
export function cityPopulationOf(settlementPopulation: number, technology: number): number {
  return Math.max(0, settlementPopulation) * urbanFraction(technology) * PRIMATE_SHARE;
}

/** Metres of built-up radius for a population, before terrain. */
export function builtRadiusM(population: number, technology: number): number {
  if (!(population > 0)) return 0;
  /* Pre-industrial cities are dense and walkable (~10 000 people/km^2 and a
     hard walking-distance limit); industrial ones sprawl at a tenth of that.
     Area therefore scales with population and INVERSELY with density, so the
     radius goes as sqrt(P / density). */
  const densityPerKm2 = 12000 - 9000 * technology;
  const areaKm2 = population / Math.max(400, densityPerKm2);
  return Math.sqrt(areaKm2 / Math.PI) * 1000;
}

/** Street-pattern era from technology. Layout reads this; it is not geometry. */
export function streetEra(technology: number): number {
  return technology < 0.2 ? 0 : technology < 0.45 ? 1 : technology < 0.7 ? 2 : 3;
}

export interface CityInit {
  readonly id: number;
  readonly settlementIndex: number;
  readonly cell: number;
  readonly seed: Seed;
  readonly population: number;
  readonly technology: number;
  readonly foundedYear: number;
  /** Directions toward water, in local ENU radians; drives PORT districts. */
  readonly waterBearings?: readonly number[];
}

export function initCity(init: CityInit): CityState {
  const s: CityState = {
    id: init.id,
    settlementIndex: init.settlementIndex,
    cell: init.cell,
    seed: init.seed,
    foundedYear: init.foundedYear,
    population: init.population,
    radiusM: builtRadiusM(init.population, init.technology),
    technology: init.technology,
    era: 0,
    districts: [],
    layoutGeneration: 1,
  };
  seedDistricts(s, init.waterBearings ?? []);
  return s;
}

/**
 * Advance a city's authoritative state.
 *
 * Returns true if the layout is now stale. Growth is hysteretic in the radius:
 * a city that loses half its people does not un-build its streets, it leaves
 * them emptier — which is what actually happens, and which keeps the layout
 * from churning every time the population wobbles.
 */
export function stepCity(
  s: CityState,
  population: number,
  technology: number,
  dtYears: number,
  waterBearings: readonly number[] = [],
): boolean {
  const before = s.layoutGeneration;
  s.population = Math.max(0, population);
  s.technology = Math.min(1, Math.max(0, technology));

  const target = builtRadiusM(s.population, s.technology);
  if (target > s.radiusM * 1.15 && s.era < MAX_ERA) {
    /* A new ring. Eras are what give an old city concentric street patterns
       from different centuries rather than one uniform grid. */
    s.radiusM = target;
    s.era++;
    s.layoutGeneration++;
    seedDistricts(s, waterBearings);
  }

  /* Past the last era the city still spreads, it just stops laying out new
     ring patterns — so the radius keeps following the population. */
  if (s.era >= MAX_ERA && target > s.radiusM * 1.15) {
    s.radiusM = target;
    s.layoutGeneration++;
  }

  /* Districts build out toward saturation; the rate falls as they fill. */
  const rate = Math.min(1, dtYears * 0.004 * (0.4 + s.technology));
  let moved = 0;
  for (const d of s.districts) {
    const next = d.development + (1 - d.development) * rate;
    moved = Math.max(moved, next - d.development);
    d.development = next;
  }
  /* Only bump the layout generation when the change is visible. Bumping on
     every tick would defeat the layout cache entirely. */
  if (moved > 0.02) s.layoutGeneration++;
  return s.layoutGeneration !== before;
}

/**
 * Place district seeds for the current era.
 *
 * Deterministic from the city seed and era, so a city rebuilt from its
 * authoritative state gets the same districts (DEC-017). The MIX is driven by
 * technology and water access, not chosen at random: a pre-industrial river
 * town gets a port and farmland, an industrial city gets industry downwind of
 * the core, and only a large one gets a distinct commercial district.
 */
function seedDistricts(s: CityState, waterBearings: readonly number[]): void {
  const kept = s.districts.filter((d) => d.development > 0.05);
  const out: DistrictSeed[] = kept;
  const era = s.era;
  const R = s.radiusM;
  if (!(R > 0)) { s.districts = [{ kind: DISTRICT.CORE, x: 0, y: 0, development: 0 }]; return; }

  if (!out.some((d) => d.kind === DISTRICT.CORE)) {
    out.push({ kind: DISTRICT.CORE, x: 0, y: 0, development: 0.1 });
  }

  /* Ports face the water, and there is no port without water. */
  for (let i = 0; i < waterBearings.length && i < 2; i++) {
    const b = waterBearings[i] as number;
    const r = R * 0.75;
    out.push({ kind: DISTRICT.PORT, x: cos(b) * r, y: sin(b) * r, development: 0 });
  }

  const wedges = 4 + era;
  for (let k = 0; k < wedges; k++) {
    const jitter = hashFloat01x64(s.seed, DOMAIN.CITY_LAYOUT, s.id, era, k);
    const angle = ((k + jitter * 0.6) / wedges) * Math.PI * 2;
    const radius = R * (0.35 + 0.5 * hashFloat01x64(s.seed, DOMAIN.CITY_LAYOUT, s.id, era, k, 1));
    const roll = hashU32(s.seed, DOMAIN.CITY_LAYOUT, s.id, era, k, 2) % 100;
    let kind: DistrictKind = DISTRICT.RESIDENTIAL;
    if (s.technology > 0.35 && roll < 22) kind = DISTRICT.INDUSTRIAL;
    else if (s.population > 60000 && roll < 42) kind = DISTRICT.COMMERCIAL;
    else if (roll < 55 && era <= 1) kind = DISTRICT.AGRICULTURAL;
    else if (roll < 60 && s.population > 200000) kind = DISTRICT.MILITARY;
    out.push({ kind, x: cos(angle) * radius, y: sin(angle) * radius, development: 0 });
  }

  /* Enforce the cap by REDEVELOPMENT, not truncation: when the list is full,
     new seeds displace the least-developed existing districts rather than
     being dropped, so a growing city can still change character. The core is
     never displaced, and the ordering is by (development, distance from
     centre, kind) — a total order, so which districts survive is a function of
     the state rather than of array order (DEC-017). */
  if (out.length > MAX_DISTRICTS) {
    const core = out.filter((d) => d.kind === DISTRICT.CORE).slice(0, 1);
    const rest = out.filter((d) => d.kind !== DISTRICT.CORE).sort((a, b) => {
      if (a.development !== b.development) return b.development - a.development;
      const ra = a.x * a.x + a.y * a.y;
      const rb = b.x * b.x + b.y * b.y;
      if (ra !== rb) return ra - rb;
      return a.kind - b.kind;
    });
    s.districts = [...core, ...rest.slice(0, MAX_DISTRICTS - core.length)];
    return;
  }
  s.districts = out;
}

/** Expected building count at full LOD — used to budget before generating. */
export function expectedBuildings(s: CityState): number {
  if (!(s.population > 0)) return 0;
  /* ~3.1 people per dwelling pre-industrial, ~2.3 modern, and non-residential
     buildings roughly a fifth again. */
  const perBuilding = 3.1 - 0.8 * s.technology;
  return Math.floor((s.population / perBuilding) * 1.2);
}

/**
 * Digest of the AUTHORITATIVE state only.
 *
 * Deliberately does not touch the layout: if the layout could change this
 * number, geometry would be state, which is the thing M9 must not do.
 */
export function cityDigest(s: CityState): number {
  const mix = (h: number, v: number): number => {
    let x = (h ^ Math.imul(v | 0, 0x9e3779b1)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
    return (x ^ (x >>> 15)) >>> 0;
  };
  /* EVERY authoritative field, in declaration order. T-0094: this previously
     omitted `settlementIndex`, `foundedYear` and `layoutGeneration`, all three
     of which change how the city evolves or which layout it regenerates — and
     the whole digest was not reachable from `World.digest()` at all. */
  let h = mix(0x9e3779b1, s.id);
  h = mix(h, s.settlementIndex);
  h = mix(h, s.cell);
  h = mix(h, Math.round(s.foundedYear * 1e3));
  h = mix(h, s.era);
  h = mix(h, Math.round(s.population * 1e3));
  h = mix(h, Math.round(s.radiusM * 1e3));
  h = mix(h, Math.round(s.technology * 1e6));
  /* The layout cache keys on this, so two cities agreeing on everything else
     but differing here regenerate different geometry on the next request. */
  h = mix(h, s.layoutGeneration);
  h = mix(h, s.districts.length);
  for (const d of s.districts) {
    h = mix(h, d.kind);
    h = mix(h, Math.round(d.x * 100));
    h = mix(h, Math.round(d.y * 100));
    h = mix(h, Math.round(d.development * 1e6));
  }
  return h >>> 0;
}

/** Rough population a city of this radius and era can hold. Used by M10. */
export function cityCapacity(s: CityState): number {
  const densityPerKm2 = 12000 - 9000 * s.technology;
  const areaKm2 = Math.PI * pow(s.radiusM / 1000, 2);
  return areaKm2 * densityPerKm2;
}

/** Order-of-magnitude class, for LOD selection and reporting. */
export function citySizeClass(population: number): number {
  return population <= 0 ? 0 : Math.max(0, Math.floor(log10(population)) - 2);
}
