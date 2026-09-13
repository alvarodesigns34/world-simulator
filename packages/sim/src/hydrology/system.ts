/**
 * @tier A
 *
 * M5 global hydrology. The authoritative network is computed on a bounded
 * cube-sphere level and crosses faces through DEC-035's neighbour topology.
 * Priority-Flood supplies an acyclic receiver tree; accumulation is a single
 * topological pass rather than repeated scanning.
 */

import { RADIUS, reducedColumnRainRate, type ClimateState } from '../climate/solver.js';
import type { GeologyState } from '../geology/plates.js';
import type { OceanState } from '../ocean/sea.js';
import { exp } from '@ws/core';
import {
  DIR,
  cubeCellSteradians,
  cubeDim,
  cubeIndex,
  geoToCubeIntensive,
  neighbor,
  resamplePlan,
} from '@ws/data';

const DIRS = [DIR.POS_U, DIR.NEG_U, DIR.POS_V, DIR.NEG_V] as const;
const WATER_DENSITY = 1000;

export interface RiverNetwork {
  readonly from: Int32Array;
  readonly to: Int32Array;
  readonly discharge: Float64Array;
  readonly width: Float32Array;
  readonly velocity: Float32Array;
  readonly order: Uint8Array;
}

export interface LakeState {
  readonly id: number;
  readonly cells: Int32Array;
  readonly outlet: number;
  levelM: number;
  volumeM3: number;
  readonly capacityM3: number;
  inflowM3: number;
  evaporationM3: number;
}

export interface WaterBudget {
  precipitationM3: number;
  evaporationM3: number;
  oceanOutflowM3: number;
  storageChangeM3: number;
  residualM3: number;
}

export interface HydrologyState {
  readonly level: number;
  readonly cellCount: number;
  readonly areaM2: Float64Array;
  readonly elevationM: Float64Array;
  readonly filledM: Float64Array;
  readonly ocean: Uint8Array;
  readonly receiver: Int32Array;
  readonly topologicalOrder: Int32Array;
  readonly basinId: Int32Array;
  readonly contributingAreaM2: Float64Array;
  readonly runoffMps: Float64Array;
  readonly dischargeM3s: Float64Array;
  readonly soilMoistureM: Float64Array;
  readonly snowpackM: Float64Array;
  readonly glacierM: Float64Array;
  readonly temperatureK: Float64Array;
  readonly precipitationRate: Float64Array;
  rivers: RiverNetwork;
  lakes: LakeState[];
  seaLevelM: number;
  readonly referenceSeaLevelM: number;
  readonly referenceLandIceM3: number;
  readonly referenceOceanTemperatureK: number;
  readonly budget: WaterBudget;
  routingGeneration: number;
}

interface Routing {
  filled: Float64Array;
  receiver: Int32Array;
  order: Int32Array;
  basin: Int32Array;
  area: Float64Array;
}

