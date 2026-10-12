/**
 * The policy kernel REFUSES.
 *
 * The demo (a) is the MVP's acceptance test: a throwaway owner signs a policy that sets the spend
 * limit to zero, an agent asks to spend 10000, and the kernel says no BEFORE the tool runs — the
 * spy tool is called zero times and the receipt says executed:false. No wallet is funded, no chain
 * is dialled, nothing is spent: the owner key exists in memory for the length of the test.
 *
 * A refusal demo proves nothing if the kernel refuses everything, or if the demo would still pass
 * with the kernel switched to "allow". So there are two guards beside it:
 *   - POSITIVE CONTROLS (a2, c2): the same kernel ALLOWS what the policy permits;
 *   - NON-VACUITY (d): swap decide() for a default-allow and the demo must FAIL.
 */
import { Wallet } from 'ethers';
import * as decideModule from '../decide';
import { CUMULATIVE_TOTAL_NOTE, REQUIRED_CHECKS, TOTAL_CAP_SCOPE_NOTE, decide, parseAmountRaw } from '../decide';
import { runUnderKernel } from '../gate';
import { POLICY_DOMAIN, POLICY_TYPES, parsePolicy, policyHash, policyTypedValue } from '../policy';
import { hashArgs, validateReceipt, verifyReceiptChain } from '../receipt';
import type { DecideInput, DecisionLeg, HalEvidence, KernelLedger, KernelReceipt, OwnerPolicy } from '../types';
import { AGENT_ID, NOW_S, PAYEE, harness, iso, postRequest, signedPolicy, spendRequest } from './fixtures';

const codes = (r: { reasons: Array<{ code: string }> }) => r.reasons.map((x) => x.code);
const check = (r: KernelReceipt, name: string) => r.decision.checks.find((c) => c.name === name)?.outcome;

// ── (a) THE REFUSAL DEMO ────────────────────────────────────────────────────────────────────────

/** Written as a function so (d) can run it against a broken kernel and watch it fail. */
async function refusalDemo(): Promise<void> {
  const h = harness();
  // The throwaway owner signs a policy whose per-transaction spend limit is 0.
  await h.ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '0' }), iso);

  const tool = jest.fn(async () => 'money moved');
  const out = await runUnderKernel(spendRequest({ amount_raw: 10000 }), tool, h.deps);

  expect(tool).toHaveBeenCalledTimes(0); // refused BEFORE the tool ran
  expect(out.executed).toBe(false);
  expect(out.decision_receipt?.decision.executed).toBe(false);
  expect(out.verdict).toBe('DENY');
  expect(codes(out)).toContain('spend_limit_zero');
  expect(out.blocking).toBe(true);
  expect(out.persisted).toBe(true);
}

describe('(a) a throwaway owner sets the spend limit to zero; a spend of 10000 is refused', () => {
  it('DENY(spend_limit_zero), the tool is called 0 times, the receipt says executed:false', async () => {
    await refusalDemo();
  });

  it('the receipt is a valid kernel-receipt/1 that says why, with the policy VERIFIED and the owner resolved', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '0' }), iso);
    const tool = jest.fn();
    const out = await runUnderKernel(spendRequest(), tool, h.deps);

    const r = out.decision_receipt!;
    expect(validateReceipt(r)).toEqual({ ok: true });
    expect(r.header.schema).toBe('kernel-receipt/1');
    expect(r.header.signer).toBeNull();
    expect(r.decision.verdict).toBe('DENY');
    expect(r.decision.executed).toBe(false);
    expect(check(r, 'owner_resolved')).toBe('PASS');
    expect(check(r, 'policy_signature')).toBe('PASS');
    expect(check(r, 'spend_limit')).toBe('FAIL');
    expect(r.decision.policy.signature).toBe('VERIFIED');
    expect(r.decision.limits.per_tx_raw).toBe('0');
    expect(r.decision.limits.effective_per_tx_raw).toBe('0');
    expect(r.decision.limits.binding_term).toBe('per_tx');
    expect(r.payment.status).toBe('NOT_APPLICABLE'); // no payment on a refusal
    expect(r.verification.status).toBe('NOT_APPLICABLE');
    expect(r.decision.does_not_attest).toContain('cumulative_total (no atomic reservation)');
    expect(r.request.args_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toContain('example.invalid'); // raw arguments are not in the record
    expect(r.decision.laya).toEqual({ lane: null, mode: 'shadow', consulted: false });
    expect(out.final_receipt).toBe(out.decision_receipt); // a refusal has exactly one record
  });

  it('exactly one ledger entry is written for the refusal, and the chain verifies', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '0' }), iso);
    await runUnderKernel(spendRequest(), jest.fn(), h.deps);
    const receipts = h.sink.records.flatMap((r) => (r.kind === 'receipt' ? [r.receipt] : []));
    expect(receipts).toHaveLength(1);
    expect(verifyReceiptChain(receipts)).toEqual({ ok: true });
  });
});

