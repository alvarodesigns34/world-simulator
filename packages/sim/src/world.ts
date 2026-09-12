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
  type SimTime,
} from '@ws/core';
import {
  FieldStore,
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
import { hashWorldState } from './hash.js';
import { deriveOcean, type OceanState } from './ocean/sea.js';
import { Scheduler } from './scheduler/scheduler.js';
import type { Subsystem } from './scheduler/types.js';
import { DEFAULT_EROSION, erode } from './terrain/erosion.js';
import { TileCache } from './tiles/cache.js';
import { MemoryTileStore } from './tiles/storage.js';

export const OWNER_GEOLOGY = subsystemId('geology');
export const OWNER_TERRAIN = subsystemId('terrain');
export const OWNER_OCEAN = subsystemId('ocean');
export const OWNER_CLIMATE = subsystemId('climate');
export const OWNER_ROTATION = subsystemId('planetRotation');

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
}

export interface World {
  readonly seed: Seed;
  readonly calendar: Calendar;
  readonly store: FieldStore;
  readonly scheduler: Scheduler;
  readonly geology: GeologyState;
  readonly ocean: OceanState;
  readonly climate: ClimateState;
  readonly tiles: TileCache;
  readonly commands: CommandLog;
  readonly terrainLevel: number;
  timeScale: number;
  visualField: string;
  apply(cmd: Command): void;
  digest(): number;
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
  let geology = runGenesis(genesisCfg);
  if (opts.erode !== false) {
    erode(geology.elevationM, geology.level, DEFAULT_EROSION);
  }
  if (terrainLevel !== geology.level) geology = upsampleGeology(geology, terrainLevel);
  const ocean = deriveOcean(geology);
  const climate = initClimate({ n: climateN, geology, seaLevel: ocean.seaLevel, seed, orbit });

  const cubeGrid = gridId('cubesphere', terrainLevel);
  const geoGrid = gridId('geodesic', climateN);

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
    .seal();

  publishGeology(store, geology, ocean);
  publishClimate(store, climate);

  const tiles = new TileCache({ storage: opts.tileStorage ?? new MemoryTileStore(), capacity: 2048 });
  const commands = createCommandLog();
  const worldRef: { timeScale: number; visualField: string; climate: ClimateState } = {
    timeScale: 1,
    visualField: 'elevation',
    climate,
  };

  const scheduler = new Scheduler({
    calendar,
    startTime: simTime(0, 0, calendar),
    store,
  })
    .register(makeRotation(store))
    .register(makeClimate(store, worldRef, orbit, calendar))
    .register(makeOcean(store, worldRef))
    .build();

  const world: World = {
    seed,
    calendar,
    store,
    scheduler,
    geology,
    ocean,
    climate,
    tiles,
    commands,
    terrainLevel,
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
    apply(cmd: Command): void {
      commands.push(cmd);
      applyCommand(world, worldRef, cmd);
    },
    digest(): number {
      return hashWorldState({
        seed,
        geology,
        climate: worldRef.climate,
        seaLevel: ocean.seaLevel,
        time: scheduler.time,
      });
    },
  };
  return world;
}

function applyCommand(
  world: World,
  ref: { timeScale: number; visualField: string; climate: ClimateState },
  cmd: Command,
): void {
  switch (cmd.kind) {
    case 'setTimeScale':
      ref.timeScale = cmd.scale;
      ref.climate.regime = classifyRegime(cmd.scale);
      break;
    case 'pause':
      world.scheduler.pause();
      break;
    case 'resume':
      world.scheduler.resume();
      break;
    case 'setRegime':
      ref.climate.regime = cmd.regime as Regime;
      break;
    case 'setVisualField':
      ref.visualField = cmd.field;
      break;
    case 'stepOnce':
      world.scheduler.advance(HOUR);
      break;
  }
}

function publishGeology(store: FieldStore, g: GeologyState, ocean: OceanState): void {
  fillI16(store, FID.elevation, OWNER_GEOLOGY, g.elevationM);
  fillU8(store, FID.plateId, OWNER_GEOLOGY, g.plateId);
  fillU8(store, FID.crustType, OWNER_GEOLOGY, g.crustType);
  fillI16(store, FID.crustAge, OWNER_GEOLOGY, g.crustAgeMyr);
  fillI16(store, FID.crustThickness, OWNER_GEOLOGY, g.crustThicknessKm);
  fillU8(store, FID.boundaryType, OWNER_GEOLOGY, g.boundaryType);
  fillI16(store, FID.uplift, OWNER_GEOLOGY, g.upliftM);
  fillU8(store, FID.oceanMask, OWNER_OCEAN, ocean.mask);
  fillI16(store, FID.waterDepth, OWNER_OCEAN, ocean.depthM);
}

function publishClimate(store: FieldStore, s: ClimateState): void {
  fillF32(store, FID.temperature, OWNER_CLIMATE, s.T);
  fillF32(store, FID.humidity, OWNER_CLIMATE, s.q);
  fillF32(store, FID.precip, OWNER_CLIMATE, s.precip);
  fillF32(store, FID.ice, OWNER_CLIMATE, s.ice);
  fillF32(store, FID.windU, OWNER_CLIMATE, s.u);
  fillF32(store, FID.windV, OWNER_CLIMATE, s.v);
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
      s.regime = classifyRegime(ref.timeScale);
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

function makeOcean(store: FieldStore, ref: { climate: ClimateState }): Subsystem {
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
      void store;
      void ref;
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
