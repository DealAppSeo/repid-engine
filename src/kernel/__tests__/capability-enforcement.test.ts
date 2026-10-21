/**
 * capability-enforcement.test.ts — the capability control wired through the real gate, ON and OFF.
 *
 * Draft 2 proved XC1 conditions 3 (blanket `tool` authorizes nothing; bindings inside the signed bytes)
 * and 4 (the check gates the PERSISTED decision, so no ALLOW receipt for an unregistered / unauthorized
 * / prohibited call; the tool runs 0 times on DENY).
 *
 * Draft 3 closes the CLOSURE SWAP (Strix MEDIUM, CWE-863): the gate threads the EXECUTING closure into
 * the screen as its `candidate`, so a caller that declares an authorized registered name but supplies a
 * DIFFERENT closure fails closed (impl_reference_mismatch) and runs 0 times — and runUnderKernel runs
 * the REGISTERED implementation, never a caller-supplied closure. Because of that, a legitimate ON
 * caller now passes the registered function object itself (`impls.<name>`); a mismatched closure is a
 * DENY. The reproduction of the pre-fix hole and the three Draft-3 scope items (closure-swap DENY, dry
 * /decide NOT-RUNNABLE, fail-closed output gate) and the flag-OFF byte-identity golden are at the end.
 */
import { Wallet } from 'ethers';
import { dryDecision, runUnderKernel } from '../gate';
import { decide } from '../decide';
import {
  POLICY_DOMAIN_V2,
  POLICY_TYPES_V2,
  policyTypedValueV2,
} from '../policy';
import { classifyProhibitedCapability, createCapabilityRegistry, screenCapability } from '../capability-registry';
import { hashArgs, validateReceipt } from '../receipt';
import type { CapabilityDecision, CapabilityState, DecideInput, KernelReceipt, OwnerPolicy } from '../types';
import { AGENT_ID, NOW_S, harness, iso, signedPolicy } from './fixtures';

const codes = (r: { reasons: Array<{ code: string }> }): string[] => r.reasons.map((x) => x.code);
const capCheck = (r: KernelReceipt): string | undefined => r.decision.checks.find((c) => c.name === 'capability')?.outcome;