describe('(a2) positive control: the same kernel ALLOWS what the owner permitted', () => {
  it('ALLOW → tool called once → two ledger entries for one call id, chained, the second executed:true', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 'paid');
    const out = await runUnderKernel(spendRequest({ amount_raw: '10000' }), tool, h.deps);

    expect(out.verdict).toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(1);
    expect(out.executed).toBe(true);
    expect(out.result).toBe('paid');
    expect(out.decision_receipt!.decision.executed).toBe(false); // written BEFORE the run
    expect(out.final_receipt!.decision.executed).toBe(true);
    expect(out.final_receipt!.header.receipt_id).toBe(out.decision_receipt!.header.receipt_id);
    expect(out.final_receipt!.header.prev_hash).toBe(out.decision_receipt!.header.receipt_hash);
    expect(out.decision_receipt!.payment.status).toBe('AUTHORIZED');
    expect(out.final_receipt!.payment.status).toBe('SUBMITTED');
    expect(out.final_receipt!.payment.settlement_evidence).toBe('NOT_CHECKED'); // authorised ≠ observed
    expect(out.final_receipt!.payment.is_simulated).toBe(true);
    expect(out.decision_receipt!.decision.limits.effective_per_tx_raw).toBe('1000000');
    expect(out.decision_receipt!.decision.limits.binding_term).toBe('per_tx');

    const receipts = h.sink.records.flatMap((r) => (r.kind === 'receipt' ? [r.receipt] : []));
    expect(receipts).toHaveLength(2);
    expect(verifyReceiptChain(receipts)).toEqual({ ok: true });
    expect(receipts.every((r) => validateReceipt(r, { persisted_decision_ids: new Set([r.header.receipt_id]) }).ok)).toBe(true);
  });

  it('an amount over a non-zero limit is DENY(spend_limit_exceeded), not zero', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '5000' }), iso);
    const tool = jest.fn();
    const out = await runUnderKernel(spendRequest({ amount_raw: 10000 }), tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('spend_limit_exceeded');
    expect(tool).not.toHaveBeenCalled();
  });

  it('the daily limit binds across calls: the second spend is refused once the day is spent', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '600000', daily_raw: '1000000', total_raw: '9000000' }), iso);
    const tool = jest.fn(async () => 'ok');
    const first = await runUnderKernel(spendRequest({ amount_raw: 600000 }), tool, h.deps);
    const second = await runUnderKernel(spendRequest({ amount_raw: 600000 }), tool, h.deps);
    expect(first.verdict).toBe('ALLOW');
    expect(second.verdict).toBe('DENY');
    expect(second.decision_receipt!.decision.limits.binding_term).toBe('daily');
    expect(second.decision_receipt!.decision.limits.effective_per_tx_raw).toBe('400000');
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it('a tool that throws after ALLOW is recorded as executed with a FAILED payment, not hidden', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const out = await runUnderKernel(spendRequest(), async () => { throw new TypeError('secret detail that must not be stored'); }, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(out.executed).toBe(true);
    expect(out.tool_error).toBe('TypeError');
    expect(out.final_receipt!.payment.status).toBe('FAILED');
    expect(codes(out)).toContain('tool_error');
    expect(JSON.stringify(out.final_receipt)).not.toContain('secret detail');
  });
});

// ── (b) NOT_CHECKED blocks: the policy store fails ──────────────────────────────────────────────

