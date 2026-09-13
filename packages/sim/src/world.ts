/**
 * World composition root for the simulation (DEC-011: this is SIM, not app).
 *
 * Owns genesis, FieldStore registry, subsystems, command application and the
 * climate/ocean coupling. `app` constructs one of these, then a renderer.
 * The renderer is never imported here.
 */

import {
  DAY,
  EARTH_CALENDAR,
  HOUR,
  duration,
  makeSeed,
  simTime,
  type Calendar,
  type Seed,
  type Duration,
  type SimTime,
} from '@ws/core';
import {
  FieldStore,
  cubeDim,
  fieldId,
  gridId,
  subsystemId,
  type FieldId,
  type SubsystemId,
} from '@ws/data';
import { sunState, EARTH_ORBIT, type OrbitParams } from './atmosphere/orbit.js';
import {
  classifyRegime,
  initClimate,
  quiesceClimate,
  refreshClimateBoundary,
  resumeClimate,
  stepClimate,
  type ClimateState,
  type Regime,
} from './climate/solver.js';
import { createCommandLog, type Command, type CommandLog } from './commands.js';
import {
  DEFAULT_GENESIS,
  runGenesis,
  upsampleGeology,
  type GenesisConfig,
  type GeologyState,
} from './geology/plates.js';
import {
  initDynamicGeology,
  refreshTerrainFromGeology,
  stepDynamicGeology,
  type DynamicGeologyState,
} from './geology/dynamic.js';
import { initHydrology, rebuildHydrologyRouting, stepHydrology, type HydrologyState } from './hydrology/system.js';
import { initBiosphere, stepBiosphere, type BiosphereState } from './biosphere/system.js';
import { hashWorldState } from './hash.js';
import { deriveOcean, refreshOcean, type OceanState } from './ocean/sea.js';
import { Scheduler } from './scheduler/scheduler.js';
import type { Subsystem } from './scheduler/types.js';
import { DEFAULT_EROSION, erode } from './terrain/erosion.js';
import {
  CIV,
  OWNER_CIVILISATION,
  initCivilisation,
  initHabitability,
  rebuildSiteIndex,
  refreshHabitability,
  stepCivilisation,
  type CivConfig,
  type CivilisationState,
  type HabitabilityState,
} from './civilisation/index.js';
import {
  initCityRegistry,
  stepCities,
  type CityRegistry,
} from './city/index.js';
import { mapGeoToCube } from './coupling.js';
import {
  COMMODITY,
  advectPollution,
  capacityMultiplier,
  initEconomy,
  initNetwork,
  initResources,
  refreshEconomyResources,
  resetEconomySlot,
  stepEconomy,
  technologyMultiplier,
  updateLandUse,
  type EconomyState,
} from './economy/index.js';
import { TileCache } from './tiles/cache.js';
import { MemoryTileStore } from './tiles/storage.js';
import { HistoryStore, WORLD_HISTORY_SERIES } from './timeline/history.js';

export const OWNER_GEOLOGY = subsystemId('geology');
export const OWNER_TERRAIN = subsystemId('terrain');
export const OWNER_OCEAN = subsystemId('ocean');
export const OWNER_CLIMATE = subsystemId('climate');
export const OWNER_ROTATION = subsystemId('planetRotation');
export const OWNER_HYDROLOGY = subsystemId('hydrology');
export const OWNER_BIOSPHERE = subsystemId('biosphere');
export const OWNER_ECONOMY = subsystemId('economy');

export const FID = {
  elevation: fieldId('elevation'),
  plateId: fieldId('plateId'),
  crustType: fieldId('crustType'),
  crustAge: fieldId('crustAge'),
  crustThickness: fieldId('crustThickness'),
  boundaryType: fieldId('boundaryType'),
  uplift: fieldId('uplift'),
  oceanMask: fieldId('oceanMask'),
  waterDepth: fieldId('waterDepth'),
  temperature: fieldId('temperature'),
  humidity: fieldId('humidity'),
  precip: fieldId('precip'),
  ice: fieldId('ice'),
  windU: fieldId('windU'),
  windV: fieldId('windV'),
  rotationAngle: fieldId('rotationAngle'),
  basinId: fieldId('basinId'),
  flowAccumulation: fieldId('flowAccumulation'),
  runoff: fieldId('runoff'),
  soilMoisture: fieldId('soilMoisture'),
  riverDischarge: fieldId('riverDischarge'),
  snowpack: fieldId('snowpack'),
  glacier: fieldId('glacier'),
  biome: fieldId('biome'),
  vegetation: fieldId('vegetation'),
  npp: fieldId('npp'),
  population: fieldId('population'),
  habitability: fieldId('habitability'),
  pollution: fieldId('pollution'),
  oreRichness: fieldId('oreRichness'),
  settlementPop: fieldId('settlementPop'),
  territory: fieldId('territory'),
} as const;

export interface WorldOptions {
  readonly seed?: Seed;
  readonly calendar?: Calendar;
  readonly genesis?: Partial<Omit<GenesisConfig, 'seed'>>;
  readonly terrainLevel?: number;
  readonly climateN?: number;
  readonly orbit?: OrbitParams;
  readonly erode?: boolean;
  readonly tileStorage?: import('./tiles/storage.js').TileStorage;
  readonly civilisation?: Omit<CivConfig, 'seed'>;
  /** Cube level for hydrology, biosphere and civilisation. Default min(6, genesis level). */
  readonly hydrologyLevel?: number;
}

export interface SerializableWorldOptions {
  readonly seed: Seed;
  readonly genesis: Omit<GenesisConfig, 'seed'>;
  readonly terrainLevel: number;
  readonly climateN: number;
  readonly hydrologyLevel: number;
  readonly erode: boolean;
  readonly civilisation: Omit<CivConfig, 'seed'>;
}

