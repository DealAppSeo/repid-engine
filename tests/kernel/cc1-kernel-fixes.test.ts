/**
 * CC1 kernel fixes, 2026-10-21: the checks that go with the fixes for XC1's P0 holes (#1444), beyond
 * flipping XC1's own probes. XC1's files are not edited except to flip `it.failing` → `it` (and the
 * CHARACTERISE pins whose behaviour a fix changed, explained in the PR). What a fix does NOT close is
 * pinned here as CHARACTERISE, so the residual is machine-checked rather than only written down.
 */
import { createCapabilityRegistry } from '../../src/kernel/capability-registry';
import { CALLER_ASSERTED_CLASS_NOTE, CAPABILITY_ENFORCED_CHECK, CUMULATIVE_TOTAL_NOTE, REQUIRED_CHECKS, TOTAL_CAP_SCOPE_NOTE, parseKernelRequest } from '../../src/kernel/decide';
import { runUnderKernel } from '../../src/kernel/gate';
import { POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2 } from '../../src/kernel/policy';
import { DEFAULT_ENV, buildReceipt, hashArgs, validateReceipt } from '../../src/kernel/receipt';
import type { OwnerPolicy } from '../../src/kernel/types';
import { AGENT_ID, NOW_S, PAYEE, harness, iso, signedPolicy, spendRequest } from '../../src/kernel/__tests__/fixtures';

const readRequest = (name: string) => ({
  agent: { agent_id: AGENT_ID, agent_name: 'kernel-demo-agent' },
  tool: { name, class: 'read' },
  origin: 'Cli',
  args_hash: hashArgs({ doc: name }),
});

describe('RS: every receipt disclaims its class or carries the enforcement marker', () => {
  it('a flag-OFF receipt carries the caller-asserted disclaimer and validates', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const out = await runUnderKernel(spendRequest(), jest.fn(async () => 'paid'), h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(out.decision_receipt!.decision.does_not_attest).toContain(CALLER_ASSERTED_CLASS_NOTE);
    expect(validateReceipt(out.decision_receipt)).toEqual({ ok: true });
  });

  it('an enforced receipt (ALLOW and DENY) carries the marker and does not claim the class is caller-asserted', async () => {
    const formatter = jest.fn(async () => 'formatted');
    const reg = createCapabilityRegistry();
    reg.register({ implId: 'impl.formatter', capability: { id: 'format.markdown', toolClass: 'read' }, run: formatter });
    const h = harness({ capabilityRegistry: reg });
    const policy: OwnerPolicy = {
      subject: AGENT_ID, owner: h.owner.address, actions: ['tool'], payees: [PAYEE],
      per_tx_raw: '0', daily_raw: '0', total_raw: '0', expires_at: NOW_S + 3600, nonce: '1', authorized_impl_hashes: ['impl.formatter'],
    };
    await h.ledger.appendPolicy({ policy, signature: await h.owner.signTypedData(POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2(policy)) }, iso);
    const allow = await runUnderKernel(readRequest('impl.formatter'), formatter as unknown as () => Promise<string>, h.deps);
    const deny = await runUnderKernel(readRequest('impl.exporter'), jest.fn(async () => 'x'), h.deps);
    for (const r of [allow.decision_receipt!, deny.decision_receipt!]) {
      expect(r.decision.checks.some((c) => c.name === CAPABILITY_ENFORCED_CHECK)).toBe(true);
      expect(r.decision.does_not_attest).not.toContain(CALLER_ASSERTED_CLASS_NOTE);
      expect(validateReceipt(r)).toEqual({ ok: true });
    }
  });

  // RT-7 (red-team.test.ts) flipped with this fix only because its forger leaves out the disclaimer
  // every genuine flag-OFF receipt now carries. That is NOT a closure: an unsigned receipt is still
  // fabricable by anyone who copies every mandatory line. The chain and the engine signature are what
  // catch it (P0-RS-04, P0-RS-06).
  it('CHARACTERISE RT-7 residual: a receipt fabricated from nothing that copies the disclaimer still validates', () => {
    const wallet = '0x00000000000000000000000000000000000000aa';
    const parsed = parseKernelRequest(spendRequest({ amount_raw: '1000000', payee: PAYEE }));
    if (!parsed.ok) throw new Error('fixture should parse');
    const forged = buildReceipt({
      receipt_id: '00000000-0000-4000-8000-0000000000ff',
      prev: null,
      created_at: iso,
      env: DEFAULT_ENV,
      request: parsed.request,
      owner: { status: 'resolved', wallet, assurance: 'wallet-proven' },
      decision: {
        verdict: 'ALLOW',
        blocking: false,
        executed: false,
        reasons: [],
        checks: REQUIRED_CHECKS.spend.map((name) => ({ name, outcome: 'PASS' as const, source: 'forged' })),
        does_not_attest: [CUMULATIVE_TOTAL_NOTE, TOTAL_CAP_SCOPE_NOTE, CALLER_ASSERTED_CLASS_NOTE],
        policy: { policy_hash: '0x' + 'ab'.repeat(32), signer: wallet, signature: 'VERIFIED', expires_at: 4_000_000_000, revocation: 'VERIFIED' },
        limits: { per_tx_raw: '9999999999', daily_raw: '9999999999', total_raw: '9999999999', effective_per_tx_raw: '9999999999', binding_term: 'per_tx' },
        laya: { lane: null, mode: 'shadow', consulted: false },
      },
      executed: false,
      phase: 'decision',
      hal: { state: 'not_needed' },
    });
    expect(validateReceipt(forged)).toEqual({ ok: true });
  });
});
