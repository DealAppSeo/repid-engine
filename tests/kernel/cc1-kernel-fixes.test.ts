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
import { StoreLedger, createJsonlStore } from '../../src/kernel/store';
import type { HalEvidence, KernelLedger, OwnerPolicy } from '../../src/kernel/types';
import * as decideModule from '../../src/kernel/decide';
import { AGENT_ID, NOW_S, PAYEE, harness, iso, postRequest, signedPolicy, spendRequest } from '../../src/kernel/__tests__/fixtures';
import { Wallet } from 'ethers';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, __resetOwnerAuthNonces, __setOwnerAuthNonceLedger, checkOwnerAuthorization, paramsHash, tableNonceLedger } from '../../src/services/owner-authorization';
import { createLocalStore } from '../../src/selfhost/local-store';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const hal = (verdict: HalEvidence['verdict']): HalEvidence => ({
  verdict, method: 'fact-check', votes: [{ family: 'a', verdict: 'PASS' }, { family: 'b', verdict: 'PASS' }], settled_by: null, grounded: false, same_domain: false,
});
const otherRequest = (name: string) => ({ ...readRequest(name), tool: { name, class: 'other' } });
const codesOf = (r: { reasons: Array<{ code: string }> }) => r.reasons.map((x) => x.code);

describe('I3-01/02: flag OFF a caller-asserted read/other is held to the gates of what it could be', () => {
  it('a tool-only policy (no spend authority) refuses a read: DENY(class_unverified), nothing runs', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { actions: ['tool'] }), iso);
    const tool = jest.fn(async () => 'x');
    const out = await runUnderKernel(readRequest('doc.read'), tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codesOf(out)).toEqual(['class_unverified']);
    expect(tool).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['no spend action', { actions: ['post', 'tool'] }],
    ['no payee', { payees: [] }],
    ['a zero per-transaction limit', { per_tx_raw: '0' }],
  ])('a policy with %s is no spend authority', async (_n, over) => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, over), iso);
    const out = await runUnderKernel(readRequest('doc.read'), jest.fn(async () => 'x'), h.deps);
    expect(codesOf(out)).toContain('class_unverified');
  });

  it('control: a policy with spend authority runs the read, and its receipt carries a PASS spend_authority row', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const out = await runUnderKernel(readRequest('doc.read'), jest.fn(async () => 'x'), h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(out.decision_receipt!.decision.checks.find((c) => c.name === 'spend_authority')?.outcome).toBe('PASS');
  });

  it('an `other` with HAL not wired is NOT_CHECKED(hal_not_checked); with HAL PASS it runs', async () => {
    const off = harness();
    await off.ledger.appendPolicy(await signedPolicy(off.owner), iso);
    const tool = jest.fn(async () => 'x');
    const nc = await runUnderKernel(otherRequest('misc.run'), tool, off.deps);
    expect(nc.verdict).toBe('NOT_CHECKED');
    expect(codesOf(nc)).toContain('hal_not_checked');
    expect(tool).toHaveBeenCalledTimes(0);
    const on = harness({ halCheck: async () => hal('PASS') });
    await on.ledger.appendPolicy(await signedPolicy(on.owner), iso);
    expect((await runUnderKernel(otherRequest('misc.run'), tool, on.deps)).verdict).toBe('ALLOW');
  });

  it('a `read` is screened by HAL when HAL is wired: a VETO refuses it', async () => {
    const h = harness({ halCheck: async () => hal('VETO') });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const out = await runUnderKernel(readRequest('doc.read'), jest.fn(async () => 'x'), h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codesOf(out)).toContain('hal_vetoed');
  });

  it('flag ON is unaffected: a tool-only owner with a bound, registered read runs it with no spend_authority row', async () => {
    const formatter = jest.fn(async () => 'formatted');
    const reg = createCapabilityRegistry();
    reg.register({ implId: 'impl.formatter', capability: { id: 'format.markdown', toolClass: 'read' }, run: formatter });
    const h = harness({ capabilityRegistry: reg });
    const policy: OwnerPolicy = {
      subject: AGENT_ID, owner: h.owner.address, actions: ['tool'], payees: [],
      per_tx_raw: '0', daily_raw: '0', total_raw: '0', expires_at: NOW_S + 3600, nonce: '1', authorized_impl_hashes: ['impl.formatter'],
    };
    await h.ledger.appendPolicy({ policy, signature: await h.owner.signTypedData(POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2(policy)) }, iso);
    const out = await runUnderKernel(readRequest('impl.formatter'), formatter as unknown as () => Promise<string>, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(out.decision_receipt!.decision.checks.some((c) => c.name === 'spend_authority')).toBe(false);
  });

  it('the ledger refuses a flag-OFF read ALLOW that lacks the spend_authority row (a decide() that drops it cannot run the tool)', async () => {
    const real = decideModule.decide;
    const spy = jest.spyOn(decideModule, 'decide').mockImplementation((input) => {
      const d = real(input);
      return { ...d, checks: d.checks.filter((c) => c.name !== 'spend_authority') };
    });
    try {
      const h = harness();
      await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
      const tool = jest.fn(async () => 'x');
      const out = await runUnderKernel(readRequest('doc.read'), tool, h.deps);
      expect(out.verdict).toBe('NOT_CHECKED');
      expect(codesOf(out)).toContain('receipt_write_failed');
      expect(tool).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('TK-03..05 / I3-16: one-use authorization, consumed atomically and durably', () => {
  const run = (deps: Parameters<typeof runUnderKernel>[2], req: Record<string, unknown>, tool = jest.fn(async () => 'x')) => runUnderKernel(req, tool, deps);

  it('survives a restart of the on-disk ledger: a replay after a new StoreLedger over the same file is DENY(authorization_consumed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc1-kernel-'));
    try {
      const path = join(dir, 'ledger.jsonl');
      const first = harness({ ledger: new StoreLedger(createJsonlStore(path)) });
      await first.deps.ledger.appendPolicy(await signedPolicy(first.owner), iso);
      expect((await run(first.deps, spendRequest())).verdict).toBe('ALLOW');
      const restarted: KernelLedger = new StoreLedger(createJsonlStore(path)); // a new process reading the same file
      const tool = jest.fn(async () => 'x');
      const again = await run({ ...first.deps, ledger: restarted }, spendRequest(), tool);
      expect(again.verdict).toBe('DENY');
      expect(codesOf(again)).toEqual(['authorization_consumed']);
      expect(tool).toHaveBeenCalledTimes(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('RT-5 for real: 12 concurrent DISTINCT spends against a 2-spend daily cap give exactly 2 effects (the reservation, not the replay rule)', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '1000000', daily_raw: '2000000', total_raw: '99000000' }), iso);
    const tool = jest.fn(async () => 'paid');
    const outs = await Promise.all(Array.from({ length: 12 }, (_, i) => run(h.deps, spendRequest({ amount_raw: '1000000', args_hash: hashArgs({ attempt: i }) }), tool)));
    expect(outs.filter((o) => o.verdict === 'ALLOW')).toHaveLength(2);
    expect(tool).toHaveBeenCalledTimes(2);
    expect(outs.filter((o) => o.verdict === 'DENY').every((o) => codesOf(o).some((c) => c === 'spend_limit_zero' || c === 'spend_limit_exceeded'))).toBe(true);
  });

  it('the ledger itself refuses a second ALLOW decision row for a consumed authorization (a builder that ignores the view cannot replay)', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const first = await run(h.deps, spendRequest());
    const copy = JSON.parse(JSON.stringify(first.decision_receipt)) as NonNullable<typeof first.decision_receipt>;
    await expect(h.ledger.appendReceipt((tip) => {
      const r = { ...copy, header: { ...copy.header, receipt_id: 'replayed-call-id', prev_receipt_id: tip!.receipt_id, prev_hash: tip!.receipt_hash } };
      return buildReceipt({ receipt_id: r.header.receipt_id, prev: tip, created_at: r.header.created_at, env: r.header.env, request: parseOk(spendRequest()), owner: { status: 'resolved', wallet: h.owner.address, assurance: 'wallet-proven' }, decision: copy.decision, executed: false, phase: 'decision', hal: { state: 'not_needed' } });
    })).rejects.toThrow(/authorization_consumed/);
  });

  it('a ledger that shows the builder no view cannot rule out a replay: NOT_CHECKED(authorization_not_checked), nothing runs', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const blind: KernelLedger = {
      appendReceipt: (b) => h.ledger.appendReceipt((tip) => b(tip)),
      appendPolicy: (p, t) => h.ledger.appendPolicy(p, t),
      latestPolicy: (s) => h.ledger.latestPolicy(s),
      findReceipts: (i) => h.ledger.findReceipts(i),
      spentTotals: (q) => h.ledger.spentTotals(q),
    };
    const tool = jest.fn(async () => 'x');
    const out = await run({ ...h.deps, ledger: blind }, spendRequest(), tool);
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(codesOf(out)).toContain('authorization_not_checked');
    expect(tool).toHaveBeenCalledTimes(0);
  });

  it('a spend replay with the payee in other letter case is still the same authorization', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    expect((await run(h.deps, spendRequest())).verdict).toBe('ALLOW');
    const again = await run(h.deps, spendRequest({ payee: PAYEE.toLowerCase() }));
    expect(codesOf(again)).toContain('authorization_consumed');
  });

  // B1 (XC1 re-grade): the key is the argument digest alone, so no field the payment does not depend on
  // (tool name, class, asset label, chain id, amount) opens a second use of one digest.
  it('one argument digest is one payment whatever the caller writes in the other fields, including filing it as a post', async () => {
    const h = harness({ halCheck: async () => hal('PASS') });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const pay = jest.fn(async () => 'paid');
    expect((await run(h.deps, spendRequest(), pay)).verdict).toBe('ALLOW');
    for (const v of [
      { tool: { name: 'x402.pay ', class: 'spend' } },
      { tool: { name: 'X402.PAY', class: 'spend' } },
      { asset: 'USDC ' }, { asset: null }, { chain_id: null }, { chain_id: 1 }, { amount_raw: 9999 },
    ]) expect(codesOf(await run(h.deps, spendRequest(v), pay))).toContain('authorization_consumed');
    const asPost = postRequest({ args_hash: (spendRequest().args_hash as string) });
    expect(codesOf(await run(h.deps, asPost, pay))).toContain('authorization_consumed');
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it('flag ON: a padded implementation id is the same payment authorization', async () => {
    const payment = jest.fn(async () => 'paid');
    const reg = createCapabilityRegistry();
    reg.register({ implId: 'impl.payment', capability: { id: 'payment.x402', toolClass: 'spend' }, run: payment });
    const h = harness({ capabilityRegistry: reg });
    const policy: OwnerPolicy = {
      subject: AGENT_ID, owner: h.owner.address, actions: ['spend', 'tool'], payees: [PAYEE],
      per_tx_raw: '1000000', daily_raw: '5000000', total_raw: '20000000', expires_at: NOW_S + 3600, nonce: '1', authorized_impl_hashes: ['impl.payment'],
    };
    await h.ledger.appendPolicy({ policy, signature: await h.owner.signTypedData(POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2(policy)) }, iso);
    const req = (name: string) => spendRequest({ tool: { name, class: 'spend' } });
    expect((await runUnderKernel(req('impl.payment'), payment as unknown as () => Promise<string>, h.deps)).verdict).toBe('ALLOW');
    for (const padded of [' impl.payment', 'impl.payment ', '﻿impl.payment']) {
      expect(codesOf(await runUnderKernel(req(padded), payment as unknown as () => Promise<string>, h.deps))).toContain('authorization_consumed');
    }
    expect(payment).toHaveBeenCalledTimes(1);
  });

  it('a post: the identical post is a replay; a post with other arguments is its own authorization (and HAL checks it)', async () => {
    const h = harness({ halCheck: async () => hal('PASS') });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    expect((await run(h.deps, postRequest())).verdict).toBe('ALLOW');
    expect(codesOf(await run(h.deps, postRequest()))).toContain('authorization_consumed');
    expect((await run(h.deps, postRequest({ args_hash: hashArgs({ channel: 'other' }) }))).verdict).toBe('ALLOW');
  });

  it('flag OFF a read/other grant is one run per policy version, whatever the tool name; the owner\'s next policy (higher nonce) grants the next', async () => {
    const h = harness({ halCheck: async () => hal('PASS') });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    expect((await run(h.deps, readRequest('doc.read'))).verdict).toBe('ALLOW');
    expect(codesOf(await run(h.deps, readRequest('doc.read.v2')))).toContain('authorization_consumed');
    expect(codesOf(await run(h.deps, otherRequest('misc.run')))).toContain('authorization_consumed');
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { nonce: '2' }), iso);
    expect((await run(h.deps, readRequest('doc.read'))).verdict).toBe('ALLOW');
  });

  it('flag ON a read/other grant is one run per bound implementation per policy version; a padded name is the same implementation', async () => {
    const impls = { a: jest.fn(async () => 'a'), b: jest.fn(async () => 'b') };
    const reg = createCapabilityRegistry();
    reg.register({ implId: 'impl.a', capability: { id: 'format.a', toolClass: 'read' }, run: impls.a });
    reg.register({ implId: 'impl.b', capability: { id: 'format.b', toolClass: 'read' }, run: impls.b });
    const h = harness({ capabilityRegistry: reg });
    const policy: OwnerPolicy = {
      subject: AGENT_ID, owner: h.owner.address, actions: ['tool'], payees: [],
      per_tx_raw: '0', daily_raw: '0', total_raw: '0', expires_at: NOW_S + 3600, nonce: '1', authorized_impl_hashes: ['impl.a', 'impl.b'],
    };
    await h.ledger.appendPolicy({ policy, signature: await h.owner.signTypedData(POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2(policy)) }, iso);
    const runImpl = (name: string, fn: jest.Mock) => runUnderKernel(readRequest(name), fn as unknown as () => Promise<string>, h.deps);
    expect((await runImpl('impl.a', impls.a)).verdict).toBe('ALLOW');
    expect((await runImpl('impl.b', impls.b)).verdict).toBe('ALLOW');
    expect(codesOf(await runImpl(' impl.a ', impls.a))).toContain('authorization_consumed');
    expect(impls.a).toHaveBeenCalledTimes(1);
  });
});

