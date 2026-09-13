import { describe, expect, it } from 'vitest';
import {
  FieldStore,
  fieldId,
  gridId,
  sharedMemoryAvailable,
  subsystemId,
  type FieldDescriptor,
} from '@ws/data';

const OWNER = subsystemId('terrain');
const ELEV = fieldId('elevation');

function desc(): FieldDescriptor {
  return {
    id: ELEV,
    grid: gridId('cubesphere', 6),
    dtype: 'i32',
    components: 1,
    quantum: 1,
    offset: 0,
    units: 'm',
    range: [-100_000, 100_000],
    owner: OWNER,
    tier: 'A',
    temporalClass: 'slow',
    doubleBuffered: true,
    persist: 'snapshot',
  };
}

/**
 * CONSISTENT READ vs POST-PUBLISH REPLICATION (T-0073).
 *
 * `commit` publishes the generation and THEN replicates this generation's dirty
 * blocks from the new front into the new back. A reader that loaded the
 * generation just before the publish is holding what is now the BACK buffer —
 * exactly the buffer replication writes into.
 *
 * The seqlock must catch that. What it guarantees, precisely: a read that
 * returns `torn: false` observed one generation throughout. It does NOT
 * guarantee that a torn read saw sane data — that is why the caller retries.
 */
describe('consistentRead under post-publish replication', () => {
  const build = (): FieldStore =>
    new FieldStore({ preferShared: false }).declare(desc()).seal();

  it('a read that straddles a commit reports torn', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    const unsafe = store.unsafeRawAccess(ELEV, 'test: seqlock behaviour');

    f.set(0, 1);
    f.commit();

    const r = unsafe.consistentRead((raw) => {
      // Commit from inside the read window — the worst case.
      f.set(1, 2);
      f.commit();
      return raw[0];
    });
    expect(r.torn).toBe(true);
  });

  it('an uncontended read reports not-torn and a coherent generation', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    for (let i = 0; i < 16; i++) f.set(i, i * 3);
    f.commit();

    const unsafe = store.unsafeRawAccess(ELEV, 'test: seqlock behaviour');
    const r = unsafe.consistentRead((raw, gen) => ({ v: raw[7], gen }));
    expect(r.torn).toBe(false);
    expect(r.value?.v).toBe(21);
    expect(r.value?.gen).toBe(store.view(ELEV).generation);
  });

  it('retrying after a torn read eventually succeeds and sees a whole generation', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    const unsafe = store.unsafeRawAccess(ELEV, 'test: seqlock retry loop');

    // Publish a sequence of internally consistent generations: every cell in
    // the field carries the same value, so a torn read is detectable by value
    // as well as by generation.
    const CELLS = 64;
    for (let gen = 1; gen <= 12; gen++) {
      for (let i = 0; i < CELLS; i++) f.set(i, gen);
      f.commit();
    }

    let attempts = 0;
    let result: number[] | undefined;
    for (let i = 0; i < 8 && result === undefined; i++) {
      attempts++;
      const r = unsafe.consistentRead((raw) => Array.from(raw.subarray(0, CELLS)));
      if (!r.torn) result = r.value;
    }
    expect(attempts).toBe(1);
    expect(new Set(result)).toEqual(new Set([12]));
  });

  /**
   * The ordering argument, made executable. Replication writes into the buffer
   * that was the front BEFORE the flip. A reader that starts AFTER the flip
   * therefore reads a buffer nothing is writing to, and must never observe a
   * partially replicated state.
   */
  it('a read started after the publish is unaffected by the replication that follows', () => {
    const store = build();
    const f = store.mut(ELEV, OWNER);
    const CELLS = 64;

    for (let i = 0; i < CELLS; i++) f.set(i, 7);
    f.commit();

    for (let gen = 8; gen < 40; gen++) {
      for (let i = 0; i < CELLS; i++) f.set(i, gen);
      f.commit();
      // Immediately after commit (i.e. after publish AND replication), a fresh
      // read must see this whole generation, never a mix.
      const seen = new Set<number>();
      for (let i = 0; i < CELLS; i++) seen.add(store.view(ELEV).get(i));
      expect(seen).toEqual(new Set([gen]));
    }
  });

  it('the same holds with shared memory when it is available', () => {
    if (!sharedMemoryAvailable()) return;
    const store = new FieldStore({ preferShared: true }).declare(desc()).seal();
    expect(store.usingSharedMemory).toBe(true);
    const f = store.mut(ELEV, OWNER);
    const CELLS = 64;
    for (let gen = 1; gen < 25; gen++) {
      for (let i = 0; i < CELLS; i++) f.set(i, gen);
      f.commit();
      const seen = new Set<number>();
      for (let i = 0; i < CELLS; i++) seen.add(store.view(ELEV).get(i));
      expect(seen).toEqual(new Set([gen]));
    }
  });
});