describe('(b) NOT_CHECKED is blocking', () => {
  it('a policy store that throws → NOT_CHECKED(policy_store_unavailable); the tool does not run; the refusal is recorded', async () => {
    const h = harness({ policySource: { latest: async () => { throw new Error('connection refused'); } } });
    const tool = jest.fn(async () => 'ran');
    const out = await runUnderKernel(spendRequest(), tool, h.deps);

    expect(out.verdict).toBe('NOT_CHECKED');
    expect(out.blocking).toBe(true);
    expect(out.executed).toBe(false);
    expect(tool).toHaveBeenCalledTimes(0);
    expect(codes(out)).toContain('policy_store_unavailable');
    expect(check(out.decision_receipt!, 'policy_present')).toBe('NOT_CHECKED');
    expect(out.decision_receipt!.decision.executed).toBe(false);
    expect(validateReceipt(out.decision_receipt!)).toEqual({ ok: true });
  });

  it('NOT_CHECKED blocks a spend, a post, and a plain tool alike', async () => {
    const h = harness({ policySource: { latest: async () => { throw new Error('down'); } } });
    for (const req of [spendRequest(), postRequest(), { ...postRequest(), tool: { name: 'fs.read', class: 'read' } }]) {
      const tool = jest.fn();
      const out = await runUnderKernel(req, tool, h.deps);
      expect(out.verdict).toBe('NOT_CHECKED');
      expect(tool).not.toHaveBeenCalled();
    }
  });

  it('an owner lookup that throws, or answers "unknown" → NOT_CHECKED(owner_not_checked)', async () => {
    for (const resolveOwner of [
      async () => { throw new Error('db down'); },
      async () => ({ status: 'unknown' as const, wallet: null, assurance: null }),
      async () => ({ status: 'resolved' as const, wallet: null, assurance: null }), // "resolved" with nobody to compare against
    ]) {
      const h = harness({ resolveOwner });
      await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
      const tool = jest.fn();
      const out = await runUnderKernel(spendRequest(), tool, h.deps);
      expect(out.verdict).toBe('NOT_CHECKED');
      expect(codes(out)).toContain('owner_not_checked');
      expect(tool).not.toHaveBeenCalled();
    }
  });

  it('an agent nobody answers for is DENY(owner_none), however well-signed its policy', async () => {
    const h = harness({ resolveOwner: async () => ({ status: 'none', wallet: null, assurance: null }) });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn();
    const out = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('owner_none');
    expect(tool).not.toHaveBeenCalled();
  });

  it('a chain that cannot be reached for the signature check → NOT_CHECKED(policy_signature_not_checked)', async () => {
    const h = harness({ chain: { getCode: async () => { throw new Error('rpc down'); }, call: async () => { throw new Error('rpc down'); } } });
    // Signed by someone else, claiming the owner's address: ecrecover cannot vouch, so the check
    // needs the chain (is this a smart wallet?) — and the chain will not answer.
    const impostor = Wallet.createRandom();
    await h.ledger.appendPolicy(await signedPolicy(impostor, { claimedOwner: h.owner.address }), iso);
    const tool = jest.fn();
    const out = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(codes(out)).toContain('policy_signature_not_checked');
    expect(out.decision_receipt!.decision.policy.signature).toBe('NOT_CHECKED');
    expect(tool).not.toHaveBeenCalled();
  });

  it('...and a signature that is simply wrong (no smart wallet there) is DENY(policy_signature_invalid), a different answer', async () => {
    const h = harness(); // default offline chain: every address is a plain wallet
    const impostor = Wallet.createRandom();
    await h.ledger.appendPolicy(await signedPolicy(impostor, { claimedOwner: h.owner.address }), iso);
    const out = await runUnderKernel(spendRequest(), jest.fn(), h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('policy_signature_invalid');
    expect(out.decision_receipt!.decision.policy.signature).toBe('FAILED');
    expect(out.decision_receipt!.decision.limits.effective_per_tx_raw).toBe('0'); // a forged policy's numbers are not used
  });

  it('a policy validly signed by someone who is NOT the accountable owner is DENY(policy_signer_not_owner)', async () => {
    const h = harness();
    const stranger = Wallet.createRandom();
    await h.ledger.appendPolicy(await signedPolicy(stranger), iso); // genuine signature, wrong person
    const out = await runUnderKernel(spendRequest(), jest.fn(), h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('policy_signer_not_owner');
  });

  it('spend totals that cannot be read → NOT_CHECKED, even though the per-tx limit alone would allow', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const broken: KernelLedger = { appendReceipt: (b) => h.ledger.appendReceipt(b), appendPolicy: (p, t) => h.ledger.appendPolicy(p, t), latestPolicy: (s) => h.ledger.latestPolicy(s), findReceipts: (i) => h.ledger.findReceipts(i), spentTotals: async () => { throw new Error('read failed'); } };
    const tool = jest.fn();
    const out = await runUnderKernel(spendRequest(), tool, { ...h.deps, ledger: broken });
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(codes(out)).toContain('spend_totals_not_checked');
    expect(tool).not.toHaveBeenCalled();
  });

  it('an expired policy is DENY(policy_expired)', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { expires_at: NOW_S - 1 }), iso);
    const out = await runUnderKernel(spendRequest(), jest.fn(), h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('policy_expired');
  });

  it('no policy at all is DENY(policy_missing): default deny', async () => {
    const h = harness();
    const tool = jest.fn();
    const out = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('policy_missing');
    expect(tool).not.toHaveBeenCalled();
    expect(out.decision_receipt!.decision.limits.effective_per_tx_raw).toBe('0');
    expect(out.decision_receipt!.decision.limits.binding_term).toBe('default_zero');
  });

  it('an action the owner did not list is DENY(action_not_permitted)', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { actions: ['post'] }), iso);
    const out = await runUnderKernel(spendRequest(), jest.fn(), h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('action_not_permitted');
  });

  it('a policy with no limits stated spends nothing: omitted limits are 0', async () => {
    const h = harness();
    // Build it through the strict parser, the way POST /policy does, with the limits left out.
    const parsed = parsePolicy({ subject: AGENT_ID, owner: h.owner.address, actions: ['spend'], expires_at: NOW_S + 3600, nonce: '1' });
    expect(parsed.ok && parsed.defaulted).toEqual(['payees', 'per_tx_raw', 'daily_raw', 'total_raw']);
    if (!parsed.ok) throw new Error('unreachable');
    const signature = await h.owner.signTypedData(POLICY_DOMAIN, POLICY_TYPES, policyTypedValue(parsed.policy));
    await h.ledger.appendPolicy({ policy: parsed.policy, signature }, iso);
    const tool = jest.fn();
    const out = await runUnderKernel(spendRequest({ amount_raw: 1 }), tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('spend_limit_zero');
    expect(tool).not.toHaveBeenCalled();
  });

  it('a higher-nonce policy supersedes; replaying the old one cannot widen it back', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { nonce: '1' }), iso);
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { nonce: '2', per_tx_raw: '0' }), iso);
    await expect(h.ledger.appendPolicy(await signedPolicy(h.owner, { nonce: '1' }), iso)).rejects.toThrow(/equal or higher nonce/);
    const out = await runUnderKernel(spendRequest(), jest.fn(), h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('spend_limit_zero');
  });
});

