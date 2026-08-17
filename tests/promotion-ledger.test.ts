/**
 * Promotion Ledger — the invariant under test is that a mechanism may be PROMOTED only on a ruled
 * measurement against a named incumbent.
 *
 * The final block pins the shipped register. It is written as a check that time can break
 * (LESSONS §6): if someone later marks one of the three stalled mechanisms `promoted` without
 * attaching a measurement, or lets a park lose its re-open condition, these go red rather than
 * waiting for a reader to notice.
 */
import {
  record,
  entryFaults,
  ledgerFaults,
  promotionBlockers,
  describeEntry,
  tally,
  UnjustifiedPromotionError,
  LedgerEntry,
} from '../src/orchestration/promotion-ledger';
import { PROMOTION_REGISTER, VERIFIED_ON } from '../src/orchestration/promotion-register';
import { buildCorpusManifest, CorpusCase } from '../src/hal/corpus-manifest';
import { recordMeasurement, MeasurementRuler } from '../src/hal/measurement-ruler';

const CASES: CorpusCase[] = [
  { id: 'a', text: 'the sky is green', expectedHallucination: true },
  { id: 'b', text: 'water boils at 100C at sea level', expectedHallucination: false },
];

function validRuler(): MeasurementRuler {
  return {
    corpus: buildCorpusManifest({
      corpusId: 'ledger-test-corpus',
      cases: CASES,
      builtAt: new Date('2026-08-17T00:00:00.000Z'),
    }),
    width: {
      familiesConfigured: 2,
      familiesMin: 2,
      familiesMax: 2,
      strictness: 2,
      decisionRequiresQuorum: true,
      penaltyRequiresQuorum: true,
    },
  };
}

function measured() {
  return recordMeasurement({
    matrix: { tp: 1, fp: 0, fn: 0, tn: 1 },
    ruler: validRuler(),
  });
}

const base: LedgerEntry = {
  mechanismId: 'a-mechanism',
  description: 'something',
  state: 'shadow',
  evidence: { kind: 'NOT_CHECKED', why: 'nobody has run it' },
  decidedAt: '2026-08-17',
  reference: 'src/somewhere.ts',
};

describe('the invariant: promotion requires measurement', () => {
  it('REFUSES promotion on NOT_CHECKED evidence', () => {
    expect(() => record({ ...base, state: 'promoted' })).toThrow(UnjustifiedPromotionError);
    const faults = entryFaults({ ...base, state: 'promoted' });
    expect(faults.map((f) => f.code)).toContain('PROMOTED_WITHOUT_MEASUREMENT');
  });

  it('REFUSES promotion on REFUSED evidence', () => {
    const entry: LedgerEntry = {
      ...base,
      state: 'promoted',
      evidence: { kind: 'REFUSED', why: 'the run was degraded; two providers held dead keys' },
    };
    expect(entryFaults(entry).map((f) => f.code)).toContain('PROMOTED_WITHOUT_MEASUREMENT');
  });

  it('ACCEPTS promotion on a ruled measurement against a named incumbent', () => {
    const entry: LedgerEntry = {
      ...base,
      state: 'promoted',
      evidence: { kind: 'MEASURED', measurement: measured(), incumbentId: 'the-incumbent' },
    };
    expect(() => record(entry)).not.toThrow();
    expect(entryFaults(entry)).toHaveLength(0);
  });

  it('refuses a measurement with no named incumbent — a delta needs two sides', () => {
    const entry: LedgerEntry = {
      ...base,
      state: 'promoted',
      evidence: { kind: 'MEASURED', measurement: measured(), incumbentId: '  ' },
    };
    expect(entryFaults(entry).map((f) => f.code)).toContain('MEASUREMENT_WITHOUT_INCUMBENT');
  });

  it('refuses a measurement whose ruler is unusable', () => {
    const broken = measured();
    // Same number, ruler quietly damaged — the case the ruler module exists to catch.
    const entry: LedgerEntry = {
      ...base,
      state: 'promoted',
      evidence: {
        kind: 'MEASURED',
        measurement: { ...broken, ruler: { ...broken.ruler, width: { ...broken.ruler.width, familiesConfigured: 0 } } },
        incumbentId: 'the-incumbent',
      },
    };
    expect(entryFaults(entry).map((f) => f.code)).toContain('MEASUREMENT_WITHOUT_USABLE_RULER');
  });
});

