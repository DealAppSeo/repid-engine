/**
 * The anchor ladder, and the one thing it must never do: call a healthy proof dead.
 *
 * MEASURED 2026-08-31 against production, which is why this file exists rather than a comment.
 * A stranger registered, fired one score event, and:
 *
 *     +4.96 s   proof complete, publicly retrievable, `anchored: false`
 *     +2 m 09 s EAS attestation mined on Base Sepolia (status 0x1, canonical EAS contract)
 *
 * For those two minutes the API returned exactly the same `anchored: false` it returns for a
 * legacy stub that will never be anchored at all. Two different truths, one boolean.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveAnchorStatus,
  easBlock,
  ANCHOR_PENDING_WINDOW_MS,
  ANCHOR_ELIGIBLE_SQL,
  ANCHOR_ELIGIBLE_SQL_COMMITMENT,
  type AnchorStatus,
} from '../src/services/anchor-status';

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();
const real = { is_real: true, zk_commitment: '0xabc' };

describe('deriveAnchorStatus', () => {
  it('an attestation uid is ANCHORED, whatever else the row says', () => {
    expect(deriveAnchorStatus({ eas_attestation_uid: '0x42de', ...real, created_at: agoMs(0) }, NOW)).toBe('ANCHORED');
    // …even for a row the worker would never have selected. We hold the uid; that is evidence.
    expect(deriveAnchorStatus({ eas_attestation_uid: '0x42de', is_real: false }, NOW)).toBe('ANCHORED');
  });

  it('a FRESH eligible proof is PENDING, not "false"', () => {
    // The two minutes the live probe spent here. This is the assertion the whole file is for.
    expect(deriveAnchorStatus({ ...real, created_at: agoMs(5_000) }, NOW)).toBe('PENDING');
    expect(deriveAnchorStatus({ ...real, created_at: agoMs(2 * 60_000 + 9_000) }, NOW)).toBe('PENDING');
  });

  it('the window is two poll intervals, so ONE slow cycle does not cry wolf', () => {
    const poll = ANCHOR_PENDING_WINDOW_MS / 2;
    expect(deriveAnchorStatus({ ...real, created_at: agoMs(poll * 1.5) }, NOW)).toBe('PENDING');
    expect(deriveAnchorStatus({ ...real, created_at: agoMs(ANCHOR_PENDING_WINDOW_MS + 1_000) }, NOW)).toBe('OVERDUE');
  });

  it('OVERDUE still means QUEUED — it must not read as abandoned', () => {
    // The worker's SELECT has no age ceiling: it backfills oldest-first forever. A 30-day-old
    // eligible proof is late, not rejected, and the copy has to say so or this status becomes
    // the new false negative.
    expect(deriveAnchorStatus({ ...real, created_at: agoMs(30 * 86_400_000) }, NOW)).toBe('OVERDUE');
    const { anchor_note } = easBlock({ ...real, created_at: agoMs(30 * 86_400_000) }, 'base-sepolia', NOW);
    expect(anchor_note).toMatch(/still queued/i);
    expect(anchor_note).not.toMatch(/fail|abandon|never/i);
  });

  it('an INELIGIBLE row is NOT_ELIGIBLE — promising it an anchor is the opposite lie', () => {
    // Without this rung every legacy stub reads PENDING forever: a chain write that is not coming,
    // announced as imminent. That is the same defect wearing the other sign.
    expect(deriveAnchorStatus({ is_real: false, zk_commitment: '0xabc', created_at: agoMs(0) }, NOW)).toBe('NOT_ELIGIBLE');
    expect(deriveAnchorStatus({ is_real: true, zk_commitment: null, created_at: agoMs(0) }, NOW)).toBe('NOT_ELIGIBLE');
    expect(deriveAnchorStatus({ created_at: agoMs(0) }, NOW)).toBe('NOT_ELIGIBLE');
  });

  it('an unreadable timestamp degrades to PENDING, never to OVERDUE', () => {
    // OVERDUE asserts the window EXPIRED. With no usable clock we cannot establish that, and the
    // direction of the failure is the whole point: claim less, not more.
    for (const created_at of [null, undefined, '', 'not-a-date']) {
      expect(deriveAnchorStatus({ ...real, created_at } as never, NOW)).toBe('PENDING');
    }
  });
});

describe('easBlock — the published shape', () => {
  it('keeps `anchored` byte-identical to the boolean consumers already read', () => {
    // @hyperdag/trustshell and the passport page read this field today. Redefining a shipped
    // boolean under them would be a fresh dishonesty, so the new status sits BESIDE it.
    expect(easBlock({ eas_attestation_uid: '0x42de', ...real }, 'base-sepolia', NOW).anchored).toBe(true);
    expect(easBlock({ ...real, created_at: agoMs(1000) }, 'base-sepolia', NOW).anchored).toBe(false);
  });

  it('every status carries a note, and no note contradicts its status', () => {
    const cases: Array<[AnchorStatus, object]> = [
      ['ANCHORED', { eas_attestation_uid: '0x1', ...real }],
      ['PENDING', { ...real, created_at: agoMs(1_000) }],
      ['OVERDUE', { ...real, created_at: agoMs(ANCHOR_PENDING_WINDOW_MS * 3) }],
      ['NOT_ELIGIBLE', { is_real: false }],
    ];
    for (const [expected, row] of cases) {
      const b = easBlock(row, 'base-sepolia', NOW);
      expect(b.anchor_status).toBe(expected);
      expect(b.anchor_note.length).toBeGreaterThan(20);
    }
    // PENDING must state the proof is ALREADY usable — that is the expectation being managed.
    expect(easBlock({ ...real, created_at: agoMs(1_000) }, 'base-sepolia', NOW).anchor_note)
      .toMatch(/verifiable/i);
  });
});

describe('the read model cannot drift from the worker that does the writing', () => {
  it("every eligibility SELECT in the worker carries the predicate this module mirrors", () => {
    // Counting occurrences of `eas_attestation_uid IS NULL` was the first draft and it was
    // WRONG: the worker uses that clause three times, and the third is the writeback UPDATE's
    // concurrency guard, not an eligibility SELECT. It has no business carrying `is_real`, so
    // the count never matched and the pin failed against correct code. Anchor on the SELECTs
    // themselves — the statements that decide what gets anchored — and assert each one filters
    // on BOTH clauses. That is the invariant; the occurrence count never was.
    const worker = readFileSync(join(__dirname, '..', 'src', 'workers', 'eas-anchor-worker.ts'), 'utf8');
    const selects = worker
      .split(/\bSELECT\b/)
      .slice(1)
      .filter((s) => /FROM repid_zkp_proofs/.test(s))
      .map((s) => s.slice(0, s.search(/ORDER BY|LIMIT|`/) + 1 || s.length));

    expect(selects.length).toBeGreaterThanOrEqual(2); // unanchoredCount + selectBatch
    for (const sql of selects) {
      expect(sql).toContain('eas_attestation_uid IS NULL');
      expect(sql).toContain(ANCHOR_ELIGIBLE_SQL);
      expect(sql).toContain(ANCHOR_ELIGIBLE_SQL_COMMITMENT);
    }
  });
});