// ── the payee allow-list: a spend to a payee not on the owner's list is refused ────────────────

describe('(e) the payee allow-list: default deny, like the limits', () => {
  const OTHER = '0x00000000000000000000000000000000000beef1';

  it('a payee NOT on the list → DENY(payee_not_allowed), a receipt with executed:false, the tool called 0 times', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { payees: [PAYEE] }), iso); // limits are generous: only the payee is wrong
    const tool = jest.fn(async () => 'money moved');
    const out = await runUnderKernel(spendRequest({ payee: OTHER }), tool, h.deps);

    expect(tool).toHaveBeenCalledTimes(0);
    expect(out.verdict).toBe('DENY');
    expect(out.executed).toBe(false);
    expect(codes(out)).toEqual(['payee_not_allowed']); // nothing else is wrong with it
    const r = out.decision_receipt!;
    expect(r.decision.executed).toBe(false);
    expect(check(r, 'payee_allowed')).toBe('FAIL');
    expect(check(r, 'spend_limit')).toBe('PASS'); // the amount was fine; the payee is what refused it
    expect(r.request.payee).toBe(OTHER);
    expect(r.payment.status).toBe('NOT_APPLICABLE');
    expect(validateReceipt(r)).toEqual({ ok: true });
    expect(h.sink.records.filter((x) => x.kind === 'receipt')).toHaveLength(1);
  });

  it('a policy that lists NO payees refuses every spend: an omitted list is an empty list, never "anyone"', async () => {
    for (const payees of [undefined, [] as string[]]) {
      const h = harness();
      const signed = await signedPolicy(h.owner, payees === undefined ? {} : { payees });
      if (payees === undefined) {
        // Built the way an owner who simply left the field out would: through the strict parser.
        const { payees: _drop, ...rest } = signed.policy;
        const parsed = parsePolicy(rest);
        if (!parsed.ok) throw new Error('unreachable');
        expect(parsed.policy.payees).toEqual([]);
        expect(parsed.defaulted).toContain('payees');
        await h.ledger.appendPolicy({ policy: parsed.policy, signature: await h.owner.signTypedData(POLICY_DOMAIN, POLICY_TYPES, policyTypedValue(parsed.policy)) }, iso);
      } else {
        await h.ledger.appendPolicy(signed, iso);
      }
      const tool = jest.fn();
      const out = await runUnderKernel(spendRequest({ amount_raw: 1 }), tool, h.deps);
      expect(out.verdict).toBe('DENY');
      expect(codes(out)).toEqual(['payee_not_allowed']);
      expect(out.decision_receipt!.decision.reasons[0]!.detail).toMatch(/lists no payees/);
      expect(tool).not.toHaveBeenCalled();
    }
  });

  it('a spend that names no payee is refused', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn();
    const out = await runUnderKernel(spendRequest({ payee: null }), tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('payee_not_allowed');
    expect(tool).not.toHaveBeenCalled();
  });

  it('(e2) positive control: a payee ON the list passes the gate and the spend is allowed', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { payees: [OTHER, PAYEE] }), iso);
    const tool = jest.fn(async () => 'paid');
    const out = await runUnderKernel(spendRequest({ payee: PAYEE }), tool, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(1);
    expect(check(out.decision_receipt!, 'payee_allowed')).toBe('PASS');
  });

  it('the match ignores letter case (a checksummed list, a lower-case request)', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { payees: [PAYEE] }), iso);
    const out = await runUnderKernel(spendRequest({ payee: PAYEE.toLowerCase() }), jest.fn(async () => 'paid'), h.deps);
    expect(out.verdict).toBe('ALLOW');
  });

  it('widening the list after the owner signed it voids the policy: DENY(policy_signature_invalid)', async () => {
    const h = harness();
    const signed = await signedPolicy(h.owner, { payees: [PAYEE] });
    signed.policy.payees = [PAYEE, OTHER]; // an attacker adds themselves
    await h.ledger.appendPolicy(signed, iso);
    const tool = jest.fn();
    const out = await runUnderKernel(spendRequest({ payee: OTHER }), tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('policy_signature_invalid');
    expect(tool).not.toHaveBeenCalled();
  });

  it('is a spend gate only: a post or a read is not asked for a payee', async () => {
    const h = harness({ halCheck: async () => ({ verdict: 'PASS', method: 'm', votes: [], settled_by: null, grounded: true, same_domain: true }) });
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { payees: [] }), iso);
    expect((await runUnderKernel(postRequest(), jest.fn(async () => 'ok'), h.deps)).verdict).toBe('ALLOW');
    expect((await runUnderKernel({ ...postRequest(), tool: { name: 'fs.read', class: 'read' } }, jest.fn(async () => 1), h.deps)).verdict).toBe('ALLOW');
  });

  it('the payee gate is one of the checks an ALLOW spend needs: dropping it from a receipt invalidates the receipt', () => {
    expect(REQUIRED_CHECKS.spend).toContain('payee_allowed');
  });
});

