/**
 * @tier A
 *
 * M10 transport network and infrastructure.
 *
 * NO GLOBAL PATHFINDING. The brief forbids a naive global Dijkstra and it is
 * right to: routing every commodity between every pair of a thousand
 * settlements, every tick, is O(N^2 log N) of work to answer a question the
 * economy does not actually ask.
 *
 * What a market does instead is LOCAL ARBITRAGE. Goods move along an edge when
 * the price at the far end exceeds the price here by more than the cost of
 * carrying them. Iterate that over the edges and prices converge to a spatial
 * equilibrium — the same equilibrium a global optimiser would find, reached the
 * way real markets reach it, at O(edges) per tick with no path ever computed.
 * Distant trade emerges as a chain of local exchanges, which is also how it
 * historically worked.
 *
 * Paths ARE computed for one thing: deciding where to build a road. That is a
 * topology question, it changes only when the settlement set or terrain routing
 * generation changes, and it is answered by cached terrain-aware corridors over
 * the sparse neighbour graph plus a bounded coastal backbone — not per tick, and
 * not per commodity. The economic graph is deliberately not described as an
 * MST: its local links and sea backbone are physical candidates, while
 * investment decides which modes are built.
 */

import { CIV, type CivilisationState } from '../civilisation/system.js';
import type { HydrologyState } from '../hydrology/system.js';
import { acos, tan } from '@ws/core';
import { DIR, cubeDim, cubeIndex, neighbor } from '@ws/data';
import { findCoastalOutlet, oceanBasinLabels, portsShareOcean, routeLandInfrastructure, seaRoute, type PhysicalRoute } from './routing.js';

const DIRS = [DIR.POS_U, DIR.NEG_U, DIR.POS_V, DIR.NEG_V] as const;

/** How goods move. Each mode has a different cost, capacity and prerequisite. */
export const MODE = { TRACK: 0, ROAD: 1, RIVER: 2, SEA: 3, RAIL: 4 } as const;
export type ModeId = (typeof MODE)[keyof typeof MODE];

export const MODE_NAMES: readonly string[] = ['track', 'road', 'river', 'sea', 'rail'];

/**
 * Cost to move one unit one metre, and the technology at which the mode
 * becomes available. Water has always been cheap; that is why every old city
 * is on a river or a coast, and the numbers have to say so.
 */
const MODE_COST_PER_M: readonly number[] = [
  1.1e-6,  // track: pack animals over unimproved ground
  3.0e-7,  // road: metalled surface and carts
  5.0e-8,  // river: a barge is an order of magnitude cheaper than a cart
  3.0e-8,  // sea
  2.5e-8,  // rail
];

/**
 * CALIBRATION. These are absolute costs per unit-metre for a commodity of unit
 * bulk, and they have to be commensurate with the price scale (0.1 .. 12) or
 * trade cannot happen at all.
 *
 * A 500 km link costs, for a unit-bulk good: 0.55 by track, 0.15 by road,
 * 0.025 by river, 0.015 by sea. Against a typical price near 1, that makes
 * overland carriage a real tax and water carriage nearly free — which is the
 * historically important fact, and is why every old trading city is on a river
 * or a coast.
 *
 * The first version was ~7x higher, putting a 500 km cart journey at 4.0
 * against goods worth ~1. That is not "expensive", it is prohibitive: no pair
 * of prices in the model's own bounded range could ever justify a shipment, so
 * total trade over a thousand simulated years was exactly zero and the whole
 * network was decorative. The relative ordering between modes was right; the
 * absolute scale was not commensurate with anything.
 */

const MODE_TECH: readonly number[] = [0, 0.15, 0, 0.25, 0.62];

/** Throughput per year, relative. Rail and sea move bulk; a track does not. */
const MODE_CAPACITY: readonly number[] = [1, 6, 20, 60, 90];

export interface TransportEdge {
  readonly a: number;
  readonly b: number;
  readonly distanceM: number;
  mode: ModeId;
  /** 0..1 build-out of the best mode available on this link. */
  quality: number;
  /** Cached: cost per unit to traverse, given mode and quality. */
  unitCost: number;
  capacity: number;
  /** Cached physical corridor. Economic flow never recomputes it. */
  readonly route: PhysicalRoute;
}

