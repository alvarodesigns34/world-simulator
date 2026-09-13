import { describe, expect, it } from 'vitest';
import {
  FieldStore,
  fieldId,
  gridId,
  subsystemId,
  type FieldDescriptor,
} from '@ws/data';

const OWNER = subsystemId('terrain');
const ATTACKER = subsystemId('attacker');
const ELEV = fieldId('elevation');

function desc(over: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    id: ELEV,
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

/**
 * DESCRIPTOR MUTATION (T-0080).
 *
 * `SafeReadView` stopped handing out live memory, but
 * `get descriptor() { return this.field.descriptor; }` returned the live
 * `FieldDescriptor`. TypeScript `readonly` is erased. A reader using only
 * `store.view(id)` could rewrite owner / quantum / offset / tier /
 * doubleBuffered and change mut(), get(), decode, and scheduler validation.
 *
 * Same object also escaped through `store.descriptor(id)`.
 */
describe('canonical descriptors are frozen at runtime', () => {
  it('view().descriptor.owner cannot hijack mut()', () => {
    const store = build();
    const d = store.view(ELEV).descriptor as unknown as { owner: string };
    expect(() => {
      d.owner = String(ATTACKER);
    }).toThrow(TypeError);
    expect(store.view(ELEV).descriptor.owner).toBe(OWNER);
    expect(() => store.mut(ELEV, ATTACKER)).toThrow(/owned by/);
    expect(() => store.mut(ELEV, OWNER).set(0, 7)).not.toThrow();
  });

  it('mutating quantum through view() cannot change decode', () => {
    const store = build();
    store.mut(ELEV, OWNER).set(0, 100);
    store.mut(ELEV, OWNER).commit();
    expect(store.view(ELEV).get(0)).toBe(100);

    const d = store.view(ELEV).descriptor as unknown as { quantum: number };
    expect(() => {
      d.quantum = 2;
    }).toThrow(TypeError);
    expect(store.view(ELEV).get(0)).toBe(100);
    expect(store.view(ELEV).descriptor.quantum).toBe(1);
  });

  it('offset, tier, doubleBuffered, persist, range are frozen too', () => {
    const store = build();
    const d = store.view(ELEV).descriptor as unknown as {
      offset: number;
      tier: string;
      doubleBuffered: boolean;
      persist: string;
      range: [number, number];
    };
    expect(() => {
      d.offset = 50;
    }).toThrow(TypeError);
    expect(() => {
      d.tier = 'C';
    }).toThrow(TypeError);
    expect(() => {
      d.doubleBuffered = true;
    }).toThrow(TypeError);
    expect(() => {
      d.persist = 'never';
    }).toThrow(TypeError);
    expect(() => {
      d.range[0] = 0;
    }).toThrow(TypeError);
    expect(store.view(ELEV).descriptor.offset).toBe(0);
    expect(store.view(ELEV).descriptor.tier).toBe('A');
    expect(store.view(ELEV).descriptor.doubleBuffered).toBe(false);
    expect(store.view(ELEV).descriptor.persist).toBe('snapshot');
    expect(store.view(ELEV).descriptor.range[0]).toBe(-11_000);
  });

  it('store.descriptor(id) is the same frozen canonical object', () => {
    const store = build();
    const viaStore = store.descriptor(ELEV) as unknown as { owner: string; quantum: number };
    const viaView = store.view(ELEV).descriptor as unknown as { owner: string };
    expect(viaStore).toBe(viaView);
    expect(() => {
      viaStore.owner = String(ATTACKER);
    }).toThrow(TypeError);
    expect(() => {
      viaStore.quantum = 4;
    }).toThrow(TypeError);
    expect(store.mut(ELEV, OWNER).descriptor).toBe(viaStore);
  });

  it("mutating the caller's original object after declare does not affect the store", () => {
    const original = desc();
    const store = new FieldStore({ preferShared: false }).declare(original).seal();
    (original as unknown as { owner: string }).owner = String(ATTACKER);
    (original as unknown as { quantum: number }).quantum = 8;
    expect(store.descriptor(ELEV).owner).toBe(OWNER);
    expect(store.descriptor(ELEV).quantum).toBe(1);
    expect(() => store.mut(ELEV, ATTACKER)).toThrow(/owned by/);
  });
});
