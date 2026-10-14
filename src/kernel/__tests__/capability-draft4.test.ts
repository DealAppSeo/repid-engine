/**
 * Draft 4 acceptance tests. Flag ON is an injected capabilityRegistry (the prod flag stays unset).
 * Sentinel returns are fixed strings. Nothing here reads the environment except the boot test,
 * which sets KERNEL_CAPABILITY_REGISTRY_ENABLED for that one call and restores it.
 */
import { Wallet } from 'ethers';
import { createCapabilityRegistry } from '../capability-registry';
import { DRY_PREVIEW_DOES_NOT_ATTEST, dryDecision, runUnderKernel } from '../gate';
import { POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2 } from '../policy';
import { hashArgs, receiptHash, validateReceipt } from '../receipt';
import type { KernelReceipt, OwnerPolicy } from '../types';
import { defaultDeps } from '../../routes/kernel';
import { AGENT_ID, NOW_S, PAYEE, harness, iso, postRequest, signedPolicy, spendRequest } from './fixtures';

const SENTINEL = 'SENTINEL_EXFIL_NOT_A_SECRET';

const codes = (r: { reasons: Array<{ code: string }> }): string[] => r.reasons.map((x) => x.code);

function registry() {
  const impls = {
    formatter: jest.fn(async () => 'formatted'),
    secret: jest.fn(async () => 'x'),
  };
  const reg = createCapabilityRegistry();
  reg.register({ implId: 'impl.formatter', capability: { id: 'format.markdown', toolClass: 'read' }, run: impls.formatter });
  reg.register({ implId: 'impl.secret', capability: { id: 'secrets.export_all', toolClass: 'read' }, run: impls.secret });
  return { reg, impls };
}

async function signedPolicyV2(signer: Wallet, over: Partial<OwnerPolicy> = {}): Promise<{ policy: OwnerPolicy; signature: string }> {
  const policy: OwnerPolicy = {
    subject: AGENT_ID,
    owner: signer.address,
    actions: ['tool'],
    payees: [],
    per_tx_raw: '0',
    daily_raw: '0',
    total_raw: '0',
    expires_at: NOW_S + 3600,
    nonce: '1',
    authorized_impl_hashes: ['impl.formatter'],
    ...over,
  };
  const signature = await signer.signTypedData(POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2(policy));
  return { policy, signature };
}

function toolRequest(name: string) {
  return {
    agent: { agent_id: AGENT_ID, agent_name: 'kernel-demo-agent' },
    tool: { name, class: 'read' as const },
    origin: 'Cli',
    args_hash: hashArgs({ doc: 'hello' }),
    amount_raw: null,
    payee: null,
    asset: null,
    chain_id: null,
  };
}

const halPass = async () => ({
  verdict: 'PASS' as const,
  method: 'm',
  votes: [
    { family: 'a', verdict: 'PASS' as const },
    { family: 'b', verdict: 'PASS' as const },
  ],
  settled_by: null,
  grounded: false,
  same_domain: false,
});

function reseal(r: KernelReceipt): KernelReceipt {
  const copy = JSON.parse(JSON.stringify(r)) as KernelReceipt;
  copy.header.receipt_hash = receiptHash(copy);
  return copy;
}