export interface TransportNetwork {
  /** Settlement indices that are nodes, ascending. */
  nodes: Int32Array;
  /** Node position in `nodes` for a settlement index, or -1. */
  nodeOf: Int32Array;
  edges: TransportEdge[];
  /** Adjacency: for each node, the edge indices touching it. */
  adjacency: Int32Array[];
  /** Bumped when the topology changes, so consumers can invalidate. */
  topologyGeneration: number;
  /** Derived corridor cache, keyed by endpoint cells and mode. */
  readonly routeCache: Map<string, PhysicalRoute>;
  /** Diagnostics. */
  roadKm: number;
  railKm: number;
  seaKm: number;
}

export function initNetwork(capacity: number): TransportNetwork {
  return {
    nodes: new Int32Array(0),
    nodeOf: new Int32Array(capacity).fill(-1),
    edges: [],
    adjacency: [],
    topologyGeneration: 0,
    routeCache: new Map(),
    roadKm: 0, railKm: 0, seaKm: 0,
  };
}

function edgeKey(storeA: number, storeB: number, coastal: boolean): string {
  const lo = storeA < storeB ? storeA : storeB;
  const hi = storeA < storeB ? storeB : storeA;
  return `${String(lo)}:${String(hi)}:${coastal ? '1' : '0'}`;
}

function applyEdgeEconomics(edge: TransportEdge): void {
  const base = MODE_COST_PER_M[edge.mode] as number;
  const trackCost = MODE_COST_PER_M[MODE.TRACK] as number;
  const effective = base + (trackCost - base) * (1 - edge.quality) * (edge.mode === MODE.SEA ? 0 : 1);
  edge.unitCost = edge.distanceM * effective;
  edge.capacity = (MODE_CAPACITY[edge.mode] as number) * (0.25 + 0.75 * edge.quality);
}

/**
 * Rebuild the topology from the current settlement set.
 *
 * Called when settlements are founded or collapse, not every tick. Two kinds of
 * link, both cheap to find and both real:
 *
 *   - NEIGHBOUR links, from territories that touch. One pass over the claim
 *     raster finds every adjacent pair, O(cells), with no distance search.
 *   - COASTAL links, between settlements that both reach the sea. Sea trade
 *     does not care about who is adjacent to whom, which is exactly what made
 *     maritime powers different from land ones.
 */