function parseOk(raw: unknown) {
  const p = parseKernelRequest(raw);
  if (!p.ok) throw new Error('fixture should parse');
  return p.request;
}

describe('TK-03: a used owner approval stays used across a restart (durable nonce ledger)', () => {
  const NOW = 1_800_000_000;
  async function approval() {
    const owner = Wallet.createRandom();
    const nonce = '0x' + randomBytes(32).toString('hex');
    const auth = { nonce, expires_at: NOW + 300, signature: await owner.signTypedData(OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, { subject: AGENT_ID, action: 'keys.create', params: paramsHash({}), nonce, expiresAt: NOW + 300 }) };
    return () => checkOwnerAuthorization({ subject: AGENT_ID, action: 'keys.create', params: {}, auth, expectedSigner: owner.address, nowS: NOW });
  }
  /** A supabase-js-shaped client whose select/insert answer as told. */
  function fakeClient(select: () => { data: unknown; error: { message: string } | null }, insert: () => { error: { message: string; code?: string } | null }) {
    const inserted: unknown[] = [];
    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: async () => select() }) }),
        insert: async (row: unknown) => { inserted.push(row); return insert(); },
      }),
    };
    return { client: client as never, inserted };
  }
  afterAll(() => {
    // Leave an offline ledger behind for anything that runs after this block (the setup file's is replaced).
    const used = new Set<string>();
    __setOwnerAuthNonceLedger({ async claim(s, n) { const k = `${s}:${n}`; if (used.has(k)) return 'replayed'; used.add(k); return 'claimed'; } });
  });

  it('table ledger: a fresh nonce is inserted (claimed); one already present is replayed; a concurrent insert (23505) is replayed', async () => {
    const fresh = fakeClient(() => ({ data: [], error: null }), () => ({ error: null }));
    expect(await tableNonceLedger(() => fresh.client).claim('0xabc', '0x01', NOW + 300)).toBe('claimed');
    expect(fresh.inserted).toEqual([{ signer: '0xabc', nonce: '0x01', expires_at: new Date((NOW + 300) * 1000).toISOString() }]);
    const seen = fakeClient(() => ({ data: [{ nonce: '0x01' }], error: null }), () => ({ error: null }));
    expect(await tableNonceLedger(() => seen.client).claim('0xabc', '0x01', NOW + 300)).toBe('replayed');
    expect(seen.inserted).toHaveLength(0);
    const raced = fakeClient(() => ({ data: [], error: null }), () => ({ error: { message: 'duplicate key', code: '23505' } }));
    expect(await tableNonceLedger(() => raced.client).claim('0xabc', '0x01', NOW + 300)).toBe('replayed');
  });

  it('table ledger down (e.g. the table is not applied yet): the approval is not_checked, fail closed, and its nonce is not burned', async () => {
    let up = false;
    const flaky = fakeClient(() => (up ? { data: [], error: null } : { data: null, error: { message: 'relation "owner_auth_nonces" does not exist' } }), () => ({ error: null }));
    __setOwnerAuthNonceLedger(tableNonceLedger(() => flaky.client));
    __resetOwnerAuthNonces();
    const present = await approval();
    expect(await present()).toMatchObject({ ok: false, code: 'not_checked' });
    up = true;
    expect(await present()).toMatchObject({ ok: true });
  });

  it('LOCAL_MODE store, real restart: a new store over the same file (and cleared process memory) refuses the used approval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc1-nonces-'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const file = join(dir, 'local-store.json');
      const present = await approval();
      const first = createLocalStore(file);
      __setOwnerAuthNonceLedger(tableNonceLedger(() => first as never));
      __resetOwnerAuthNonces();
      expect(await present()).toMatchObject({ ok: true });
      const restarted = createLocalStore(file); // a new process opening the same store
      __setOwnerAuthNonceLedger(tableNonceLedger(() => restarted as never));
      __resetOwnerAuthNonces();
      expect(await present()).toMatchObject({ ok: false, code: 'replayed' });
    } finally {
      warn.mockRestore();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* a SQLite handle may still hold the file on Windows */ }
    }
  });
});