describe('(f) the receipt does not let a resetting cap read as a lifetime one', () => {
  it('every kind of call says the total cap is per policy version and resets on supersession', async () => {
    const h = harness({ halCheck: async () => ({ verdict: 'PASS', method: 'm', votes: [], settled_by: null, grounded: true, same_domain: true }) });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const receipts: KernelReceipt[] = [];
    for (const [req, tool] of [
      [spendRequest(), async () => 'a'],
      [spendRequest({ payee: '0x00000000000000000000000000000000000beef1' }), async () => 'refused'],
      [postRequest(), async () => 'b'],
      [{ ...postRequest(), tool: { name: 'fs.read', class: 'read' } }, async () => 'c'],
    ] as const) {
      const out = await runUnderKernel(req, tool, h.deps);
      receipts.push(out.decision_receipt!);
      if (out.final_receipt) receipts.push(out.final_receipt);
    }
    expect(receipts.length).toBeGreaterThanOrEqual(5);
    for (const r of receipts) {
      expect(r.decision.does_not_attest).toContain(CUMULATIVE_TOTAL_NOTE);
      expect(r.decision.does_not_attest).toContain(TOTAL_CAP_SCOPE_NOTE);
    }
    expect(TOTAL_CAP_SCOPE_NOTE).toMatch(/per policy version/);
    expect(TOTAL_CAP_SCOPE_NOTE).toMatch(/resets when a policy is superseded/);
  });

  it('and the claim is TRUE: the total is keyed to the policy hash, so a superseding policy starts from zero', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { nonce: '1', per_tx_raw: '600', daily_raw: '100000', total_raw: '1000' }), iso);
    expect((await runUnderKernel(spendRequest({ amount_raw: 600 }), async () => 'ok', h.deps)).verdict).toBe('ALLOW');
    expect((await runUnderKernel(spendRequest({ amount_raw: 600 }), async () => 'ok', h.deps)).decision_receipt!.decision.limits.binding_term).toBe('total');
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { nonce: '2', per_tx_raw: '600', daily_raw: '100000', total_raw: '1000' }), iso);
    const afterSupersession = await runUnderKernel(spendRequest({ amount_raw: 600 }), async () => 'ok', h.deps);
    expect(afterSupersession.verdict).toBe('ALLOW'); // the same 1000 total, spent again: it reset
  });
});

// ── (c) a post is blocked when HAL abstains ─────────────────────────────────────────────────────