export interface World {
  readonly seed: Seed;
  readonly calendar: Calendar;
  readonly store: FieldStore;
  readonly scheduler: Scheduler;
  readonly geology: GeologyState;
  readonly ocean: OceanState;
  readonly climate: ClimateState;
  readonly hydrology: HydrologyState;
  readonly biosphere: BiosphereState;
  readonly dynamicGeology: DynamicGeologyState;
  readonly civilisation: CivilisationState;
  readonly habitability: HabitabilityState;
  readonly cities: CityRegistry;
  readonly economy: EconomyState;
  readonly tiles: TileCache;
  readonly commands: CommandLog;
  readonly history: HistoryStore;
  readonly terrainLevel: number;
  readonly creationOptions: SerializableWorldOptions;
  timeScale: number;
  visualField: string;
  /**
   * How many dynamic-geology events have been copied into history.
   * Checkpoints must restore this or a rewind silently drops the interval's
   * events (cursor sits at the live length while the event list shrinks).
   */
  geologyEventCursor: number;
  apply(cmd: Command): void;
  advance(dt: number): void;
  /**
   * Geological fast-forward with an explicitly approximate civilisation and
   * economy (T-0096). Distinct from `advance()`, which is physically
   * meaningful at its regime's cadence.
   */
  advanceDeepTimeApproximate(years: number): void;
  digest(): number;
}

interface WorldRuntimeRef {
  timeScale: number;
  visualField: string;
  climate: ClimateState;
  geology: GeologyState;
  ocean: OceanState;
  hydrology: HydrologyState;
  biosphere: BiosphereState;
  dynamicGeology: DynamicGeologyState;
  civilisation: CivilisationState;
  habitability: HabitabilityState;
  civConfig: CivConfig;
  cities: CityRegistry;
  economy: EconomyState;
  history: HistoryStore;
  geologyEventCursor: number;
  /** Reusable per-settlement forcing buffers; sized once, never per tick. */
  capMul: Float64Array;
  techMul: Float64Array;
  /** Wind resampled onto the economy grid, for pollution advection (T-0080). */
  windOnCube: { u: Float64Array; v: Float64Array };
}

const DEFAULT_SEED = makeSeed(0x51a5, 0x1a51);

