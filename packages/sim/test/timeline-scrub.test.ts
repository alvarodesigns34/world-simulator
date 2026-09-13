/**
 * M11 historical state navigation (T-0095).
 *
 * The slider used to read population and temperature series, write a label
 * saying "RECORDED SNAPSHOT", and leave the planet exactly where it was. These
 * tests are written against the digest, because the digest is the only thing
 * that can tell "the world really is at that instant" apart from "the label
 * says so".
 */

import { describe, expect, it } from 'vitest';
import { makeSeed } from '@ws/core';
import {
  CIV,
  CheckpointStore,
  TimelineNavigator,
  absoluteSeconds,
  captureCheckpoint,
  createWorld,
  restoreCheckpoint,
} from '@ws/sim';

function world() {
  return createWorld({
    seed: makeSeed(0x7a, 0x2f),
    genesis: { level: 4, steps: 16, plateCount: 7 },
    terrainLevel: 4, climateN: 3, erode: false,
  });
}

/** Advance a paleo world by whole 100 kyr chunks, checkpointing each. */
function evolve(w: ReturnType<typeof world>, nav: TimelineNavigator, chunks: number): number[] {
  const marks: number[] = [];
  for (let i = 0; i < chunks; i++) {
    w.advance(100_000 * w.calendar.secondsPerYear);
    nav.record();
    marks.push(absoluteSeconds(w.scheduler.time, w.calendar.secondsPerYear));
  }
  return marks;
}

describe('T-0095 checkpoints reconstruct the world exactly', () => {
  it('captures and restores an authoritative state bit for bit', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    w.advance(200_000 * w.calendar.secondsPerYear);

    const before = w.digest();
    const cp = captureCheckpoint(w);
    expect(cp.digest).toBe(before);

    /* Move the world well away from the captured instant. */
    w.advance(300_000 * w.calendar.secondsPerYear);
    expect(w.digest()).not.toBe(before);

    restoreCheckpoint(w, cp);
    expect(w.digest(), 'restore did not reproduce the captured state').toBe(before);
  }, 120000);

  it('restores in place, so long-lived references still see the world', () => {
    /* The failure this guards: replacing arrays instead of filling them leaves
       the renderer and the field store reading a detached copy — which is the
       same shape of bug as a slider that moves nothing. */
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    w.advance(200_000 * w.calendar.secondsPerYear);

    const elevation = w.hydrology.elevationM;
    const claim = w.civilisation.claim;
    const pollution = w.economy.pollution;
    const cp = captureCheckpoint(w);

    w.advance(200_000 * w.calendar.secondsPerYear);
    restoreCheckpoint(w, cp);

    expect(w.hydrology.elevationM, 'hydrology array identity lost').toBe(elevation);
    expect(w.civilisation.claim, 'claim raster identity lost').toBe(claim);
    expect(w.economy.pollution, 'pollution field identity lost').toBe(pollution);
  }, 120000);

  it('keeps memory bounded by thinning old checkpoints, not by dropping new ones', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    const store = new CheckpointStore({ maxCheckpoints: 8 });
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      w.advance(50_000 * w.calendar.secondsPerYear);
      store.capture(w);
      times.push(absoluteSeconds(w.scheduler.time, w.calendar.secondsPerYear));
    }
    expect(store.count).toBeLessThanOrEqual(8);
    /* Strictly increasing, and the newest instant is still retained. */
    const kept = store.checkpoints.map((c) => c.at);
    for (let i = 1; i < kept.length; i++) expect(kept[i] as number).toBeGreaterThan(kept[i - 1] as number);
    expect(kept[kept.length - 1]).toBeCloseTo(times[times.length - 1] as number, 3);
    /* And deep history is still reachable, not truncated away. */
    expect(kept[0] as number).toBeLessThan((times[times.length - 1] as number) / 2);
  }, 180000);
});

