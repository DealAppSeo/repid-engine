/**
 * Asymmetric missing-`contract_id`-only case for the public receipt verifier.
 *
 * A receipt that carries a `settled_at` timestamp but cannot name its
 * `contract_id` must report `?? NOT_CHECKED` on the settlement / contract-binding
 * leg. The verifier must never invent a contract id as a measured pass and must
 * never treat absence as a false `FAILED` forgery.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'verify-trust-receipt.mjs');
const DIR = mkdtempSync(join(tmpdir(), 'receipt-verify-contract-id-'));

interface RepEvent {
  agent: string;
  event: string;
  delta: number;
  from: number;
  to: number;
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

const outcomeOf = (line: string): 'VERIFIED' | 'NOT_CHECKED' | 'FAILED' =>
  line.includes('FAIL') ? 'FAILED' : line.includes('??') ? 'NOT_CHECKED' : 'VERIFIED';

/** The `settlement / contract binding` line, as the script prints it. */
function bindingLine(out: string): string {
  const line = out.split('\n').find((l) => l.includes('settlement / contract binding'));
  if (!line) throw new Error(`no settlement / contract binding leg in output:\n${out}`);
  return line;
}

const CLAIM = 'XC2-SENSITIVE-CLAIM-TEXT-LEAK';
const USER_ID = 'XC2-USER-ID-LEAK';

function assertNoPrivacyLeak(out: string) {
  expect(out).not.toContain(CLAIM);
  expect(out).not.toContain(USER_ID);
  expect(out).not.toMatch(/\bclaim\b/);
  expect(out).not.toMatch(/\buser_id\b/);
}

describe('verify-trust-receipt: missing contract_id only is NOT_CHECKED, never pass or forgery', () => {
  it('NOT_CHECKED when contract_id key is absent while settled_at is present', () => {
    const { contract_id: _drop, ...withoutId } = receipt([
      { agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 },
    ]);
    const { out, code } = run({ ...withoutId, claim: CLAIM, user_id: USER_ID });
    const line = bindingLine(out);
    expect(outcomeOf(line)).toBe('NOT_CHECKED');
    expect(line).toMatch(/\?\?/);
    expect(line).not.toMatch(/FAIL/);
    expect(line).toMatch(/does not name a contract_id/);
    // The ledger is otherwise VERIFIED, so the script exits 0 — nothing FAILED.
    expect(code).toBe(0);
    assertNoPrivacyLeak(out);
  });

  it('NOT_CHECKED when contract_id is null while settled_at is present', () => {
    const { out, code } = run({
      ...receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 }]),
      contract_id: null,
      claim: CLAIM,
      user_id: USER_ID,
    });
    const line = bindingLine(out);
    expect(outcomeOf(line)).toBe('NOT_CHECKED');
    expect(line).toMatch(/\?\?/);
    expect(line).not.toMatch(/FAIL/);
    expect(line).toMatch(/does not name a contract_id/);
    expect(code).toBe(0);
    assertNoPrivacyLeak(out);
  });

  it('NOT_CHECKED when contract_id is an empty string while settled_at is present', () => {
    const { out, code } = run({
      ...receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 }]),
      contract_id: '',
      claim: CLAIM,
      user_id: USER_ID,
    });
    const line = bindingLine(out);
    expect(outcomeOf(line)).toBe('NOT_CHECKED');
    expect(line).toMatch(/\?\?/);
    expect(line).not.toMatch(/FAIL/);
    expect(line).toMatch(/does not name a contract_id/);
    expect(code).toBe(0);
    assertNoPrivacyLeak(out);
  });

  it('is silent on the binding leg when contract_id is present and verifiable', () => {
    const { out, code } = run({
      ...receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 }]),
      claim: CLAIM,
      user_id: USER_ID,
    });
    expect(out).not.toMatch(/settlement \/ contract binding/);
    expect(code).toBe(0);
    assertNoPrivacyLeak(out);
  });
});
