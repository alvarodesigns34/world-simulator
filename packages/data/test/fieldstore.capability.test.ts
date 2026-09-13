import { describe, expect, it } from 'vitest';
import {
  FieldStore,
  fieldId,
  gridId,
  subsystemId,
  type FieldDescriptor,
} from '@ws/data';

const OWNER = subsystemId('terrain');

function desc(over: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    id: fieldId('elevation'),
    grid: gridId('cubesphere', 6),
    dtype: 'i16',
    components: 1,
    quantum: 1,
    offset: 0,
    units: 'm',
    range: [-11_000, 9_000],
    owner: OWNER,
    tier: 'A',
    temporalClass: 'slow',
    doubleBuffered: false,
    persist: 'snapshot',
    ...over,
  };
}

const build = (over: Partial<FieldDescriptor> = {}): FieldStore =>
  new FieldStore({ preferShared: false }).declare(desc(over)).seal();

const ELEV = fieldId('elevation');

/**
 * HOSTILE READER (T-0070).
 *
 * Grok's `SafeReadView` correctly stopped `view()` from returning the live
 * `Field`, so a reader has no `set` / `rawMut` / `commit`. But it still forwards
 * `raw()` and `handles()`, and neither is read-only at RUNTIME:
 * `Readonly<TypedArray>` is erased by the compiler, and an `ArrayBufferLike` can
 * simply be re-wrapped.
 *
 * These attacks use ONLY the public capabilities a reader is handed. No cast to
 * the private `Field`, no reaching into internals. If they succeed, "read-only"
 * is a comment, not a contract.
 */
describe('hostile reader: capabilities handed out by view()', () => {
  it('cannot mutate authoritative state through raw()', () => {
    const store = build();
    store.mut(ELEV, OWNER).set(0, 1234);
    store.mut(ELEV, OWNER).commit();

    const reader = store.view(ELEV);
    expect(reader.get(0)).toBe(1234);

    // The attack: a reader takes the array it was handed and writes to it.
    const attacker = store.view(ELEV) as unknown as {
      raw?: () => { fill(v: number): void; [i: number]: number };
    };
    if (typeof attacker.raw === 'function') {
      const arr = attacker.raw();
      arr.fill(999);
      arr[0] = 4242;
    }

    // A DIFFERENT reader must not see the tampering, and the generation must
    // not have moved without a commit.
    const other = store.view(ELEV);
    expect(other.get(0)).toBe(1234);
    expect(other.generation).toBe(reader.generation);
  });

  it('cannot mutate authoritative state through handles()', () => {
    const store = build();
    store.mut(ELEV, OWNER).set(3, 777);
    store.mut(ELEV, OWNER).commit();

    const attacker = store.view(ELEV) as unknown as {
      handles?: () => { data: ArrayBufferLike };
    };
    if (typeof attacker.handles === 'function') {
      const h = attacker.handles();
      // Re-wrap the backing store and write straight through it.
      new Int16Array(h.data as ArrayBuffer)[3] = -5000;
    }

    expect(store.view(ELEV).get(3)).toBe(777);
  });

  it('a reader has no writer methods at all', () => {
    const v = store0().view(ELEV) as unknown as Record<string, unknown>;
    for (const m of ['set', 'rawMut', 'commit', 'markDirty', 'markAllDirty']) {
      expect(typeof v[m]).not.toBe('function');
    }
  });
});

function store0(): FieldStore {
  return build();
}