export function initHydrology(opts: {
  geology: GeologyState;
  ocean: OceanState;
  climate: ClimateState;
  level?: number;
}): HydrologyState {
  const level = opts.level ?? Math.min(6, opts.geology.level);
  const n = cubeDim(level);
  const count = 6 * n * n;
  const elevationM = new Float64Array(count);
  const ocean = new Uint8Array(count);
  const areaM2 = new Float64Array(count);
  const shift = opts.geology.level - level;
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = cubeIndex(face, level, x, y);
        const sx = shift >= 0 ? x << shift : x >> -shift;
        const sy = shift >= 0 ? y << shift : y >> -shift;
        const si = cubeIndex(face, opts.geology.level, sx, sy);
        elevationM[i] = opts.geology.elevationM[si] as number;
        ocean[i] = elevationM[i] < opts.ocean.seaLevel ? 1 : 0;
        areaM2[i] = cubeCellSteradians({ face, x, y }, level) * RADIUS * RADIUS;
      }
    }
  }
  const routing = routeSurface(elevationM, ocean, areaM2, level);
  const temperatureK = new Float64Array(count);
  const precipitationRate = new Float64Array(count);
  resampleClimate(opts.climate, level, temperatureK, precipitationRate);
  const soilMoistureM = new Float64Array(count);
  soilMoistureM.fill(0.1);
  const snowpackM = new Float64Array(count);
  const glacierM = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    if (ocean[i] === 0 && (temperatureK[i] as number) < 268) {
      snowpackM[i] = 0.05;
      if ((elevationM[i] as number) > 1200) glacierM[i] = 8;
    }
  }
  const state: HydrologyState = {
    level,
    cellCount: count,
    areaM2,
    elevationM,
    filledM: routing.filled,
    ocean,
    receiver: routing.receiver,
    topologicalOrder: routing.order,
    basinId: routing.basin,
    contributingAreaM2: routing.area,
    runoffMps: new Float64Array(count),
    dischargeM3s: new Float64Array(count),
    soilMoistureM,
    snowpackM,
    glacierM,
    temperatureK,
    precipitationRate,
    rivers: emptyRivers(),
    lakes: buildLakes(elevationM, routing.filled, routing.receiver, areaM2, level),
    seaLevelM: opts.ocean.seaLevel,
    referenceSeaLevelM: opts.ocean.seaLevel,
    referenceLandIceM3: iceVolume(glacierM, snowpackM, areaM2, ocean),
    referenceOceanTemperatureK: oceanMean(temperatureK, areaM2, ocean),
    budget: { precipitationM3: 0, evaporationM3: 0, oceanOutflowM3: 0, storageChangeM3: 0, residualM3: 0 },
    routingGeneration: 0,
  };
  updateDischarge(state);
  state.rivers = buildRivers(state);
  return state;
}

export function rebuildHydrologyRouting(state: HydrologyState, geology: GeologyState): void {
  const n = cubeDim(state.level);
  const shift = geology.level - state.level;
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = cubeIndex(face, state.level, x, y);
        const sx = shift >= 0 ? x << shift : x >> -shift;
        const sy = shift >= 0 ? y << shift : y >> -shift;
        state.elevationM[i] = geology.elevationM[cubeIndex(face, geology.level, sx, sy)] as number;
        state.ocean[i] = (state.elevationM[i] as number) < state.seaLevelM ? 1 : 0;
      }
    }
  }
  const r = routeSurface(state.elevationM, state.ocean, state.areaM2, state.level);
  state.filledM.set(r.filled);
  state.receiver.set(r.receiver);
  state.topologicalOrder.set(r.order);
  state.basinId.set(r.basin);
  state.contributingAreaM2.set(r.area);
  state.lakes = buildLakes(state.elevationM, state.filledM, state.receiver, state.areaM2, state.level);
  updateDischarge(state);
  state.rivers = buildRivers(state);
  state.routingGeneration++;
}