export function createWorld(opts: WorldOptions = {}): World {
  const seed = opts.seed ?? DEFAULT_SEED;
  const calendar = opts.calendar ?? EARTH_CALENDAR;
  const terrainLevel = opts.terrainLevel ?? 8;
  const climateN = opts.climateN ?? 4;
  const orbit = opts.orbit ?? EARTH_ORBIT;

  const genesisCfg: GenesisConfig = {
    seed,
    ...DEFAULT_GENESIS,
    ...opts.genesis,
  };
  const genesis = runGenesis(genesisCfg);
  if (opts.erode !== false) {
    erode(genesis.elevationM, genesis.level, DEFAULT_EROSION);
  }
  let geology: GeologyState = genesis;
  if (terrainLevel !== geology.level) geology = upsampleGeology(geology, terrainLevel);
  const ocean = deriveOcean(geology);
  const climate = initClimate({ n: climateN, geology, seaLevel: ocean.seaLevel, seed, orbit });
  /* Hydrology's default level is min(6, geology.level), and biosphere and
     civilisation inherit it. That cap is a cost choice, not a law, and it also
     caps how many settlements the world can hold — so it is exposed rather
     than hidden, and the M8 benchmark raises it to measure the step at scale. */
  const hydrology = initHydrology(
    opts.hydrologyLevel === undefined
      ? { geology, ocean, climate }
      : { geology, ocean, climate, level: opts.hydrologyLevel },
  );
  const biosphere = initBiosphere(hydrology);
  const dynamicGeology = initDynamicGeology(genesisCfg, genesis);
  const habitability = initHabitability(hydrology);
  const civConfig: CivConfig = { seed, ...opts.civilisation };
  const civilisation = initCivilisation(hydrology, biosphere, habitability, civConfig);
  const cities = initCityRegistry(seed, civilisation.store.capacity);
  const resources = initResources(hydrology);
  const economy = initEconomy(civilisation, resources, initNetwork(civilisation.store.capacity));
  refreshEconomyResources(economy, geology, hydrology, biosphere, { seed });

  const cubeGrid = gridId('cubesphere', terrainLevel);
  const geoGrid = gridId('geodesic', climateN);
  const hydroGrid = gridId('cubesphere', hydrology.level);

  const store = new FieldStore()
    .declare(i16(FID.elevation, cubeGrid, OWNER_GEOLOGY, 'm', [-11000, 9000], 'slow'))
    .declare(u8(FID.plateId, cubeGrid, OWNER_GEOLOGY, 'id', [0, 255], 'slow'))
    .declare(u8(FID.crustType, cubeGrid, OWNER_GEOLOGY, 'enum', [0, 1], 'slow'))
    .declare(i16(FID.crustAge, cubeGrid, OWNER_GEOLOGY, 'Myr', [0, 400], 'slow'))
    .declare(i16(FID.crustThickness, cubeGrid, OWNER_GEOLOGY, 'km', [0, 80], 'slow'))
    .declare(u8(FID.boundaryType, cubeGrid, OWNER_GEOLOGY, 'enum', [0, 3], 'slow'))
    .declare(i16(FID.uplift, cubeGrid, OWNER_GEOLOGY, 'm', [0, 9000], 'slow'))
    .declare(u8(FID.oceanMask, cubeGrid, OWNER_OCEAN, 'bool', [0, 1], 'slow'))
    .declare(i16(FID.waterDepth, cubeGrid, OWNER_OCEAN, 'm', [0, 11000], 'slow'))
    .declare(f32(FID.temperature, geoGrid, OWNER_CLIMATE, 'K', [180, 340], 'slow'))
    .declare(f32(FID.humidity, geoGrid, OWNER_CLIMATE, 'kg/kg', [0, 0.05], 'fast'))
    .declare(f32(FID.precip, geoGrid, OWNER_CLIMATE, 'kg/m2/s', [0, 1e-3], 'fast'))
    .declare(f32(FID.ice, geoGrid, OWNER_CLIMATE, 'frac', [0, 1], 'slow'))
    .declare(f32(FID.windU, geoGrid, OWNER_CLIMATE, 'm/s', [-200, 200], 'fast'))
    .declare(f32(FID.windV, geoGrid, OWNER_CLIMATE, 'm/s', [-200, 200], 'fast'))
    .declare(i16(FID.rotationAngle, gridId('cubesphere', 6), OWNER_ROTATION, 'deg', [0, 360], 'fast'))
    .declare(i16(FID.basinId, hydroGrid, OWNER_HYDROLOGY, 'id', [-1, 32767], 'slow'))
    .declare(f32(FID.flowAccumulation, hydroGrid, OWNER_HYDROLOGY, 'm2', [0, 6e14], 'slow'))
    .declare(f32(FID.runoff, hydroGrid, OWNER_HYDROLOGY, 'm/s', [0, 0.1], 'slow'))
    .declare(f32(FID.soilMoisture, hydroGrid, OWNER_HYDROLOGY, 'm', [0, 10], 'slow'))
    .declare(f32(FID.riverDischarge, hydroGrid, OWNER_HYDROLOGY, 'm3/s', [0, 1e9], 'slow'))
    .declare(f32(FID.snowpack, hydroGrid, OWNER_HYDROLOGY, 'm', [0, 1000], 'slow'))
    .declare(f32(FID.glacier, hydroGrid, OWNER_HYDROLOGY, 'm', [0, 5000], 'slow'))
    .declare(u8(FID.biome, hydroGrid, OWNER_BIOSPHERE, 'enum', [0, 15], 'slow'))
    .declare(f32(FID.vegetation, hydroGrid, OWNER_BIOSPHERE, 'frac', [0, 1], 'slow'))
    .declare(f32(FID.npp, hydroGrid, OWNER_BIOSPHERE, 'kg/m2/yr', [0, 20], 'slow'))
    .declare(f32(FID.population, hydroGrid, OWNER_BIOSPHERE, 'density', [0, 100], 'slow'))
    .declare(f32(FID.habitability, hydroGrid, OWNER_CIVILISATION, 'frac', [0, 1], 'slow'))
    .declare(f32(FID.settlementPop, hydroGrid, OWNER_CIVILISATION, 'people', [0, 5e7], 'slow'))
    .declare(i16(FID.territory, hydroGrid, OWNER_CIVILISATION, 'id', [-1, 32767], 'slow'))
    .declare(f32(FID.pollution, hydroGrid, OWNER_ECONOMY, 'rel', [0, 1e6], 'slow'))
    .declare(f32(FID.oreRichness, hydroGrid, OWNER_ECONOMY, 'frac', [0, 1], 'slow'))
    .seal();

  publishGeology(store, geology, ocean);
  publishClimate(store, climate);
  publishHydrology(store, hydrology);
  publishBiosphere(store, biosphere);
  publishCivilisation(store, civilisation);
  publishEconomy(store, economy);

  const tiles = new TileCache({ storage: opts.tileStorage ?? new MemoryTileStore(), capacity: 2048 });
  const history = new HistoryStore(WORLD_HISTORY_SERIES);
  const worldRef: WorldRuntimeRef = {
    timeScale: 1,
    visualField: 'elevation',
    climate,
    geology,
    ocean,
    hydrology,
    biosphere,
    dynamicGeology,
    civilisation,
    habitability,
    civConfig,
    cities,
    economy,
    history,
    geologyEventCursor: 0,
    capMul: new Float64Array(civilisation.store.capacity).fill(1),
    techMul: new Float64Array(civilisation.store.capacity).fill(1),
    windOnCube: {
      u: new Float64Array(hydrology.cellCount),
      v: new Float64Array(hydrology.cellCount),
    },
  };

  const scheduler = new Scheduler({
    calendar,
    startTime: simTime(0, 0, calendar),
    store,
    maxStepsPerAdvance: 8192,
  })
    .register(makeGeology(store, worldRef, calendar, seed))
    .register(makeHydrology(store, worldRef, calendar))
    .register(makeClimate(store, worldRef, orbit, calendar))
    .register(makeOcean(store, worldRef))
    .register(makeBiosphere(store, worldRef, calendar))
    .register(makeCivilisation(store, worldRef, calendar))
    .register(makeEconomy(store, worldRef, calendar))
    .register(makeRotation(store))
    .build();
  const commands = createCommandLog(() => scheduler.time);
  const creationOptions: SerializableWorldOptions = {
    seed,
    genesis: {
      level: genesisCfg.level,
      plateCount: genesisCfg.plateCount,
      steps: genesisCfg.steps,
      continentFraction: genesisCfg.continentFraction,
    },
    terrainLevel,
    climateN,
    hydrologyLevel: hydrology.level,
    erode: opts.erode !== false,
    civilisation: { ...(opts.civilisation ?? {}) },
  };

  const world: World = {
    seed,
    calendar,
    store,
    scheduler,
    geology,
    ocean,
    climate,
    hydrology,
    biosphere,
    dynamicGeology,
    civilisation,
    habitability,
    cities,
    economy,
    tiles,
    commands,
    history,
    terrainLevel,
    creationOptions,
    get timeScale() {
      return worldRef.timeScale;
    },
    set timeScale(v: number) {
      worldRef.timeScale = v;
    },
    get visualField() {
      return worldRef.visualField;
    },
    set visualField(v: string) {
      worldRef.visualField = v;
    },
    get geologyEventCursor() {
      return worldRef.geologyEventCursor;
    },
    set geologyEventCursor(v: number) {
      worldRef.geologyEventCursor = v;
    },
    apply(cmd: Command): void {
      if (cmd.kind === 'advance') {
        if (!Number.isFinite(cmd.seconds) || cmd.seconds < 0) {
          throw new Error('advance requires a finite non-negative duration');
        }
        /* A paused scheduler no-ops the step; logging it would make the recipe
           claim time passed that did not. */
        if (scheduler.state !== 'running') return;
      }
      applyCommand(world, worldRef, cmd);
      commands.push(cmd);
    },
    advance(dt: number): void {
      if (!Number.isFinite(dt) || dt < 0) {
        throw new Error('advance requires a finite non-negative duration');
      }
      if (scheduler.state !== 'running') return;
      scheduler.advance(duration(dt));
      commands.push({ kind: 'advance', seconds: dt });
      recordHistory(world);
    },
    /**
     * Geological fast-forward. NOT an ordinary advance: civilisation and
     * economy are reduced to an envelope for the duration. See
     * `advanceDeepTimeApproximate`.
     */
    advanceDeepTimeApproximate(years: number): void {
      if (!(years > 0) || !Number.isFinite(years)) {
        throw new Error('deep-time advance requires finite positive years');
      }
      advanceDeepTimeApproximate(world, worldRef, years);
      commands.push({ kind: 'advanceDeepTime', years });
    },
    digest(): number {
      /* T-0082 covered M5-M7; T-0094 adds M9 cities, the M10 arrays M8 reads
         from the previous tick, and the scheduler's own state machine. This is
         a CONTINUATION digest — see the note at the top of hash.ts.
         O(total state) — a checkpoint operation, never on the tick path. */
      return hashWorldState({
        seed,
        geology,
        climate: worldRef.climate,
        hydrology: worldRef.hydrology,
        biosphere: worldRef.biosphere,
        dynamicGeology: worldRef.dynamicGeology,
        ocean: worldRef.ocean,
        civilisation: worldRef.civilisation,
        economy: worldRef.economy,
        cities: worldRef.cities,
        scheduler: scheduler.snapshot(),
        seaLevel: ocean.seaLevel,
        time: scheduler.time,
      });
    },
  };
  return world;
}