describe('T-0095 scrubbing moves the world, not just the label', () => {
  it('scrubs back to a past instant and reproduces its digest', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    const nav = new TimelineNavigator(w, { maxCheckpoints: 16 });

    const marks = evolve(w, nav, 4);
    const past = marks[1] as number;
    const pastDigest = nav.store.nearestAtOrBefore(past)!.digest;
    const liveDigest = w.digest();

    const r = nav.scrubTo(past);
    expect(r.exact).toBe(true);
    expect(nav.mode).toBe('history');
    expect(w.digest(), 'scrub did not reconstruct the past state').toBe(pastDigest);
    expect(w.digest()).not.toBe(liveDigest);
    /* And the simulation clock genuinely moved back. */
    expect(absoluteSeconds(w.scheduler.time, w.calendar.secondsPerYear)).toBeCloseTo(past, 3);
  }, 180000);

  it('scrubs forward again and reproduces the later digest', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    const nav = new TimelineNavigator(w, { maxCheckpoints: 16 });

    const marks = evolve(w, nav, 4);
    const early = marks[0] as number;
    const later = marks[2] as number;
    const earlyDigest = nav.store.nearestAtOrBefore(early)!.digest;
    const laterDigest = nav.store.nearestAtOrBefore(later)!.digest;
    expect(earlyDigest).not.toBe(laterDigest);

    nav.scrubTo(early);
    expect(w.digest()).toBe(earlyDigest);
    nav.scrubTo(later);
    expect(w.digest(), 'forward scrub did not reach the later state').toBe(laterDigest);
    nav.scrubTo(early);
    expect(w.digest(), 'second backward scrub diverged').toBe(earlyDigest);
  }, 180000);

  it('returns to live exactly', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    const nav = new TimelineNavigator(w, { maxCheckpoints: 16 });
    const marks = evolve(w, nav, 3);
    const live = w.digest();
    const liveAt = absoluteSeconds(w.scheduler.time, w.calendar.secondsPerYear);

    nav.scrubTo(marks[0] as number);
    expect(w.digest()).not.toBe(live);
    nav.returnToLive();

    expect(nav.mode).toBe('live');
    expect(w.digest(), 'returning to live did not restore the head state').toBe(live);
    expect(absoluteSeconds(w.scheduler.time, w.calendar.secondsPerYear)).toBeCloseTo(liveAt, 3);
  }, 180000);

  it('replays from the nearest checkpoint, never from year zero', () => {
    /* The performance contract. A scrub to just after a checkpoint must replay
       a short interval, not the whole history. */
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    const nav = new TimelineNavigator(w, { maxCheckpoints: 32 });
    const marks = evolve(w, nav, 5);

    const chunk = 100_000 * w.calendar.secondsPerYear;
    const target = (marks[3] as number) - chunk * 0.25;
    const r = nav.scrubTo(target);

    expect(r.fromCheckpoint).toBeDefined();
    /* Started from the checkpoint immediately before the target... */
    expect(r.fromCheckpoint as number).toBeLessThanOrEqual(target);
    expect((marks[3] as number) - (r.fromCheckpoint as number)).toBeLessThanOrEqual(chunk + 1);
    /* ...and replayed less than one checkpoint interval, not five. */
    expect(r.replayedSeconds).toBeLessThan(chunk);
  }, 180000);

  it('a later scrub supersedes an earlier one without leaving the world half-restored', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    const nav = new TimelineNavigator(w, { maxCheckpoints: 16 });
    const marks = evolve(w, nav, 4);

    /* Three targets in quick succession, as a dragged slider produces. The
       world must end at the LAST one and be internally consistent. */
    nav.scrubTo(marks[0] as number);
    nav.scrubTo(marks[2] as number);
    const final = nav.scrubTo(marks[1] as number);
    expect(final.exact).toBe(true);
    expect(w.digest()).toBe(nav.store.nearestAtOrBefore(marks[1] as number)!.digest);
  }, 180000);

  it('clamps a target beyond the reachable range instead of inventing one', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    const nav = new TimelineNavigator(w, { maxCheckpoints: 16 });
    const marks = evolve(w, nav, 3);
    const latest = marks[marks.length - 1] as number;

    const beyond = nav.scrubTo(latest * 10);
    expect(beyond.at).toBeLessThanOrEqual(latest + 1);
    const before = nav.scrubTo(-1);
    expect(before.at).toBeGreaterThanOrEqual(0);
    nav.returnToLive();
    expect(nav.mode).toBe('live');
  }, 180000);
});

describe('T-0095 history and bookmarks stay coherent across a scrub', () => {
  it('rewinds the recorded series with the world', () => {
    /* History is authoritative state too: a world at year N must not carry
       samples from year 3N, or the plot would show a future that, from the
       reconstructed instant, has not happened. */
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    const nav = new TimelineNavigator(w, { maxCheckpoints: 16 });
    const marks = evolve(w, nav, 4);

    const liveSamples = w.history.samples('population').length;
    nav.scrubTo(marks[0] as number);
    const pastSamples = w.history.samples('population').length;
    expect(pastSamples).toBeLessThan(liveSamples);

    nav.returnToLive();
    expect(w.history.samples('population').length).toBe(liveSamples);
  }, 180000);

  it('keeps bookmarks that were placed before the scrub target', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    const nav = new TimelineNavigator(w, { maxCheckpoints: 16 });

    w.advance(100_000 * w.calendar.secondsPerYear);
    w.apply({ kind: 'bookmark', label: 'early' });
    nav.record();
    const at = absoluteSeconds(w.scheduler.time, w.calendar.secondsPerYear);

    evolve(w, nav, 3);
    w.apply({ kind: 'bookmark', label: 'late' });
    nav.record();

    nav.scrubTo(at);
    const labels = w.history.bookmarks().map((b: { label: string }) => b.label);
    expect(labels).toContain('early');
    expect(labels).not.toContain('late');

    nav.returnToLive();
    expect(w.history.bookmarks().map((b: { label: string }) => b.label)).toContain('late');
  }, 180000);

  it('leaves the civilisation entity store consistent after a rewind', () => {
    const w = world();
    w.apply({ kind: 'setTimeScale', scale: 1e8 });
    const nav = new TimelineNavigator(w, { maxCheckpoints: 16 });
    const marks = evolve(w, nav, 4);

    nav.scrubTo(marks[1] as number);
    const store = w.civilisation.store;
    const pop = store.column(CIV.population);
    let live = 0;
    for (let i = 0; i < store.bound; i++) {
      if (!store.aliveAt(i)) continue;
      live++;
      expect(Number.isFinite(pop[i] as number)).toBe(true);
      expect(pop[i] as number).toBeGreaterThanOrEqual(0);
    }
    expect(live).toBe(store.count);
    /* And it can keep simulating from the reconstructed state. */
    w.advance(10_000 * w.calendar.secondsPerYear);
    expect(Number.isFinite(w.civilisation.totalPopulation)).toBe(true);
  }, 180000);
});