export function stepHydrology(state: HydrologyState, climate: ClimateState, dtSeconds: number): WaterBudget {
  /* Climatology/paleo calls are representative water-budget windows. Keep the
     bucket integration stable while scheduler time advances coarsely. */
  const elapsedSeconds = dtSeconds;
  dtSeconds = Math.min(dtSeconds, 365.25 * 86400);
  resampleClimate(climate, state.level, state.temperatureK, state.precipitationRate);
  /*
   * A direct hydrology diagnostic can be handed a millennial window without a
   * preceding atmosphere tick. If the atmospheric mean is effectively empty,
   * use the same reduced-column closure as paleo climate; this keeps soil
   * moisture a property of the simulated interval, not of call ordering.
   *
   * DECLARED DISCONTINUITY (T-0107). The trigger is a HARD threshold on window
   * length, so 1 x 1000 years and 1000 x 1 year are driven by different
   * rainfall and land two orders of magnitude apart. That is measured and
   * pinned in `soil-path-independence.test.ts`. It is confined to this
   * diagnostic entry point: a world advanced through the scheduler runs the
   * atmosphere first, so no cell is dry enough to fall back, and the same test
   * asserts that too.
   */
  if (elapsedSeconds >= 1_000 * 365.25 * 86400) {
    for (let i = 0; i < state.cellCount; i++) {
      if ((state.precipitationRate[i] as number) < 1e-8) {
        state.precipitationRate[i] = reducedColumnRainRate(state.temperatureK[i] as number);
      }
    }
  }
  const before = storageVolume(state);
  let precipitation = 0;
  let evaporation = 0;
  for (let i = 0; i < state.cellCount; i++) {
    if (state.ocean[i] !== 0) {
      state.runoffMps[i] = 0;
      continue;
    }
    const area = state.areaM2[i] as number;
    const T = state.temperatureK[i] as number;
    const p = Math.max(0, state.precipitationRate[i] as number) / WATER_DENSITY;
    const inputM = p * dtSeconds;
    precipitation += inputM * area;
    let rainM = inputM;
    if (T < 273.15) {
      state.snowpackM[i] = (state.snowpackM[i] as number) + inputM;
      rainM = 0;
    }
    let meltM = 0;
    if (T > 273.15) {
      const potential = (T - 273.15) * 2e-8 * dtSeconds;
      meltM = Math.min(state.snowpackM[i] as number, potential);
      state.snowpackM[i] = (state.snowpackM[i] as number) - meltM;
      if ((state.snowpackM[i] as number) <= 0.01 && (state.glacierM[i] as number) > 0) {
        const gm = Math.min(state.glacierM[i] as number, potential * 0.08);
        state.glacierM[i] = (state.glacierM[i] as number) - gm;
        meltM += gm;
      }
    } else if ((state.snowpackM[i] as number) > 0.5 && (state.elevationM[i] as number) > 1000) {
      const compact = Math.min((state.snowpackM[i] as number) * 0.001, 1e-7 * dtSeconds);
      state.snowpackM[i] = (state.snowpackM[i] as number) - compact;
      state.glacierM[i] = (state.glacierM[i] as number) + compact;
    }
    /* SOIL WATER BALANCE, solved over the interval rather than split (T-0083).
     *
     * The previous form infiltrated once and then evaporated for the whole
     * step. At an hourly cadence that is harmless. At the paleo cadence one
     * step is 100 kyr, so the soil was recharged once and then dried for a
     * hundred thousand years: moisture decayed monotonically, NPP followed it
     * to zero, and the planet became uninhabitable — which M8 discovered by
     * founding civilisations that then all starved.
     *
     * The physical statement is a balance, not a sequence. The soil is a leaky
     * bucket losing water two ways at once:
     *
     *     dS/dt = R - (E0/C) S - (D0/C) S
     *
     * recharge at rate R against evapotranspiration AND drainage to the river,
     * each proportional to how wet the soil is. That has an exact solution over
     * any dt,
     *
     *     S(t+dt) = Seq + (S - Seq) exp(-k dt),  k = (E0 + D0)/C,  Seq = R/k
     *
     * which relaxes toward the climate's equilibrium moisture instead of
     * draining to nothing.
     *
     * WHAT PATH-INDEPENDENCE THIS BUYS, EXACTLY (T-0107). Under a FIXED
     * forcing the exponentials compose, so any chunking of the same interval
     * gives the same answer — one 32-year step and 32 one-year steps agree to
     * the last bit, and `soil-path-independence.test.ts` asserts it at chunk
     * sizes that span the ~7-year relaxation time, where an Euler step or a
     * recharge-then-evaporate sequence would visibly diverge. That is the
     * path-independence DEC-030 requires of slow state.
     *
     * It does NOT mean the answer is independent of how coarsely the FORCING
     * is sampled. A 100 kyr step reads one temperature and one rainfall for
     * the whole interval; that is temporal LOD changing results, which DEC-030
     * states as a property rather than hiding. And the reduced-column
     * substitution below is a hard threshold on window length, so it is a real
     * discontinuity at 1000 years — measured and pinned by that same test
     * rather than described as absent.
     *
     * THE DRAINAGE TERM IS NOT DECORATION (T-0084). Without it the only way
     * water reached a river was saturation excess — recharge overflowing the
     * profile — which needs supply to beat the infiltration rate within a
     * single step. At an hourly cadence that happens in every storm, so the
     * hydrology tests passed. At a 100 kyr step the mean supply rate is far
     * below the infiltration rate, so it never happens, and EVERY RIVER ON THE
     * PLANET had zero discharge at paleo time scales. Baseflow out of soil
     * storage is what actually sustains a river between storms, and it is
     * cadence-independent.
     */
    const capacity = 0.35;
    const s0 = state.soilMoistureM[i] as number;
    const supplyM = rainM + meltM;
    /* Infiltration is rate-limited: a downpour runs off, it does not all soak
       in however dry the ground is. */
    const infiltrationRate = 2e-7 + 2e-6 * capacity;
    const rechargeRate = Math.min(supplyM / Math.max(dtSeconds, 1), infiltrationRate);
    const potentialEtRate = Math.max(0, T - 250) * 4e-11;
    /* Baseflow at saturation, m/s. ~0.032 m/yr, which against a typical
       evapotranspiration of ~0.048 m/yr puts the land water balance near the
       real 60/40 split between evaporation and runoff. */
    const drainageRate = 1.0e-9;
    const lossRate = potentialEtRate + drainageRate;
    const k = lossRate / capacity;

    let sUnclamped: number;
    if (k > 0) {
      const sEq = rechargeRate / k;
      /* Soil moisture is authoritative slow state, so its exact relaxation
         uses the full simulated interval. Flux diagnostics below still use
         the bounded representative climatology window. */
      sUnclamped = sEq + (s0 - sEq) * exp(-k * elapsedSeconds);
    } else {
      sUnclamped = s0 + rechargeRate * dtSeconds;
    }
    const sFinal = Math.min(capacity, Math.max(0, sUnclamped));
    /* Saturation excess: water the profile could not hold becomes runoff. */
    const saturationExcess = Math.max(0, sUnclamped - capacity);
    const rechargeM = rechargeRate * dtSeconds;
    const absorbed = sFinal - s0;
    /* Everything that entered and did not stay, left one of two ways, split in
       proportion to the two loss rates. Closes exactly:
       supply = runoff + storage change + evaporation. */
    const departed = Math.max(0, rechargeM - absorbed - saturationExcess);
    const evapShare = lossRate > 0 ? potentialEtRate / lossRate : 1;
    const evapM = departed * evapShare;
    const baseflowM = departed - evapM;
    state.soilMoistureM[i] = sFinal;
    evaporation += evapM * area;
    /* Infiltration-excess overland flow, saturation excess, and baseflow. */
    const runoffM = Math.max(0, supplyM - rechargeM) + saturationExcess + baseflowM;
    state.runoffMps[i] = runoffM / Math.max(dtSeconds, 1);
  }
  updateDischarge(state);
  let oceanOutflow = 0;
  for (let i = 0; i < state.cellCount; i++) {
    const r = state.receiver[i] as number;
    if (r >= 0 && state.ocean[r] !== 0) oceanOutflow += (state.dischargeM3s[i] as number) * dtSeconds;
  }
  let retainedByLakes = 0;
  for (const lake of state.lakes) {
    const inflow = lake.outlet >= 0 ? (state.dischargeM3s[lake.outlet] as number) * dtSeconds : 0;
    lake.inflowM3 = inflow;
    lake.evaporationM3 = Math.min(lake.volumeM3, inflow * 0.002);
    const retained = Math.min(inflow, Math.max(0, lake.capacityM3 - lake.volumeM3 + lake.evaporationM3));
    lake.volumeM3 += retained - lake.evaporationM3;
    retainedByLakes += retained;
    evaporation += lake.evaporationM3;
  }
  oceanOutflow = Math.max(0, oceanOutflow - retainedByLakes);
  const after = storageVolume(state);
  const storageChange = after - before;
  /* Runoff routed to the ocean is not retained. Lake storage is retained and
     counted above. The explicit account is the conservation invariant. */
  const residual = precipitation - evaporation - oceanOutflow - storageChange;
  state.budget.precipitationM3 += precipitation;
  state.budget.evaporationM3 += evaporation;
  state.budget.oceanOutflowM3 += oceanOutflow;
  state.budget.storageChangeM3 += storageChange;
  state.budget.residualM3 += residual;
  updateDynamicSeaLevel(state);
  state.rivers = buildRivers(state);
  return state.budget;
}