export function rebuildTopology(
  net: TransportNetwork,
  civ: CivilisationState,
  h: HydrologyState,
): void {
  const store = civ.store;
  const cellCol = store.column(CIV.cell);

  /* T-0139. Infrastructure is hysteretic: a road built stays built. The
     previous rebuild started every edge at TRACK/quality 0, so a village
     founding (topologyVersion++) wiped the rail network. Key by SETTLEMENT
     index, not node index — founding shifts node numbers. */
  const prev = new Map<string, { mode: ModeId; quality: number }>();
  for (const e of net.edges) {
    const sa = net.nodes[e.a] as number;
    const sb = net.nodes[e.b] as number;
    prev.set(edgeKey(sa, sb, e.mode === MODE.SEA), { mode: e.mode, quality: e.quality });
  }

  const nodes: number[] = [];
  net.nodeOf.fill(-1);
  for (let i = 0; i < store.bound; i++) {
    if (!store.aliveAt(i)) continue;
    if ((cellCol[i] as number) < 0) continue;
    net.nodeOf[i] = nodes.length;
    nodes.push(i);
  }
  net.nodes = Int32Array.from(nodes);
  net.edges = [];
  net.adjacency = nodes.map(() => new Int32Array(0));
  if (nodes.length === 0) { net.topologyGeneration++; return; }

  const n = cubeDim(civ.level);
  const seen = new Set<number>();
  const adjacency: number[][] = nodes.map(() => []);
  const portsBySettlement = new Map<number, number>();
  /* One flood fill per topology rebuild answers every navigability question
     below. Without it, two towns on opposite shores of a landlocked sea were
     given a sea lane and goods moved along a route no ship could take. */
  let basins: Int32Array | null = null;
  const portFor = (settlement: number): number => {
    const hit = portsBySettlement.get(settlement);
    if (hit !== undefined) return hit;
    const port = findCoastalOutlet(h, cellCol[settlement] as number);
    portsBySettlement.set(settlement, port);
    return port;
  };

  const link = (ai: number, bi: number, coastal: boolean): void => {
    const a = net.nodeOf[ai] as number;
    const b = net.nodeOf[bi] as number;
    if (a < 0 || b < 0 || a === b) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    /* Pair key packs two node indices; nodes are bounded by the store's
       capacity, so this cannot collide. */
    const key = lo * 1e7 + hi + (coastal ? 5e13 : 0);
    if (seen.has(key)) return;
    seen.add(key);
    const start = cellCol[ai] as number;
    const goal = cellCol[bi] as number;
    let distanceM: number;
    let route: PhysicalRoute;
    if (coastal) {
      const portA = portFor(ai);
      const portB = portFor(bi);
      /* Two inland centres can share the same coastal outlet. That is one
         port, not a zero-length sea lane between two fictional ports. */
      if (portA < 0 || portB < 0 || portA === portB) return;
      basins ??= oceanBasinLabels(h);
      /* Both ends have a coast. That is not the same as a sea route between
         them existing (T-0105). */
      if (!portsShareOcean(h, basins, portA, portB)) return;
      distanceM = greatCircleBetween(portA, portB, civ.level);
      const routeKey = `sea:${String(Math.min(portA, portB))}:${String(Math.max(portA, portB))}`;
      route = net.routeCache.get(routeKey) ?? seaRoute(h, portA, portB, distanceM);
      net.routeCache.set(routeKey, route);
    } else {
      const routeKey = `land:${String(Math.min(start, goal))}:${String(Math.max(start, goal))}`;
      route = net.routeCache.get(routeKey) ?? routeLandInfrastructure(h, start, goal);
      net.routeCache.set(routeKey, route);
      if ((route.cells[route.cells.length - 1] as number) !== goal) return;
      distanceM = route.distanceM;
    }
    const e: TransportEdge = {
      a: lo, b: hi, distanceM,
      mode: coastal ? MODE.SEA : MODE.TRACK,
      quality: 0,
      unitCost: distanceM * (MODE_COST_PER_M[coastal ? MODE.SEA : MODE.TRACK] as number),
      capacity: MODE_CAPACITY[coastal ? MODE.SEA : MODE.TRACK] as number,
      route,
    };
    const inherited = prev.get(edgeKey(ai, bi, coastal));
    if (inherited !== undefined) {
      e.mode = inherited.mode;
      e.quality = inherited.quality;
      applyEdgeEconomics(e);
    }
    adjacency[lo]!.push(net.edges.length);
    adjacency[hi]!.push(net.edges.length);
    net.edges.push(e);
  };

  /* Neighbour links: one sweep of the claim raster. */
  for (let c = 0; c < civ.cellCount; c++) {
    const owner = civ.claim[c] as number;
    if (owner < 0 || !store.aliveAt(owner)) continue;
    const face = Math.floor(c / (n * n));
    const local = c - face * n * n;
    const y = Math.floor(local / n);
    const x = local - y * n;
    for (const d of DIRS) {
      const nb = neighbor({ face, x, y }, civ.level, d);
      const j = cubeIndex(nb.face, civ.level, nb.x, nb.y);
      const other = civ.claim[j] as number;
      if (other < 0 || other === owner || !store.aliveAt(other)) continue;
      link(owner, other, false);
    }
  }

  /* Coastal links: every port to every other port is O(ports^2), so instead
     each port links to the nearest few by cell index order — a coastline is
     roughly one-dimensional, so index-adjacent ports are usually genuinely
     near, and the arbitrage chain reaches the rest. */
  const ports: number[] = [];
  for (const i of nodes) {
    const c = cellCol[i] as number;
    if (c < 0) continue;
    if (portFor(i) >= 0) ports.push(i);
  }
  for (let k = 0; k + 1 < ports.length; k++) {
    link(ports[k] as number, ports[k + 1] as number, true);
    if (k + 2 < ports.length) link(ports[k] as number, ports[k + 2] as number, true);
  }
  /* Close the ring so the sea network is connected rather than a path. */
  if (ports.length > 2) link(ports[ports.length - 1] as number, ports[0] as number, true);

  net.adjacency = adjacency.map((a) => Int32Array.from(a));
  net.topologyGeneration++;
}

const RADIUS_M = 6_371_000;

function greatCircleBetween(cellA: number, cellB: number, level: number): number {
  const n = cubeDim(level);
  const p = unitOf(cellA, n);
  const q = unitOf(cellB, n);
  const dot = Math.max(-1, Math.min(1, p.x * q.x + p.y * q.y + p.z * q.z));
  return acos(dot) * RADIUS_M;
}

