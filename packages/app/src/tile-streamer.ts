/** Browser-worker terrain streaming. Workers calculate; this main-thread
 * coordinator publishes completed tiles into TileCache in request-id order. */

import type { Seed } from '@ws/core';
import { quadkey, type QuadKey } from '@ws/data';
import {
  AUTH_TILE_MAX,
  AUTH_TILE_MIN,
  ancestorAt,
  tileId,
  type GeologyState,
  type TileCache,
  type TileRecord,
} from '@ws/sim';

interface Work { id: number; key: QuadKey; generation: number }
interface Slot { worker: Worker; busy: Work | undefined }

export class TileStreamer {
  private readonly slots: Slot[] = [];
  private readonly queue: Work[] = [];
  private readonly queued = new Set<string>();
  private readonly visible = new Set<string>();
  private nextId = 0;
  private commitId = 0;
  private readonly completed = new Map<number, TileRecord>();
  private readonly cancelledIds = new Set<number>();
  private generation = 0;

  constructor(
    private readonly cache: TileCache,
    private readonly geology: GeologyState,
    private readonly seed: Seed,
    private seaLevel: number,
    workerCount = 2,
  ) {
    for (let i = 0; i < workerCount; i++) this.slots.push(this.makeSlot());
  }

  beginFrame(geologyGeneration: number, seaLevel: number): void {
    this.visible.clear();
    if (geologyGeneration !== this.generation || Math.abs(seaLevel - this.seaLevel) > 1e-6) {
      this.generation = geologyGeneration;
      this.seaLevel = seaLevel;
      this.cache.invalidateAll();
      this.queue.length = 0;
      this.queued.clear();
      this.completed.clear();
      this.cancelledIds.clear();
      this.commitId = this.nextId;
      for (let i = 0; i < this.slots.length; i++) {
        this.slots[i]!.worker.terminate();
        this.slots[i] = this.makeSlot();
      }
    }
  }

  request(key: QuadKey): TileRecord | undefined {
    if (key.level < AUTH_TILE_MIN) return undefined;
    this.visible.add(tileId(key));
    if (!this.cache.lookup(key, false)) {
      const chain: QuadKey[] = [];
      for (let l = AUTH_TILE_MIN; l <= Math.min(key.level, AUTH_TILE_MAX); l++) chain.push(ancestorAt(key, l));
      if (key.level < AUTH_TILE_MAX) chain.push(...quadkey.children(key));
      chain.sort((a, b) => a.level - b.level || a.face - b.face || a.y - b.y || a.x - b.x);
      for (const k of chain) this.enqueue(k);
      this.pump();
    }
    return this.cache.lookup(key, true);
  }

  endFrame(): void {
    /* Drop queued work that has neither a visible descendant nor ancestor.
       Running tiles are small; camera abandonment is bounded by one tile bake. */
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const work = this.queue[i] as Work;
      if (!this.relatedToVisible(work.key)) {
        this.queue.splice(i, 1);
        this.queued.delete(tileId(work.key));
        this.cancelledIds.add(work.id);
      }
    }
  }

  dispose(): void { for (const slot of this.slots) slot.worker.terminate(); }

  private enqueue(key: QuadKey): void {
    const id = tileId(key);
    if (this.queued.has(id) || this.cache.lookup(key, false)) return;
    this.queued.add(id);
    this.queue.push({ id: this.nextId++, key, generation: this.generation });
  }

  private makeSlot(): Slot {
    const worker = new Worker(new URL('./tile-worker.ts', import.meta.url), { type: 'module' });
    const slot: Slot = { worker, busy: undefined };
    worker.postMessage({ kind: 'init', geology: this.geology, seed: this.seed,
      seaLevel: this.seaLevel, generation: this.generation });
    worker.onmessage = (event: MessageEvent<{ kind: 'tile'; id: number; generation: number; tile: TileRecord }>) => {
      const msg = event.data;
      if (msg.generation === this.generation) this.completed.set(msg.id, msg.tile);
      if (slot.busy) this.queued.delete(tileId(slot.busy.key));
      slot.busy = undefined;
      this.commitCompleted();
      this.pump();
    };
    return slot;
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.busy || this.queue.length === 0) continue;
      const work = this.queue.shift() as Work;
      slot.busy = work;
      slot.worker.postMessage({ kind: 'bake', ...work });
    }
  }

  private commitCompleted(): void {
    /* Publication is request-id ordered, never worker completion ordered. */
    for (;;) {
      if (this.cancelledIds.delete(this.commitId)) { this.commitId++; continue; }
      if (!this.completed.has(this.commitId)) break;
      this.cache.put(this.completed.get(this.commitId) as TileRecord);
      this.completed.delete(this.commitId++);
    }
  }

  private relatedToVisible(key: QuadKey): boolean {
    for (const id of this.visible) {
      const [faceS, levelS, xS, yS] = id.split('/');
      const face = Number(faceS); const level = Number(levelS);
      if (face !== key.face) continue;
      if (level >= key.level) {
        const shift = level - key.level;
        if ((Number(xS) >> shift) === key.x && (Number(yS) >> shift) === key.y) return true;
      } else {
        const shift = key.level - level;
        if ((key.x >> shift) === Number(xS) && (key.y >> shift) === Number(yS)) return true;
      }
    }
    return false;
  }
}

export function sampleStreamedTile(tile: TileRecord, key: QuadKey, cornerX: 0 | 1, cornerY: 0 | 1): number {
  const scale = 2 ** (key.level - tile.level);
  const relX = (key.x - tile.x * scale + cornerX) / scale;
  const relY = (key.y - tile.y * scale + cornerY) / scale;
  const x = Math.max(0, Math.min(tile.size - 1, Math.round(relX * (tile.size - 1))));
  const y = Math.max(0, Math.min(tile.size - 1, Math.round(relY * (tile.size - 1))));
  return tile.elevation[y * tile.size + x] as number;
}
