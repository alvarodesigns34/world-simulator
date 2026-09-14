/**
 * T-0098. M12: "Every registered field is visualisable with correct units and
 * legend."
 *
 * That claim was being checked by counting: the FieldStore registry held 32
 * fields and `SCIENTIFIC_FIELDS` held 32 descriptors, and the numbers matching
 * was read as the sets matching. They shared 23 ids. Nine registered fields had
 * no descriptor at all (crustType, oceanMask, flowAccumulation, biosphere
 * population, and four that differed only in naming) and nine descriptors were
 * derived views with no registered field behind them.
 *
 * These tests compare the STRUCTURES. Two independent lists that can drift
 * silently are exactly what produced the false claim, so the drift is what is
 * tested.
 */

import { describe, expect, it } from 'vitest';
import { makeSeed } from '@ws/core';
import {
  SCIENTIFIC_EXCLUSIONS,
  SCIENTIFIC_FIELDS,
  createWorld,
  scientificField,
} from '@ws/sim';

function world() {
  return createWorld({
    seed: makeSeed(0x1c, 0x5b),
    genesis: { level: 3, steps: 8, plateCount: 6 },
    terrainLevel: 3, climateN: 2, erode: false,
  });
}

/** Every FieldStore id a descriptor claims to visualise. */
function coveredFieldIds(): Set<string> {
  const out = new Set<string>();
  for (const d of SCIENTIFIC_FIELDS) {
    if (d.derived === true) continue;
    for (const src of d.source ?? [d.id]) out.add(src);
  }
  return out;
}

describe('T-0098 registry coverage is structural, not numerical', () => {
  it('gives every registered field a descriptor or an explicit exclusion', () => {
    /* THE test. It fails automatically when someone registers a new visualisable
       field without deciding how it is shown — which is the regression that
       "both lists are 32" could never catch. */
    const w = world();
    const covered = coveredFieldIds();
    const missing: string[] = [];
    for (const id of w.store.fieldIds()) {
      const name = String(id);
      if (covered.has(name)) continue;
      if (Object.prototype.hasOwnProperty.call(SCIENTIFIC_EXCLUSIONS, name)) continue;
      missing.push(name);
    }
    expect(missing,
      'registered fields with neither a scientific descriptor nor an entry in SCIENTIFIC_EXCLUSIONS')
      .toEqual([]);
  }, 60000);

  it('does not claim to cover fields that are not registered', () => {
    /* The other direction: a `source` pointing at a field that no longer exists
       is a descriptor that will throw the first time anyone selects it. */
    const w = world();
    const registered = new Set(w.store.fieldIds().map(String));
    const dangling: string[] = [];
    for (const d of SCIENTIFIC_FIELDS) {
      if (d.derived === true) continue;
      for (const src of d.source ?? [d.id]) {
        if (!registered.has(src)) dangling.push(`${d.id} -> ${src}`);
      }
    }
    expect(dangling, 'descriptors naming a FieldStore field that is not registered').toEqual([]);
  }, 60000);

  it('justifies every exclusion', () => {
    const w = world();
    const registered = new Set(w.store.fieldIds().map(String));
    for (const [id, reason] of Object.entries(SCIENTIFIC_EXCLUSIONS)) {
      expect(registered.has(id), `excluded '${id}' is not a registered field`).toBe(true);
      expect(reason.length, `exclusion of '${id}' has no reason`).toBeGreaterThan(40);
    }
  }, 60000);

  it('separates registry coverage from derived scientific views', () => {
    /* Derived views are legitimate and should keep existing — they are just not
       evidence of registry coverage, which is what conflating the two counts
       implied. */
    const derived = SCIENTIFIC_FIELDS.filter((d) => d.derived === true).map((d) => d.id);
    expect(derived.length).toBeGreaterThan(0);
    const w = world();
    const registered = new Set(w.store.fieldIds().map(String));
    for (const id of derived) {
      expect(registered.has(id), `'${id}' is marked derived but IS a registered field`).toBe(false);
    }
  }, 60000);
});

describe('T-0098 every descriptor actually resolves', () => {
  it('returns finite values, a sane level and correct arity for all of them', () => {
    const w = world();
    for (const d of SCIENTIFIC_FIELDS) {
      const view = scientificField(w, d.id);
      expect(view.descriptor.id, `${d.id}: wrong descriptor returned`).toBe(d.id);
      expect(view.values.length, `${d.id}: empty field`).toBeGreaterThan(0);
      expect(view.level, `${d.id}: no grid level`).toBeGreaterThan(0);
      if (d.grid === 'geodesic') {
        expect(view.positions, `${d.id}: geodesic view without positions`).toBeDefined();
      }
      if (d.kind === 'vector') {
        expect(view.vectorV, `${d.id}: vector view without a second component`).toBeDefined();
        expect(view.vectorV!.length).toBe(view.values.length);
      }
      for (let i = 0; i < view.values.length; i++) {
        if (!Number.isFinite(view.values[i] as number)) {
          throw new Error(`${d.id}[${String(i)}] is not finite`);
        }
      }
    }
  }, 120000);

  it('declares units and a legend for every descriptor', () => {
    /* "with correct units and legend" is part of the acceptance, so it is part
       of the test. */
    for (const d of SCIENTIFIC_FIELDS) {
      expect(d.units.length, `${d.id}: no units`).toBeGreaterThan(0);
      expect(d.label.length, `${d.id}: no label`).toBeGreaterThan(0);
      expect(d.ramp.length, `${d.id}: no ramp`).toBeGreaterThan(0);
      expect(d.domain[1], `${d.id}: empty domain`).toBeGreaterThan(d.domain[0]);
      if (d.kind === 'categorical' && d.categories !== undefined) {
        expect(Object.keys(d.categories).length).toBeGreaterThan(0);
      }
    }
  });

  it('has no duplicate descriptor ids', () => {
    const seen = new Set<string>();
    for (const d of SCIENTIFIC_FIELDS) {
      expect(seen.has(d.id), `duplicate descriptor '${d.id}'`).toBe(false);
      seen.add(d.id);
    }
  });
});
