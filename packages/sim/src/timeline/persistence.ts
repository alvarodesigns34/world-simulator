/** M11 versioned recipe/replay and direct authoritative snapshot saves. */

import type { SimTime } from '@ws/core';
import type { EntityStoreSnapshot } from '@ws/data';
import type { LoggedCommand } from '../commands.js';
import { createWorld, publishWorldState, type SerializableWorldOptions, type World } from '../world.js';
import type { SchedulerSnapshot } from '../scheduler/scheduler.js';
import type { HistorySnapshot } from './history.js';
import { SCIENTIFIC_FIELDS, type ScientificFieldDescriptor } from '../visualisation/scientific.js';

export const SAVE_SCHEMA = 2;
export const ENGINE_SCHEMA = 'world-simulator-m13';

export interface RecipeSave {
  readonly kind: 'recipe';
  readonly schema: 2;
  readonly engine: string;
  readonly options: SerializableWorldOptions;
  readonly commands: readonly LoggedCommand[];
  readonly expectedDigest: number;
  readonly checksum: string;
}

interface EncodedTypedArray { readonly typed: string; readonly data: readonly number[] }
type Encoded = null | boolean | number | string | EncodedTypedArray | Encoded[] | { readonly [key: string]: Encoded };

export interface SnapshotSave {
  readonly kind: 'snapshot';
  readonly schema: 2;
  readonly engine: string;
  readonly options: SerializableWorldOptions;
  readonly commandLog: readonly LoggedCommand[];
  readonly scheduler: SchedulerSnapshot;
  readonly entities: EntityStoreSnapshot;
  readonly history: HistorySnapshot;
  readonly subsystems: Readonly<Record<string, number>>;
  readonly fieldMetadata: readonly ScientificFieldDescriptor[];
  readonly roots: Readonly<Record<string, Encoded>>;
  readonly expectedDigest: number;
  readonly checksum: string;
}

export function saveRecipe(world: World): string {
  const payload = {
    kind: 'recipe' as const,
    schema: SAVE_SCHEMA as 2,
    engine: ENGINE_SCHEMA,
    options: world.creationOptions,
    commands: world.commands.entries,
    expectedDigest: world.digest(),
  };
  return seal(payload);
}

export function replayRecipe(text: string): World {
  const save = parseAndVerify(text);
  if (save.kind !== 'recipe') throw new Error('expected a recipe save');
  const world = createWorld(save.options);
  for (const entry of save.commands) applyReplayCommand(world, entry);
  if (world.digest() !== save.expectedDigest) {
    throw new Error(`recipe replay digest mismatch: expected ${String(save.expectedDigest)}, got ${String(world.digest())}`);
  }
  return world;
}

export function saveSnapshot(world: World): string {
  const roots: Record<string, Encoded> = {
    geology: encode(world.geology),
    ocean: encode(world.ocean),
    climate: encode(world.climate, CLIMATE_DERIVED),
    hydrology: encode(world.hydrology),
    biosphere: encode(world.biosphere),
    dynamicGeology: encode(world.dynamicGeology, new Set(['units'])),
    habitability: encode(world.habitability),
    civilisation: encode(world.civilisation, new Set(['store', 'habitability', 'cellAreaM2'])),
    cities: encode(world.cities),
    economy: encode(world.economy),
    presentation: encode({ timeScale: world.timeScale, visualField: world.visualField }),
  };
  const payload = {
    kind: 'snapshot' as const,
    schema: SAVE_SCHEMA as 2,
    engine: ENGINE_SCHEMA,
    options: world.creationOptions,
    commandLog: world.commands.entries,
    scheduler: world.scheduler.snapshot(),
    entities: world.civilisation.store.snapshot(),
    history: world.history.snapshot(),
    subsystems: { geology: 1, climate: 1, hydrology: 1, biosphere: 1,
      civilisation: 1, cities: 1, economy: 1, timeline: 1 },
    fieldMetadata: SCIENTIFIC_FIELDS,
    roots,
    expectedDigest: world.digest(),
  };
  return seal(payload);
}

export function loadSnapshot(text: string): World {
  const save = parseAndVerify(text);
  if (save.kind !== 'snapshot') throw new Error('expected a snapshot save');
  for (const [name, version] of Object.entries(save.subsystems)) {
    if (version !== 1) throw new Error(`unsupported ${name} subsystem schema ${String(version)}`);
  }
  const world = createWorld(save.options);
  restore(world.geology, save.roots.geology);
  restore(world.ocean, save.roots.ocean);
  restore(world.climate, save.roots.climate);
  restore(world.hydrology, save.roots.hydrology);
  restore(world.biosphere, save.roots.biosphere);
  restore(world.dynamicGeology, save.roots.dynamicGeology);
  restore(world.habitability, save.roots.habitability);
  restore(world.civilisation, save.roots.civilisation);
  restore(world.cities, save.roots.cities);
  restore(world.economy, save.roots.economy);
  const presentation = decode(save.roots.presentation!) as { timeScale: number; visualField: string };
  world.timeScale = presentation.timeScale;
  world.visualField = presentation.visualField;
  world.civilisation.store.restore(save.entities);
  world.commands.restore(save.commandLog);
  world.scheduler.restore(save.scheduler);
  world.history.restore(save.history);
  publishWorldState(world);
  if (world.digest() !== save.expectedDigest) {
    throw new Error(`snapshot digest mismatch: expected ${String(save.expectedDigest)}, got ${String(world.digest())}`);
  }
  return world;
}