describe('I2-08: an effect whose outcome could not be recorded is INDETERMINATE, and is never retried', () => {
  // P0-I2-08 itself stays it.failing: it asks that a failed OUTCOME append leave zero effect, but the
  // outcome row is written after the tool ran, and P0-I2-03 / P0-I2-07 (PASS) require exactly one
  // receipt row (the decision) before the tool runs. What can be done is the blueprint's answer:
  // name the state, keep it across a restart, and refuse a retry.
  function failSecondReceipt() {
    const records: Array<import('../../src/kernel/types').LedgerRecord> = [];
    let receipts = 0;
    return {
      records,
      async append(record: import('../../src/kernel/types').LedgerRecord) {
        if (record.kind === 'receipt' && ++receipts === 2) throw new Error('disk full');
        records.push(JSON.parse(JSON.stringify(record)));
      },
      async readAll() { return records.map((r) => JSON.parse(JSON.stringify(r))); },
    };
  }

  it('the ledger lists the call as INDETERMINATE, still after a restart, and a retry is DENY with no second effect', async () => {
    const sink = failSecondReceipt();
    const ledger = new StoreLedger(sink);
    const h = harness({ ledger });
    await ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 'MONEY MOVED');
    const out = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(out.outcome_unrecorded).toBe(true);
    expect(await ledger.indeterminate()).toEqual([out.decision_receipt!.header.receipt_id]);
    const restarted = new StoreLedger(sink);
    expect(await restarted.indeterminate()).toEqual([out.decision_receipt!.header.receipt_id]);
    const retry = await runUnderKernel(spendRequest(), tool, { ...h.deps, ledger: restarted });
    expect(codesOf(retry)).toContain('authorization_consumed');
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it('control: a call whose outcome row was written is not INDETERMINATE', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    expect((await runUnderKernel(spendRequest(), jest.fn(async () => 'paid'), h.deps)).final_receipt).not.toBeNull();
    expect(await h.ledger.indeterminate()).toEqual([]);
  });
});