describe('(c) a post needs HAL, and HAL abstaining is NOT_CHECKED', () => {
  const hal = (over: Partial<HalEvidence> = {}): HalEvidence => ({
    verdict: 'PASS',
    method: 'cross-llm-quorum',
    votes: [
      { family: 'anthropic', verdict: 'PASS' },
      { family: 'openai', verdict: 'PASS' },
      { family: 'google', verdict: 'FAIL' },
    ],
    settled_by: null,
    grounded: true,
    same_domain: true,
    ...over,
  });

  it('HAL abstains → NOT_CHECKED(hal_abstained); the post is not made', async () => {
    const h = harness({ halCheck: async () => hal({ verdict: 'ABSTAIN', votes: [] }) });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 'posted');
    const out = await runUnderKernel(postRequest(), tool, h.deps);

    expect(out.verdict).toBe('NOT_CHECKED');
    expect(codes(out)).toContain('hal_abstained');
    expect(tool).toHaveBeenCalledTimes(0);
    expect(out.executed).toBe(false);
    expect(out.decision_receipt!.decision.executed).toBe(false);
    expect(out.decision_receipt!.verification.status).toBe('NOT_CHECKED');
    expect(out.decision_receipt!.verification.counts_toward_band_restore).toBe(false);
  });

  it('HAL not wired at all → NOT_CHECKED(hal_not_checked), never a pass', async () => {
    const h = harness(); // no halCheck
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn();
    const out = await runUnderKernel(postRequest(), tool, h.deps);
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(codes(out)).toContain('hal_not_checked');
    expect(tool).not.toHaveBeenCalled();
  });

  it('HAL throwing is NOT_CHECKED too', async () => {
    const h = harness({ halCheck: async () => { throw new Error('quorum unreachable'); } });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const out = await runUnderKernel(postRequest(), jest.fn(), h.deps);
    expect(out.verdict).toBe('NOT_CHECKED');
  });

  it('HAL VETO is DENY(hal_vetoed) and FLAG is DENY(hal_flagged): flagged is not cleared', async () => {
    for (const [verdict, code] of [['VETO', 'hal_vetoed'], ['FLAG', 'hal_flagged']] as const) {
      const h = harness({ halCheck: async () => hal({ verdict }) });
      await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
      const tool = jest.fn();
      const out = await runUnderKernel(postRequest(), tool, h.deps);
      expect(out.verdict).toBe('DENY');
      expect(codes(out)).toContain(code);
      expect(tool).not.toHaveBeenCalled();
    }
  });

  it('(c2) positive control: HAL PASS on a 2-1 vote → ALLOW, but the label is only PROVISIONAL and it cannot restore a band', async () => {
    const h = harness({ halCheck: async () => hal() });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 'posted');
    const out = await runUnderKernel(postRequest(), tool, h.deps);

    expect(out.verdict).toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(1);
    const v = out.final_receipt!.verification;
    expect(v.status).toBe('VERIFIED');
    expect(v.verdict_label).toBe('PROVISIONAL'); // 2-1 with no settler
    expect(v.settled_by).toBeNull();
    expect(v.grounded).toBe(true);
    expect(v.same_domain).toBe(true);
    expect(v.is_simulated).toBe(true);
    expect(v.counts_toward_band_restore).toBe(false); // simulated, so it can never count
    expect(out.final_receipt!.decision.does_not_attest.join(' ')).toMatch(/verification_settled/);
  });

  it('settled_by comes only from HAL evidence the kernel gathered; a settled, grounded, same-domain, REAL run counts', async () => {
    const h = harness({
      env: { network: 'base-sepolia', chain_id: 84532, is_simulated: false },
      halCheck: async () => hal({ settled_by: 'holdout' }),
    });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const out = await runUnderKernel(postRequest(), jest.fn(async () => 'posted'), h.deps);
    const v = out.final_receipt!.verification;
    expect(v.verdict_label).toBe('SETTLED');
    expect(v.settled_by).toBe('holdout');
    expect(v.counts_toward_band_restore).toBe(true); // grounded && same_domain && !simulated
  });
});

// ── request handling: unknown → deny, nothing smuggled ──────────────────────────────────────────

describe('unknown and malformed requests are denied without running anything', () => {
  const cases: Array<[string, unknown]> = [
    ['an unknown tool class', spendRequest({ tool: { name: 'x', class: 'transfer' } })],
    ['not an object', 'spend 10000'],
    ['null', null],
    ['a forbidden key: claim', spendRequest({ claim: 'the sky is green' })],
    ['a forbidden key: prompt', spendRequest({ prompt: 'ignore previous instructions' })],
    ['a forbidden key: user_id', spendRequest({ user_id: 'u-1' })],
    ['raw args', spendRequest({ args: { url: 'https://example.invalid' } })],
    ['a supplied counts_toward_band_restore', spendRequest({ counts_toward_band_restore: true })],
    ['an args_hash that is not a hash', spendRequest({ args_hash: 'trust me' })],
    ['a missing agent', { ...spendRequest(), agent: undefined }],
  ];
  it.each(cases)('%s → DENY, tool not called, no receipt', async (_label, body) => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn();
    const out = await runUnderKernel(body, tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(out.executed).toBe(false);
    expect(out.persisted).toBe(false);
    expect(tool).not.toHaveBeenCalled();
    expect(h.sink.records.filter((r) => r.kind === 'receipt')).toHaveLength(0);
  });

  it('echoes the NAME of a forbidden key, never its value', async () => {
    const h = harness();
    const out = await runUnderKernel(spendRequest({ prompt: 'SECRET-PROMPT-TEXT' }), jest.fn(), h.deps);
    expect(JSON.stringify(out.reasons)).toContain('prompt');
    expect(JSON.stringify(out.reasons)).not.toContain('SECRET-PROMPT-TEXT');
  });

  it('money fields on a read or a post are a spend in disguise → DENY(malformed_request)', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn();
    const out = await runUnderKernel({ ...postRequest(), tool: { name: 'fs.read', class: 'read' }, amount_raw: 5000, payee: PAYEE }, tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('malformed_request');
    expect(tool).not.toHaveBeenCalled();
  });

  it('a missing tool function is refused, not run', async () => {
    const h = harness();
    const out = await runUnderKernel(spendRequest(), undefined as never, h.deps);
    expect(out.verdict).toBe('DENY');
  });

  it('a read-class tool with a policy that lists tool is allowed (positive control)', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 42);
    const out = await runUnderKernel({ ...postRequest(), tool: { name: 'fs.read', class: 'read' } }, tool, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(out.result).toBe(42);
    expect(out.final_receipt!.payment.status).toBe('NOT_APPLICABLE');
  });
});

