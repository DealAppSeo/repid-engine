/**
 * capability-enforcement.test.ts — Draft 2 acceptance: the capability DECISION, wired through the real
 * gate, under enforcement ON and OFF. Proves XC1 conditions 3 (blanket `tool` authorizes nothing;
 * bindings inside the signed bytes) and 4 (the check gates the PERSISTED decision, so no ALLOW receipt
 * for an unregistered/unauthorized/prohibited call; the tool runs 0 times on DENY).
 *
 * NOT YET CLOSED HERE (Draft 3): the full closure swap — runUnderKernel running the REGISTERED
 * implementation instead of the caller's closure. Draft 2 resolves + authorizes + prohibits by the
 * owner-signed binding; the running-function reference-equality is enforced at the call site in Draft 3.
 */
import { Wallet } from 'ethers';
import { runUnderKernel } from '../gate';
import { decide } from '../decide';
import {
  POLICY_DOMAIN_V2,
  POLICY_TYPES_V2,
  policyTypedValueV2,
} from '../policy';
import { classifyProhibitedCapability, createCapabilityRegistry } from '../capability-registry';
import { hashArgs, validateReceipt } from '../receipt';
import type { CapabilityDecision, CapabilityState, DecideInput, KernelReceipt, OwnerPolicy } from '../types';
import { AGENT_ID, NOW_S, harness, iso, signedPolicy } from './fixtures';

const codes = (r: { reasons: Array<{ code: string }> }): string[] => r.reasons.map((x) => x.code);
const capCheck = (r: KernelReceipt): string | undefined => r.decision.checks.find((c) => c.name === 'capability')?.outcome;

// A fresh boot registry per test. Distinct function objects; identity is by reference.
function registry() {
  const reg = createCapabilityRegistry();
  reg.register({ implId: 'impl.formatter', capability: { id: 'format.markdown' }, run: async () => 'formatted' });
  reg.register({ implId: 'impl.secret', capability: { id: 'secrets.export_all' }, run: async () => 'SECRET-LEAKED' });
  reg.register({ implId: 'impl.rotate', capability: { id: 'secrets.rotate' }, run: async () => 'rotated' });
  reg.register({ implId: 'impl.readtrusted', capability: { id: 'memory.read_trusted' }, run: async () => 'read' });
  return reg;
}

/** Sign a policy under the v2 scheme so the signature COVERS authorized_impl_hashes. */
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
    authorized_impl_hashes: ['impl.formatter', 'impl.rotate', 'impl.readtrusted', 'impl.secret'],
    ...over,
  };
  const signature = await signer.signTypedData(POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2(policy));
  return { policy, signature };
}

