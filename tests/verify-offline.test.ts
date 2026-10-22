/**
 * scripts/verify-offline: the standalone verifier (no repo imports) checked against the REAL kernel and a
 * REAL trustshell evidence card.
 *
 * Each mutation must turn exactly the leg it attacks red. A verifier that passed them all would be
 * measuring nothing (LESSONS 5), so every leg is shown capable of FAILED here.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { FORMAT, buildFixtures, tamperCard } from '../scripts/verify-offline/make-fixture';
import { receiptHash, validateReceipt, verifyReceiptChain } from '../src/kernel/receipt';
import { POLICY_DOMAIN, POLICY_TYPES, policyTypedValue } from '../src/kernel/policy';
import { canonicalJson } from '../src/services/owner-authorization';
import type { KernelReceipt } from '../src/kernel/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { verifyRecords } = require('../scripts/verify-offline/verify-offline.cjs');

const DIR = join(__dirname, '..', 'scripts', 'verify-offline', 'fixtures');
const read = (f: string) => readFileSync(join(DIR, f), 'utf8').replace(/\r\n/g, '\n');
const GOOD = read('ledger.jsonl');
const TAMPERED = read('ledger.tampered.jsonl');
const CARD = read('evidence-card.json');
const CARD_TAMPERED = read('evidence-card.tampered.json');
const OWNER = '0x0271fa8d4470907C2a1587A836861528aa31BADD';
const ENGINE = '0x7AdF801D0D187105D99bf0d10336b5bcEC84799B';
const anchors = { owner: OWNER, engineSigner: ENGINE };

type Line = Record<string, any>;
const parse = (t: string): Line[] => t.trim().split('\n').map((l) => JSON.parse(l));
const jsonl = (ls: Line[]) => ls.map((l) => JSON.stringify(l)).join('\n') + '\n';
const failed = (out: any, leg: string): string[] => out.legs[leg]?.failed ?? [];
const receiptsOf = (t: string) => parse(t).filter((l) => l.kind === 'kernel-receipt').map((l) => l.record as KernelReceipt);

/** Re-seal every receipt so hashes and links are self-consistent again (what a ledger writer can do). */
function reseal(ls: Line[]): Line[] {
  let prev: KernelReceipt | null = null;
  for (const l of ls) {
    if (l.kind !== 'kernel-receipt') continue;
    const r = l.record as KernelReceipt;
    r.header.prev_hash = prev ? prev.header.receipt_hash : null;
    r.header.prev_receipt_id = prev ? prev.header.receipt_id : null;
    r.header.receipt_hash = receiptHash(r);
    prev = r;
  }
  return ls;
}