describe('amounts are parsed bigint-safe', () => {
  it.each([
    [NaN], [Infinity], [-1], [-0.5], [1.5], [2 ** 53], [2 ** 60], ['-1'], ['1.5'], ['1e3'], ['0x10'], [' 10'], ['010'], [''], ['abc'],
    ['9007199254740993'], [true], [{}], [[]], [undefined], [null],
  ])('rejects %p', (raw) => {
    expect(parseAmountRaw(raw).ok).toBe(false);
  });

  it('accepts a safe integer, a canonical string, and exactly 2^53 as a string', () => {
    expect(parseAmountRaw(10000)).toEqual({ ok: true, value: 10000n, canonical: '10000' });
    expect(parseAmountRaw('10000')).toEqual({ ok: true, value: 10000n, canonical: '10000' });
    expect(parseAmountRaw('0')).toEqual({ ok: true, value: 0n, canonical: '0' });
    expect(parseAmountRaw('9007199254740992').ok).toBe(true);
  });

  it('a spend of an invalid amount, or of zero, is DENY(invalid_amount)', async () => {
    for (const amount_raw of [-1, NaN, '1e3', '9007199254740993', 0, '0', null]) {
      const h = harness();
      await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
      const tool = jest.fn();
      const out = await runUnderKernel(spendRequest({ amount_raw }), tool, h.deps);
      expect(out.verdict).toBe('DENY');
      expect(codes(out)).toContain('invalid_amount');
      expect(tool).not.toHaveBeenCalled();
    }
  });
});

// ── the write-ahead rule ────────────────────────────────────────────────────────────────────────

describe('a receipt-write failure means the tool does NOT run', () => {
  it('ledger.appendReceipt throws → NOT_CHECKED(receipt_write_failed), tool 0×, even though the decision was ALLOW', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const failing: KernelLedger = {
      appendReceipt: async () => { throw new Error('disk full'); },
      appendPolicy: (p, t) => h.ledger.appendPolicy(p, t),
      latestPolicy: (s) => h.ledger.latestPolicy(s),
      spentTotals: (q) => h.ledger.spentTotals(q),
      findReceipts: (i) => h.ledger.findReceipts(i),
    };
    const tool = jest.fn(async () => 'paid');
    const out = await runUnderKernel(spendRequest(), tool, { ...h.deps, ledger: failing });
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(codes(out)).toContain('receipt_write_failed');
    expect(tool).toHaveBeenCalledTimes(0);
    expect(out.persisted).toBe(false);
    expect(out.executed).toBe(false);
  });

  it('a sink that fails on the first receipt write: the tool does not run, and a retry works once the sink recovers', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const realAppend = h.sink.append.bind(h.sink);
    let fail = true;
    h.sink.append = async (rec) => {
      if (fail && rec.kind === 'receipt') throw new Error('EIO');
      return realAppend(rec);
    };
    const tool = jest.fn(async () => 'paid');
    const blocked = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(blocked.verdict).toBe('NOT_CHECKED');
    expect(tool).not.toHaveBeenCalled();
    fail = false;
    const ok = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(ok.verdict).toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it('if the OUTCOME row cannot be written the run still happened, and the result says the record is incomplete', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const realAppend = h.sink.append.bind(h.sink);
    let receipts = 0;
    h.sink.append = async (rec) => {
      if (rec.kind === 'receipt' && ++receipts === 2) throw new Error('EIO');
      return realAppend(rec);
    };
    const out = await runUnderKernel(spendRequest(), jest.fn(async () => 'paid'), h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(out.executed).toBe(true);
    expect(out.outcome_unrecorded).toBe(true);
    expect(out.final_receipt).toBeNull();
    expect(out.decision_receipt!.decision.executed).toBe(false); // the ledger still says only "permitted"
  });

  it('concurrent calls cannot fork the chain', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    await Promise.all(Array.from({ length: 8 }, () => runUnderKernel(spendRequest({ amount_raw: 1 }), async () => 'ok', h.deps)));
    const receipts = h.sink.records.flatMap((r) => (r.kind === 'receipt' ? [r.receipt] : []));
    expect(receipts).toHaveLength(16);
    expect(verifyReceiptChain(receipts)).toEqual({ ok: true });
  });
});

// ── decide() on its own ─────────────────────────────────────────────────────────────────────────