function applyCommand(
  world: World,
  ref: WorldRuntimeRef,
  cmd: Command,
): void {
  switch (cmd.kind) {
    case 'setTimeScale':
      ref.timeScale = cmd.scale;
      transitionRegime(world, ref, classifyRegime(cmd.scale));
      break;
    case 'pause':
      world.scheduler.pause();
      break;
    case 'resume':
      /* The command is play/pause (T-0023). `resume()` reseeds climate
         transients (quiesce reverse). Unpause must not. */
      world.scheduler.resumeRunning();
      break;
    case 'setRegime':
      transitionRegime(world, ref, cmd.regime as Regime);
      break;
    case 'setVisualField':
      ref.visualField = cmd.field;
      break;
    case 'stepOnce':
      world.scheduler.advance(HOUR);
      recordHistory(world);
      break;
    case 'advance':
      world.scheduler.advance(duration(cmd.seconds));
      recordHistory(world);
      break;
    case 'advanceDeepTime':
      advanceDeepTimeApproximate(world, ref, cmd.years);
      break;
    case 'bookmark':
      world.history.bookmark(world.scheduler.time, cmd.label);
      world.history.addEvent(world.scheduler.time, 'timeline', cmd.label, 0.9);
      break;
  }
}

/**
 * DEEP-TIME APPROXIMATION — not a physically meaningful timeline advance.
 *
 * This is the geological fast-forward behind the 4.5 Gyr stress path, and it is
 * named for what it is (T-0096). It is NOT `advance()` with a big number.
 *
 * WHAT IT APPROXIMATES, AND WHY THAT IS DEFENSIBLE. `transitionRegime` argues,
 * correctly, that civilisation must not run on geological ticks because "a
 * 100 kyr civilisation tick would skip the entire history of every society".
 * This function used to set civilisation and economy to 1 Myr per step — the
 * same objection, ten times worse — while presenting itself as an ordinary
 * timeline jump. That was the contradiction.
 *
 * The resolution is not a smaller step; at 4.5 Gyr no affordable step resolves
 * societies. It is to state what the model becomes:
 *
 *   - Geology, climate, hydrology and biosphere DO have deep-time dynamics and
 *     are integrated on macro steps. Their state is meaningful afterwards.
 *   - Civilisation and economy are advanced as an ENVELOPE, not a history.
 *     Population and technology are closed-form (DEC-042), so they track their
 *     equilibria correctly at any dt; what is lost is the rise and fall of
 *     individual societies, which at this scale were never resolvable. The
 *     civilisation LOD is switched to `aggregate` explicitly to say so, rather
 *     than leaving a full-detail model running at a step it cannot support.
 *
 * DEC-030 permits temporal LOD and path dependence. What it does not permit is
 * an approximation that is not declared, which is what this was.
 *
 * On return every cadence is restored from the single regime table, so a jump
 * cannot leave civilisation integrating at a million years per step.
 */
function advanceDeepTimeApproximate(world: World, ref: WorldRuntimeRef, years: number): void {
  if (!(years > 0) || !Number.isFinite(years)) throw new Error('deep-time advance requires finite positive years');
  transitionRegime(world, ref, 'paleo');
  const secondsPerYear = world.calendar.secondsPerYear;
  const macro = duration(1_000_000 * secondsPerYear);
  for (const owner of [OWNER_GEOLOGY, OWNER_CLIMATE, OWNER_HYDROLOGY, OWNER_BIOSPHERE,
    OWNER_CIVILISATION, OWNER_ECONOMY, OWNER_ROTATION] as const) {
    world.scheduler.setCadence(owner, { kind: 'every', dt: macro });
  }
  /* Already 'aggregate' at paleo; set explicitly because this function is the
     one place that runs civilisation far outside its designed cadence. */
  ref.civilisation.detail = 'aggregate';

  let remaining = years;
  while (remaining > 0) {
    const chunkYears = Math.min(remaining, 500_000_000);
    world.scheduler.advance(duration(chunkYears * secondsPerYear));
    remaining -= chunkYears;
  }

  /* Restore from the regime table rather than repeating it. */
  applyRegimeCadences(world, ref, ref.climate.regime);
  recordHistory(world);
  world.history.addEvent(world.scheduler.time, 'timeline',
    `Deep-time approximation ${years.toExponential(3)} years`, 1);
}

