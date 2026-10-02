/**
 * XC2 concern: a receipt whose `criterion_ratings` is a bare boolean (`true` or
 * `false`, not an array/object of rating rows) must yield NOT_CHECKED on the
 * satisfaction-score leg. A boolean shape cannot be read as a measurement, so
 * it must never be treated as `filter(met===true).length / n` — not as a forged
 * `0.0000` VERIFIED and not as a false FAILED for an unreadable ratings field.
 *
 * Drives the real `scripts/verify-trust-receipt.mjs --file` subprocess.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'verify-trust-receipt.mjs');
const DIR = mkdtempSync(join(tmpdir(), 'receipt-bool-ratings-'));

const CLAIM_TEXT = 'XC2-BOOLEAN-CRITERION-CLAIM-TEXT';
const USER_ID = 'XC2-BOOLEAN-CRITERION-USER-ID';

function receipt(ratings: boolean, score?: number): Record<string, unknown> {
  const r: Record<string, unknown> = {
    contract_id: 'test-contract',
    settled_at: '2026-09-04T00:00:00Z',
    buyer: 'buyer-agent',
    provider: 'provider-agent',
    claim: CLAIM_TEXT,
    user_id: USER_ID,
    criterion_ratings: ratings,
    reputation_events: [{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 }],
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
  expect(out).not.toMatch(/\bclaim\b/);
  expect(out).not.toMatch(/\buser_id\b/);
}

describe('verify-trust-receipt: boolean-shaped criterion_ratings', () => {
  it.each<
    [string, boolean, number | undefined]
  >([
    // Forged 0.0000 would match a vacuous "none met" count if the boolean were
    // treated as an empty or single-element array. It must not verify.
    ['true with a forged 0.0000 score', true, 0.0],
    // A non-zero score with false ratings must not produce a false FAILED.
    ['false with a 1.0000 score', false, 1.0],
    // The score may also be absent; the shape alone is enough to make the leg
    // unreadable.
    ['true with no score', true, undefined],
    ['false with no score', false, undefined],
  ])(
    'is NOT_CHECKED when criterion_ratings is %s, never derived or FAILED',
    (_label, ratings, score) => {
      const { out, code } = run(receipt(ratings, score));
      const line = satisfactionScoreLine(out);
      expect(outcomeOf(line)).toBe('NOT_CHECKED');
      expect(line).toMatch(/\?\?/);
      expect(line).not.toMatch(/FAIL/);
      expect(line).toMatch(/boolean/);
      expect(line).toMatch(/not an array of per-criterion rating rows/);
      expect(code).not.toBe(1); // no false FAILED forgery for an unreadable shape
      assertNoPrivacyLeak(out);
    },
  );

  it('never leaks claim text or user_id to stdout/stderr when ratings are a boolean', () => {
    const { out } = run(receipt(true, 0.5));
    assertNoPrivacyLeak(out);
  });
});
