import { describe, expect, it } from 'vitest';
import { DAY, EARTH_CALENDAR, duration, simTime } from '@ws/core';
import { FieldStore, fieldId, gridId, subsystemId, type FieldDescriptor } from '@ws/data';
import { Scheduler, type Subsystem } from '@ws/sim';

const CAL = EARTH_CALENDAR;
const A = subsystemId('alpha');
const B = subsystemId('bravo');
const FA = fieldId('fieldA');
const FB = fieldId('fieldB');

function desc(id: typeof FA, owner: typeof A): FieldDescriptor {
  return {
    id,
    grid: gridId('cubesphere', 6),
    dtype: 'i16',
    components: 1,
    quantum: 1,
    offset: 0,
    units: 'm',
    range: [-1000, 1000],
    owner,
    tier: 'A',
    temporalClass: 'slow',
    doubleBuffered: false,
    persist: 'snapshot',
  };
}

const build = (): FieldStore =>
  new FieldStore({ preferShared: false }).declare(desc(FA, A)).declare(desc(FB, B)).seal();

function sub(id: typeof A, writes: (typeof FA)[], step: () => void): Subsystem {
  return { id, phase: 'Terrain', cadence: { kind: 'every', dt: DAY }, reads: [], writes, step };
}

/**
 * DEC-016 WRITE BARRIER (T-0074).
 *
 * DEC-016 promised that an inaccurate `writes[]` declaration would be detected
 * at runtime rather than silently producing wrong ordering. Grok implemented
 * `beginStep`/`endStep` around each step. These test the boundary of what that
 * actually catches — including the ways it can still be evaded, so the promise
 * in the ADR matches the mechanism.
 */
describe('write barrier: what it catches', () => {
  it('an undeclared write by the rightful owner throws', () => {
    const store = build();
    let threw: unknown;
    const s = new Scheduler({ calendar: CAL, startTime: simTime(0, 0, CAL), store })
      .register(
        sub(A, [], () => {
          try {
            store.mut(FA, A).set(0, 1); // owner of FA, but FA is not in writes[]
          } catch (e) {
            threw = e;
          }
        }),
      )
      .build();
    s.advance(duration(86400));
    expect(String(threw)).toMatch(/undeclared write to 'fieldA'/);
  });

  it('a declared write by the rightful owner succeeds', () => {
    const store = build();
    let ok = false;
    const s = new Scheduler({ calendar: CAL, startTime: simTime(0, 0, CAL), store })
      .register(
        sub(A, [FA], () => {
          store.mut(FA, A).set(0, 5);
          store.mut(FA, A).commit();
          ok = true;
        }),
      )
      .build();
    s.advance(duration(86400));
    expect(ok).toBe(true);
    expect(store.view(FA).get(0)).toBe(5);
  });

  it('a foreign subsystem cannot write during another subsystem step', () => {
    const store = build();
    let threw: unknown;
    const s = new Scheduler({ calendar: CAL, startTime: simTime(0, 0, CAL), store })
      .register(
        sub(A, [FA], () => {
          try {
            store.mut(FB, B).set(0, 1); // B owns FB, but A's step is in flight
          } catch (e) {
            threw = e;
          }
        }),
      )
      .build();
    s.advance(duration(86400));
    expect(String(threw)).toMatch(/not the in-flight author/);
  });

  it('a FieldView captured BEFORE the step is still barred during it', () => {
    const store = build();
    const captured = store.mut(FA, A); // taken outside any step
    let threw: unknown;
    const s = new Scheduler({ calendar: CAL, startTime: simTime(0, 0, CAL), store })
      .register(
        sub(B, [FB], () => {
          try {
            captured.set(0, 99); // A's field, during B's step
          } catch (e) {
            threw = e;
          }
        }),
      )
      .build();
    s.advance(duration(86400));
    expect(String(threw)).toMatch(/undeclared write to 'fieldA'/);
    expect(store.view(FA).get(0)).toBe(0);
  });

  it('the barrier is released even when a step throws', () => {
    const store = build();
    const s = new Scheduler({ calendar: CAL, startTime: simTime(0, 0, CAL), store })
      .register(
        sub(A, [FA], () => {
          throw new Error('subsystem blew up');
        }),
      )
      .build();
    expect(() => s.advance(duration(86400))).toThrow(/subsystem blew up/);
    // If endStep had been skipped, this would fail with "nested beginStep" or
    // with a stale in-flight author.
    expect(() => store.mut(FB, B).set(0, 1)).not.toThrow();
  });

  it('nested steps are refused rather than silently replacing the author', () => {
    const store = build();
    store.beginStep(A, [FA]);
    expect(() => store.beginStep(B, [FB])).toThrow(/nested beginStep/);
    store.endStep();
  });
});

/**
 * THE HOLE, PINNED DELIBERATELY.
 *
 * `rawMut()` hands out live memory. An array captured before a step can be
 * written during it without passing the barrier — the same fact as
 * `unsafeRawAccess` on the read side: JavaScript cannot revoke a TypedArray.
 *
 * This is asserted rather than hidden so that DEC-016's claim stays honest and
 * so the day someone closes it, the test says so.
 */
describe('write barrier: what it cannot catch', () => {
  it('a raw array captured before a step evades the barrier', () => {
    const store = build();
    const escaped = store.mut(FA, A).rawMut(); // live memory, taken outside a step

    const s = new Scheduler({ calendar: CAL, startTime: simTime(0, 0, CAL), store })
      .register(
        sub(B, [FB], () => {
          escaped[0] = 1234; // no throw: the barrier never sees this
        }),
      )
      .build();
    s.advance(duration(86400));

    // Documented consequence: the value lands, unversioned and unmarked.
    expect(store.view(FA).get(0)).toBe(1234);
    // And nothing recorded it as a change, which is exactly why raw writes must
    // stay inside the owning subsystem's own step.
    expect(store.view(FA).blockChangedAt(0)).toBe(0);
  });
});