function recordHistory(world: World): void {
  world.history.record(world.scheduler.time, {
    population: world.civilisation.totalPopulation,
    settlements: world.civilisation.store.count,
    cities: world.cities.cities.length,
    temperature: mean(world.climate.T),
    seaLevel: world.hydrology.seaLevelM,
    ice: mean(world.climate.ice),
    biomass: mean(world.biosphere.biomassKgM2),
    trade: world.economy.totalTrade,
    production: world.economy.totalProduction,
    pollution: mean(world.economy.pollution),
  });
}

function mean(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] as number;
  return sum / values.length;
}

/** T0..T4 transitions are explicit command-log boundaries. Fast transients
 * quiesce, cadence windows realign deterministically, and slow geology retains
 * its fixed 100 kyr cadence. */
/**
 * The cadence each subsystem runs at in a given regime.
 *
 * Extracted so there is ONE table. `advanceDeepTimeApproximate` used to restore
 * cadences by repeating these numbers inline, which is exactly how a restore
 * drifts from the thing it is restoring to.
 */
function regimeCadences(regime: Regime, secondsPerYear: number): {
  climate: Duration; hydrology: Duration; biosphere: Duration;
  civilisation: Duration; geology: Duration;
} {
  const y = secondsPerYear;
  const climate = regime === 'explicit' ? HOUR
    : regime === 'synoptic' ? duration(6 * HOUR)
    : regime === 'climatology' ? duration(30 * DAY)
    : duration(100_000 * y);
  const hydrology = regime === 'explicit' ? DAY
    : regime === 'synoptic' ? duration(7 * DAY)
    : regime === 'climatology' ? duration(y)
    : duration(100_000 * y);
  const biosphere = regime === 'explicit' ? duration(30 * DAY)
    : regime === 'synoptic' ? duration(90 * DAY)
    : regime === 'climatology' ? duration(y)
    : duration(100_000 * y);
  /* Civilisation's own time scale is years to millennia, so it does NOT
     coarsen to the 100 kyr geological step at paleo: a 100 kyr civilisation
     tick would skip the entire history of every society that ever existed.
     500 years is the coarsest step at which the closed-form demography still
     resolves a rise and a fall, and the step is O(cells), so 200 of them per
     geological tick is affordable. */
  const civilisation = regime === 'explicit' || regime === 'synoptic' ? duration(y)
    : regime === 'climatology' ? duration(10 * y)
    : duration(500 * y);
  /* Geology is on a fixed simulation-time cadence in every regime (DEC-030):
     its trajectory must be path-independent of how fast the user is watching. */
  const geology = duration(100_000 * y);
  return { climate, hydrology, biosphere, civilisation, geology };
}

function applyRegimeCadences(world: World, ref: WorldRuntimeRef, regime: Regime): void {
  const c = regimeCadences(regime, world.calendar.secondsPerYear);
  world.scheduler.setCadence(OWNER_CLIMATE, { kind: 'every', dt: c.climate });
  world.scheduler.setCadence(OWNER_HYDROLOGY, { kind: 'every', dt: c.hydrology });
  world.scheduler.setCadence(OWNER_BIOSPHERE, { kind: 'every', dt: c.biosphere });
  world.scheduler.setCadence(OWNER_CIVILISATION, { kind: 'every', dt: c.civilisation });
  world.scheduler.setCadence(OWNER_ECONOMY, { kind: 'every', dt: c.civilisation });
  world.scheduler.setCadence(OWNER_GEOLOGY, { kind: 'every', dt: c.geology });
  world.scheduler.setCadence(OWNER_ROTATION, { kind: 'every', dt: c.climate });
  /* Below the paleo regime every society is resolved individually; at paleo the
     interesting quantity is the population envelope (DEC-015). */
  ref.civilisation.detail = regime === 'paleo' ? 'aggregate' : 'full';
}

function transitionRegime(world: World, ref: WorldRuntimeRef, regime: Regime): void {
  if (ref.climate.regime === regime) return;
  quiesceClimate(ref.climate);
  ref.climate.regime = regime;
  applyRegimeCadences(world, ref, regime);
  resumeClimate(ref.climate);
}

function publishGeology(store: FieldStore, g: GeologyState, ocean: OceanState): void {
  publishGeologyFields(store, g);
  fillU8(store, FID.oceanMask, OWNER_OCEAN, ocean.mask);
  fillI16(store, FID.waterDepth, OWNER_OCEAN, ocean.depthM);
}

function publishGeologyFields(store: FieldStore, g: GeologyState): void {
  fillI16(store, FID.elevation, OWNER_GEOLOGY, g.elevationM);
  fillU8(store, FID.plateId, OWNER_GEOLOGY, g.plateId);
  fillU8(store, FID.crustType, OWNER_GEOLOGY, g.crustType);
  fillI16(store, FID.crustAge, OWNER_GEOLOGY, g.crustAgeMyr);
  fillI16(store, FID.crustThickness, OWNER_GEOLOGY, g.crustThicknessKm);
  fillU8(store, FID.boundaryType, OWNER_GEOLOGY, g.boundaryType);
  fillI16(store, FID.uplift, OWNER_GEOLOGY, g.upliftM);
}

function publishClimate(store: FieldStore, s: ClimateState): void {
  fillF32(store, FID.temperature, OWNER_CLIMATE, s.T);
  fillF32(store, FID.humidity, OWNER_CLIMATE, s.q);
  fillF32(store, FID.precip, OWNER_CLIMATE, s.precip);
  fillF32(store, FID.ice, OWNER_CLIMATE, s.ice);
  fillF32(store, FID.windU, OWNER_CLIMATE, s.u);
  fillF32(store, FID.windV, OWNER_CLIMATE, s.v);
}