describe('the other states', () => {
  it('refuses a park with no re-open condition', () => {
    const entry: LedgerEntry = { ...base, state: 'parked' };
    const faults = entryFaults(entry);
    expect(faults.map((f) => f.code)).toContain('PARKED_WITHOUT_REOPEN_CONDITION');
  });

  it('accepts a park that says what would bring it back', () => {
    const entry: LedgerEntry = {
      ...base,
      state: 'parked',
      reopenCondition: 'when the ANFIS retune lands',
    };
    expect(entryFaults(entry)).toHaveLength(0);
  });

  it('refuses an empty reason — an empty string reads as "nothing there"', () => {
    const entry: LedgerEntry = { ...base, evidence: { kind: 'NOT_CHECKED', why: '   ' } };
    expect(entryFaults(entry).map((f) => f.code)).toContain('EMPTY_REASON');
  });

  it('allows rejection without a measurement, since deciding not to pursue needs no number', () => {
    const entry: LedgerEntry = {
      ...base,
      state: 'rejected',
      evidence: { kind: 'NOT_CHECKED', why: 'superseded by a simpler approach' },
    };
    expect(entryFaults(entry)).toHaveLength(0);
  });

  it('catches duplicate mechanism ids across a ledger', () => {
    const faults = ledgerFaults([base, { ...base, description: 'a different one' }]);
    expect(faults.map((f) => f.code)).toContain('DUPLICATE_MECHANISM_ID');
  });
});

describe('promotionBlockers', () => {
  it('names the evidence kind and its reason when promotion is impossible', () => {
    const blockers = promotionBlockers(base);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('NOT_CHECKED');
    expect(blockers[0]).toContain('nobody has run it');
  });

  it('is empty when the entry could be promoted right now', () => {
    const entry: LedgerEntry = {
      ...base,
      evidence: { kind: 'MEASURED', measurement: measured(), incumbentId: 'the-incumbent' },
    };
    expect(promotionBlockers(entry)).toHaveLength(0);
  });
});

describe('the shipped register', () => {
  it('is not empty — a ledger with nothing entered is canAssign() again', () => {
    expect(PROMOTION_REGISTER.length).toBeGreaterThanOrEqual(3);
  });

  it('is internally valid', () => {
    expect(ledgerFaults(PROMOTION_REGISTER)).toHaveLength(0);
  });

  it('holds NOTHING promoted, because nothing has been measured', () => {
    // Not an aspiration — Phase 0 of the plan says nothing is measurable while the fleet is down,
    // so a `promoted` entry appearing here means either a real measurement landed (in which case
    // this test should be updated deliberately) or the invariant was bypassed.
    expect(tally(PROMOTION_REGISTER).promoted).toBe(0);
  });

  it('gives every entry a concrete reason it cannot be promoted today', () => {
    for (const entry of PROMOTION_REGISTER) {
      const blockers = promotionBlockers(entry);
      expect(blockers.length).toBeGreaterThan(0);
      expect(blockers.join(' ')).not.toMatch(/undefined|\[object/);
    }
  });

  it('every entry points the reader at something they can check for themselves', () => {
    for (const entry of PROMOTION_REGISTER) {
      expect(entry.reference.trim().length).toBeGreaterThan(0);
      expect(entry.decidedAt).toBe(VERIFIED_ON);
    }
  });

  it('describes each entry in one readable line', () => {
    for (const entry of PROMOTION_REGISTER) {
      const line = describeEntry(entry);
      expect(line).toContain(entry.mechanismId);
      expect(line).toMatch(/\[(SHADOW|PROMOTED|PARKED|REJECTED)\]/);
    }
  });
});
