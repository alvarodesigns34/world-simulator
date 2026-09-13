/** M11 bounded, multiresolution recorded history. Past plots read this store. */

import type { SimTime } from '@ws/core';

export interface HistorySeriesDescriptor {
  readonly id: string;
  readonly label: string;
  readonly units: string;
}

export interface HistorySample {
  readonly time: SimTime;
  readonly value: number;
  readonly span: number;
}

export interface HistoryEvent {
  readonly id: number;
  readonly time: SimTime;
  readonly kind: 'civilisation' | 'city' | 'geology' | 'economy' | 'timeline';
  readonly label: string;
  readonly importance: number;
  readonly refs?: readonly number[];
}

export interface TimelineBookmark {
  readonly id: number;
  readonly time: SimTime;
  readonly label: string;
}

interface SeriesState {
  readonly descriptor: HistorySeriesDescriptor;
  readonly levels: HistorySample[][];
}

export interface HistorySnapshot {
  readonly schema: 1;
  readonly series: readonly { descriptor: HistorySeriesDescriptor; levels: readonly (readonly HistorySample[])[] }[];
  readonly events: readonly HistoryEvent[];
  readonly bookmarks: readonly TimelineBookmark[];
  readonly nextEventId: number;
  readonly nextBookmarkId: number;
}

export class HistoryStore {
  private readonly series = new Map<string, SeriesState>();
  private readonly eventList: HistoryEvent[] = [];
  private readonly bookmarkList: TimelineBookmark[] = [];
  private nextEventId = 1;
  private nextBookmarkId = 1;

  constructor(
    descriptors: readonly HistorySeriesDescriptor[],
    readonly samplesPerLevel = 1024,
    readonly maxLevels = 8,
    readonly maxEvents = 4096,
  ) {
    for (const descriptor of descriptors) {
      if (this.series.has(descriptor.id)) throw new Error(`history series '${descriptor.id}' declared twice`);
      this.series.set(descriptor.id, { descriptor, levels: [[]] });
    }
  }

  descriptors(): readonly HistorySeriesDescriptor[] {
    return [...this.series.values()].map((s) => s.descriptor)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  record(time: SimTime, values: Readonly<Record<string, number>>): void {
    const ids = Object.keys(values).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const id of ids) {
      const state = this.series.get(id);
      if (state === undefined) throw new Error(`unknown history series '${id}'`);
      const value = values[id] as number;
      if (!Number.isFinite(value)) throw new Error(`history '${id}' received non-finite value`);
      state.levels[0]!.push({ time: { ...time }, value, span: 1 });
      this.compact(state, 0);
    }
  }

  samples(id: string): readonly HistorySample[] {
    const state = this.series.get(id);
    if (state === undefined) throw new Error(`unknown history series '${id}'`);
    const out: HistorySample[] = [];
    for (const level of state.levels) out.push(...level);
    out.sort((a, b) => a.time.year !== b.time.year ? a.time.year - b.time.year : a.time.seconds - b.time.seconds);
    return out;
  }

  addEvent(time: SimTime, kind: HistoryEvent['kind'], label: string, importance = 0.5, refs?: readonly number[]): HistoryEvent {
    const event: HistoryEvent = { id: this.nextEventId++, time: { ...time }, kind, label,
      importance: Math.max(0, Math.min(1, importance)), ...(refs === undefined ? {} : { refs: [...refs] }) };
    this.eventList.push(event);
    if (this.eventList.length > this.maxEvents) {
      /* Preserve important old events while thinning routine markers. */
      const removable = this.eventList.findIndex((e, i) => i % 2 === 0 && e.importance < 0.8);
      this.eventList.splice(removable >= 0 ? removable : 0, 1);
    }
    return event;
  }

  events(): readonly HistoryEvent[] { return this.eventList; }

  bookmark(time: SimTime, label: string): TimelineBookmark {
    const mark = { id: this.nextBookmarkId++, time: { ...time }, label };
    this.bookmarkList.push(mark);
    return mark;
  }

  bookmarks(): readonly TimelineBookmark[] { return this.bookmarkList; }

  snapshot(): HistorySnapshot {
    return {
      schema: 1,
      series: this.descriptors().map((descriptor) => {
        const state = this.series.get(descriptor.id)!;
        return { descriptor, levels: state.levels.map((level) => level.map((sample) => ({ ...sample, time: { ...sample.time } }))) };
      }),
      events: this.eventList.map((event) => ({ ...event, time: { ...event.time } })),
      bookmarks: this.bookmarkList.map((mark) => ({ ...mark, time: { ...mark.time } })),
      nextEventId: this.nextEventId,
      nextBookmarkId: this.nextBookmarkId,
    };
  }

  restore(snapshot: HistorySnapshot): void {
    if (snapshot.schema !== 1) throw new Error(`unsupported history schema ${String(snapshot.schema)}`);
    for (const saved of snapshot.series) {
      const state = this.series.get(saved.descriptor.id);
      if (state === undefined) throw new Error(`snapshot contains unknown history series '${saved.descriptor.id}'`);
      state.levels.length = 0;
      for (const level of saved.levels) state.levels.push(level.map((sample) => ({ ...sample, time: { ...sample.time } })));
    }
    this.eventList.splice(0, this.eventList.length, ...snapshot.events.map((event) => ({ ...event, time: { ...event.time } })));
    this.bookmarkList.splice(0, this.bookmarkList.length, ...snapshot.bookmarks.map((mark) => ({ ...mark, time: { ...mark.time } })));
    this.nextEventId = snapshot.nextEventId;
    this.nextBookmarkId = snapshot.nextBookmarkId;
  }

  private compact(state: SeriesState, level: number): void {
    const bucket = state.levels[level]!;
    if (bucket.length <= this.samplesPerLevel) return;
    const a = bucket.shift()!;
    const b = bucket.shift()!;
    if (level + 1 >= this.maxLevels) return;
    if (state.levels[level + 1] === undefined) state.levels[level + 1] = [];
    const span = a.span + b.span;
    state.levels[level + 1]!.push({
      time: { ...b.time },
      value: (a.value * a.span + b.value * b.span) / span,
      span,
    });
    this.compact(state, level + 1);
  }
}

export const WORLD_HISTORY_SERIES: readonly HistorySeriesDescriptor[] = [
  { id: 'population', label: 'Population', units: 'people' },
  { id: 'settlements', label: 'Settlements', units: 'count' },
  { id: 'cities', label: 'Cities', units: 'count' },
  { id: 'temperature', label: 'Global temperature', units: 'K' },
  { id: 'seaLevel', label: 'Sea level', units: 'm' },
  { id: 'ice', label: 'Ice fraction', units: 'fraction' },
  { id: 'biomass', label: 'Mean biomass', units: 'kg/m²' },
  { id: 'trade', label: 'Trade volume', units: 'relative/year' },
  { id: 'production', label: 'Production', units: 'relative/year' },
  { id: 'pollution', label: 'Mean pollution', units: 'relative' },
];
