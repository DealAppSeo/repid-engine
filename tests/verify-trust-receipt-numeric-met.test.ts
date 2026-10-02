/**
 * Numeric `met` values on present criterion ratings.
 *
 * A receipt that publishes `criterion_ratings` but encodes every `met` as a
 * number (1, 0, 1.0) has no usable boolean measurement. The public verifier
 * must report the satisfaction-score leg as NOT_CHECKED, never derive a
 * 0.0000 pass and never falsely fail a non-zero score.
 *
 * These tests drive the real `scripts/verify-trust-receipt.mjs --file`
 * subprocess so they verify the artifact a stranger runs, not a copy of its
 * logic.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'verify-trust-receipt.mjs');
const DIR = mkdtempSync(join(tmpdir(), 'receipt-verify-'));

interface RepEvent {
  agent: string;
  event: string;
  delta: number;
  from: number;
  to: number;
  decay?: number | null;
}

/** A receipt with only the fields these legs read. */
function receipt(events: RepEvent[]): Record<string, unknown> {
  return {
    contract_id: 'test-contract',
    settled_at: '2026-09-04T00:00:00Z',
    buyer: 'buyer-agent',
    provider: 'provider-agent',
    reputation_events: events,
  };
}

/** Run the real script against a receipt; never throws on a non-zero exit. */
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

/** Any leg line by its human-readable name. */
function legLine(out: string, label: string): string {
  const line = out.split('\n').find((l) => l.includes(label));
  if (!line) throw new Error(`no ${label} leg in output:\n${out}`);
  return line;
}

const outcomeOf = (line: string): 'VERIFIED' | 'NOT_CHECKED' | 'FAILED' =>
  line.includes('FAIL') ? 'FAILED' : line.includes('??') ? 'NOT_CHECKED' : 'VERIFIED';

describe('verify-trust-receipt: numeric met values on present ratings', () => {
  const CLAIM = 'XC2-NUMERIC-MET-CLAIM-TEXT';
  const USER_ID = 'XC2-NUMERIC-MET-USER-ID';

  function assertPrivacy(out: string) {
    expect(out).not.toContain(CLAIM);
    expect(out).not.toContain(USER_ID);
    expect(out).not.toMatch(/\bclaim\b/);
    expect(out).not.toMatch(/\buser_id\b/);
  }

  /** A receipt whose criterion_ratings all carry numeric `met` values. */
  function receiptWithNumericMet(score: unknown, ratings: unknown[]): Record<string, unknown> {
    const r = receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 }]);
    r.buyer_satisfaction_score = score;
    r.criterion_ratings = ratings;
    r.claim = CLAIM;
    r.user_id = USER_ID;
    return r;
  }

  it.each<[string, unknown, unknown[]]>([
    ['all integer 1/0 with a forged-looking 0.0000 score', 0.0, [{ n: 1, met: 1 }, { n: 2, met: 0 }]],
    ['all float 1.0/0.0 with a forged-looking 0.0000 score', 0.0, [{ n: 1, met: 1.0 }, { n: 2, met: 0.0 }]],
    ['all 1 with a matching 1.0000 score that would otherwise falsely fail', 1.0, [{ n: 1, met: 1 }, { n: 2, met: 1 }]],
    ['single numeric 1 with a non-matching 0.5 score', 0.5, [{ n: 1, met: 1 }]],
    ['single numeric 0 with a non-matching 1.0 score', 1.0, [{ n: 1, met: 0 }]],
  ])(
    'is NOT_CHECKED when %s, never a forged VERIFIED or false FAILED',
    (_label, score, ratings) => {
      const { out, code } = run(receiptWithNumericMet(score, ratings));
      const line = legLine(out, 'satisfaction score');
      expect(outcomeOf(line)).toBe('NOT_CHECKED');
      expect(line).toMatch(/\?\?/);
      expect(line).not.toMatch(/FAIL/);
      expect(line).toMatch(/numeric/);
      expect(line).toMatch(/readable boolean/);
      expect(line).not.toMatch(/round\(/);
      expect(code).not.toBe(1);
      assertPrivacy(out);
    },
  );

  it('still VERIFIED when ratings contain real boolean met values', () => {
    const { out, code } = run(receiptWithNumericMet(0.5, [{ n: 1, met: true }, { n: 2, met: false }]));
    const line = legLine(out, 'satisfaction score');
    expect(outcomeOf(line)).toBe('VERIFIED');
    expect(code).toBe(0);
    assertPrivacy(out);
  });

  it('does not leak claim text or user_id from stdout/stderr when every met is numeric', () => {
    const { out, code } = run(receiptWithNumericMet(0.0, [{ n: 1, met: 1 }, { n: 2, met: 0 }]));
    expect(code).not.toBe(1);
    assertPrivacy(out);
  });
});