function resampleClimate(climate: ClimateState, level: number, T: Float64Array, P: Float64Array): void {
  const plan = resamplePlan(level, climate.n);
  geoToCubeIntensive(plan, climate.T, T);
  geoToCubeIntensive(plan, climate.precipMean, P);
  let total = 0;
  for (let i = 0; i < P.length; i++) total += P[i] as number;
  if (!(total > 0)) geoToCubeIntensive(plan, climate.precip, P);
}

export function priorityFlood(
  elevation: Float64Array,
  ocean: Uint8Array,
  level: number,
): { filled: Float64Array; receiver: Int32Array } {
  const count = elevation.length;
  const filled = elevation.slice();
  const receiver = new Int32Array(count);
  receiver.fill(-2);
  const seen = new Uint8Array(count);
  const heap = new MinHeap(count);
  for (let i = 0; i < count; i++) {
    if (ocean[i] !== 0) {
      seen[i] = 1;
      receiver[i] = -1;
      heap.push(i, elevation[i] as number);
    }
  }
  if (heap.size === 0) {
    let low = 0;
    for (let i = 1; i < count; i++) if ((elevation[i] as number) < (elevation[low] as number)) low = i;
    seen[low] = 1;
    receiver[low] = -1;
    heap.push(low, elevation[low] as number);
  }
  const n = cubeDim(level);
  while (heap.size > 0) {
    const i = heap.pop();
    const face = Math.floor(i / (n * n));
    const local = i - face * n * n;
    const y = Math.floor(local / n);
    const x = local - y * n;
    for (const dir of DIRS) {
      const nb = neighbor({ face, x, y }, level, dir);
      const j = cubeIndex(nb.face, level, nb.x, nb.y);
      if (seen[j] !== 0) continue;
      seen[j] = 1;
      receiver[j] = i;
      const h = Math.max(elevation[j] as number, filled[i] as number);
      filled[j] = h;
      heap.push(j, h);
    }
  }
  return { filled, receiver };
}

