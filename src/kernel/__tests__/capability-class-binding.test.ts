/**
 * Class binding (re-attack of #1358). The registry did not record which class an implementation
 * belongs to, so the caller-asserted `tool.class` still chose which gates ran:
 *   - a registered PAYMENT impl called as `other` ran with no amount, payee, or limit check;
 *   - a registered POST impl called as `read` ran without HAL.
 * Flag ON = an injected capabilityRegistry. Fixed sentinel returns, no env reads.
 */
import { Wallet } from 'ethers';
import { createCapabilityRegistry, screenCapability } from '../capability-registry';
import { runUnderKernel } from '../gate';
import { POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2 } from '../policy';
import type { OwnerPolicy } from '../types';
import { AGENT_ID, NOW_S, PAYEE, harness, iso, postRequest, spendRequest } from './fixtures';

async function signedV2(signer: Wallet, over: Partial<OwnerPolicy>) {
  const policy: OwnerPolicy = {
    subject: AGENT_ID,
    owner: signer.address,
    actions: ['spend', 'post', 'tool'],
    payees: [PAYEE],
    per_tx_raw: '1000000',
    daily_raw: '5000000',
    total_raw: '20000000',
    expires_at: NOW_S + 3600,
    nonce: '1',
    authorized_impl_hashes: [],
    ...over,
  };
  return { policy, signature: await signer.signTypedData(POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2(policy)) };
}

/** A non-money, non-post request shape: what a read/other call looks like after parsing. */
function toolCall(name: string, cls: 'read' | 'other') {
  return { ...spendRequest(), tool: { name, class: cls }, amount_raw: null, payee: null, asset: null, chain_id: null };
}

async function paymentHarness() {
  const payment = jest.fn(async () => 'paid');
  const reg = createCapabilityRegistry();
  reg.register({ implId: 'impl.payment', capability: { id: 'payment.transfer', toolClass: 'spend' }, run: payment });
  const h = harness({ capabilityRegistry: reg });
  await h.ledger.appendPolicy(await signedV2(h.owner, { authorized_impl_hashes: ['impl.payment'] }), iso);
  return { payment, h };
}

const capRow = (out: { decision_receipt?: { decision: { checks: Array<{ name: string; outcome: string }> } } | null }) =>
  out.decision_receipt?.decision.checks.find((c) => c.name === 'capability')?.outcome;
const codes = (out: { reasons: Array<{ code: string }> }) => out.reasons.map((r) => r.code);

describe('class binding — a registered implementation runs only under its registered class', () => {
  it('control: the payment impl under its own class (spend) ALLOWs and runs once', async () => {
    const { payment, h } = await paymentHarness();
    const out = await runUnderKernel(spendRequest({ tool: { name: 'impl.payment', class: 'spend' } }), payment, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(payment).toHaveBeenCalledTimes(1);
    expect(capRow(out)).toBe('PASS');
  });

  it('the payment impl relabelled as `other` is DENIED and never runs (spend checks cannot be skipped)', async () => {
    const { payment, h } = await paymentHarness();
    const out = await runUnderKernel(toolCall('impl.payment', 'other'), payment, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(out.executed).toBe(false);
    expect(payment).toHaveBeenCalledTimes(0);
    expect(codes(out)).toContain('impl_class_mismatch');
    expect(capRow(out)).toBe('FAIL');
    expect(out.result).toBeUndefined();
  });

  it('a post impl relabelled as `read` is DENIED and never runs (HAL cannot be skipped)', async () => {
    const post = jest.fn(async () => 'posted');
    const reg = createCapabilityRegistry();
    reg.register({ implId: 'impl.post', capability: { id: 'social.publish', toolClass: 'post' }, run: post });
    const h = harness({ capabilityRegistry: reg }); // no halCheck: as `post` this is NOT_CHECKED
    await h.ledger.appendPolicy(await signedV2(h.owner, { authorized_impl_hashes: ['impl.post'] }), iso);

    const asPost = await runUnderKernel(postRequest({ tool: { name: 'impl.post', class: 'post' } }), post, h.deps);
    expect(asPost.verdict).toBe('NOT_CHECKED');
    const asRead = await runUnderKernel(postRequest({ tool: { name: 'impl.post', class: 'read' } }), post, h.deps);
    expect(asRead.verdict).toBe('DENY');
    expect(codes(asRead)).toContain('impl_class_mismatch');
    expect(post).toHaveBeenCalledTimes(0);
  });

  it('read and other are not interchangeable', async () => {
    const fmt = jest.fn(async () => 'formatted');
    const reg = createCapabilityRegistry();
    reg.register({ implId: 'impl.formatter', capability: { id: 'format.markdown', toolClass: 'read' }, run: fmt });
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedV2(h.owner, { authorized_impl_hashes: ['impl.formatter'] }), iso);
    expect((await runUnderKernel(toolCall('impl.formatter', 'read'), fmt, h.deps)).verdict).toBe('ALLOW');
    expect((await runUnderKernel(toolCall('impl.formatter', 'other'), fmt, h.deps)).verdict).toBe('DENY');
    expect(fmt).toHaveBeenCalledTimes(1);
  });

  it('the pure screen fails closed when the query carries no class', () => {
    const run = jest.fn();
    const reg = createCapabilityRegistry();
    reg.register({ implId: 'impl.formatter', capability: { id: 'format.markdown', toolClass: 'read' }, run });
    const r = screenCapability({ implRef: 'impl.formatter', candidate: run, toolClass: undefined }, reg, new Set(['impl.formatter']));
    expect(r.allow).toBe(false);
    expect(r.code).toBe('impl_class_mismatch');
    expect(r.run).toBeNull();
  });

  it('registration refuses a missing or unknown class', () => {
    const reg = createCapabilityRegistry();
    const noClass = { id: 'format.markdown' } as unknown as { id: string; toolClass: 'read' };
    expect(() => reg.register({ implId: 'impl.a', capability: noClass, run: jest.fn() })).toThrow(/toolClass/);
    const badClass = { id: 'format.markdown', toolClass: 'SPEND' } as unknown as { id: string; toolClass: 'read' };
    expect(() => reg.register({ implId: 'impl.b', capability: badClass, run: jest.fn() })).toThrow(/toolClass/);
    expect(reg.size).toBe(0);
  });
});
