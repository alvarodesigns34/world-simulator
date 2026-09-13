/**
 * Deterministic physical infrastructure routing.
 *
 * The economic graph stays sparse and is solved by local arbitrage.  This
 * module materialises each land edge as a cached route on the hydrology grid;
 * it is only called when topology changes, never per commodity or trade tick.
 */

import { DIR, cubeDim, cubeIndex, neighbor } from '@ws/data';
import type { HydrologyState } from '../hydrology/system.js';

const DIRS = [DIR.POS_U, DIR.NEG_U, DIR.POS_V, DIR.NEG_V] as const;
/* Routing is a topology-time operation, but a rebuild can ask for dozens of
   corridors. Cache the four-way cube-sphere stencil once per level so a route
   search does not allocate a short JS array for every visited cell. */
const neighbourTables = new Map<number, Int32Array>();

export interface PhysicalRoute {
  readonly cells: Int32Array;
  readonly bridgeCells: Int32Array;
  readonly portA: number;
  readonly portB: number;
  readonly distanceM: number;
  readonly maxGradient: number;
}

/**
 * The nearest coastal outlet a settlement can reach OVER LAND.
 *
 * HONESTY (T-0105). This used to be called `findNavigablePort`, which claimed
 * more than it delivered twice over: the search is a breadth-first walk across
 * land, so it finds a coast, not a harbour, and finding a coast for two
 * settlements says nothing about whether a ship can sail between them. Two
 * towns on opposite shores of a landlocked inland sea both have an outlet and
 * no sea route at all. The name now says what the function does, and
 * `oceanBasinLabels` answers the question the old name was pretending to.
 */
export function findCoastalOutlet(h: HydrologyState, origin: number): number {
  if (origin < 0 || origin >= h.cellCount || h.ocean[origin] !== 0) return -1;
  const queue = new Int32Array(h.cellCount);
  const seen = new Uint8Array(h.cellCount);
  let head = 0;
  let tail = 0;
  queue[tail++] = origin;
  seen[origin] = 1;
  while (head < tail) {
    const cell = queue[head++] as number;
    if (isCoastalLand(h, cell)) return cell;
    for (const next of neighbours(cell, h.level)) {
      if (seen[next] !== 0 || h.ocean[next] !== 0) continue;
      seen[next] = 1;
      queue[tail++] = next;
    }
  }
  return -1;
}

export function routeLandInfrastructure(
  h: HydrologyState,
  start: number,
  goal: number,
): PhysicalRoute {
  if (h.ocean[start] !== 0 || h.ocean[goal] !== 0) {
    throw new Error('land infrastructure endpoints must be on land');
  }
  const count = h.cellCount;
  const came = new Int32Array(count).fill(-1);
  const cost = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  const closed = new Uint8Array(count);
  const heap = new RouteHeap();
  const stepM = Math.sqrt(meanCellArea(h));
  cost[start] = 0;
  heap.push(start, 0);

  while (heap.size > 0) {
    const cell = heap.pop();
    if (closed[cell] !== 0) continue;
    closed[cell] = 1;
    if (cell === goal) break;
    for (const next of neighbours(cell, h.level)) {
      if (closed[next] !== 0 || h.ocean[next] !== 0) continue;
      const dh = Math.abs((h.elevationM[next] as number) - (h.elevationM[cell] as number));
      const gradient = dh / stepM;
      /* Grades above 45% are impassable at this aggregate resolution. */
      if (gradient > 0.45) continue;
      const altitude = Math.max(0, h.elevationM[next] as number);
      const river = (h.dischargeM3s[next] as number) > 250 ? 0.45 : 0;
      const mountain = Math.max(0, altitude - 1800) / 1800;
      const stepCost = stepM * (1 + 28 * gradient * gradient + mountain * mountain * 5 + river);
      const candidate = (cost[cell] as number) + stepCost;
      if (candidate < (cost[next] as number) ||
          (candidate === (cost[next] as number) && cell < (came[next] as number))) {
        cost[next] = candidate;
        came[next] = cell;
        heap.push(next, candidate);
      }
    }
  }
  if (start !== goal && (came[goal] as number) < 0) {
    return { cells: Int32Array.from([start]), bridgeCells: new Int32Array(0), portA: -1, portB: -1,
      distanceM: stepM, maxGradient: 1 };
  }
  const reversed: number[] = [];
  for (let cell = goal; cell >= 0; cell = came[cell] as number) {
    reversed.push(cell);
    if (cell === start) break;
  }
  reversed.reverse();
  const bridges: number[] = [];
  let maxGradient = 0;
  for (let i = 1; i < reversed.length; i++) {
    const a = reversed[i - 1] as number;
    const b = reversed[i] as number;
    maxGradient = Math.max(maxGradient,
      Math.abs((h.elevationM[b] as number) - (h.elevationM[a] as number)) / stepM);
    if ((h.dischargeM3s[b] as number) > 250) bridges.push(b);
  }
  return {
    cells: Int32Array.from(reversed),
    bridgeCells: Int32Array.from(bridges),
    portA: -1,
    portB: -1,
    distanceM: Math.max(stepM, stepM * Math.max(1, reversed.length - 1)),
    maxGradient,
  };
}