function routeSurface(elevation: Float64Array, ocean: Uint8Array, cellArea: Float64Array, level: number): Routing {
  const flood = priorityFlood(elevation, ocean, level);
  const count = elevation.length;
  const indegree = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const r = flood.receiver[i] as number;
    if (r >= 0) indegree[r] = (indegree[r] as number) + 1;
  }
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < count; i++) if (indegree[i] === 0) queue[tail++] = i;
  const order = new Int32Array(count);
  const area = cellArea.slice();
  let used = 0;
  while (head < tail) {
    const i = queue[head++] as number;
    order[used++] = i;
    const r = flood.receiver[i] as number;
    if (r >= 0) {
      area[r] = (area[r] as number) + (area[i] as number);
      indegree[r] = (indegree[r] as number) - 1;
      if (indegree[r] === 0) queue[tail++] = r;
    }
  }
  if (used !== count) throw new Error('hydrology routing cycle');
  const basin = new Int32Array(count);
  for (let k = count - 1; k >= 0; k--) {
    const i = order[k] as number;
    const r = flood.receiver[i] as number;
    basin[i] = r < 0 ? i + 1 : basin[r] as number;
  }
  return { filled: flood.filled, receiver: flood.receiver, order, basin, area };
}

function updateDischarge(state: HydrologyState): void {
  state.dischargeM3s.fill(0);
  for (let k = 0; k < state.cellCount; k++) {
    const i = state.topologicalOrder[k] as number;
    state.dischargeM3s[i] = (state.dischargeM3s[i] as number) +
      (state.runoffMps[i] as number) * (state.areaM2[i] as number);
    const r = state.receiver[i] as number;
    if (r >= 0) state.dischargeM3s[r] = (state.dischargeM3s[r] as number) + (state.dischargeM3s[i] as number);
  }
}

