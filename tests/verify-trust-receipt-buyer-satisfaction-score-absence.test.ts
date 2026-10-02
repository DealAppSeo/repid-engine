/**
 * XC2 concern: a receipt with non-empty `criterion_ratings` but missing
 * `buyer_satisfaction_score` must be NOT_CHECKED, never a derived-score pass
 * and never a false FAILED forgery for absence.
 *
 * Drives the real `scripts/verify-trust-receipt.mjs --file` subprocess.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'verify-trust-receipt.mjs');
const DIR = mkdtempSync(join(tmpdir(), 'receipt-satisfaction-absence-'));

const CLAIM_TEXT = 'XC2-SENSITIVE-CLAIM-TEXT';
const USER_ID = 'XC2-USER-ID-LEAK';
const RATING_NOTE_1 = 'XC2-SECRET-RATING-NOTE-1';
const RATING_NOTE_2 = 'XC2-SECRET-RATING-NOTE-2';

function receipt(score?: number | null): Record<string, unknown> {
  const r: Record<string, unknown> = {
    contract_id: 'test-contract',
    settled_at: '2026-09-04T00:00:00Z',
    buyer: 'buyer-agent',
    provider: 'provider-agent',
    claim: CLAIM_TEXT,
    user_id: USER_ID,
    criterion_ratings: [
      { n: 1, met: true, note: RATING_NOTE_1 },
      { n: 2, met: false, note: RATING_NOTE_2 },
    ],
  };
  if (score !== undefined) {
    r.buyer_satisfaction_score = score;
  }
  return r;
}

function run(r: Record<string, unknown>): { code: number; out: string } {
  const file = join(DIR, `r-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(r));
  try {
    const out = execFileSync('node', [SCRIPT, '--file', file], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function satisfactionScoreLine(out: string): string {
  const line = out.split('\n').find((l) => l.includes('satisfaction score'));
  if (!line) throw new Error(`no satisfaction score leg in output:\n${out}`);
  return line;
}

const outcomeOf = (line: string): 'VERIFIED' | 'NOT_CHECKED' | 'FAILED' =>
  line.includes('FAIL') ? 'FAILED' : line.includes('??') ? 'NOT_CHECKED' : 'VERIFIED';

function assertNoPrivacyLeak(out: string) {
  expect(out).not.toContain(CLAIM_TEXT);
  expect(out).not.toContain(USER_ID);
  expect(out).not.toContain(RATING_NOTE_1);
  expect(out).not.toContain(RATING_NOTE_2);
  expect(out).not.toMatch(/\bclaim\b/);
  expect(out).not.toMatch(/\buser_id\b/);
}

describe('verify-trust-receipt: missing buyer_satisfaction_score with ratings present', () => {
  it.each<
    [string, number | null | undefined]
  >([
    ['the key is absent', undefined],
    ['the key is present with null', null],
    // JavaScript `undefined` serializes to an absent key, so the absent-key
    // case above also covers a parsed undefined. This explicit row documents
    // the symmetry the leg must honour.
    ['the key is present with undefined', undefined],
  ])(
    'is NOT_CHECKED when buyer_satisfaction_score is %s',
    (_label, score) => {
      const { out, code } = run(receipt(score));
      const line = satisfactionScoreLine(out);
      expect(outcomeOf(line)).toBe('NOT_CHECKED');
      expect(line).toMatch(/\?\?/);
      expect(line).not.toMatch(/FAIL/);
      expect(line).toMatch(/no score recorded on the contract/);
      // No leg can VERIFIED without a score, a work statement, or on-chain txs.
      expect(code).toBe(2);
      assertNoPrivacyLeak(out);
    },
  );

  it('is VERIFIED when the score is present and matches the derived value', () => {
    // One of two criteria is met => round(1/2, 4) = 0.5000.
    const { out, code } = run(receipt(0.5));
    const line = satisfactionScoreLine(out);
    expect(outcomeOf(line)).toBe('VERIFIED');
    expect(line).toMatch(/exactly round\(1\/2, 4\) = 0\.5000/);
    expect(code).toBe(0);
    assertNoPrivacyLeak(out);
  });

  it('is FAILED when the score is present but does not match the derived value', () => {
    // One of two criteria is met => 0.5000, but the receipt asserts 1.0000.
    const { out, code } = run(receipt(1.0));
    const line = satisfactionScoreLine(out);
    expect(outcomeOf(line)).toBe('FAILED');
    expect(line).toMatch(/stored 1\.0000 is not round\(1\/2, 4\) = 0\.5000/);
    expect(code).toBe(1);
    assertNoPrivacyLeak(out);
  });
});
