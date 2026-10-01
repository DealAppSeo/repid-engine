/**
 * XC2 concern: a reputation event missing its `kind` (the `event` field) must
 * be NOT_CHECKED, never numeric 0, and never a false FAILED forgery for absence.
 *
 * Drives the real `scripts/verify-trust-receipt.mjs --file` subprocess.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'verify-trust-receipt.mjs');
const DIR = mkdtempSync(join(tmpdir(), 'receipt-kind-absence-'));

interface RepEvent {
  agent: string;
  event?: string | null;
  delta: number;
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

describe('verify-trust-receipt: missing event kind is NOT_CHECKED, never FAILED or numeric 0', () => {
  it.each([
    ['absent event key', { agent: 'a', delta: 20, from: 1000, to: 1020 }],
    ['null event', { agent: 'a', event: null, delta: 20, from: 1000, to: 1020 }],
    ['empty string event', { agent: 'a', event: '', delta: 20, from: 1000, to: 1020 }],
  ])(
    'NOT_CHECKED when %s',
    (_label, event) => {
      const { out } = run(receipt([event as RepEvent]));
      const line = ledgerLine(out);
      expect(outcomeOf(line)).toBe('NOT_CHECKED');
      expect(line).toMatch(/\?\?/);
      expect(line).not.toMatch(/FAIL/);
      expect(line).toMatch(/no event kind/);
      expect(line).not.toMatch(/0 of \d+ event\(s\) balance/);
      assertNoPrivacyLeak(out);
    },
  );

  it('still VERIFIED when the event kind is present and the arithmetic closes', () => {
    const { out } = run(receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 }]));
    expect(outcomeOf(ledgerLine(out))).toBe('VERIFIED');
    assertNoPrivacyLeak(out);
  });
});