function publishHydrology(store: FieldStore, s: HydrologyState): void {
  fillI16(store, FID.basinId, OWNER_HYDROLOGY, s.basinId);
  fillF32(store, FID.flowAccumulation, OWNER_HYDROLOGY, s.contributingAreaM2);
  fillF32(store, FID.runoff, OWNER_HYDROLOGY, s.runoffMps);
  fillF32(store, FID.soilMoisture, OWNER_HYDROLOGY, s.soilMoistureM);
  fillF32(store, FID.riverDischarge, OWNER_HYDROLOGY, s.dischargeM3s);
  fillF32(store, FID.snowpack, OWNER_HYDROLOGY, s.snowpackM);
  fillF32(store, FID.glacier, OWNER_HYDROLOGY, s.glacierM);
}

function publishBiosphere(store: FieldStore, s: BiosphereState): void {
  fillU8(store, FID.biome, OWNER_BIOSPHERE, s.biome);
  fillF32(store, FID.vegetation, OWNER_BIOSPHERE, s.vegetationDensity);
  fillF32(store, FID.npp, OWNER_BIOSPHERE, s.nppKgM2Yr);
  fillF32(store, FID.population, OWNER_BIOSPHERE, s.populationDensity);
}

function fillI16(store: FieldStore, id: FieldId, owner: SubsystemId, src: ArrayLike<number>): void {
  const f = store.mut(id, owner);
  const raw = f.rawMut() as Int16Array;
  const n = Math.min(raw.length, src.length);
  for (let i = 0; i < n; i++) {
    const v = Math.round(src[i] as number);
    raw[i] = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
  }
  f.markAllDirty();
  f.commit();
}

function fillU8(store: FieldStore, id: FieldId, owner: SubsystemId, src: ArrayLike<number>): void {
  const f = store.mut(id, owner);
  const raw = f.rawMut() as Uint8Array;
  const n = Math.min(raw.length, src.length);
  for (let i = 0; i < n; i++) raw[i] = src[i] as number;
  f.markAllDirty();
  f.commit();
}

function fillF32(store: FieldStore, id: FieldId, owner: SubsystemId, src: ArrayLike<number>): void {
  const f = store.mut(id, owner);
  const raw = f.rawMut() as Float32Array;
  const n = Math.min(raw.length, src.length);
  for (let i = 0; i < n; i++) raw[i] = src[i] as number;
  f.markAllDirty();
  f.commit();
}

function makeGeology(store: FieldStore, ref: WorldRuntimeRef, calendar: Calendar, seed: Seed): Subsystem {
  return {
    id: OWNER_GEOLOGY,
    phase: 'Geology',
    cadence: { kind: 'every', dt: duration(100_000 * calendar.secondsPerYear) },
    reads: [],
    writes: [FID.elevation, FID.plateId, FID.crustType, FID.crustAge,
      FID.crustThickness, FID.boundaryType, FID.uplift],
    step: (ctx) => {
      /* Initial due tick establishes the cadence boundary; genesis already
         represents the state at t=0. */
      if (ctx.step === 0) return;
      const dtMyr = (ctx.dt as number) / calendar.secondsPerYear / 1e6;
      /* Forcing arrives WITH its grid (T-0080). Precipitation is on the
         geodesic climate grid, runoff on the hydrology cube level; neither is
         the geology grid, and neither may be indexed proportionally. */
      stepDynamicGeology(ref.dynamicGeology, dtMyr, {
        precipitationAnnual: ref.climate.precipMean,
        geodesicN: ref.climate.grid.n,
        runoffMps: ref.hydrology.runoffMps,
        runoffLevel: ref.hydrology.level,
      });
      refreshTerrainFromGeology(ref.dynamicGeology.coarse, ref.geology);
      refreshOcean(ref.ocean, ref.geology, ref.hydrology.seaLevelM);
      refreshClimateBoundary(ref.climate, ref.geology, ref.ocean.seaLevel);
      rebuildHydrologyRouting(ref.hydrology, ref.geology);
      /* Geography moved, so where people CAN live moved with it. Refreshing
         here rather than per-tick is what makes M8 a consequence of M2-M7
         instead of a parallel world with its own opinions. */
      refreshHabitability(ref.habitability, ref.hydrology, ref.biosphere);
      rebuildSiteIndex(ref.civilisation, ref.civConfig);
      /* What is in the ground changed, so what the ground is worth changed.
         Move a plate boundary and the mining regions move with it. */
      refreshEconomyResources(ref.economy, ref.geology, ref.hydrology, ref.biosphere, { seed });
      const newEvents = ref.dynamicGeology.events.length - ref.geologyEventCursor;
      if (newEvents > 0) {
        const latest = ref.dynamicGeology.events[ref.dynamicGeology.events.length - 1]!;
        ref.history.addEvent(ctx.time, 'geology', `${String(newEvents)} tectonic event${newEvents === 1 ? '' : 's'}`, 0.75, [latest.cell]);
        ref.geologyEventCursor = ref.dynamicGeology.events.length;
      }
      publishGeologyFields(store, ref.geology);
    },
  };
}

function makeHydrology(store: FieldStore, ref: WorldRuntimeRef, calendar: Calendar): Subsystem {
  return {
    id: OWNER_HYDROLOGY,
    phase: 'Hydrology',
    cadence: { kind: 'every', dt: DAY },
    /* Climate arrays are the previous atmosphere generation: the one-step lag
       breaks geology→hydrology→atmosphere feedback explicitly. */
    reads: [FID.elevation],
    writes: [FID.basinId, FID.flowAccumulation, FID.runoff, FID.soilMoisture,
      FID.riverDischarge, FID.snowpack, FID.glacier],
    step: (ctx) => {
      stepHydrology(ref.hydrology, ref.climate, ctx.dt as number);
      if (Math.abs(ref.ocean.seaLevel - ref.hydrology.seaLevelM) > 1e-6) {
        refreshOcean(ref.ocean, ref.geology, ref.hydrology.seaLevelM);
      }
      publishHydrology(store, ref.hydrology);
      void calendar;
    },
  };
}

