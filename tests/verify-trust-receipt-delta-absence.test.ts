/**
 * XC2 concern: a reputation event missing `delta` must be NOT_CHECKED, never
 * numeric 0 and never a false FAILED forgery for absence.
 *
 * Drives the real `scripts/verify-trust-receipt.mjs --file` subprocess.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'verify-trust-receipt.mjs');
const DIR = mkdtempSync(join(tmpdir(), 'receipt-delta-absence-'));

interface RepEvent {
  agent: string;
  event: string;
  delta?: number | null;
  from: number;
  to: number;
  decay?: number | null;
}

function receipt(events: RepEvent[]): Record<string, unknown> {
  return {
    contract_id: 'test-contract',
    settled_at: '2026-09-04T00:00:00Z',
    buyer: 'buyer-agent',
    provider: 'provider-agent',
    claim: 'XC2-SENSITIVE-CLAIM-TEXT',
    user_id: 'XC2-USER-ID-LEAK',
    reputation_events: events,
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

function ledgerLine(out: string): string {
  const line = out.split('\n').find((l) => l.includes('reputation ledger arithmetic'));
  if (!line) throw new Error(`no ledger leg in output:\n${out}`);
  return line;
}

const outcomeOf = (line: string): 'VERIFIED' | 'NOT_CHECKED' | 'FAILED' =>
  line.includes('FAIL') ? 'FAILED' : line.includes('??') ? 'NOT_CHECKED' : 'VERIFIED';

function assertNoPrivacyLeak(out: string) {
  expect(out).not.toMatch(/\bclaim\b/);
  expect(out).not.toMatch(/\buser_id\b/);
  expect(out).not.toContain('XC2-SENSITIVE-CLAIM-TEXT');
  expect(out).not.toContain('XC2-USER-ID-LEAK');
}

describe('verify-trust-receipt: missing delta is NOT_CHECKED, never 0 or FAILED', () => {
  it.each([
    ['absent', { agent: 'a', event: 'SERVICE_FULFILLED', from: 1000, to: 1000 }],
    ['null', { agent: 'a', event: 'SERVICE_FULFILLED', delta: null, from: 1000, to: 1000 }],
  ])('NOT_CHECKED when delta is %s and the score did not move', (_label, event) => {
    // This is the numeric-0 trap: `to - from - null` is 0, which the old code
    // treated as "balances if no decay", yielding VERIFIED/assumed.
    const { out } = run(receipt([event as RepEvent]));
    expect(outcomeOf(ledgerLine(out))).toBe('NOT_CHECKED');
    expect(ledgerLine(out)).toMatch(/\?\?/);
    expect(ledgerLine(out)).not.toMatch(/FAIL/);
    assertNoPrivacyLeak(out);
  });

  it.each([
    ['absent', { agent: 'a', event: 'SERVICE_FULFILLED', from: 1000, to: 1020 }],
    ['null', { agent: 'a', event: 'SERVICE_FULFILLED', delta: null, from: 1000, to: 1020 }],
  ])('NOT_CHECKED when delta is %s and the score rose', (_label, event) => {
    // This is the false-FAILED trap: `to - from - null` is +20, which the old
    // code treated as an unexplained upward move.
    const { out } = run(receipt([event as RepEvent]));
    expect(outcomeOf(ledgerLine(out))).toBe('NOT_CHECKED');
    expect(ledgerLine(out)).toMatch(/\?\?/);
    expect(ledgerLine(out)).not.toMatch(/FAIL/);
    assertNoPrivacyLeak(out);
  });

  it.each([
    ['absent', { agent: 'a', event: 'SERVICE_FULFILLED', from: 1000, to: 990 }],
    ['null', { agent: 'a', event: 'SERVICE_FULFILLED', delta: null, from: 1000, to: 990 }],
  ])('NOT_CHECKED when delta is %s and the score fell', (_label, event) => {
    const { out } = run(receipt([event as RepEvent]));
    expect(outcomeOf(ledgerLine(out))).toBe('NOT_CHECKED');
    expect(ledgerLine(out)).toMatch(/\?\?/);
    expect(ledgerLine(out)).not.toMatch(/FAIL/);
    assertNoPrivacyLeak(out);
  });

  it('NOT_CHECKED when delta is absent and a decay is published', () => {
    // The NaN trap: `clamp(from - decay + undefined)` is NaN, which the old
    // code reported as FAILED with a NaN message.
    const { out } = run(
      receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', from: 1000, to: 990, decay: 30 }]),
    );
    expect(outcomeOf(ledgerLine(out))).toBe('NOT_CHECKED');
    expect(ledgerLine(out)).toMatch(/\?\?/);
    expect(ledgerLine(out)).not.toMatch(/FAIL/);
    expect(ledgerLine(out)).not.toMatch(/\bNaN\b/);
    assertNoPrivacyLeak(out);
  });

  it('still VERIFIED for a legitimate zero delta', () => {
    const { out } = run(
      receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 0, from: 1000, to: 1000 }]),
    );
    expect(outcomeOf(ledgerLine(out))).toBe('VERIFIED');
    assertNoPrivacyLeak(out);
  });
});
