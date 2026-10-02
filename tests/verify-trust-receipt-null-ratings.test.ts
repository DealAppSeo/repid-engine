/**
 * Asymmetric null-`criterion_ratings` on the satisfaction-score leg.
 *
 * A receipt may carry a numeric `buyer_satisfaction_score` while its
 * `criterion_ratings` is the JSON value `null`. The verifier must treat that
 * as "no per-criterion ratings published": NOT_CHECKED (`??`). It must not
 * derive a pass from an unreadable null value, and it must not falsely FAIL
 * the leg because the numerator/denominator cannot be read.
 *
 * This file drives the REAL public verifier as a subprocess so the test is of
 * the artifact a stranger runs, not a copy of its logic.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'verify-trust-receipt.mjs');
const DIR = mkdtempSync(join(tmpdir(), 'receipt-verify-null-ratings-'));

interface RepEvent {
  agent: string;
  event: string;
  delta: number;
  from: number;
  to: number;
  decay?: number | null;
}

/** Minimal receipt carrying one reputation event. */
function receipt(events: RepEvent[]): Record<string, unknown> {
  return {
    contract_id: 'test-contract',
    settled_at: '2026-09-04T00:00:00Z',
    buyer: 'buyer-agent',
    provider: 'provider-agent',
    reputation_events: events,
  };
}

/** A receipt with a score and explicitly JSON-null criterion_ratings. */
function receiptWithNullRatings(score: number): Record<string, unknown> {
  return {
    ...receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 }]),
    buyer_satisfaction_score: score,
    criterion_ratings: null,
    claim: 'XC2-SENSITIVE-CLAIM-TEXT-NULL-RATINGS',
    user_id: 'XC2-USER-ID-NULL-RATINGS',
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

/** The `satisfaction score` line from the script's output. */
function satisfactionLine(out: string): string {
  const line = out.split('\n').find((l) => l.includes('satisfaction score'));
  if (!line) throw new Error(`no satisfaction score leg in output:\n${out}`);
  return line;
}

const outcomeOf = (line: string): 'VERIFIED' | 'NOT_CHECKED' | 'FAILED' =>
  line.includes('FAIL') ? 'FAILED' : line.includes('??') ? 'NOT_CHECKED' : 'VERIFIED';

const assertPrivacy = (out: string) => {
  // The exact secret payloads must not appear.
  expect(out).not.toContain('XC2-SENSITIVE-CLAIM-TEXT-NULL-RATINGS');
  expect(out).not.toContain('XC2-USER-ID-NULL-RATINGS');
  // The field names themselves must not appear anywhere in stdout/stderr.
  expect(out).not.toMatch(/\bclaim\b/);
  expect(out).not.toMatch(/\buser_id\b/);
};

describe('verify-trust-receipt: satisfaction score when criterion_ratings is JSON null', () => {
  it('is NOT_CHECKED when a score is present but criterion_ratings is null', () => {
    const { out, code } = run(receiptWithNullRatings(0.85));
    const line = satisfactionLine(out);
    expect(outcomeOf(line)).toBe('NOT_CHECKED');
    expect(line).toMatch(/\?\?/);
    expect(line).not.toMatch(/FAIL/);
    expect(line).toMatch(/no per-criterion ratings published/);
    expect(code).not.toBe(1); // never a false FAILED forgery for unreadable null ratings
    assertPrivacy(out);
  });

  it('does not treat null criterion_ratings as a measured 0.0000 VERIFIED pass', () => {
    // A forged score of exactly 0.0000 must not be reported as "exactly round(0/0, 4)"
    // because null is not an empty array and has no length to measure.
    const { out, code } = run(receiptWithNullRatings(0.0));
    const line = satisfactionLine(out);
    expect(outcomeOf(line)).toBe('NOT_CHECKED');
    expect(line).not.toMatch(/VERIFIED|ok/);
    expect(line).not.toMatch(/0\.0000/);
    expect(line).not.toMatch(/round\(/);
    expect(code).not.toBe(1);
    assertPrivacy(out);
  });

  it('does not treat null criterion_ratings as a measured 1.0000 VERIFIED pass', () => {
    const { out, code } = run(receiptWithNullRatings(1.0));
    const line = satisfactionLine(out);
    expect(outcomeOf(line)).toBe('NOT_CHECKED');
    expect(line).not.toMatch(/VERIFIED|ok/);
    expect(line).not.toMatch(/1\.0000/);
    expect(line).not.toMatch(/round\(/);
    expect(code).not.toBe(1);
    assertPrivacy(out);
  });

  it('never reports the leg as FAILED for any numeric score paired with null ratings', () => {
    for (const score of [0, 0.0001, 0.5, 0.85, 1, 1.5]) {
      const { out, code } = run(receiptWithNullRatings(score));
      const line = satisfactionLine(out);
      expect(outcomeOf(line)).toBe('NOT_CHECKED');
      expect(line).not.toMatch(/FAIL/);
      expect(code).not.toBe(1);
      assertPrivacy(out);
    }
  });
});