export interface LegacyRecipeV1 {
  readonly kind: 'recipe';
  readonly schema: 1;
  readonly seed: readonly [number, number];
  readonly options?: SerializableWorldOptions;
  readonly commands: readonly { readonly cmd: LoggedCommand['cmd']; readonly time?: SimTime }[];
}

export function migrateSave(text: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (parsed.schema === SAVE_SCHEMA) return text;
  if (parsed.schema !== 1 || parsed.kind !== 'recipe' || !Array.isArray(parsed.seed) || !Array.isArray(parsed.commands)) {
    throw new Error(`unsupported save schema ${String(parsed.schema ?? 'missing')}; supported: 1, ${String(SAVE_SCHEMA)}`);
  }
  const raw = parsed as unknown as LegacyRecipeV1;
  const world = createWorld(raw.options ?? { seed: { hi: raw.seed[0] >>> 0, lo: raw.seed[1] >>> 0 } });
  for (const item of raw.commands) world.apply(item.cmd);
  return saveRecipe(world);
}

function applyReplayCommand(world: World, entry: LoggedCommand): void {
  if (entry.cmd.kind !== 'advance') { world.apply(entry.cmd); return; }
  let remaining = entry.cmd.seconds;
  const year = world.calendar.secondsPerYear;
  while (remaining > 0) {
    const max = world.climate.regime === 'paleo' ? 4_000_000 * year
      : world.climate.regime === 'climatology' ? 50_000 * year
      : world.climate.regime === 'synoptic' ? 4 * year
      : 300 * 86400;
    const step = Math.min(remaining, max);
    world.apply({ kind: 'advance', seconds: step });
    remaining -= step;
  }
}

const CLIMATE_DERIVED = new Set([
  'grid', 'lat', 'sinLat', 'cosLat', 'eastX', 'eastY', 'northX', 'northY', 'northZ',
  'gradCoeffE', 'gradCoeffN', 'gradT', 'gradH', 'gradElev', 'edgeI', 'edgeJ', 'edgeLength',
  'edgeUi', 'edgeVi', 'edgeUj', 'edgeVj', 'edgeFlux', 'outgoing', 'transportDelta', 'heightDelta', 'areaM2', 'qsat',
]);

function encode(value: unknown, omit: ReadonlySet<string> = new Set()): Encoded {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const a = value as unknown as { constructor: { name: string }; length: number; [index: number]: number };
    return { typed: a.constructor.name, data: Array.from({ length: a.length }, (_, i) => a[i] as number) };
  }
  if (Array.isArray(value)) return value.map((item) => encode(item));
  if (typeof value === 'object') {
    const out: Record<string, Encoded> = {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
      if (!omit.has(key) && typeof record[key] !== 'function') out[key] = encode(record[key]);
    }
    return out;
  }
  throw new Error(`cannot encode ${typeof value}`);
}

function restore(target: unknown, encoded: Encoded | undefined): unknown {
  if (encoded === undefined) return target;
  if (target === null || typeof target !== 'object') return decode(encoded);
  if (ArrayBuffer.isView(target) && !(target instanceof DataView)) {
    const saved = encoded as EncodedTypedArray;
    if ((target as unknown as { length: number }).length !== saved.data.length) return decode(encoded);
    (target as unknown as { set(values: ArrayLike<number>): void }).set(saved.data);
    return target;
  }
  if (Array.isArray(target)) {
    const source = decode(encoded) as unknown[];
    target.splice(0, target.length, ...source);
    return target;
  }
  const record = target as Record<string, unknown>;
  const source = encoded as Record<string, Encoded>;
  for (const key of Object.keys(source)) {
    const current = record[key];
    if (current !== null && typeof current === 'object') record[key] = restore(current, source[key]);
    else record[key] = decode(source[key]!);
  }
  return target;
}

function decode(encoded: Encoded): unknown {
  if (encoded === null || typeof encoded !== 'object') return encoded;
  if (Array.isArray(encoded)) return encoded.map((item) => decode(item));
  if ('typed' in encoded && 'data' in encoded) {
    const saved = encoded as EncodedTypedArray;
    const data = saved.data;
    switch (saved.typed) {
      case 'Int8Array': return Int8Array.from(data);
      case 'Uint8Array': return Uint8Array.from(data);
      case 'Int16Array': return Int16Array.from(data);
      case 'Uint16Array': return Uint16Array.from(data);
      case 'Int32Array': return Int32Array.from(data);
      case 'Uint32Array': return Uint32Array.from(data);
      case 'Float32Array': return Float32Array.from(data);
      case 'Float64Array': return Float64Array.from(data);
      default: throw new Error(`unsupported typed array ${saved.typed}`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(encoded)) out[key] = decode(value);
  return out;
}

function seal(payload: object): string {
  const body = JSON.stringify(payload);
  return JSON.stringify({ ...payload, checksum: checksum(body) });
}

function parseAndVerify(text: string): RecipeSave | SnapshotSave {
  const parsed = JSON.parse(text) as RecipeSave | SnapshotSave;
  if (parsed.schema !== SAVE_SCHEMA) throw new Error(`unsupported save schema ${String(parsed.schema)}`);
  if (parsed.engine !== ENGINE_SCHEMA) throw new Error(`unsupported engine schema '${String(parsed.engine)}'`);
  const { checksum: got, ...payload } = parsed;
  const want = checksum(JSON.stringify(payload));
  if (got !== want) throw new Error(`save checksum mismatch: expected ${want}, got ${got}`);
  return parsed;
}

function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