function buildRivers(state: HydrologyState): RiverNetwork {
  const threshold = 4 * STABLE_CELL_AREA(state);
  let count = 0;
  for (let i = 0; i < state.cellCount; i++) {
    if (state.ocean[i] === 0 && (state.receiver[i] as number) >= 0 && (state.contributingAreaM2[i] as number) >= threshold) count++;
  }
  const from = new Int32Array(count);
  const to = new Int32Array(count);
  const discharge = new Float64Array(count);
  const width = new Float32Array(count);
  const velocity = new Float32Array(count);
  const order = new Uint8Array(count);
  const cellOrder = new Uint8Array(state.cellCount);
  cellOrder.fill(1);
  const maxUp = new Uint8Array(state.cellCount);
  const maxCount = new Uint8Array(state.cellCount);
  for (let k = 0; k < state.cellCount; k++) {
    const i = state.topologicalOrder[k] as number;
    const r = state.receiver[i] as number;
    if (r < 0) continue;
    const o = cellOrder[i] as number;
    if (o > (maxUp[r] as number)) { maxUp[r] = o; maxCount[r] = 1; }
    else if (o === (maxUp[r] as number)) maxCount[r] = (maxCount[r] as number) + 1;
    cellOrder[r] = (maxUp[r] as number) + ((maxCount[r] as number) >= 2 ? 1 : 0);
  }
  let e = 0;
  for (let i = 0; i < state.cellCount; i++) {
    if (state.ocean[i] !== 0 || (state.receiver[i] as number) < 0 || (state.contributingAreaM2[i] as number) < threshold) continue;
    const q = state.dischargeM3s[i] as number;
    from[e] = i;
    to[e] = state.receiver[i] as number;
    discharge[e] = q;
    width[e] = Math.max(1, Math.sqrt(Math.max(q, 0)) * 2.5);
    velocity[e] = Math.min(5, 0.4 + Math.sqrt(Math.max(q, 0)) * 0.02);
    order[e] = cellOrder[i] as number;
    e++;
  }
  return { from, to, discharge, width, velocity, order };
}

