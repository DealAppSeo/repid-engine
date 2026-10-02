/**
 * XC2 concern: a receipt whose `criterion_ratings` is a non-empty plain object
 * (map-like, not an array) must be NOT_CHECKED on the satisfaction-score leg —
 * never treated as `filter(met === true).length / n` pass (including a forged
 * 0.0000 VERIFIED) and never a false FAILED forgery for unreadable object-shaped
 * ratings.
 *
 * Drives the real `scripts/verify-trust-receipt.mjs --file` subprocess.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'verify-trust-receipt.mjs');
const DIR = mkdtempSync(join(tmpdir(), 'receipt-object-ratings-'));

const CLAIM_TEXT = 'XC2-SENSITIVE-CLAIM-TEXT';
const USER_ID = 'XC2-USER-ID-LEAK';
const RATING_NOTE = 'XC2-SECRET-RATING-NOTE';

function receipt(score: number | null, ratings: unknown): Record<string, unknown> {
  return {
    contract_id: 'test-contract',
    settled_at: '2026-09-04T00:00:00Z',
    buyer: 'buyer-agent',
    provider: 'provider-agent',
    claim: CLAIM_TEXT,
    user_id: USER_ID,
    reputation_events: [{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 }],
    buyer_satisfaction_score: score,
    criterion_ratings: ratings,
  };
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
  expect(out).not.toContain(RATING_NOTE);
  expect(out).not.toMatch(/\bclaim\b/);
  expect(out).not.toMatch(/\buser_id\b/);
}

describe('verify-trust-receipt: object-shaped criterion_ratings', () => {
  it.each<
    [string, number | null, Record<string, unknown>]
  >([
    [
      'named keys with mixed boolean met and a matching score',
      0.5,
      { speed: { met: true }, quality: { met: false } },
    ],
    [
      'string numeric keys with boolean met and a matching score',
      0.5,
      { '1': { met: true }, '2': { met: false } },
    ],
    [
      'a forged 0.0000 score with every met false',
      0,
      { '1': { met: false }, '2': { met: false } },
    ],
    [
      'a forged 1.0000 score with every met true',
      1,
      { '1': { met: true }, '2': { met: true } },
    ],
    [
      'a score present but ratings object has only unreadable shape',
      0.75,
      { speed: { met: 'yes' }, quality: { met: null } },
    ],
  ])(
    'is NOT_CHECKED when criterion_ratings is an object with %s',
    (_label, score, ratings) => {
      const { out, code } = run(receipt(score, ratings));
      const line = satisfactionScoreLine(out);
      expect(outcomeOf(line)).toBe('NOT_CHECKED');
      expect(line).toMatch(/\?\?/);
      expect(line).not.toMatch(/FAIL/);
      expect(line).toMatch(/no per-criterion ratings published/);
      expect(code).not.toBe(1);
      assertNoPrivacyLeak(out);
    },
  );

  it('never echoes object values, claim text, or user_id even when ratings carry secrets', () => {
    const ratings = {
      speed: { met: true, note: RATING_NOTE },
      quality: { met: false, claim: CLAIM_TEXT, user_id: USER_ID },
    };
    const { out, code } = run(receipt(1, ratings));
    const line = satisfactionScoreLine(out);
    expect(outcomeOf(line)).toBe('NOT_CHECKED');
    expect(line).not.toContain(RATING_NOTE);
    expect(line).not.toContain(CLAIM_TEXT);
    expect(line).not.toContain(USER_ID);
    expect(code).not.toBe(1);
    assertNoPrivacyLeak(out);
  });

  it('is NOT_CHECKED and exits 0 when the score is missing and ratings are object-shaped', () => {
    const { out, code } = run(receipt(null as unknown as number, { '1': { met: true } }));
    const line = satisfactionScoreLine(out);
    expect(outcomeOf(line)).toBe('NOT_CHECKED');
    expect(line).not.toMatch(/FAIL/);
    expect(code).not.toBe(1);
    assertNoPrivacyLeak(out);
  });
});