describe('decide() is pure and starts at deny', () => {
  const bare = (over: Partial<DecideInput> = {}): DecideInput => ({
    request: { agent: { agent_id: AGENT_ID, agent_name: 'a' }, tool: { name: 't', class: 'read' }, origin: 'Cli', args_hash: hashArgs({}), amount_raw: null, payee: null, asset: null, chain_id: null },
    now_s: NOW_S,
    owner: { status: 'none', wallet: null, assurance: null },
    policy: { state: 'absent' },
    spent: { state: 'not_needed' },
    hal: { state: 'not_needed' },
    ...over,
  });

  it('with no evidence at all the verdict is DENY', () => {
    const d = decide(bare());
    expect(d.verdict).toBe('DENY');
    expect(d.blocking).toBe(true);
    expect(d.limits.effective_per_tx_raw).toBe('0');
  });

  it('an unknown class is DENY(unknown_tool_class) even with a fully valid policy', () => {
    const policy: OwnerPolicy = { subject: AGENT_ID, owner: PAYEE, actions: ['spend', 'post', 'tool'], per_tx_raw: '9', daily_raw: '9', total_raw: '9', expires_at: NOW_S + 1, nonce: '1' };
    const d = decide(bare({
      request: { ...bare().request, tool: { name: 't', class: 'teleport' as never } },
      owner: { status: 'resolved', wallet: PAYEE, assurance: 'wallet-proven' },
      policy: { state: 'loaded', policy, policy_hash: policyHash(policy), signature: 'VERIFIED', revocation: 'VERIFIED' },
    }));
    expect(d.verdict).toBe('DENY');
    expect(d.reasons.map((r) => r.code)).toContain('unknown_tool_class');
  });

  it('a definite no beats an unrelated gap: FAIL + NOT_CHECKED → DENY', () => {
    const d = decide(bare({ owner: { status: 'none', wallet: null, assurance: null }, policy: { state: 'not_checked', detail: 'x' } }));
    expect(d.verdict).toBe('DENY');
    expect(d.checks.some((c) => c.outcome === 'NOT_CHECKED')).toBe(true);
  });

  it('is deterministic: the same evidence gives the same answer', () => {
    expect(decide(bare())).toEqual(decide(bare()));
  });

  it('every class names the checks an ALLOW rests on', () => {
    for (const cls of ['read', 'other', 'spend', 'post'] as const) expect(REQUIRED_CHECKS[cls].length).toBeGreaterThan(5);
    expect(REQUIRED_CHECKS.spend).toEqual(expect.arrayContaining(['spend_limit', 'spend_totals', 'amount_valid']));
    expect(REQUIRED_CHECKS.post).toContain('hal_verdict');
  });
});

// ── (d) NON-VACUITY ─────────────────────────────────────────────────────────────────────────────

describe('(d) non-vacuity: a default-allow decide must make the refusal demo FAIL', () => {
  const allCheckNames = (cls: 'spend') => REQUIRED_CHECKS[cls].map((name) => ({ name, outcome: 'PASS' as const, source: 'default-allow' }));

  /** A decide() that approves everything and does not even bother to write down why. */
  const lazyAllow = (): DecisionLeg => ({
    verdict: 'ALLOW',
    blocking: false,
    executed: false,
    reasons: [],
    checks: [],
    does_not_attest: [CUMULATIVE_TOTAL_NOTE],
    policy: { policy_hash: null, signer: null, signature: 'NOT_CHECKED', expires_at: null, revocation: 'NOT_CHECKED' },
    limits: { per_tx_raw: '0', daily_raw: '0', total_raw: '0', effective_per_tx_raw: '0', binding_term: 'default_zero' },
    laya: { lane: null, mode: 'shadow', consulted: false },
  });

  /** A decide() that approves everything AND forges a clean-looking trail, to get past the ledger. */
  const forgedAllow = (): DecisionLeg => ({
    ...lazyAllow(),
    does_not_attest: [CUMULATIVE_TOTAL_NOTE, TOTAL_CAP_SCOPE_NOTE],
    checks: allCheckNames('spend'),
    policy: { policy_hash: null, signer: null, signature: 'VERIFIED', expires_at: null, revocation: 'VERIFIED' },
    limits: { per_tx_raw: '1000000000', daily_raw: '1000000000', total_raw: '1000000000', effective_per_tx_raw: '1000000000', binding_term: 'per_tx' },
  });

  afterEach(() => jest.restoreAllMocks());

  it('the demo passes against the real decide() (so a failure below is the swap, not the demo)', async () => {
    await expect(refusalDemo()).resolves.toBeUndefined();
  });

  it('a lazy default-allow is caught by the demo', async () => {
    jest.spyOn(decideModule, 'decide').mockImplementation(lazyAllow);
    await expect(refusalDemo()).rejects.toThrow();
  });

  it('a default-allow that forges a clean trail gets past the ledger, runs the tool, and is caught by the tool-call assertion', async () => {
    jest.spyOn(decideModule, 'decide').mockImplementation(forgedAllow);
    // The demo's FIRST assertion is the call count, so this is the tool-was-run failure, not an
    // incidental one further down.
    await expect(refusalDemo()).rejects.toThrow(/toHaveBeenCalledTimes/);
  });

  it('...and even the lazy one never gets the tool run: the ledger refuses an ALLOW with no checks behind it', async () => {
    jest.spyOn(decideModule, 'decide').mockImplementation(lazyAllow);
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '0' }), iso);
    const tool = jest.fn();
    const out = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(tool).not.toHaveBeenCalled();
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(codes(out)).toContain('receipt_write_failed');
  });
});
