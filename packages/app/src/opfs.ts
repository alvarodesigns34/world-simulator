/**
 * OPFS tile persistence (M2). Browser-only; `sim` talks to this through
 * `TileStorage`. A missing OPFS falls back to the memory store the world
 * already constructed.
 */

import { MemoryTileStore, type TileRecord, type TileStorage } from '@ws/sim';

export async function openOpfsTileStore(ns = 'ws-tiles-v1'): Promise<TileStorage> {
  const g = globalThis as { navigator?: { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } } };
  if (typeof g.navigator?.storage?.getDirectory !== 'function') return new MemoryTileStore();
  try {
    const root = await g.navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(ns, { create: true });
    return new OpfsTileStore(dir);
  } catch {
    return new MemoryTileStore();
  }
}

class OpfsTileStore implements TileStorage {
  private readonly mem = new MemoryTileStore();
  constructor(private readonly dir: FileSystemDirectoryHandle) {}

  get(id: string): TileRecord | undefined {
    return this.mem.get(id);
  }

  set(tile: TileRecord): void {
    this.mem.set(tile);
    void this.persist(tile);
  }

  delete(id: string): void {
    this.mem.delete(id);
    void this.dir.removeEntry(safeName(id)).catch(() => undefined);
  }

  get size(): number {
    return this.mem.size;
  }

  private async persist(tile: TileRecord): Promise<void> {
    const handle = await this.dir.getFileHandle(safeName(tile.id), { create: true });
    const w = await handle.createWritable();
    const src = new Uint8Array(tile.elevation.buffer, tile.elevation.byteOffset, tile.elevation.byteLength);
    const copy = new Uint8Array(src.byteLength);
    copy.set(src);
    await w.write(copy);
    await w.close();
  }
}

function safeName(id: string): string {
  return id.replace(/[^0-9a-z/]/gi, '_').replace(/\//g, '_');
}
