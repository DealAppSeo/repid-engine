/**
 * Harness Adoption Register -- pins the one entry docs/AGENT-HARNESS-ADOPTION-PLAN.md's concept
 * map produced, using the same ledger invariant proven in tests/promotion-ledger.test.ts.
 *
 * Importing src/orchestration/harness-adoption-register.ts is itself part of the check: `record()`
 * throws at module load on a malformed entry, so this file existing and running in `npm test` is
 * what makes that validation actually fire in CI rather than only on a human re-reading the file
 * (LESSONS 3 -- a check nothing calls is worse than no check).
 */
import { ledgerFaults, promotionBlockers, describeEntry, tally } from '../src/orchestration/promotion-ledger';
import { HARNESS_ADOPTION_REGISTER, VERIFIED_ON } from '../src/orchestration/harness-adoption-register';
import { PROMOTION_REGISTER } from '../src/orchestration/promotion-register';

describe('the harness adoption register', () => {
  it('is not empty', () => {
    expect(HARNESS_ADOPTION_REGISTER.length).toBeGreaterThanOrEqual(1);
  });

  it('is internally valid', () => {
    expect(ledgerFaults(HARNESS_ADOPTION_REGISTER)).toHaveLength(0);
  });

  it('holds NOTHING promoted, because nothing has been measured', () => {
    // Not an aspiration -- the entry's own evidence says the tables a measurement would compare
    // against are empty. A `promoted` entry appearing here means either a real measurement
    // landed (update this test deliberately) or the invariant was bypassed.
    expect(tally(HARNESS_ADOPTION_REGISTER).promoted).toBe(0);
  });

  it('gives every entry a concrete reason it cannot be promoted today', () => {
    for (const entry of HARNESS_ADOPTION_REGISTER) {
      const blockers = promotionBlockers(entry);
      expect(blockers.length).toBeGreaterThan(0);
      expect(blockers.join(' ')).not.toMatch(/undefined|\[object/);
    }
  });

  it('every entry points the reader at something they can check for themselves', () => {
    for (const entry of HARNESS_ADOPTION_REGISTER) {
      expect(entry.reference.trim().length).toBeGreaterThan(0);
      expect(entry.decidedAt).toBe(VERIFIED_ON);
    }
  });

  it('describes each entry in one readable line', () => {
    for (const entry of HARNESS_ADOPTION_REGISTER) {
      const line = describeEntry(entry);
      expect(line).toContain(entry.mechanismId);
      expect(line).toMatch(/\[(SHADOW|PROMOTED|PARKED|REJECTED)\]/);
    }
  });

  it('does not collide with promotion-register.ts mechanism ids', () => {
    // Two registers are only safe side by side (see the header on harness-adoption-register.ts)
    // if they never disagree about the same mechanism. Cheapest possible guard: no shared id.
    const otherIds = new Set(PROMOTION_REGISTER.map((e) => e.mechanismId));
    for (const entry of HARNESS_ADOPTION_REGISTER) {
      expect(otherIds.has(entry.mechanismId)).toBe(false);
    }
  });
});