function makeBiosphere(store: FieldStore, ref: WorldRuntimeRef, calendar: Calendar): Subsystem {
  return {
    id: OWNER_BIOSPHERE,
    phase: 'Biosphere',
    cadence: { kind: 'every', dt: duration(30 * DAY) },
    reads: [FID.soilMoisture, FID.snowpack, FID.glacier, FID.runoff],
    writes: [FID.biome, FID.vegetation, FID.npp, FID.population],
    step: (ctx) => {
      const years = (ctx.dt as number) / calendar.secondsPerYear;
      const season = (ctx.time.seconds / calendar.secondsPerYear) % 1;
      stepBiosphere(ref.biosphere, ref.hydrology, years, season);
      publishBiosphere(store, ref.biosphere);
    },
  };
}

function makeCivilisation(store: FieldStore, ref: WorldRuntimeRef, calendar: Calendar): Subsystem {
  return {
    id: OWNER_CIVILISATION,
    phase: 'Civilisation',
    cadence: { kind: 'every', dt: duration(calendar.secondsPerYear) },
    /* Reads the biosphere and hydrology fields that habitability is built
       from. It writes no field any other subsystem reads this tick, so it
       cannot feed back into the same step — the feedback path is the next
       one, which is what keeps the graph acyclic (DEC-031). */
    reads: [FID.npp, FID.soilMoisture, FID.riverDischarge, FID.biome],
    writes: [FID.habitability, FID.settlementPop, FID.territory],
    step: (ctx) => {
      const years = (ctx.dt as number) / calendar.secondsPerYear;
      const founded = ref.civilisation.foundedTotal;
      const collapsed = ref.civilisation.collapsedTotal;
      const cityCount = ref.cities.cities.length;
      /* Habitability tracks the biosphere between geological refreshes: a
         drought that kills the NPP must empty the towns, not just the fields. */
      refreshHabitability(ref.habitability, ref.hydrology, ref.biosphere);
      /* The economy's arrows back into M8, read from LAST tick's economy —
         economy runs in a later phase, so this is one-directional and the
         dependency graph stays acyclic (DEC-031). */
      for (let i = 0; i < ref.civilisation.store.bound; i++) {
        ref.capMul[i] = capacityMultiplier(ref.economy, ref.civilisation, i);
        ref.techMul[i] = technologyMultiplier(ref.economy, ref.civilisation, i);
      }
      stepCivilisation(ref.civilisation, ref.hydrology, years, ref.civConfig,
        {
          capacity: ref.capMul,
          technology: ref.techMul,
          onVacateSlot: (index) => { resetEconomySlot(ref.economy, index); },
        });
      /* M9 follows M8 in the same phase and the same tick: a city is what a
         settlement's people do to the ground, so it must never observe a
         population from a different step. No geometry is built here — only
         authoritative city state advances. */
      stepCities(ref.cities, ref.civilisation, ref.hydrology, years);
      if (ref.civilisation.foundedTotal > founded) ref.history.addEvent(ctx.time, 'civilisation',
        `${String(ref.civilisation.foundedTotal - founded)} settlement founded`, 0.6);
      if (ref.civilisation.collapsedTotal > collapsed) ref.history.addEvent(ctx.time, 'civilisation',
        `${String(ref.civilisation.collapsedTotal - collapsed)} settlement collapsed`, 0.7);
      if (ref.cities.cities.length > cityCount) ref.history.addEvent(ctx.time, 'city',
        `${String(ref.cities.cities.length - cityCount)} city milestone`, 0.7);
      publishCivilisation(store, ref.civilisation);
    },
  };
}

function publishCivilisation(store: FieldStore, c: CivilisationState): void {
  fillF32(store, FID.habitability, OWNER_CIVILISATION, c.habitability.suitability);

  /* Per-cell settlement population: a settlement's people spread over the
     territory it holds, so the renderer and M10 see a population FIELD rather
     than a point. Reusing the coupling scratch would alias across subsystems,
     so this owns its own buffer. */
  const pop = store.mut(FID.settlementPop, OWNER_CIVILISATION);
  const rawPop = pop.rawMut() as Float32Array;
  rawPop.fill(0);
  const terr = store.mut(FID.territory, OWNER_CIVILISATION);
  const rawTerr = terr.rawMut() as Int16Array;
  rawTerr.fill(-1);

  const cells = c.store.column(CIV.cell);
  const people = c.store.column(CIV.population);
  const held = c.store.column(CIV.territoryCells);
  const n = Math.min(rawPop.length, c.cellCount);
  for (let i = 0; i < n; i++) {
    const owner = c.claim[i] as number;
    if (owner < 0 || !c.store.aliveAt(owner)) continue;
    rawTerr[i] = owner > 32767 ? 32767 : owner;
    const t = held[owner] as number;
    if (t > 0) rawPop[i] = (people[owner] as number) / t;
  }
  /* The settlement's own cell also carries its centre-of-population marker, so
     a one-cell polity is still visible. */
  for (let k = 0; k < c.store.bound; k++) {
    if (!c.store.aliveAt(k)) continue;
    const cellIndex = cells[k] as number;
    if (cellIndex >= 0 && cellIndex < n) {
      rawPop[cellIndex] = Math.max(rawPop[cellIndex] as number, (people[k] as number) / Math.max(1, held[k] as number));
      rawTerr[cellIndex] = k > 32767 ? 32767 : k;
    }
  }
  pop.markAllDirty();
  pop.commit();
  terr.markAllDirty();
  terr.commit();
}