function unitOf(cell: number, n: number): { x: number; y: number; z: number } {
  const face = Math.floor(cell / (n * n));
  const local = cell - face * n * n;
  const y = Math.floor(local / n);
  const x = local - y * n;
  /* Inlined rather than importing cubeFaceToUnitRaw's PCF wrapper: this is
     called once per edge on rebuild, not per tick. */
  const u = (x + 0.5) / n;
  const v = (y + 0.5) / n;
  const a = tan((u - 0.5) * Math.PI / 2);
  const b = tan((v - 0.5) * Math.PI / 2);
  /* DEC-035: POS_Y is (a, 1, −b), not the pre-Ampere (−a, 1, b). */
  let vx: number;
  let vy: number;
  let vz: number;
  switch (face) {
    case 0: vx = 1; vy = a; vz = b; break;
    case 1: vx = -1; vy = -a; vz = b; break;
    case 2: vx = a; vy = 1; vz = -b; break;
    case 3: vx = a; vy = -1; vz = b; break;
    case 4: vx = a; vy = b; vz = 1; break;
    default: vx = a; vy = -b; vz = -1; break;
  }
  const inv = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
  return { x: vx * inv, y: vy * inv, z: vz * inv };
}

/**
 * Upgrade links whose traffic and whose owners' technology justify it.
 *
 * Infrastructure is authoritative state, and it is HYSTERETIC: a road built
 * stays built even if trade falls away, and only decays slowly. That is why
 * old empires leave roads behind, and it stops the network flickering with
 * every price wobble.
 */
export function investInInfrastructure(
  net: TransportNetwork,
  civ: CivilisationState,
  traffic: Float64Array,
  dtYears: number,
): void {
  const tech = civ.store.column(CIV.technology);
  const pop = civ.store.column(CIV.population);
  net.roadKm = 0;
  net.railKm = 0;
  net.seaKm = 0;

  for (let e = 0; e < net.edges.length; e++) {
    const edge = net.edges[e]!;
    const ai = net.nodes[edge.a] as number;
    const bi = net.nodes[edge.b] as number;
    const t = Math.min(tech[ai] as number, tech[bi] as number);
    const scale = Math.min(pop[ai] as number, pop[bi] as number);

    /* The best mode both ends can afford and build. Sea links stay sea. */
    let best: ModeId = edge.mode === MODE.SEA ? MODE.SEA : MODE.TRACK;
    if (edge.mode !== MODE.SEA) {
      for (const m of [MODE.ROAD, MODE.RAIL] as const) {
        if (t >= (MODE_TECH[m] as number) && (m !== MODE.RAIL || edge.route.maxGradient <= 0.08)) best = m;
      }
    }

    /* Investment is proportional to traffic and to how much surplus the
       smaller partner has. A rich pair with no trade builds nothing. */
    const use = (traffic[e] as number) / Math.max(1, edge.capacity);
    const want = Math.min(1, use * 0.6 + Math.min(1, scale / 2e6) * 0.4);
    if (best !== edge.mode && want > 0.25) {
      edge.mode = best;
      edge.quality = 0;
    }
    const rate = Math.min(1, dtYears * 0.01 * (0.2 + t));
    edge.quality += (want - edge.quality) * rate;
    edge.quality = Math.max(0, Math.min(1, edge.quality));

    /* A half-built road is not half a road: cost falls with quality but never
       below the mode's floor, and capacity scales with it. */
    applyEdgeEconomics(edge);

    const km = edge.distanceM / 1000;
    if (edge.mode === MODE.RAIL) net.railKm += km * edge.quality;
    else if (edge.mode === MODE.ROAD) net.roadKm += km * edge.quality;
    else if (edge.mode === MODE.SEA) net.seaKm += km * edge.quality;
  }
}

/** Total built infrastructure, for reporting and for the digest. */
export function networkDigest(net: TransportNetwork): number {
  const mix = (h: number, v: number): number => {
    let x = (h ^ Math.imul(v | 0, 0x9e3779b1)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
    return (x ^ (x >>> 15)) >>> 0;
  };
  let h = mix(0x9e3779b1, net.edges.length);
  h = mix(h, net.topologyGeneration);
  h = mix(h, net.nodes.length);
  for (let i = 0; i < net.nodes.length; i++) h = mix(h, net.nodes[i] as number);
  for (const e of net.edges) {
    h = mix(h, e.a);
    h = mix(h, e.b);
    h = mix(h, e.mode);
    h = mix(h, Math.round(e.quality * 1e6));
    h = mix(h, e.route.cells.length);
    h = mix(h, Math.round(e.route.maxGradient * 1e6));
    for (let i = 0; i < e.route.cells.length; i++) h = mix(h, e.route.cells[i] as number);
  }
  return h >>> 0;
}
