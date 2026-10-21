/**
 * scripts/verify-offline: the standalone verifier (no repo imports) checked against the REAL kernel.
 *
 * Each mutation must turn exactly the leg it attacks red. A verifier that passed them all would be
 * measuring nothing (LESSONS 5), so every leg is shown capable of FAILED here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { buildFixtures } from '../scripts/verify-offline/make-fixture';
import { receiptHash, validateReceipt, verifyReceiptChain } from '../src/kernel/receipt';
import { POLICY_DOMAIN, POLICY_TYPES, policyTypedValue } from '../src/kernel/policy';
import type { KernelReceipt } from '../src/kernel/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { verifyLedger } = require('../scripts/verify-offline/verify-offline.cjs');

const DIR = join(__dirname, '..', 'scripts', 'verify-offline', 'fixtures');
const read = (f: string) => readFileSync(join(DIR, f), 'utf8').replace(/\r\n/g, '\n');
const GOOD = read('ledger.jsonl');
const TAMPERED = read('ledger.tampered.jsonl');
const OWNER = '0x0271fa8d4470907C2a1587A836861528aa31BADD';
const ENGINE = '0x7AdF801D0D187105D99bf0d10336b5bcEC84799B';
const anchors = { owner: OWNER, engineSigner: ENGINE };

type Line = Record<string, any>;
const parse = (t: string): Line[] => t.trim().split('\n').map((l) => JSON.parse(l));
const jsonl = (ls: Line[]) => ls.map((l) => JSON.stringify(l)).join('\n') + '\n';
const failed = (out: any, leg: string): string[] => out.legs[leg]?.failed ?? [];

/** Re-seal every receipt so hashes and links are self-consistent again (what a ledger writer can do). */
function reseal(ls: Line[]): Line[] {
  let prev: KernelReceipt | null = null;
  for (const l of ls) {
    if (l.kind !== 'receipt') continue;
    const r = l.receipt as KernelReceipt;
    r.header.prev_hash = prev ? prev.header.receipt_hash : null;
    r.header.prev_receipt_id = prev ? prev.header.receipt_id : null;
    r.header.receipt_hash = receiptHash(r);
    prev = r;
  }
  return ls;
}

describe('verify-offline', () => {
  it('the checked-in fixtures are byte-for-byte what the real kernel writes today', async () => {
    const f = await buildFixtures();
    expect(f.owner).toBe(OWNER);
    expect(f.engineSigner).toBe(ENGINE);
    // Fails when the receipt format changes: regenerate with scripts/verify-offline/make-fixture.ts.
    expect(f.ledger).toBe(GOOD);
    expect(f.tampered).toBe(TAMPERED);
  }, 120_000);

  it('the real kernel ledger PASSES, every leg verified, nothing failed', () => {
    const out = verifyLedger(GOOD, anchors);
    expect(out.exitCode).toBe(0);
    expect(out.summary.failed).toBe(0);
    for (const leg of ['receipt_hashes', 'chain_links', 'owner_policy_signature', 'invariants', 'within_policy', 'engine_signature']) {
      expect(out.legs[leg].verified).toBeGreaterThan(0);
    }
  });

  it('a re-sealed rewrite passes the hash chain and still FAILS on the owner policy and the engine signature', () => {
    const out = verifyLedger(TAMPERED, anchors);
    expect(out.exitCode).toBe(1);
    expect(failed(out, 'receipt_hashes')).toEqual([]); // the boundary: a hash chain alone cannot see this
    expect(failed(out, 'chain_links')).toEqual([]);
    expect(failed(out, 'within_policy').join()).toMatch(/not on the owner's list/);
    expect(failed(out, 'engine_signature').length).toBeGreaterThan(0);
  });

  it("agrees with the kernel's own checks, including on what neither can see", () => {
    for (const [text, label] of [[GOOD, 'good'], [TAMPERED, 'tampered']] as const) {
      const rs = parse(text).filter((l) => l.kind === 'receipt').map((l) => l.receipt as KernelReceipt);
      const ids = new Set(rs.filter((r) => r.decision.verdict === 'ALLOW' && !r.decision.executed).map((r) => r.header.receipt_id));
      expect([label, verifyReceiptChain(rs).ok]).toEqual([label, true]);
      for (const r of rs) expect([label, validateReceipt(r, { persisted_decision_ids: ids })]).toEqual([label, { ok: true }]);
    }
  });

  it('an edited receipt fails its hash', () => {
    const ls = parse(GOOD);
    ls[1]!.receipt.request.amount_raw = '1';
    expect(failed(verifyLedger(jsonl(ls), anchors), 'receipt_hashes').length).toBe(1);
  });

  it('a removed receipt breaks the chain', () => {
    const ls = parse(GOOD);
    ls.splice(3, 1);
    expect(failed(verifyLedger(jsonl(ls), anchors), 'chain_links').length).toBe(1);
  });

  it('a policy signed by another key fails, and so does every ALLOW under it', async () => {
    const ls = parse(GOOD);
    const other = new Wallet(keccak256(toUtf8Bytes('hyperdag/verify-offline/test-other/v1')));
    ls[0]!.policy.signature = await other.signTypedData(POLICY_DOMAIN, POLICY_TYPES, policyTypedValue(ls[0]!.policy.policy));
    const out = verifyLedger(jsonl(ls), anchors);
    expect(failed(out, 'owner_policy_signature').length).toBe(1);
    expect(failed(out, 'within_policy').join()).toMatch(/does not verify/);
  });

  it('the wrong pinned owner or engine signer fails', () => {
    const stranger = '0x000000000000000000000000000000000000dEaD';
    expect(failed(verifyLedger(GOOD, { ...anchors, owner: stranger }), 'owner_policy_signature').length).toBe(1);
    expect(failed(verifyLedger(GOOD, { ...anchors, engineSigner: stranger }), 'engine_signature').length).toBe(7);
  });

  it('a replayed spend authorization fails the one-use invariant', () => {
    const ls = parse(GOOD);
    const first = ls.find((l) => l.kind === 'receipt' && l.receipt.decision.verdict === 'ALLOW')!;
    const copy = JSON.parse(JSON.stringify(first));
    delete copy.engine_signature;
    copy.receipt.header.receipt_id = '00000000-0000-4000-8000-0000000000ff';
    ls.push(copy);
    expect(failed(verifyLedger(jsonl(reseal(ls)), anchors), 'invariants').join()).toMatch(/authorization reused/);
  });

  it('without trust anchors it says what it could not check, and never calls that a pass', () => {
    const out = verifyLedger(GOOD, {});
    expect(out.legs.engine_signature.verified).toBe(0);
    expect(out.legs.engine_signature.not_checked.join()).toMatch(/--engine-signer/);
    expect(out.legs.owner_policy_signature.not_checked.join()).toMatch(/--owner/);
    expect(out.legs.offline_limits.verified).toBe(0);
  });
});