// ── F1: the relabel probe, kept as a permanent test ──────────────────────────────────────────────
describe('Draft 4 F1 — spend/post relabel cannot skip the capability screen', () => {
  for (const name of ['secrets.export_all', 'impl.formatter']) {
    it(`flag-on spend relabel (${name}) is DENIED and runs nothing`, async () => {
      const { reg, impls } = registry();
      const h = harness({ capabilityRegistry: reg });
      await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
      const evil = jest.fn(async () => SENTINEL);
      const out = await runUnderKernel(spendRequest({ tool: { name, class: 'spend' } }), evil, h.deps);
      expect(out.verdict).toBe('DENY');
      expect(out.executed).toBe(false);
      expect(evil).toHaveBeenCalledTimes(0);
      expect(impls.formatter).toHaveBeenCalledTimes(0);
      expect(impls.secret).toHaveBeenCalledTimes(0);
      expect(out.result).toBeUndefined();
      expect(out.decision_receipt?.decision.checks.find((c) => c.name === 'capability')?.outcome).toBe('FAIL');
      expect(out.decision_receipt?.decision.checks.find((c) => c.name === 'capability_enforced')?.outcome).toBe('PASS');
      expect(JSON.stringify(out.decision_receipt)).not.toContain(SENTINEL);
    });
  }

  it('flag-on spend swapped closure is DENIED and runs neither function', async () => {
    const { reg, impls } = registry();
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const evil = jest.fn(async () => SENTINEL);
    const out = await runUnderKernel(spendRequest({ tool: { name: 'impl.formatter', class: 'spend' } }), evil, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('impl_reference_mismatch');
    expect(evil).toHaveBeenCalledTimes(0);
    expect(impls.formatter).toHaveBeenCalledTimes(0);
    expect(out.result).toBeUndefined();
  });

  for (const name of ['secrets.export_all', 'impl.formatter']) {
    it(`flag-on post relabel (${name}) with HAL PASS is DENIED and runs nothing`, async () => {
      const { reg, impls } = registry();
      const h = harness({ capabilityRegistry: reg, halCheck: halPass });
      await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
      const evil = jest.fn(async () => SENTINEL);
      const out = await runUnderKernel(postRequest({ tool: { name, class: 'post' } }), evil, h.deps);
      expect(out.verdict).toBe('DENY');
      expect(out.executed).toBe(false);
      expect(out.decision_receipt?.decision.checks.find((c) => c.name === 'hal_verdict')?.outcome).toBe('PASS');
      expect(out.decision_receipt?.decision.checks.find((c) => c.name === 'capability')?.outcome).toBe('FAIL');
      expect(evil).toHaveBeenCalledTimes(0);
      expect(impls.formatter).toHaveBeenCalledTimes(0);
      expect(impls.secret).toHaveBeenCalledTimes(0);
      expect(out.result).toBeUndefined();
      expect(JSON.stringify(out.decision_receipt)).not.toContain(SENTINEL);
    });
  }

  it('flag-on post swapped closure with HAL PASS is DENIED and runs neither function', async () => {
    const { reg, impls } = registry();
    const h = harness({ capabilityRegistry: reg, halCheck: halPass });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const evil = jest.fn(async () => SENTINEL);
    const out = await runUnderKernel(postRequest({ tool: { name: 'impl.formatter', class: 'post' } }), evil, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('impl_reference_mismatch');
    expect(out.decision_receipt?.decision.checks.find((c) => c.name === 'hal_verdict')?.outcome).toBe('PASS');
    expect(evil).toHaveBeenCalledTimes(0);
    expect(impls.formatter).toHaveBeenCalledTimes(0);
  });

  it('flag-on legit spend runs the registered payment impl once', async () => {
    const payment = jest.fn(async () => 'paid');
    const caller = jest.fn(async () => SENTINEL);
    const reg = createCapabilityRegistry();
    reg.register({ implId: 'impl.payment', capability: { id: 'payment.transfer', toolClass: 'spend' }, run: payment });
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(
      await signedPolicyV2(h.owner, {
        actions: ['spend', 'post', 'tool'],
        payees: [PAYEE],
        per_tx_raw: '1000000',
        daily_raw: '5000000',
        total_raw: '20000000',
        authorized_impl_hashes: ['impl.payment'],
      }),
      iso,
    );
    const out = await runUnderKernel(spendRequest({ tool: { name: 'impl.payment', class: 'spend' } }), payment, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(out.executed).toBe(true);
    expect(payment).toHaveBeenCalledTimes(1);
    expect(caller).toHaveBeenCalledTimes(0);
    expect(out.result).toBe('paid');
    expect(out.decision_receipt?.decision.checks.find((c) => c.name === 'capability')?.outcome).toBe('PASS');
    expect(JSON.stringify(out.final_receipt)).not.toContain(SENTINEL);
  });
});

// ── F2: the validator requires the capability row only when the enforcement marker is present ────
describe('Draft 4 F2 — an enforced ALLOW without a PASS capability row does not validate', () => {
  it('an enforced ALLOW with the capability row removed fails validateReceipt', async () => {
    const { reg, impls } = registry();
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    const out = await runUnderKernel(toolRequest('impl.formatter'), impls.formatter, h.deps);
    expect(out.verdict).toBe('ALLOW');
    const intact = out.decision_receipt!;
    expect(validateReceipt(intact)).toEqual({ ok: true });
    expect(intact.decision.checks.find((c) => c.name === 'capability_enforced')?.outcome).toBe('PASS');

    const stripped = JSON.parse(JSON.stringify(intact)) as KernelReceipt;
    stripped.decision.checks = stripped.decision.checks.filter((c) => c.name !== 'capability');
    const resealed = reseal(stripped);
    const verdict = validateReceipt(resealed);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.errors.map((e) => e.code)).toContain('allow_missing_required_check');
  });

  it('flag-OFF receipt hashes stay the frozen golden and carry no enforcement marker', async () => {
    // Same pin as the Draft 3 golden (origin/main @ 1b71d9f4). A matching hash is byte-identity.
    const FIXED_OWNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const fixedOwner = new Wallet(FIXED_OWNER_PK);
    const h = harness({
      resolveOwner: async () => ({ status: 'resolved', wallet: fixedOwner.address, assurance: 'wallet-proven' }),
    });
    await h.ledger.appendPolicy(
      await signedPolicy(fixedOwner, { actions: ['tool'], per_tx_raw: '0', daily_raw: '0', total_raw: '0' }),
      iso,
    );
    const out = await runUnderKernel(toolRequest('impl.formatter'), async () => 'formatted', h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(out.decision_receipt!.header.receipt_hash).toBe('0xb30a1fa69a14505bedae823aa63612bfcc5dea3a5cc51da562a8cb88bd2b734f');
    expect(out.final_receipt!.header.receipt_hash).toBe('0x620238f59e4dffbf0d610377305b76e6e10c343a621533be889c88f80af58608');
    expect(out.decision_receipt!.decision.checks.some((c) => c.name === 'capability' || c.name === 'capability_enforced')).toBe(false);
  });
});

// ── F3: an empty registry is loud ────────────────────────────────────────────────────────────────
describe('Draft 4 F3 — flag ON with an empty registry is registry_empty, not a silent unregistered_tool', () => {
  it('flag-on empty registry DENYs with registry_empty and logs LOUD', async () => {
    const reg = createCapabilityRegistry();
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { actions: ['tool'], per_tx_raw: '0', daily_raw: '0', total_raw: '0' }), iso);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const evil = jest.fn(async () => SENTINEL);
      const out = await runUnderKernel(toolRequest('memory.read_trusted'), evil, h.deps);
      expect(out.verdict).toBe('DENY');
      expect(out.executed).toBe(false);
      expect(evil).toHaveBeenCalledTimes(0);
      expect(codes(out)).toContain('registry_empty');
      expect(codes(out)).not.toContain('unregistered_tool');
      expect(spy.mock.calls.flat().join(' ')).toContain('LOUD');
      expect(JSON.stringify(out.decision_receipt)).not.toContain(SENTINEL);
    } finally {
      spy.mockRestore();
    }
  });

  it('boot with the flag on and an empty registry logs LOUD', () => {
    const prev = process.env['KERNEL_CAPABILITY_REGISTRY_ENABLED'];
    process.env['KERNEL_CAPABILITY_REGISTRY_ENABLED'] = 'true';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const deps = defaultDeps();
      expect(deps.capabilityRegistry).toBeDefined();
      expect(deps.capabilityRegistry!.size).toBe(0);
      expect(spy.mock.calls.flat().join(' ')).toContain('LOUD');
      expect(spy.mock.calls.flat().join(' ')).toContain('boot');
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env['KERNEL_CAPABILITY_REGISTRY_ENABLED'];
      else process.env['KERNEL_CAPABILITY_REGISTRY_ENABLED'] = prev;
    }
  });
});

