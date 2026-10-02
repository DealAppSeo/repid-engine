/**
 * XC2 receipts theme — asymmetric missing-`to` only.
 *
 * A `reputation_events` entry that has `from` / `delta` / `agent` / `event` but
 * is missing `to` (absent key / null / empty string) must report `??`
 * NOT_CHECKED on the reputation ledger arithmetic leg, never numeric `0`, and
 * never a false FAILED forgery for absence.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'verify-trust-receipt.mjs');
const DIR = mkdtempSync(join(tmpdir(), 'receipt-verify-to-'));

function receipt(events: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    contract_id: 'test-contract',
    settled_at: '2026-09-04T00:00:00Z',
    buyer: 'buyer-agent',
    provider: 'provider-agent',
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

describe('verify-trust-receipt: missing to score is NOT_CHECKED, never FAILED or numeric 0', () => {
  it.each([
    ['absent to key', { agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000 }],
    ['null to', { agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: null }],
    ['empty string to', { agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: '' }],
  ])('%s', (_label, event) => {
    const r = receipt([event]);
    (r as any).claim = 'XC2-SENSITIVE-CLAIM-TEXT-LEAK';
    (r as any).user_id = 'XC2-USER-ID-LEAK';
    const { out } = run(r);
    const line = ledgerLine(out);
    expect(outcomeOf(line)).toBe('NOT_CHECKED');
    expect(line).not.toMatch(/FAIL/);
    expect(line).toMatch(/no 'to' score/);
    expect(line).not.toMatch(/\b0\b/);
    expect(out).not.toMatch(/\bclaim\b/);
    expect(out).not.toMatch(/\buser_id\b/);
  });

  it('still VERIFIED when to is present and the arithmetic closes', () => {
    const { out } = run(receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 }]));
    expect(outcomeOf(ledgerLine(out))).toBe('VERIFIED');
  });
});