// A fresh boot registry per test. Distinct function objects; identity is by reference.
//
// Draft 3: the gate runs the REGISTERED implementation and the screen verifies, by reference equality,
// that the caller's executing closure IS that registered object. So a legitimate caller passes the
// registered function itself — `impls.<name>` — which a trusted boot/call site holds and a poisoned
// repo cannot forge. The helper exposes those function objects for exactly that. Each is a jest.fn so
// a test can assert whether the REGISTERED implementation ran.
function registry() {
  const impls = {
    formatter: jest.fn(async () => 'formatted'),
    secret: jest.fn(async () => 'SECRET-LEAKED'),
    rotate: jest.fn(async () => 'rotated'),
    readtrusted: jest.fn(async () => 'read'),
  };
  const reg = createCapabilityRegistry();
  reg.register({ implId: 'impl.formatter', capability: { id: 'format.markdown', toolClass: 'read' }, run: impls.formatter });
  reg.register({ implId: 'impl.secret', capability: { id: 'secrets.export_all', toolClass: 'read' }, run: impls.secret });
  reg.register({ implId: 'impl.rotate', capability: { id: 'secrets.rotate', toolClass: 'read' }, run: impls.rotate });
  reg.register({ implId: 'impl.readtrusted', capability: { id: 'memory.read_trusted', toolClass: 'read' }, run: impls.readtrusted });
  return { reg, impls };
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
    const { reg } = registry();
    const h = harness({ capabilityRegistry: reg });
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
    const { reg } = registry();
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    for (const name of ['get_secret', 'read_private_key', 'write_trusted_memory', 'secrets.export_all']) {
      const tool = jest.fn(async () => 'x');
      const out = await runUnderKernel(toolRequest(name), tool, h.deps);
      expect(out.verdict).toBe('DENY');
      expect(tool).toHaveBeenCalledTimes(0);
    }
  });

  it('a registered + authorized impl whose CAPABILITY is a secret-export is DENIED (prohibition floor), 0 calls', async () => {
    const { reg, impls } = registry();
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    // The caller passes the actual registered implementation (reference matches), so the prohibition
    // floor — not the reference check — is what refuses it; the registered impl never runs.
    const out = await runUnderKernel(toolRequest('impl.secret'), impls.secret, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(impls.secret).toHaveBeenCalledTimes(0);
    expect(codes(out)).toContain('prohibited_capability');
  });

  it('#8: an unregistered tool with a BENIGN name (no prohibition-regex match) is DENIED, never allowed', async () => {
    // The verdict comes from the positively-established registered capability — NOT from "the
    // prohibition regex did not match → allow". 'formatter' matches no pattern yet is still DENIED.
    expect(classifyProhibitedCapability('formatter')).toBeNull();
    const { reg } = registry();
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    const out = await runUnderKernel(toolRequest('formatter'), jest.fn(async () => 'x'), h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('unregistered_tool');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('enforcement ON — a benign registered+authorized tool and the exceptions ALLOW', () => {
  it('a benign registered+authorized read ALLOWs; the receipt validates with capability PASS; the REGISTERED impl runs', async () => {
    const { reg, impls } = registry();
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    const out = await runUnderKernel(toolRequest('impl.formatter'), impls.formatter, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(impls.formatter).toHaveBeenCalledTimes(1); // the registered implementation ran
    expect(out.result).toBe('formatted');
    expect(capCheck(out.final_receipt ?? out.decision_receipt!)).toBe('PASS');
  });

  it('the deliberate exceptions ALLOW: memory.read_trusted and secrets.rotate', async () => {
    const { reg, impls } = registry();
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    for (const [name, run] of [['impl.readtrusted', impls.readtrusted], ['impl.rotate', impls.rotate]] as const) {
      const out = await runUnderKernel(toolRequest(name), run, h.deps);
      expect(out.verdict).toBe('ALLOW');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('XC1 #3 — the blanket `tool` action authorizes NOTHING, and bindings live in the signed bytes', () => {
  it('a legacy v1 policy with actions:[tool] and NO bindings authorizes no implementation (DENY)', async () => {
    const { reg, impls } = registry();
    const h = harness({ capabilityRegistry: reg });
    // signedPolicy signs under v1 and carries no authorized_impl_hashes — the blanket tool grant.
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { actions: ['tool'], per_tx_raw: '0', daily_raw: '0', total_raw: '0' }), iso);
    // The caller passes the genuine registered impl, so the reference check passes and AUTHORIZATION is
    // what refuses it — the point of this test (blanket `tool` authorizes nothing).
    const out = await runUnderKernel(toolRequest('impl.formatter'), impls.formatter, h.deps);
    expect(out.verdict).toBe('DENY'); // registered, but not authorized by any signed binding
    expect(impls.formatter).toHaveBeenCalledTimes(0);
    expect(codes(out)).toContain('impl_unauthorized');
  });

  it('bindings tampered after signing FAIL verification → no authorization → DENY (the signature covers them)', async () => {
    const { reg, impls } = registry();
    const h = harness({ capabilityRegistry: reg });
    const signed = await signedPolicyV2(h.owner, { authorized_impl_hashes: ['impl.formatter'] });
    // Tamper: add impl.secret to the stored bindings AFTER the owner signed only [impl.formatter].
    const tampered = { policy: { ...signed.policy, authorized_impl_hashes: ['impl.formatter', 'impl.secret'] }, signature: signed.signature };
    await h.ledger.appendPolicy(tampered, iso);
    const out = await runUnderKernel(toolRequest('impl.formatter'), impls.formatter, h.deps);
    // The v2 digest no longer matches the signature → policy signature FAILED → authorized set empty → DENY.
    expect(out.verdict).toBe('DENY');
    expect(impls.formatter).toHaveBeenCalledTimes(0);
    expect(codes(out)).toContain('impl_unauthorized');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('enforcement OFF (flag unset) — byte-unchanged: no capability check, and the blanket tool still ALLOWs', () => {
  it('the SAME v1 policy + read that ON denies, OFF ALLOWs (today\'s behaviour) with no capability check', async () => {
    const h = harness(); // no capabilityRegistry dep ⇒ OFF
    // CC1 2026-10-21: flag OFF a caller-asserted read now needs a policy with spend authority (P0-I3-01).
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { actions: ['spend', 'tool'], per_tx_raw: '1', daily_raw: '0', total_raw: '0' }), iso);
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
        subject: AGENT_ID, owner: '0x000000000000000000000000000000000000dEaD', actions: ['spend', 'tool'], payees: ['0x000000000000000000000000000000000000dEaD'], // CC1 2026-10-21: flag OFF a caller-asserted read now needs a policy with spend authority (P0-I3-01).
        per_tx_raw: '1', daily_raw: '0', total_raw: '0', expires_at: NOW_S + 3600, nonce: '1',
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

// ════════════════════════════════════════════════════════════════════════════════════════
// DRAFT 3 — the CLOSURE SWAP (Strix MEDIUM, CWE-863). Scope item 1: reference-equality at the call
// site. A caller that declares an authorized registered name but supplies a DIFFERENT closure must
// DENY and run nothing; the gate runs the REGISTERED implementation, never the caller's closure.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('Draft 3 #1 — reference-equality at the call site closes the closure swap', () => {
  it('REPRODUCTION: without threading the candidate (Draft-2 behaviour) the screen PASSes an authorized name regardless of which closure would run', () => {
    // This is the hole. The screen, asked ONLY the declared name (no candidate), says allow — even
    // though the gate would then run whatever closure the caller supplied. Draft 2 called it this way.
    const { reg } = registry();
    const screenNoCandidate = screenCapability({ toolClass: 'read', implRef: 'impl.formatter' }, reg, new Set(['impl.formatter']));
    expect(screenNoCandidate.allow).toBe(true);
    expect(screenNoCandidate.outcome).toBe('PASS');
    // Draft 3 threads the EXECUTING closure in as the candidate: a look-alike (different object) fails
    // closed BEFORE anything runs.
    const evil = async () => 'EXFILTRATED';
    const screenWithCandidate = screenCapability({ toolClass: 'read', implRef: 'impl.formatter', candidate: evil }, reg, new Set(['impl.formatter']));
    expect(screenWithCandidate.allow).toBe(false);
    expect(screenWithCandidate.code).toBe('impl_reference_mismatch');
  });

  it('FIX: a caller handing a DIFFERENT closure under an authorized registered name is DENIED, and NEITHER closure runs', async () => {
    const { reg, impls } = registry();
    const h = harness({ capabilityRegistry: reg });
    // The owner authorizes impl.formatter, so the ONLY thing that can refuse is the reference check —
    // proving the mismatch (not authorization or prohibition) is what closes the swap.
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner, { authorized_impl_hashes: ['impl.formatter'] }), iso);
    const evil = jest.fn(async () => 'EXFILTRATED');
    const out = await runUnderKernel(toolRequest('impl.formatter'), evil, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('impl_reference_mismatch');
    expect(out.executed).toBe(false);
    expect(evil).toHaveBeenCalledTimes(0); // the caller's malicious closure never ran
    expect(impls.formatter).toHaveBeenCalledTimes(0); // nor did the registered one (the call was refused)
    // and nothing from the swapped closure leaks into the refusal receipt
    expect(JSON.stringify(out.decision_receipt)).not.toContain('EXFILTRATED');
    expect(validateReceipt(out.decision_receipt)).toEqual({ ok: true });
  });

  it('the gate runs the REGISTERED implementation, not the caller-passed object — even one that is reference-equal', async () => {
    // The caller passes the genuine registered impl. The gate runs the registry\'s own `run`; here that
    // is the same object, so it is observably invoked exactly once and its value is returned.
    const { reg, impls } = registry();
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner, { authorized_impl_hashes: ['impl.formatter'] }), iso);
    const out = await runUnderKernel(toolRequest('impl.formatter'), impls.formatter, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(impls.formatter).toHaveBeenCalledTimes(1);
    expect(out.result).toBe('formatted');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// DRAFT 3 #2 — a dry POST /decide is NOT-RUNNABLE: an ALLOW there is a policy would-allow, never an
// enforced ALLOW of execution.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('Draft 3 #2 — a dry decide is NOT-RUNNABLE, distinguishable from a real enforced run', () => {
  it('dryDecision under enforcement: verdict may be ALLOW but runnable:false, persisted:false, executed:false, and nothing is written', async () => {
    const { reg, impls } = registry();
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso); // authorizes impl.formatter
    const dry = await dryDecision(toolRequest('impl.formatter'), h.deps);
    expect('malformed' in dry).toBe(false);
    if ('malformed' in dry) throw new Error('unreachable');
    expect(dry.verdict).toBe('ALLOW'); // the owner policy WOULD permit it
    expect(dry.runnable).toBe(false); // but this did not and will not run a tool
    expect(dry.persisted).toBe(false);
    expect(dry.receipt_preview!.decision.executed).toBe(false);
    expect(h.sink.records.filter((r) => r.kind === 'receipt')).toHaveLength(0); // nothing persisted

    // A real enforced run of the SAME call is unmistakably different: it executes and persists, and a
    // GateResult never carries `runnable` (only a DryDecision does).
    const real = await runUnderKernel(toolRequest('impl.formatter'), impls.formatter, h.deps);
    expect(real.verdict).toBe('ALLOW');
    expect(real.executed).toBe(true);
    expect(real.persisted).toBe(true);
    expect('runnable' in real).toBe(false);
  });

  it('the dry route carries runnable:false in its body (the signal a client reads)', async () => {
    const { reg } = registry();
    const h = harness({ capabilityRegistry: reg });
    await h.ledger.appendPolicy(await signedPolicyV2(h.owner), iso);
    const dry = await dryDecision(toolRequest('impl.formatter'), h.deps);
    if ('malformed' in dry) throw new Error('unreachable');
    expect(dry).toMatchObject({ runnable: false, persisted: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// DRAFT 3 #3 — fail-closed output gate: on any output-gate failure the tool's return value enters
// NEITHER the receipt NOR the gate result. (Defence-in-depth; independent of the flag.)
// ════════════════════════════════════════════════════════════════════════════════════════
describe('Draft 3 #3 — fail-closed output gate', () => {
  it('when the outcome row cannot be written, the return value is withheld from the gate result and never entered a receipt', async () => {
    const h = harness(); // OFF: the output gate is defence-in-depth, not flag-gated
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { actions: ['spend', 'tool'] }), iso); // CC1 2026-10-21: flag OFF a caller-asserted read now needs a policy with spend authority (P0-I3-01).
    const realAppend = h.sink.append.bind(h.sink);
    let receipts = 0;
    h.sink.append = async (rec) => {
      if (rec.kind === 'receipt' && ++receipts === 2) throw new Error('EIO'); // fail the OUTCOME row write
      return realAppend(rec);
    };
    const SECRET_RETURN = 'TOOL-RETURN-VALUE-SHOULD-NOT-LEAK';
    const out = await runUnderKernel(toolRequest('impl.formatter'), async () => SECRET_RETURN, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(out.executed).toBe(true); // the run happened
    expect(out.outcome_unrecorded).toBe(true); // but its outcome row could not be written
    expect(out.final_receipt).toBeNull();
    expect(out.result).toBeUndefined(); // the value is WITHHELD from the gate result (fail closed)
    expect('result' in out).toBe(false);
    // and it never entered the one receipt that WAS written (the decision row)
    expect(JSON.stringify(out.decision_receipt)).not.toContain(SECRET_RETURN);
  });

  it('on the happy path the result is returned (so the withholding above is the failure branch, not a regression)', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { actions: ['spend', 'tool'] }), iso); // CC1 2026-10-21: flag OFF a caller-asserted read now needs a policy with spend authority (P0-I3-01).
    const out = await runUnderKernel(toolRequest('impl.formatter'), async () => 'ok', h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(out.outcome_unrecorded).toBe(false);
    expect(out.result).toBe('ok');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// DRAFT 3 — flag-OFF is BYTE-IDENTICAL to pre-Draft-3. The golden hashes were captured from the base
// (origin/main @ 1b71d9f4) before any Draft-3 change; a matching receipt_hash is byte-identity of the
// canonical receipt content (keccak256 over it). If OFF behaviour drifts, this goes red.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('Draft 3 — flag-OFF receipt is byte-identical to pre-Draft-3 (frozen golden)', () => {
  // Captured from origin/main @ 1b71d9f4 (Draft 2, BEFORE any Draft-3 change), via a fully
  // deterministic OFF run: a FIXED owner wallet (so the signed wallet in the receipt does not vary),
  // the fixed-clock / fixed-id harness, no capabilityRegistry (=> OFF), a v1 `tool` policy with limits
  // 0, and a read of impl.formatter returning 'formatted'. receipt_hash is keccak256 over the canonical
  // JSON of the receipt, so a matching hash is byte-identity of the whole receipt content. If OFF
  // behaviour drifts by even one byte, these go red.
  // RE-PINNED by CC1 2026-10-21 (P0-I3-01): flag OFF a read now carries a spend_authority row and needs
  // a policy that authorizes spending, so the policy and both hashes changed on purpose. The OFF path
  // still carries no capability check; the pin still catches any further drift.
  const FIXED_OWNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const GOLDEN_DECISION_HASH = '0xad0c36e31db28d350ed71fef5e48fe6c64e8c22bb6822b8dcad03fb802578656';
  const GOLDEN_OUTCOME_HASH = '0x535440a18fb33c138cc848a89dfc6555cbc5f3a0114f11b985532565a1663110';

  async function offRun() {
    const fixedOwner = new Wallet(FIXED_OWNER_PK);
    const h = harness({ resolveOwner: async () => ({ status: 'resolved', wallet: fixedOwner.address, assurance: 'wallet-proven' }) });
    await h.ledger.appendPolicy(await signedPolicy(fixedOwner, { actions: ['spend', 'tool'], per_tx_raw: '1', daily_raw: '0', total_raw: '0' }), iso);
    return runUnderKernel(toolRequest('impl.formatter'), async () => 'formatted', h.deps);
  }

  it('the OFF receipt hashes match the frozen base values, and carry no capability check', async () => {
    const out = await offRun();
    expect(out.verdict).toBe('ALLOW');
    expect(out.decision_receipt!.header.receipt_hash).toBe(GOLDEN_DECISION_HASH);
    expect(out.final_receipt!.header.receipt_hash).toBe(GOLDEN_OUTCOME_HASH);
    expect(out.decision_receipt!.decision.checks.some((c) => c.name === 'capability')).toBe(false);
    expect(out.final_receipt!.decision.checks.some((c) => c.name === 'capability')).toBe(false);
    expect(out.decision_receipt!.decision.checks.some((c) => c.name === 'capability_enforced')).toBe(false);
    expect(out.final_receipt!.decision.checks.some((c) => c.name === 'capability_enforced')).toBe(false);
  });
});