// ── residuals ────────────────────────────────────────────────────────────────────────────────────
describe('Draft 4 residuals — non-string return and the dry preview', () => {
  it('a non-string return is withheld from the gate result and the receipt', async () => {
    const impl = jest.fn(async () => ({ leaked: SENTINEL }));
    const reg = createCapabilityRegistry();
    reg.register({ implId: 'impl.formatter', capability: { id: 'format.markdown', toolClass: 'read' }, run: impl });
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    const out = await runUnderKernel(toolRequest('impl.formatter'), impl, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(out.executed).toBe(true);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(out.result).toBeUndefined();
    expect(out.tool_error).toBe('OpaqueReturn');
    expect(JSON.stringify(out.decision_receipt)).not.toContain(SENTINEL);
    expect(JSON.stringify(out.final_receipt)).not.toContain(SENTINEL);
  });

  it('a numeric return is still handed back (kernel positive control)', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { actions: ['tool'], per_tx_raw: '0', daily_raw: '0', total_raw: '0' }), iso);
    const out = await runUnderKernel(toolRequest('fs.read'), async () => 42, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(out.result).toBe(42);
    expect(out.tool_error).toBeUndefined();
  });

  it('a dry preview receipt names itself as not executable', async () => {
    const { reg, impls } = registry();
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    const dry = await dryDecision(toolRequest('impl.formatter'), h.deps);
    expect('malformed' in dry).toBe(false);
    if ('malformed' in dry) return;
    expect(dry.runnable).toBe(false);
    expect(dry.persisted).toBe(false);
    expect(dry.receipt_preview!.decision.executed).toBe(false);
    expect(dry.receipt_preview!.decision.does_not_attest).toContain(DRY_PREVIEW_DOES_NOT_ATTEST);
    expect(validateReceipt(dry.receipt_preview!)).toEqual({ ok: true });

    const real = await runUnderKernel(toolRequest('impl.formatter'), impls.formatter, h.deps);
    expect(real.decision_receipt!.decision.does_not_attest).not.toContain(DRY_PREVIEW_DOES_NOT_ATTEST);
    expect(JSON.stringify(real.decision_receipt)).not.toContain('dry_preview');
  });
});