/**
 * A sea link between two coastal outlets.
 *
 * WHAT `distanceM` IS. A great-circle separation, which is a LOWER BOUND on
 * the sailed distance: no cape is rounded, no strait is threaded, no continent
 * is gone around. That is a deliberate reduction — detailed global sea
 * navigation is not in scope — but it must be named, because a route this
 * cheap makes sea carriage look better than it is around an obstructed coast.
 *
 * WHAT IT NOW REQUIRES. The caller must have established that the two outlets
 * touch the SAME body of water (`portsShareOcean`). Before that check existed,
 * two towns on opposite sides of a landlocked sea were given a sea lane with a
 * great-circle distance, and goods moved along a route no ship could take.
 */
export function seaRoute(h: HydrologyState, portA: number, portB: number, distanceM: number): PhysicalRoute {
  if (!isCoastalLand(h, portA) || !isCoastalLand(h, portB)) {
    throw new Error('sea route requires coastal land outlets at both ends');
  }
  return { cells: Int32Array.from([portA, portB]), bridgeCells: new Int32Array(0),
    portA, portB, distanceM, maxGradient: 0 };
}

/**
 * Connected components of water, one label per cell, -1 on land.
 *
 * A flood fill over the ocean mask. O(cells) and computed once per topology
 * rebuild, which is what makes a real navigability test affordable — the
 * alternative, a path search per settlement pair, is the global pathfinding
 * DEC forbids.
 *
 * Deterministic: cells are visited in ascending index order, so component ids
 * are assigned in the same order on every run of the same world.
 */
export function oceanBasinLabels(h: HydrologyState): Int32Array {
  const labels = new Int32Array(h.cellCount).fill(-1);
  const queue = new Int32Array(h.cellCount);
  let next = 0;
  for (let seed = 0; seed < h.cellCount; seed++) {
    if (h.ocean[seed] === 0 || labels[seed] !== -1) continue;
    const label = next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    labels[seed] = label;
    while (head < tail) {
      const cell = queue[head++] as number;
      for (const nb of neighbours(cell, h.level)) {
        if (h.ocean[nb] === 0 || labels[nb] !== -1) continue;
        labels[nb] = label;
        queue[tail++] = nb;
      }
    }
  }
  return labels;
}

/**
 * Can a ship get from one coastal outlet to the other at all?
 *
 * True when the two outlets touch a common body of water. It does not claim
 * the crossing is short, safe or ice-free — only that it exists. Ruling out
 * the impossible is cheap; ruling in the optimal is the search we do not do.
 */
export function portsShareOcean(
  h: HydrologyState, labels: Int32Array, portA: number, portB: number,
): boolean {
  if (portA === portB) return true;
  const a = adjacentBasins(h, labels, portA);
  if (a.length === 0) return false;
  for (const label of adjacentBasins(h, labels, portB)) {
    if (a.includes(label)) return true;
  }
  return false;
}

function adjacentBasins(h: HydrologyState, labels: Int32Array, cell: number): number[] {
  if (cell < 0 || cell >= h.cellCount) return [];
  const out: number[] = [];
  for (const nb of neighbours(cell, h.level)) {
    const label = labels[nb] as number;
    if (label >= 0 && !out.includes(label)) out.push(label);
  }
  return out;
}

export function isCoastalLand(h: HydrologyState, cell: number): boolean {
  if (cell < 0 || cell >= h.cellCount || h.ocean[cell] !== 0) return false;
  for (const next of neighbours(cell, h.level)) if (h.ocean[next] !== 0) return true;
  return false;
}

function neighbours(cell: number, level: number): Int32Array {
  let table = neighbourTables.get(level);
  if (table === undefined) {
    const n = cubeDim(level);
    table = new Int32Array(6 * n * n * DIRS.length);
    for (let i = 0; i < 6 * n * n; i++) {
      const face = Math.floor(i / (n * n));
      const local = i - face * n * n;
      const y = Math.floor(local / n);
      const x = local - y * n;
      const ids: number[] = [];
      for (const d of DIRS) {
        const p = neighbor({ face, x, y }, level, d);
        ids.push(cubeIndex(p.face, level, p.x, p.y));
      }
      ids.sort((a, b) => a - b);
      table.set(ids, i * DIRS.length);
    }
    neighbourTables.set(level, table);
  }
  return table.subarray(cell * DIRS.length, cell * DIRS.length + DIRS.length);
}

function meanCellArea(h: HydrologyState): number {
  let area = 0;
  for (let i = 0; i < h.areaM2.length; i++) area += h.areaM2[i] as number;
  return area / h.areaM2.length;
}

class RouteHeap {
  private readonly ids: number[] = [];
  private readonly keys: number[] = [];
  size = 0;
  push(id: number, key: number): void {
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const pk = this.keys[p] as number;
      const pi = this.ids[p] as number;
      if (pk < key || (pk === key && pi <= id)) break;
      this.ids[i] = pi; this.keys[i] = pk; i = p;
    }
    this.ids[i] = id; this.keys[i] = key;
  }
  pop(): number {
    const root = this.ids[0] as number;
    const last = --this.size;
    if (last <= 0) return root;
    const id = this.ids[last] as number;
    const key = this.keys[last] as number;
    let i = 0;
    while (true) {
      let child = i * 2 + 1;
      if (child >= last) break;
      if (child + 1 < last) {
        const lk = this.keys[child] as number;
        const rk = this.keys[child + 1] as number;
        const li = this.ids[child] as number;
        const ri = this.ids[child + 1] as number;
        if (rk < lk || (rk === lk && ri < li)) child++;
      }
      const ck = this.keys[child] as number;
      const ci = this.ids[child] as number;
      if (ck > key || (ck === key && ci >= id)) break;
      this.ids[i] = ci; this.keys[i] = ck; i = child;
    }
    this.ids[i] = id; this.keys[i] = key;
    return root;
  }
}