function toolRequest(name: string, cls: 'read' | 'other' = 'read') {
  return {
    agent: { agent_id: AGENT_ID, agent_name: 'kernel-demo-agent' },
    tool: { name, class: cls },
    origin: 'Cli',
    args_hash: hashArgs({ doc: 'hello' }),
    amount_raw: null,
    payee: null,
    asset: null,
    chain_id: null,
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════
describe('enforcement ON — the formatter bypass and the evasion list are DENIED, 0 calls', () => {
  it('the formatter-with-malicious-closure bypass: an UNREGISTERED name is DENIED, tool runs 0 times', async () => {
    const h = harness({ capabilityRegistry: registry() });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    const tool = jest.fn(async () => 'exfiltrated');
    const out = await runUnderKernel(toolRequest('formatter'), tool, h.deps);

    expect(out.verdict).toBe('DENY');
    expect(tool).toHaveBeenCalledTimes(0);
    expect(out.executed).toBe(false);
    expect(codes(out)).toContain('unregistered_tool');
    const r = out.decision_receipt!;
    expect(validateReceipt(r)).toEqual({ ok: true });
    expect(capCheck(r)).toBe('FAIL');
    // No secret value and no raw args leak into the refusal receipt.
    expect(JSON.stringify(r)).not.toContain('SECRET-LEAKED');
    expect(JSON.stringify(r)).not.toContain('exfiltrated');
  });

  it("XC1's evasion names are DENIED (unregistered), 0 calls", async () => {
    const h = harness({ capabilityRegistry: registry() });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    for (const name of ['get_secret', 'read_private_key', 'write_trusted_memory', 'secrets.export_all']) {
      const tool = jest.fn(async () => 'x');
      const out = await runUnderKernel(toolRequest(name), tool, h.deps);
      expect(out.verdict).toBe('DENY');
      expect(tool).toHaveBeenCalledTimes(0);
    }
  });

  it('a registered + authorized impl whose CAPABILITY is a secret-export is DENIED (prohibition floor), 0 calls', async () => {
    const h = harness({ capabilityRegistry: registry() });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    const tool = jest.fn(async () => 'SECRET-LEAKED');
    const out = await runUnderKernel(toolRequest('impl.secret'), tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(tool).toHaveBeenCalledTimes(0);
    expect(codes(out)).toContain('prohibited_capability');
  });

  it('#8: an unregistered tool with a BENIGN name (no prohibition-regex match) is DENIED, never allowed', async () => {
    // The verdict comes from the positively-established registered capability — NOT from "the
    // prohibition regex did not match → allow". 'formatter' matches no pattern yet is still DENIED.
    expect(classifyProhibitedCapability('formatter')).toBeNull();
    const h = harness({ capabilityRegistry: registry() });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    const out = await runUnderKernel(toolRequest('formatter'), jest.fn(async () => 'x'), h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('unregistered_tool');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('enforcement ON — a benign registered+authorized tool and the exceptions ALLOW', () => {
  it('a benign registered+authorized read ALLOWs; the receipt validates with capability PASS', async () => {
    const h = harness({ capabilityRegistry: registry() });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    const tool = jest.fn(async () => 'formatted');
    const out = await runUnderKernel(toolRequest('impl.formatter'), tool, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(1);
    expect(capCheck(out.final_receipt ?? out.decision_receipt!)).toBe('PASS');
  });

  it('the deliberate exceptions ALLOW: memory.read_trusted and secrets.rotate', async () => {
    const h = harness({ capabilityRegistry: registry() });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    for (const name of ['impl.readtrusted', 'impl.rotate']) {
      const out = await runUnderKernel(toolRequest(name), jest.fn(async () => 'ok'), h.deps);
      expect(out.verdict).toBe('ALLOW');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('XC1 #3 — the blanket `tool` action authorizes NOTHING, and bindings live in the signed bytes', () => {
  it('a legacy v1 policy with actions:[tool] and NO bindings authorizes no implementation (DENY)', async () => {
    const h = harness({ capabilityRegistry: registry() });
    // signedPolicy signs under v1 and carries no authorized_impl_hashes — the blanket tool grant.
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { actions: ['tool'], per_tx_raw: '0', daily_raw: '0', total_raw: '0' }), iso);
    const tool = jest.fn(async () => 'formatted');
    const out = await runUnderKernel(toolRequest('impl.formatter'), tool, h.deps);
    expect(out.verdict).toBe('DENY'); // registered, but not authorized by any signed binding
    expect(tool).toHaveBeenCalledTimes(0);
    expect(codes(out)).toContain('impl_unauthorized');
  });

  it('bindings tampered after signing FAIL verification → no authorization → DENY (the signature covers them)', async () => {
    const h = harness({ capabilityRegistry: registry() });
    const signed = await signedPolicyV2(h.owner, { authorized_impl_hashes: ['impl.formatter'] });
    // Tamper: add impl.secret to the stored bindings AFTER the owner signed only [impl.formatter].
    const tampered = { policy: { ...signed.policy, authorized_impl_hashes: ['impl.formatter', 'impl.secret'] }, signature: signed.signature };
    await h.ledger.appendPolicy(tampered, iso);
    const out = await runUnderKernel(toolRequest('impl.formatter'), jest.fn(async () => 'x'), h.deps);
    // The v2 digest no longer matches the signature → policy signature FAILED → authorized set empty → DENY.
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('impl_unauthorized');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('enforcement OFF (flag unset) — byte-unchanged: no capability check, and the blanket tool still ALLOWs', () => {
  it('the SAME v1 policy + read that ON denies, OFF ALLOWs (today\'s behaviour) with no capability check', async () => {
    const h = harness(); // no capabilityRegistry dep ⇒ OFF
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { actions: ['tool'], per_tx_raw: '0', daily_raw: '0', total_raw: '0' }), iso);
    const tool = jest.fn(async () => 'formatted');
    const out = await runUnderKernel(toolRequest('impl.formatter'), tool, h.deps);
    expect(out.verdict).toBe('ALLOW'); // the blanket tool action permits it, exactly as before
    expect(tool).toHaveBeenCalledTimes(1);
    // The receipt carries NO capability check — byte-identical to pre-Draft-2.
    expect(capCheck(out.final_receipt ?? out.decision_receipt!)).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('decide() unit — the capability check gates the verdict (XC1 #4), fail-closed', () => {
  const base: Omit<DecideInput, 'capability'> = {
    request: toolRequest('impl.formatter'),
    now_s: NOW_S,
    owner: { status: 'resolved', wallet: '0x000000000000000000000000000000000000dEaD', assurance: 'wallet-proven' },
    policy: {
      state: 'loaded',
      policy: {
        subject: AGENT_ID, owner: '0x000000000000000000000000000000000000dEaD', actions: ['tool'], payees: [],
        per_tx_raw: '0', daily_raw: '0', total_raw: '0', expires_at: NOW_S + 3600, nonce: '1',
        authorized_impl_hashes: ['impl.formatter'],
      },
      policy_hash: '0x' + 'ab'.repeat(32),
      signature: 'VERIFIED',
      revocation: 'VERIFIED',
    },
    spent: { state: 'not_needed' },
    hal: { state: 'not_needed' },
  };

  const enforced = (outcome: 'PASS' | 'FAIL', code: CapabilityDecision['code']): CapabilityState => ({
    state: 'enforced',
    decision: {
      outcome,
      capability_id: outcome === 'PASS' ? 'format.markdown' : null,
      impl_id: outcome === 'PASS' ? 'impl.formatter' : null,
      code,
      detail: 'test',
    },
  });

  it('capability PASS ⇒ ALLOW; capability FAIL ⇒ DENY; capability NOT_CHECKED ⇒ blocks', () => {
    expect(decide({ ...base, capability: enforced('PASS', null) }).verdict).toBe('ALLOW');
    const denied = decide({ ...base, capability: enforced('FAIL', 'impl_unauthorized') });
    expect(denied.verdict).toBe('DENY');
    expect(denied.checks.find((c) => c.name === 'capability')?.outcome).toBe('FAIL');
    const nc = decide({ ...base, capability: { state: 'not_checked', detail: 'registry down' } });
    expect(nc.verdict).toBe('NOT_CHECKED'); // fail-closed, never a pass
  });

  it('OFF (not_enforced / absent) records no capability check and leaves the verdict unchanged', () => {
    const off = decide({ ...base, capability: { state: 'not_enforced' } });
    const absent = decide({ ...base });
    expect(off.checks.some((c) => c.name === 'capability')).toBe(false);
    expect(absent.checks.some((c) => c.name === 'capability')).toBe(false);
    expect(off.verdict).toBe(absent.verdict); // identical
    expect(off.verdict).toBe('ALLOW'); // the blanket tool action permits it, as before
  });

  it('#7c: under enforcement capability is a required check — an ALLOW read carries a PASS capability row', () => {
    const pass = decide({ ...base, capability: enforced('PASS', null) });
    expect(pass.verdict).toBe('ALLOW');
    expect(pass.checks.find((c) => c.name === 'capability')?.outcome).toBe('PASS');
  });
});
