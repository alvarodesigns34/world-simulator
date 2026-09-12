import { bakeTile, type GeologyState } from '@ws/sim';
import type { Seed } from '@ws/core';
import type { QuadKey } from '@ws/data';

type Input =
  | { kind: 'init'; geology: GeologyState; seed: Seed; seaLevel: number; generation: number }
  | { kind: 'bake'; id: number; key: QuadKey; generation: number };

let geology: GeologyState | undefined;
let seed: Seed | undefined;
let seaLevel = 0;
let generation = 0;

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Input>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

scope.onmessage = (event): void => {
  const msg = event.data;
  if (msg.kind === 'init') {
    geology = msg.geology;
    seed = msg.seed;
    seaLevel = msg.seaLevel;
    generation = msg.generation;
    return;
  }
  if (!geology || !seed || msg.generation !== generation) return;
  const tile = bakeTile({ geology, seed, seaLevel, key: msg.key });
  scope.postMessage({ kind: 'tile', id: msg.id, generation, tile }, [tile.elevation.buffer]);
};

export {};