function makeEconomy(
  store: FieldStore,
  ref: WorldRuntimeRef,
  calendar: Calendar,
): Subsystem {
  return {
    id: OWNER_ECONOMY,
    phase: 'Economy',
    cadence: { kind: 'every', dt: duration(calendar.secondsPerYear) },
    /* Reads the wind it advects pollution with, and the terrain the resource
       map is built on. Writes only its own fields. */
    reads: [FID.windU, FID.windV, FID.elevation],
    writes: [FID.pollution, FID.oreRichness],
    step: (ctx) => {
      const years = (ctx.dt as number) / calendar.secondsPerYear;
      const topology = ref.economy.network.topologyGeneration;
      const railKm = ref.economy.network.railKm;
      stepEconomy(ref.economy, ref.civilisation, ref.hydrology, years);
      updateLandUse(ref.economy, ref.civilisation);
      /* Wind lives on the geodesic climate grid; pollution on the cube. The
         resample is coordinate-aware (T-0080) — indexing one array with the
         other's index would blow every plume in an arbitrary direction. */
      mapGeoToCube(ref.climate.u, ref.climate.grid.n, ref.hydrology.level, ref.windOnCube.u);
      mapGeoToCube(ref.climate.v, ref.climate.grid.n, ref.hydrology.level, ref.windOnCube.v);
      advectPollution(ref.economy, ref.windOnCube.u, ref.windOnCube.v, years, cubeDim);
      if (ref.economy.network.topologyGeneration > topology) ref.history.addEvent(ctx.time, 'economy',
        'Transport network rebuilt', 0.55);
      if (railKm === 0 && ref.economy.network.railKm > 0) ref.history.addEvent(ctx.time, 'economy',
        'First railway', 0.9);
      publishEconomy(store, ref.economy);
    },
  };
}

function publishEconomy(store: FieldStore, e: EconomyState): void {
  fillF32(store, FID.pollution, OWNER_ECONOMY, e.pollution);
  const ore = store.mut(FID.oreRichness, OWNER_ECONOMY);
  const raw = ore.rawMut() as Float32Array;
  const N = e.resources.cellCount;
  const base = COMMODITY.ORE * N;
  const n = Math.min(raw.length, N);
  for (let i = 0; i < n; i++) raw[i] = e.resources.endowment[base + i] as number;
  ore.markAllDirty();
  ore.commit();
}

/** Refresh derived FieldStore mirrors after loading authoritative state. */
export function publishWorldState(world: World): void {
  publishGeology(world.store, world.geology, world.ocean);
  publishClimate(world.store, world.climate);
  publishHydrology(world.store, world.hydrology);
  publishBiosphere(world.store, world.biosphere);
  publishCivilisation(world.store, world.civilisation);
  publishEconomy(world.store, world.economy);
}

function makeRotation(store: FieldStore): Subsystem {
  const f = store.mut(FID.rotationAngle, OWNER_ROTATION);
  return {
    id: OWNER_ROTATION,
    phase: 'Derived',
    cadence: { kind: 'every', dt: DAY },
    reads: [],
    writes: [FID.rotationAngle],
    step: (ctx) => {
      f.set(0, ctx.step % 360);
      f.commit();
    },
  };
}

function makeClimate(
  store: FieldStore,
  ref: { timeScale: number; climate: ClimateState },
  orbit: OrbitParams,
  calendar: Calendar,
): Subsystem {
  return {
    id: OWNER_CLIMATE,
    phase: 'Atmosphere',
    cadence: { kind: 'every', dt: HOUR },
    /* Ocean mask is genesis-static (deriveOcean) and copied into ClimateState
       at init. Declaring a current-gen read of oceanMask is illegal: ocean
       writes it in a later phase and the field is not double-buffered, so
       readsPrev is also illegal (DEC-031). Climate does not sample the store
       for the mask — it uses s.ocean. */
    reads: [FID.elevation],
    writes: [FID.temperature, FID.humidity, FID.precip, FID.ice, FID.windU, FID.windV],
    step: (ctx) => {
      const s = ref.climate;
      const sun = sunState(ctx.time, calendar, orbit);
      stepClimate(s, ctx.dt as number, sun.declination, orbit);
      publishClimate(store, s);
    },
    quiesce: () => {
      quiesceClimate(ref.climate);
    },
    resume: () => {
      resumeClimate(ref.climate);
    },
  };
}

function makeOcean(store: FieldStore, ref: WorldRuntimeRef): Subsystem {
  return {
    id: OWNER_OCEAN,
    phase: 'Ocean',
    cadence: { kind: 'everyNOf', n: 6, of: OWNER_CLIMATE },
    reads: [FID.temperature, FID.ice],
    writes: [FID.oceanMask, FID.waterDepth],
    step: () => {
      /* Mask/depth are slow (terrain-derived). Ice albedo coupling lives in
         the climate step; this tick exists so M5 hydrology has an ocean owner
         already in the graph. */
      fillU8(store, FID.oceanMask, OWNER_OCEAN, ref.ocean.mask);
      fillI16(store, FID.waterDepth, OWNER_OCEAN, ref.ocean.depthM);
    },
  };
}

function i16(
  id: FieldId,
  grid: ReturnType<typeof gridId>,
  owner: SubsystemId,
  units: string,
  range: readonly [number, number],
  temporalClass: 'slow' | 'fast',
) {
  return {
    id,
    grid,
    dtype: 'i16' as const,
    components: 1,
    quantum: 1,
    offset: 0,
    units,
    range,
    owner,
    tier: 'A' as const,
    temporalClass,
    doubleBuffered: false,
    persist: 'snapshot' as const,
  };
}

function u8(
  id: FieldId,
  grid: ReturnType<typeof gridId>,
  owner: SubsystemId,
  units: string,
  range: readonly [number, number],
  temporalClass: 'slow' | 'fast',
) {
  return {
    id,
    grid,
    dtype: 'u8' as const,
    components: 1,
    quantum: 1,
    offset: 0,
    units,
    range,
    owner,
    tier: 'A' as const,
    temporalClass,
    doubleBuffered: false,
    persist: 'snapshot' as const,
  };
}

function f32(
  id: FieldId,
  grid: ReturnType<typeof gridId>,
  owner: SubsystemId,
  units: string,
  range: readonly [number, number],
  temporalClass: 'slow' | 'fast',
) {
  return {
    id,
    grid,
    dtype: 'f32' as const,
    components: 1,
    quantum: 1,
    offset: 0,
    units,
    range,
    owner,
    tier: 'A' as const,
    temporalClass,
    doubleBuffered: temporalClass === 'fast',
    persist: temporalClass === 'slow' ? ('snapshot' as const) : ('derived' as const),
  };
}

export function worldTime(w: World): SimTime {
  return w.scheduler.time;
}

export { duration };