function buildLakes(
  elevation: Float64Array,
  filled: Float64Array,
  receiver: Int32Array,
  area: Float64Array,
  level: number,
): LakeState[] {
  const count = elevation.length;
  const lake = new Uint8Array(count);
  for (let i = 0; i < count; i++) if ((filled[i] as number) - (elevation[i] as number) > 0.5) lake[i] = 1;
  const seen = new Uint8Array(count);
  const n = cubeDim(level);
  const out: LakeState[] = [];
  const queue = new Int32Array(count);
  for (let start = 0; start < count; start++) {
    if (lake[start] === 0 || seen[start] !== 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let volume = 0;
    let levelM = filled[start] as number;
    let outlet = receiver[start] as number;
    const cells: number[] = [];
    while (head < tail) {
      const i = queue[head++] as number;
      cells.push(i);
      volume += ((filled[i] as number) - (elevation[i] as number)) * (area[i] as number);
      if ((filled[i] as number) > levelM) levelM = filled[i] as number;
      const r = receiver[i] as number;
      if (r >= 0 && lake[r] === 0) outlet = r;
      const face = Math.floor(i / (n * n));
      const local = i - face * n * n;
      const y = Math.floor(local / n);
      const x = local - y * n;
      for (const dir of DIRS) {
        const nb = neighbor({ face, x, y }, level, dir);
        const j = cubeIndex(nb.face, level, nb.x, nb.y);
        if (lake[j] !== 0 && seen[j] === 0) { seen[j] = 1; queue[tail++] = j; }
      }
    }
    cells.sort((a, b) => a - b);
    out.push({ id: out.length + 1, cells: Int32Array.from(cells), outlet, levelM,
      volumeM3: volume, capacityM3: volume, inflowM3: 0, evaporationM3: 0 });
  }
  return out;
}

function storageVolume(state: HydrologyState): number {
  let v = 0;
  let correction = 0;
  for (let i = 0; i < state.cellCount; i++) {
    const value = ((state.soilMoistureM[i] as number) + (state.snowpackM[i] as number) + (state.glacierM[i] as number)) * (state.areaM2[i] as number);
    const y = value - correction;
    const next = v + y;
    correction = (next - v) - y;
    v = next;
  }
  for (const lake of state.lakes) {
    const y = lake.volumeM3 - correction;
    const next = v + y;
    correction = (next - v) - y;
    v = next;
  }
  return v;
}

function iceVolume(glacier: Float64Array, snow: Float64Array, area: Float64Array, ocean: Uint8Array): number {
  let v = 0;
  for (let i = 0; i < glacier.length; i++) if (ocean[i] === 0) v += ((glacier[i] as number) + (snow[i] as number)) * (area[i] as number);
  return v;
}

function oceanMean(T: Float64Array, area: Float64Array, ocean: Uint8Array): number {
  let s = 0;
  let a = 0;
  for (let i = 0; i < T.length; i++) if (ocean[i] !== 0) { s += (T[i] as number) * (area[i] as number); a += area[i] as number; }
  return a > 0 ? s / a : 273.15;
}

function updateDynamicSeaLevel(state: HydrologyState): void {
  let oceanArea = 0;
  for (let i = 0; i < state.cellCount; i++) if (state.ocean[i] !== 0) oceanArea += state.areaM2[i] as number;
  if (!(oceanArea > 0)) return;
  const ice = iceVolume(state.glacierM, state.snowpackM, state.areaM2, state.ocean);
  const eustatic = (state.referenceLandIceM3 - ice) / oceanArea;
  const meanT = oceanMean(state.temperatureK, state.areaM2, state.ocean);
  const thermal = 2.1e-4 * (meanT - state.referenceOceanTemperatureK) * 3700;
  state.seaLevelM = state.referenceSeaLevelM + eustatic + thermal;
}

function STABLE_CELL_AREA(state: HydrologyState): number {
  let total = 0;
  for (let i = 0; i < state.areaM2.length; i++) total += state.areaM2[i] as number;
  return total / state.cellCount;
}

function emptyRivers(): RiverNetwork {
  return { from: new Int32Array(0), to: new Int32Array(0), discharge: new Float64Array(0), width: new Float32Array(0), velocity: new Float32Array(0), order: new Uint8Array(0) };
}

class MinHeap {
  private readonly ids: Int32Array;
  private readonly keys: Float64Array;
  size = 0;
  constructor(capacity: number) { this.ids = new Int32Array(capacity); this.keys = new Float64Array(capacity); }
  push(id: number, key: number): void {
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.keys[p] as number) < key || ((this.keys[p] as number) === key && (this.ids[p] as number) <= id)) break;
      this.ids[i] = this.ids[p] as number; this.keys[i] = this.keys[p] as number; i = p;
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
      let c = i * 2 + 1;
      if (c >= last) break;
      if (c + 1 < last && ((this.keys[c + 1] as number) < (this.keys[c] as number) || ((this.keys[c + 1] as number) === (this.keys[c] as number) && (this.ids[c + 1] as number) < (this.ids[c] as number)))) c++;
      if ((this.keys[c] as number) > key || ((this.keys[c] as number) === key && (this.ids[c] as number) >= id)) break;
      this.ids[i] = this.ids[c] as number; this.keys[i] = this.keys[c] as number; i = c;
    }
    this.ids[i] = id; this.keys[i] = key;
    return root;
  }
}
