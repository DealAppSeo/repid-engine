/**
 * P0 RECEIPT STRIP-AND-RESEAL. XC1, 2026-10-19 (Trust Harness, gate P0).
 *
 * PR #1358 ("Draft 4", F2) added a `capability_enforced` marker so that stripping the `capability`
 * row from an enforced ALLOW and resealing fails validateReceipt. Its body concedes the limit:
 * "Stripping the marker as well, then resealing, produces a different hash that looks like a
 * flag-OFF receipt." This file PROVES that concession on origin/main, measures how far it goes
 * (an enforced capability DENY can be rewritten into a valid ALLOW), and then measures which layer
 * DOES catch it: the receipt chain, and the engine's detached receipt signature.
 *
 * READ-ONLY on src/. The engine signing key used here is Wallet.createRandom(), set in process.env
 * for this file only and restored afterwards; it is never written anywhere and signs nothing real.
 * Same outcome vocabulary as p0-invariants.test.ts: [PASS …] it, [FAIL …] it.failing, CHARACTERISE.
 */
import { Wallet } from 'ethers';
import { createCapabilityRegistry } from '../../src/kernel/capability-registry';
import { CALLER_ASSERTED_CLASS_NOTE, CAPABILITY_ENFORCED_CHECK } from '../../src/kernel/decide';
import { runUnderKernel } from '../../src/kernel/gate';
import { POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2 } from '../../src/kernel/policy';
import { hashArgs, receiptHash, validateReceipt, verifyReceiptChain } from '../../src/kernel/receipt';
import type { KernelReceipt, OwnerPolicy } from '../../src/kernel/types';
import { AGENT_ID, NOW_S, PAYEE, harness, iso } from '../../src/kernel/__tests__/fixtures';
import { signReceipt, verifyReceiptSignature } from '../../src/services/receipt-signer';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const reseal = (r: KernelReceipt): KernelReceipt => {
  const c = clone(r);
  c.header.receipt_hash = receiptHash(c);
  return c;
};
const ENFORCEMENT_ROWS = new Set(['capability', CAPABILITY_ENFORCED_CHECK]);
const stripEnforcement = (r: KernelReceipt): KernelReceipt => {
  const c = clone(r);
  c.decision.checks = c.decision.checks.filter((x) => !ENFORCEMENT_ROWS.has(x.name));
  return c;
};
// CC1 2026-10-21: since the kernel fix, an enforced receipt no longer carries the flag-OFF class
// disclaimer, so the strip alone fails validateReceipt. The residual a forger still has is to ADD the
// disclaimer back, which makes the forgery a self-consistent flag-OFF receipt. The CHARACTERISE pins
// below now pin that residual.
const asFlagOff = (r: KernelReceipt): KernelReceipt => {
  const c = stripEnforcement(r);
  if (!c.decision.does_not_attest.includes(CALLER_ASSERTED_CLASS_NOTE)) c.decision.does_not_attest.splice(2, 0, CALLER_ASSERTED_CLASS_NOTE);
  // ...and, since P0-I3-01's fix, the flag-OFF read row a self-consistent flag-OFF ALLOW carries.
  c.decision.checks.push({ name: 'spend_authority', outcome: 'PASS', source: 'forged' });
  return c;
};

function readRequest(name: string) {
  return {
    agent: { agent_id: AGENT_ID, agent_name: 'kernel-demo-agent' },
    tool: { name, class: 'read' },
    origin: 'Cli',
    args_hash: hashArgs({ doc: 'hello' }),
  };
}

/** Flag ON. Returns a ledger with: an enforced ALLOW (decision + outcome) and an enforced DENY after it. */
async function enforcedLedger() {
  const formatter = jest.fn(async () => 'formatted');
  const reg = createCapabilityRegistry();
  reg.register({ implId: 'impl.formatter', capability: { id: 'format.markdown', toolClass: 'read' }, run: formatter });
  const h = harness({ capabilityRegistry: reg });
  const policy: OwnerPolicy = {
    subject: AGENT_ID, owner: h.owner.address, actions: ['tool'], payees: [PAYEE],
    per_tx_raw: '0', daily_raw: '0', total_raw: '0', expires_at: NOW_S + 3600, nonce: '1',
    authorized_impl_hashes: ['impl.formatter'],
  };
  await h.ledger.appendPolicy({ policy, signature: await h.owner.signTypedData(POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2(policy)) }, iso);
  const allow = await runUnderKernel(readRequest('impl.formatter'), formatter as unknown as () => Promise<string>, h.deps);
  const evil = jest.fn(async () => 'EXFIL');
  const deny = await runUnderKernel(readRequest('impl.exporter'), evil, h.deps);
  const chain = h.sink.records.flatMap((r) => (r.kind === 'receipt' ? [r.receipt] : []));
  return { allow, deny, chain, evil };
}