describe('verify-offline: kernel ledgers as trustshell-evidence/1 records', () => {
  let f: Awaited<ReturnType<typeof buildFixtures>>;
  beforeAll(async () => {
    f = await buildFixtures();
  }, 120_000);

  it('the checked-in fixtures are byte-for-byte what the real kernel writes today', () => {
    expect([f.owner, f.engineSigner]).toEqual([OWNER, ENGINE]);
    // Fails when the receipt format changes: regenerate with scripts/verify-offline/make-fixture.ts.
    expect(f.ledger).toBe(GOOD);
    expect(f.tampered).toBe(TAMPERED);
    expect(parse(GOOD).every((l) => l.format === FORMAT)).toBe(true);
  });

  it('the real kernel ledger PASSES, every leg verified, nothing failed', () => {
    const out = verifyRecords(GOOD, anchors);
    expect(out.exitCode).toBe(0);
    expect(out.summary.failed).toBe(0);
    for (const leg of ['receipt_hashes', 'chain_links', 'owner_policy_signature', 'invariants', 'within_policy', 'engine_signature']) {
      expect(out.legs[leg].verified).toBeGreaterThan(0);
    }
  });

  it("the kernel store's own unwrapped JSONL verifies the same as the envelope", () => {
    expect(parse(f.raw).every((l) => l.kind === 'policy' || l.kind === 'receipt')).toBe(true);
    expect(verifyRecords(f.raw, anchors).summary).toEqual(verifyRecords(GOOD, anchors).summary);
  });

  it('a re-sealed rewrite passes the hash chain and still FAILS on the owner policy and the engine signature', () => {
    const out = verifyRecords(TAMPERED, anchors);
    expect(out.exitCode).toBe(1);
    expect(failed(out, 'receipt_hashes')).toEqual([]); // the boundary: a hash chain alone cannot see this
    expect(failed(out, 'chain_links')).toEqual([]);
    expect(failed(out, 'within_policy').join()).toMatch(/not on the owner's list/);
    expect(failed(out, 'engine_signature').length).toBeGreaterThan(0);
  });

  it("agrees with the kernel's own checks, including on what neither can see", () => {
    for (const [text, label] of [[GOOD, 'good'], [TAMPERED, 'tampered']] as const) {
      const rs = receiptsOf(text);
      const ids = new Set(rs.filter((r) => r.decision.verdict === 'ALLOW' && !r.decision.executed).map((r) => r.header.receipt_id));
      expect([label, verifyReceiptChain(rs).ok]).toEqual([label, true]);
      for (const r of rs) expect([label, validateReceipt(r, { persisted_decision_ids: ids })]).toEqual([label, { ok: true }]);
    }
  });

  it('an edited receipt fails its hash', () => {
    const ls = parse(GOOD);
    ls[1]!.record.request.amount_raw = '1';
    expect(failed(verifyRecords(jsonl(ls), anchors), 'receipt_hashes').length).toBe(1);
  });

  it('a removed receipt breaks the chain', () => {
    const ls = parse(GOOD);
    ls.splice(3, 1);
    expect(failed(verifyRecords(jsonl(ls), anchors), 'chain_links').length).toBe(1);
  });

  it('a receipt that drops its scope statement fails, even re-sealed', () => {
    const ls = parse(GOOD);
    ls[4]!.record.decision.does_not_attest = [];
    expect(failed(verifyRecords(jsonl(reseal(ls)), anchors), 'invariants').join()).toMatch(/does_not_attest/);
  });

  it('a policy signed by another key fails, and so does every ALLOW under it', async () => {
    const ls = parse(GOOD);
    const other = new Wallet(keccak256(toUtf8Bytes('hyperdag/verify-offline/test-other/v1')));
    ls[0]!.record.signature = await other.signTypedData(POLICY_DOMAIN, POLICY_TYPES, policyTypedValue(ls[0]!.record.policy));
    const out = verifyRecords(jsonl(ls), anchors);
    expect(failed(out, 'owner_policy_signature').length).toBe(1);
    expect(failed(out, 'within_policy').join()).toMatch(/does not verify/);
  });

  it('the wrong pinned owner or engine signer fails', () => {
    const stranger = '0x000000000000000000000000000000000000dEaD';
    expect(failed(verifyRecords(GOOD, { ...anchors, owner: stranger }), 'owner_policy_signature').length).toBe(1);
    expect(failed(verifyRecords(GOOD, { ...anchors, engineSigner: stranger }), 'engine_signature').length).toBe(7);
  });

  it('a replayed spend authorization fails the one-use invariant', () => {
    const ls = parse(GOOD);
    const first = ls.find((l) => l.kind === 'kernel-receipt' && l.record.decision.verdict === 'ALLOW')!;
    const copy = JSON.parse(JSON.stringify(first));
    delete copy.engine_signature;
    copy.record.header.receipt_id = '00000000-0000-4000-8000-0000000000ff';
    ls.push(copy);
    expect(failed(verifyRecords(jsonl(reseal(ls)), anchors), 'invariants').join()).toMatch(/authorization reused/);
  });

  it('without trust anchors it says what it could not check, and never calls that a pass', () => {
    const out = verifyRecords(GOOD, {});
    expect(out.legs.engine_signature.verified).toBe(0);
    expect(out.legs.engine_signature.not_checked.join()).toMatch(/--engine-signer/);
    expect(out.legs.owner_policy_signature.not_checked.join()).toMatch(/--owner/);
    expect(out.legs.offline_limits.verified).toBe(0);
  });
});

describe('verify-offline: trustshell evidence cards', () => {
  it("the captured card's own RFC 8785 digest (made by trustshell) verifies here", () => {
    const out = verifyRecords(CARD, {});
    expect(out.exitCode).toBe(0);
    expect(out.legs.record_digest.verified).toBe(1);
    expect(out.legs.card_scope.verified).toBe(1);
    expect(out.legs.card_verdicts.verified).toBeGreaterThan(0);
    expect(out.legs.offline_limits.not_checked.join()).toMatch(/unsigned/);
  });

  it('the tampered card fixture is derived from the captured one, byte for byte', () => {
    expect(tamperCard(CARD)).toBe(CARD_TAMPERED);
  });

  it('a flipped verdict with a recomputed digest still FAILS on the card\'s own observation', () => {
    const out = verifyRecords(CARD_TAMPERED, {});
    expect(out.exitCode).toBe(1);
    expect(failed(out, 'record_digest')).toEqual([]); // the boundary: an unsigned digest can be recomputed
    expect(failed(out, 'card_verdicts').join()).toMatch(/git\.head_sha/);
  });

  it('an edit without a new digest fails the digest', () => {
    const card = JSON.parse(CARD);
    card.record.claims[0].scope = 'everything is fine';
    expect(failed(verifyRecords(JSON.stringify(card), {}), 'record_digest').length).toBe(1);
  });

  it('a card that inflates or drops its assurance scope fails, even re-digested', () => {
    for (const edit of [(c: any) => { c.assurance.cryptographic_integrity = 'VERIFIED'; }, (c: any) => { c.does_not_prove = []; }]) {
      const card = JSON.parse(CARD);
      edit(card.record);
      card.digest.value = createHash('sha256').update(canonicalJson(card.record), 'utf8').digest('hex');
      const out = verifyRecords(JSON.stringify({ format: FORMAT, kind: 'action-evidence', ...card }), {});
      expect(failed(out, 'record_digest')).toEqual([]);
      expect(failed(out, 'card_scope').length).toBeGreaterThan(0);
    }
  });

  it('reserved kinds and unknown formats are NOT_CHECKED, never a pass', () => {
    const out = verifyRecords(jsonl([{ format: FORMAT, kind: 'guard-decision', record: {} }, { format: 'trustshell-evidence/9', kind: 'x', record: {} }]), {});
    expect(out.exitCode).toBe(2);
    expect(out.legs.reserved_kinds.not_checked.length).toBe(1);
    expect(out.legs.structure.not_checked.length).toBe(1);
  });
});