describe('P0-RS a receipt with BOTH the capability row and the capability_enforced marker stripped, then resealed', () => {
  it('positive control: the genuine enforced ALLOW and DENY validate, and both carry the marker and the capability row', async () => {
    const { allow, deny, chain, evil } = await enforcedLedger();
    expect(allow.verdict).toBe('ALLOW');
    expect(deny.verdict).toBe('DENY');
    expect(evil).toHaveBeenCalledTimes(0);
    for (const r of [allow.decision_receipt!, deny.decision_receipt!]) {
      expect(validateReceipt(r)).toEqual({ ok: true });
      expect(r.decision.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['capability', CAPABILITY_ENFORCED_CHECK]));
    }
    expect(verifyReceiptChain(chain)).toEqual({ ok: true });
  });

  it('[PASS P0-RS-01] stripping ONLY the capability row (marker kept) and resealing is refused (the #1358 F2 control holds)', async () => {
    const { allow } = await enforcedLedger();
    const c = clone(allow.decision_receipt!);
    c.decision.checks = c.decision.checks.filter((x) => x.name !== 'capability');
    const v = validateReceipt(reseal(c));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.path)).toContain('decision.checks.capability');
  });

  it('[FAIL P0-RS-02] stripping BOTH rows from an enforced ALLOW and resealing must not validate (BREACHED: #1358\'s concession, proven)', async () => {
    const { allow } = await enforcedLedger();
    expect(validateReceipt(reseal(stripEnforcement(allow.decision_receipt!))).ok).toBe(false);
  });
  it('CHARACTERISE P0-RS-02: the stripped, resealed ALLOW validates and reads as a flag-OFF receipt; only its hash differs from the original', async () => {
    const { allow } = await enforcedLedger();
    const original = allow.decision_receipt!;
    const forged = reseal(asFlagOff(original));
    expect(validateReceipt(forged)).toEqual({ ok: true });
    expect(forged.decision.checks.some((c) => ENFORCEMENT_ROWS.has(c.name))).toBe(false);
    expect(forged.header.receipt_hash).not.toBe(original.header.receipt_hash);
    expect(forged.header.receipt_id).toBe(original.header.receipt_id);
  });

  // Further than the concession: the stripped rows were the ONLY failing checks on a capability DENY,
  // because every REQUIRED_CHECKS row for a read already passed. Flip the verdict and it is a valid ALLOW.
  it('[FAIL P0-RS-03] an enforced capability DENY rewritten into an ALLOW (rows and reasons stripped, verdict flipped) and resealed must not validate (BREACHED)', async () => {
    const { deny } = await enforcedLedger();
    const c = stripEnforcement(deny.decision_receipt!);
    c.decision.verdict = 'ALLOW';
    c.decision.blocking = false;
    c.decision.reasons = [];
    expect(validateReceipt(reseal(c)).ok).toBe(false);
  });
  it('CHARACTERISE P0-RS-03: the rewritten DENY validates as an ALLOW for a tool the registry refused', async () => {
    const { deny } = await enforcedLedger();
    expect(deny.decision_receipt!.decision.reasons.map((r) => r.code)).toContain('unregistered_tool');
    const c = asFlagOff(deny.decision_receipt!);
    c.decision.verdict = 'ALLOW';
    c.decision.blocking = false;
    c.decision.reasons = [];
    const forged = reseal(c);
    expect(validateReceipt(forged)).toEqual({ ok: true });
    expect(forged.request.tool.name).toBe('impl.exporter');
  });

  it('[PASS P0-RS-04] substituted into the ledger, the forgery breaks the chain at the next entry (broken_link)', async () => {
    const { chain } = await enforcedLedger();
    const i = chain.findIndex((r) => r.decision.verdict === 'ALLOW' && !r.decision.executed);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(chain.length - 1);
    const tampered = [...chain];
    tampered[i] = reseal(stripEnforcement(chain[i]!));
    expect(verifyReceiptChain(tampered)).toMatchObject({ ok: false, index: i + 1, code: 'broken_link' });
  });

  it('CHARACTERISE P0-RS-05: the chain is unsigned, so re-sealing every entry from the forgery onward verifies again (and a forged TIP needs no re-seal at all)', async () => {
    const { chain } = await enforcedLedger();
    const i = chain.findIndex((r) => r.decision.verdict === 'ALLOW' && !r.decision.executed);
    const rebuilt: KernelReceipt[] = chain.slice(0, i);
    for (let k = i; k < chain.length; k++) {
      const c = k === i ? stripEnforcement(chain[k]!) : clone(chain[k]!);
      const prev = rebuilt[rebuilt.length - 1];
      c.header.prev_receipt_id = prev ? prev.header.receipt_id : null;
      c.header.prev_hash = prev ? prev.header.receipt_hash : null;
      rebuilt.push(reseal(c));
    }
    expect(verifyReceiptChain(rebuilt)).toEqual({ ok: true });
    expect(rebuilt[i]!.decision.checks.some((c) => ENFORCEMENT_ROWS.has(c.name))).toBe(false);
  });

  describe('the engine detached receipt signature (receipt-signer, used by the DB index)', () => {
    let saved: string | undefined;
    beforeAll(() => {
      saved = process.env['RECEIPT_SIGNING_KEY'];
      process.env['RECEIPT_SIGNING_KEY'] = Wallet.createRandom().privateKey; // in memory only
    });
    afterAll(() => {
      if (saved === undefined) delete process.env['RECEIPT_SIGNING_KEY'];
      else process.env['RECEIPT_SIGNING_KEY'] = saved;
    });

    it('[PASS P0-RS-06] the engine signature over the genuine receipt VERIFIES, and the same signature FAILS on the stripped, resealed body', async () => {
      const { allow, deny } = await enforcedLedger();
      const original = allow.decision_receipt!;
      const signed = await signReceipt(original);
      expect(signed.ok).toBe(true);
      if (!signed.ok) return;
      expect(verifyReceiptSignature(original, signed.signature).status).toBe('VERIFIED');
      expect(verifyReceiptSignature(reseal(stripEnforcement(original)), signed.signature).status).toBe('FAILED');
      // And on the DENY-to-ALLOW rewrite, against the signature the engine put on the real DENY.
      const signedDeny = await signReceipt(deny.decision_receipt!);
      expect(signedDeny.ok).toBe(true);
      if (!signedDeny.ok) return;
      const rewritten = stripEnforcement(deny.decision_receipt!);
      rewritten.decision.verdict = 'ALLOW';
      rewritten.decision.blocking = false;
      rewritten.decision.reasons = [];
      expect(verifyReceiptSignature(reseal(rewritten), signedDeny.signature).status).toBe('FAILED');
    });

    it('CHARACTERISE P0-RS-07: the signature attests WHO sealed, not that enforcement ran: the key holder can sign the stripped body and it VERIFIES', async () => {
      const { allow } = await enforcedLedger();
      const forged = reseal(stripEnforcement(allow.decision_receipt!));
      const signed = await signReceipt(forged);
      expect(signed.ok).toBe(true);
      if (signed.ok) expect(verifyReceiptSignature(forged, signed.signature).status).toBe('VERIFIED');
    });
  });

  it('[PASS P0-RS-08] with no engine key configured, the signature check on the forgery is NOT_CHECKED, never VERIFIED', async () => {
    const saved = process.env['RECEIPT_SIGNING_KEY'];
    const key = Wallet.createRandom().privateKey;
    process.env['RECEIPT_SIGNING_KEY'] = key;
    try {
      const { allow } = await enforcedLedger();
      const signed = await signReceipt(allow.decision_receipt!);
      delete process.env['RECEIPT_SIGNING_KEY'];
      expect(signed.ok).toBe(true);
      if (signed.ok) {
        expect(verifyReceiptSignature(reseal(stripEnforcement(allow.decision_receipt!)), signed.signature).status).toBe('NOT_CHECKED');
        expect(verifyReceiptSignature(allow.decision_receipt!, signed.signature).status).toBe('NOT_CHECKED');
      }
    } finally {
      if (saved === undefined) delete process.env['RECEIPT_SIGNING_KEY'];
      else process.env['RECEIPT_SIGNING_KEY'] = saved;
    }
  });
});
