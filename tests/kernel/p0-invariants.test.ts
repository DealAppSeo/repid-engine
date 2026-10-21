/**
 * P0 INVARIANT RED TEAM of the policy kernel. XC1, 2026-10-19 (Trust Harness, gate P0).
 *
 * Extends tests/kernel/red-team.test.ts (#1323) in the same style, against origin/main.
 * READ-ONLY on src/: this file imports src/kernel and src/services and attacks them; it changes
 * nothing in either. Owner keys are Wallet.createRandom(): in memory for one test, never written,
 * never funded, no chain is dialled (the chain is always an injected fake or the offline default).
 *
 * HOW TO READ THIS FILE. Every probe name starts with its outcome and an id that
 * eval/p0/INVARIANT_REPORT.md cites.
 *   - it('[PASS P0-…] …')              the invariant HELD on origin/main. Each group carries a
 *                                       positive control, so a refusal cannot be a broken probe.
 *   - it.failing('[FAIL P0-…] …')      a SECURE expectation origin/main does NOT meet. Jest counts it
 *                                       as passing while the hole is open and turns RED the day it
 *                                       closes ("failing test passed"): the cue to drop the marker.
 *   - it.todo('[NOT_CHECKED P0-…] …')  the mechanism the invariant needs does not exist on main, so
 *                                       there is nothing to attack yet. Not a pass.
 *   - it('CHARACTERISE P0-…')          pins a documented limitation so it cannot drift unnoticed.
 *
 * THE INVARIANTS (blueprint v4 "The invariants every gate is tested against", plus the XC1 brief).
 *   I1  DENY or NOT_CHECKED means zero protected effect.
 *   I2  No protected effect if the decision cannot be written durably, a receipt append fails, or
 *       the capability reservation fails.
 *   I3  The class comes from registration, never from the request body; forged, swapped and
 *       look-alike implementation ids and widened scope are refused; authorization binds identity,
 *       policy, action, argument digest, target, expiry, nonce, attempt id and maximum uses.
 *   AP  A fake owner approval authorizes nothing.
 *   VF  An unknown or unavailable verifier yields NOT_CHECKED, never a pass.
 *   TK  A one-use token yields at most one effect, under a race and on replay.
 * The receipt strip-and-reseal probe (PR #1358's conceded limit) is in p0-receipt-strip.test.ts.
 */
import { Wallet } from 'ethers';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapabilityRegistry, type ReadonlyCapabilityRegistry, type ToolImplementation } from '../../src/kernel/capability-registry';
import { runUnderKernel } from '../../src/kernel/gate';
import { POLICY_DOMAIN, POLICY_DOMAIN_V2, POLICY_TYPES, POLICY_TYPES_V2, policyHash, policyTypedValue, policyTypedValueV2 } from '../../src/kernel/policy';
import { hashArgs } from '../../src/kernel/receipt';
import { StoreLedger, createJsonlStore, createMemoryStore } from '../../src/kernel/store';
import type { GateDeps, GateResult, HalEvidence, KernelReceipt, KernelSink, LedgerRecord, OwnerPolicy, SignedOwnerPolicy, ToolClass } from '../../src/kernel/types';
import { AGENT_ID, NOW_S, PAYEE, harness, iso, postRequest, signedPolicy, spendRequest } from '../../src/kernel/__tests__/fixtures';
import { MAX_LIFETIME_S, OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, __resetOwnerAuthNonces, checkOwnerAuthorization, paramsHash } from '../../src/services/owner-authorization';
import { verifyReceiptSignature } from '../../src/services/receipt-signer';
import type { SignatureChain } from '../../src/services/wallet-signature';

const codes = (r: { reasons: Array<{ code: string }> }) => r.reasons.map((x) => x.code);
const CLASSES: ToolClass[] = ['read', 'spend', 'post', 'other'];

const hal = (over: Partial<HalEvidence> = {}): HalEvidence => ({
  verdict: 'PASS',
  method: 'fact-check',
  votes: [
    { family: 'gpt-oss', verdict: 'PASS' },
    { family: 'qwen', verdict: 'PASS' },
  ],
  settled_by: null,
  grounded: false,
  same_domain: false,
  ...over,
});
const halPass = async () => hal();

/** A well-formed request of any class. Money fields only on a spend (anything else is a disguised spend). */
function requestFor(cls: ToolClass, over: Record<string, unknown> = {}): Record<string, unknown> {
  if (cls === 'spend') return spendRequest(over);
  if (cls === 'post') return postRequest(over);
  return {
    agent: { agent_id: AGENT_ID, agent_name: 'kernel-demo-agent' },
    tool: { name: cls === 'read' ? 'doc.read' : 'misc.run', class: cls },
    origin: 'Cli',
    args_hash: hashArgs({ cls }),
    ...over,
  };
}

/** Zero protected effect, read from outside: nothing ran, nothing came back, no outcome row, no payment. */
function assertZeroEffect(out: GateResult<unknown>, ...tools: jest.Mock[]): void {
  expect(out.verdict).not.toBe('ALLOW');
  expect(out.blocking).toBe(true);
  expect(out.executed).toBe(false);
  for (const t of tools) expect(t).toHaveBeenCalledTimes(0);
  expect(out.result).toBeUndefined();
  expect(out.tool_error).toBeUndefined();
  expect(out.final_receipt).toBe(out.decision_receipt); // no outcome row was written
  if (out.decision_receipt) {
    expect(out.decision_receipt.decision.executed).toBe(false);
    expect(out.decision_receipt.payment.status).toBe('NOT_APPLICABLE');
  }
}

/** A harness with a generous signed v1 policy already on the ledger (no implementation bindings). */
async function armed(over: Partial<GateDeps> = {}, policy: Partial<OwnerPolicy> & { claimedOwner?: string } = {}) {
  const h = harness(over);
  await h.ledger.appendPolicy(await signedPolicy(h.owner, policy), iso);
  return h;
}

/** An owner-signed v2 policy: v1 plus the implementation bindings, which the signature covers. */
async function policyV2(signer: Wallet, over: Partial<OwnerPolicy> = {}): Promise<SignedOwnerPolicy> {
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
    authorized_impl_hashes: ['impl.formatter', 'impl.payment', 'impl.poster'],
    ...over,
  };
  const signature = await signer.signTypedData(POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2(policy));
  return { policy, signature };
}

/** Flag ON, as the route does it: a boot-populated registry handed to the gate (prod flag stays unset). */
function registry() {
  const impls = {
    formatter: jest.fn(async () => 'formatted'),
    payment: jest.fn(async () => 'paid'),
    poster: jest.fn(async () => 'posted'),
  };
  const reg = createCapabilityRegistry();
  reg.register({ implId: 'impl.formatter', capability: { id: 'format.markdown', toolClass: 'read' }, run: impls.formatter });
  reg.register({ implId: 'impl.payment', capability: { id: 'payment.x402', toolClass: 'spend' }, run: impls.payment });
  reg.register({ implId: 'impl.poster', capability: { id: 'social.publish', toolClass: 'post' }, run: impls.poster });
  return { reg, impls };
}

/** Flag-ON harness with every registered impl authorized by a signed v2 policy. */
async function enforced(over: Partial<GateDeps> = {}, policy: Partial<OwnerPolicy> = {}) {
  const { reg, impls } = registry();
  const h = harness({ capabilityRegistry: reg, halCheck: halPass, ...over });
  await h.ledger.appendPolicy(await policyV2(h.owner, policy), iso);
  return { ...h, reg, impls };
}

/** A sink that can be told to fail a given receipt append. Policy appends always go through. */
function failingSink(failOnReceipt: (n: number) => boolean, mode: 'throw' | 'reject-later' = 'throw') {
  const inner = createMemoryStore();
  let receipts = 0;
  const sink: KernelSink & { records: LedgerRecord[] } = {
    records: inner.records,
    async append(record) {
      if (record.kind === 'receipt') {
        receipts += 1;
        if (failOnReceipt(receipts)) {
          if (mode === 'reject-later') await new Promise((r) => setTimeout(r, 5));
          throw new Error('disk full');
        }
      }
      return inner.append(record);
    },
    readAll: () => inner.readAll(),
  };
  return sink;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// I1 — DENY or NOT_CHECKED means zero protected effect. Every class, every refusal family.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('P0-I1 DENY or NOT_CHECKED means zero protected effect', () => {
  it.each(CLASSES)('[PASS P0-I1-00] positive control: a clean %s call ALLOWs and runs the tool exactly once', async (cls) => {
    const h = await armed({ halCheck: halPass });
    const tool = jest.fn(async () => 'ran');
    const out = await runUnderKernel(requestFor(cls), tool, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(1);
    expect(out.result).toBe('ran');
  });

  type Breaker = [string, 'DENY' | 'NOT_CHECKED', (owner: Wallet) => Promise<{ deps?: Partial<GateDeps>; policy?: SignedOwnerPolicy | null }>];
  const BREAKERS: Breaker[] = [
    ['no policy on record', 'DENY', async () => ({ policy: null })],
    ['policy store unreadable', 'NOT_CHECKED', async () => ({ deps: { policySource: { latest: async () => { throw new Error('store down'); } } } })],
    ['owner unknown', 'NOT_CHECKED', async () => ({ deps: { resolveOwner: async () => ({ status: 'unknown', wallet: null, assurance: null }) } })],
    ['owner none', 'DENY', async () => ({ deps: { resolveOwner: async () => ({ status: 'none', wallet: null, assurance: null }) } })],
    ['policy expired', 'DENY', async (o) => ({ policy: await signedPolicy(o, { expires_at: NOW_S - 1 }) })],
    ['policy signed for another agent', 'DENY', async (o) => ({ policy: await signedPolicy(o, { subject: '22222222-2222-4222-8222-222222222222' }) })],
    ['policy lists no actions', 'DENY', async (o) => ({ policy: await signedPolicy(o, { actions: [] }) })],
    ['policy signed by an impostor claiming the owner', 'DENY', async (o) => ({ policy: await signedPolicy(Wallet.createRandom(), { claimedOwner: o.address }) })],
  ];
  const MATRIX = CLASSES.flatMap((cls) => BREAKERS.map(([name, verdict, make]) => [cls, name, verdict, make] as const));

  it.each(MATRIX)('[PASS P0-I1-01] %s: %s -> %s, tool 0 calls, no result, no outcome row, no payment', async (cls, _name, verdict, make) => {
    const h = harness({ halCheck: halPass });
    const m = await make(h.owner);
    const deps: GateDeps = { ...h.deps, ...(m.deps ?? {}) };
    const policy = m.policy === undefined ? await signedPolicy(h.owner) : m.policy;
    if (policy) await h.ledger.appendPolicy(policy, iso);
    const tool = jest.fn(async () => 'EFFECT');
    const out = await runUnderKernel(requestFor(cls), tool, deps);
    expect(out.verdict).toBe(verdict);
    assertZeroEffect(out, tool);
  });

  it.each(CLASSES)('[PASS P0-I1-02] flag ON, %s: an unregistered tool is DENY and neither the caller closure nor any registered impl runs', async (cls) => {
    const e = await enforced();
    const tool = jest.fn(async () => 'EFFECT');
    const out = await runUnderKernel(requestFor(cls), tool, e.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('unregistered_tool');
    assertZeroEffect(out, tool, e.impls.formatter, e.impls.payment, e.impls.poster);
  });

  it.each(CLASSES)('[PASS P0-I1-03] flag ON, %s: a registry that throws while screening is NOT_CHECKED and nothing runs', async (cls) => {
    const exploding: ReadonlyCapabilityRegistry = {
      get size(): number { return 3; },
      resolveById: () => { throw new Error('registry corrupted'); },
      isRegisteredImplementation: () => { throw new Error('registry corrupted'); },
    };
    const h = harness({ capabilityRegistry: exploding, halCheck: halPass });
    await h.ledger.appendPolicy(await policyV2(h.owner), iso);
    const tool = jest.fn(async () => 'EFFECT');
    const out = await runUnderKernel(requestFor(cls), tool, h.deps);
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(codes(out)).toContain('capability_not_checked');
    assertZeroEffect(out, tool);
  });

  it('[PASS P0-I1-04] refusals consume no budget: five DENY and NOT_CHECKED spends leave the cumulative totals at zero', async () => {
    const h = await armed({}, { per_tx_raw: '5000000', daily_raw: '5000000' });
    const tool = jest.fn(async () => 'MONEY MOVED');
    // DENY: payee off the list (the decision row is persisted, with the full amount on it).
    for (let i = 0; i < 4; i++) {
      const out = await runUnderKernel(spendRequest({ amount_raw: '5000000', payee: '0x000000000000000000000000000000000000bEEF' }), tool, h.deps);
      expect(out.verdict).toBe('DENY');
      expect(out.persisted).toBe(true);
    }
    // NOT_CHECKED: the owner could not be resolved (also persisted).
    const nc = await runUnderKernel(spendRequest({ amount_raw: '5000000' }), tool, { ...h.deps, resolveOwner: async () => ({ status: 'unknown', wallet: null, assurance: null }) });
    expect(nc.verdict).toBe('NOT_CHECKED');
    expect(tool).toHaveBeenCalledTimes(0);
    const policy = await h.ledger.latestPolicy(AGENT_ID);
    expect(await h.ledger.spentTotals({ agent_id: AGENT_ID, policy_hash: policyHash(policy!.policy), since_s: NOW_S - 86_400 })).toEqual({ daily_raw: '0', total_raw: '0' });
    // Control: the whole daily budget is still there.
    const ok = await runUnderKernel(spendRequest({ amount_raw: '5000000' }), tool, h.deps);
    expect(ok.verdict).toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it('[PASS P0-I1-05] a malformed request is DENY with nothing persisted and nothing run (no receipt to attribute)', async () => {
    const h = await armed();
    const tool = jest.fn(async () => 'EFFECT');
    const out = await runUnderKernel({ ...spendRequest(), tool: { name: 'x402.pay', class: 'SPEND' } }, tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(out.persisted).toBe(false);
    assertZeroEffect(out, tool);
    expect(h.sink.records.filter((r) => r.kind === 'receipt')).toHaveLength(0);
  });

  it('[PASS P0-I1-06] observePayment (the spend reporter) is never consulted on a refusal', async () => {
    const h = await armed({}, { per_tx_raw: '0' });
    const tool = jest.fn(async () => 'MONEY MOVED');
    const observePayment = jest.fn(() => ({ tx_hash: null }));
    const out = await runUnderKernel(spendRequest(), tool, h.deps, { observePayment });
    expect(out.verdict).toBe('DENY');
    assertZeroEffect(out, tool);
    expect(observePayment).toHaveBeenCalledTimes(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// I2 — no protected effect if the decision cannot be written durably or a receipt append fails.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('P0-I2 a failed durable write or receipt append means zero effect', () => {
  it.each([
    ...CLASSES.map((c) => [c, 'throw'] as const),
    ...CLASSES.map((c) => [c, 'reject-later'] as const),
  ])('[PASS P0-I2-01] %s: the decision-row append fails (%s) -> NOT_CHECKED(receipt_write_failed), tool 0 calls', async (cls, mode) => {
    const sink = failingSink(() => true, mode);
    const h = harness({ ledger: new StoreLedger(sink), halCheck: halPass });
    await h.deps.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 'EFFECT');
    const out = await runUnderKernel(requestFor(cls), tool, h.deps);
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(codes(out)).toContain('receipt_write_failed');
    expect(out.persisted).toBe(false);
    assertZeroEffect(out, tool);
  });

  it('[PASS P0-I2-02] a DENY whose row cannot be written stays DENY (a definite no is not softened) and runs nothing', async () => {
    const sink = failingSink(() => true);
    const h = harness({ ledger: new StoreLedger(sink) });
    await h.deps.ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '0' }), iso);
    const tool = jest.fn(async () => 'EFFECT');
    const out = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toEqual(expect.arrayContaining(['spend_limit_zero', 'receipt_write_failed']));
    assertZeroEffect(out, tool);
  });

  it('[PASS P0-I2-03] ordering: when the tool runs, its ALLOW decision row (executed:false) is already in the sink', async () => {
    const h = await armed();
    let seen: KernelReceipt | undefined;
    const tool = jest.fn(async () => {
      const rows = h.sink.records.filter((r): r is Extract<LedgerRecord, { kind: 'receipt' }> => r.kind === 'receipt');
      seen = rows[rows.length - 1]?.receipt;
      return 'ran';
    });
    const out = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(seen?.header.receipt_id).toBe(out.decision_receipt?.header.receipt_id);
    expect(seen?.decision.verdict).toBe('ALLOW');
    expect(seen?.decision.executed).toBe(false);
  });

  it('[PASS P0-I2-04] a failed append does not wedge the ledger: the next call writes and runs (positive control on the failure path)', async () => {
    const sink = failingSink((n) => n === 1);
    const h = harness({ ledger: new StoreLedger(sink) });
    await h.deps.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 'ran');
    expect((await runUnderKernel(spendRequest(), tool, h.deps)).verdict).toBe('NOT_CHECKED');
    expect(tool).toHaveBeenCalledTimes(0);
    expect((await runUnderKernel(spendRequest(), tool, h.deps)).verdict).toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(1);
  });

  describe('on-disk JSONL ledger (the production sink type)', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'xc1-p0-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('[PASS P0-I2-05] an unwritable ledger path (its parent is a regular file) -> nothing runs', async () => {
      const blocker = join(dir, 'not-a-dir');
      writeFileSync(blocker, 'x');
      const policyOk = harness();
      const signed = await signedPolicy(policyOk.owner);
      const h = harness({
        ledger: new StoreLedger(createJsonlStore(join(blocker, 'ledger.jsonl'))),
        resolveOwner: policyOk.deps.resolveOwner,
        policySource: { latest: async () => signed }, // the policy is readable; only the receipt write fails
      });
      const tool = jest.fn(async () => 'EFFECT');
      const out = await runUnderKernel(spendRequest(), tool, h.deps);
      expect(out.verdict).toBe('NOT_CHECKED');
      expect(codes(out)).toContain('receipt_write_failed');
      assertZeroEffect(out, tool);
    });

    it('[PASS P0-I2-06] a ledger file with a damaged line is refused for every read -> NOT_CHECKED and nothing runs', async () => {
      const path = join(dir, 'ledger.jsonl');
      const seed = harness();
      writeFileSync(path, JSON.stringify({ kind: 'policy', recorded_at: iso, policy: await signedPolicy(seed.owner) }) + '\n{"kind":"receipt", BROKEN\n');
      const h = harness({ ledger: new StoreLedger(createJsonlStore(path)), resolveOwner: seed.deps.resolveOwner });
      const tool = jest.fn(async () => 'EFFECT');
      const out = await runUnderKernel(spendRequest(), tool, h.deps);
      expect(out.verdict).toBe('NOT_CHECKED');
      assertZeroEffect(out, tool);
    });

    it('[PASS P0-I2-07] positive control: the same JSONL ledger, writable, ALLOWs and the decision row is on disk before the tool returns', async () => {
      const path = join(dir, 'ledger.jsonl');
      const h = harness({ ledger: new StoreLedger(createJsonlStore(path)) });
      await h.deps.ledger.appendPolicy(await signedPolicy(h.owner), iso);
      let linesAtRun = 0;
      const tool = jest.fn(async () => {
        linesAtRun = readFileSync(path, 'utf8').trim().split('\n').length;
        return 'ran';
      });
      expect((await runUnderKernel(spendRequest(), tool, h.deps)).verdict).toBe('ALLOW');
      expect(linesAtRun).toBe(2); // the policy line and the decision row
    });
  });

  // The outcome row is written AFTER the tool ran. A failure there cannot be "zero effect": the effect
  // already happened. Strict I2 ("a failed receipt append means zero effect") is therefore unmet for the
  // outcome leg. The blueprint's answer is INDETERMINATE + reconciliation, which main does not have.
  it.failing('[FAIL P0-I2-08] a failed OUTCOME append must leave zero protected effect (BREACHED: the tool already ran)', async () => {
    const sink = failingSink((n) => n === 2);
    const h = harness({ ledger: new StoreLedger(sink) });
    await h.deps.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 'MONEY MOVED');
    await runUnderKernel(spendRequest(), tool, h.deps);
    expect(tool).toHaveBeenCalledTimes(0);
  });
  it('CHARACTERISE P0-I2-08: the effect happened, the gate says outcome_unrecorded and withholds the result, and nothing marks it INDETERMINATE for reconciliation', async () => {
    const sink = failingSink((n) => n === 2);
    const h = harness({ ledger: new StoreLedger(sink) });
    await h.deps.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 'MONEY MOVED');
    const out = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(tool).toHaveBeenCalledTimes(1);
    expect(out.verdict).toBe('ALLOW');
    expect(out.executed).toBe(true);
    expect(out.outcome_unrecorded).toBe(true);
    expect(out.result).toBeUndefined();
    expect(out.final_receipt).toBeNull();
    // The durable record shows an AUTHORIZED decision and nothing after it: indistinguishable on the
    // ledger from "authorized, never run". The kernel vocabulary has no INDETERMINATE state.
    const rows = sink.records.filter((r) => r.kind === 'receipt');
    expect(rows).toHaveLength(1);
  });

  it('CHARACTERISE P0-I2-09: a sink that acknowledges and drops is not detected; the tool runs and a restarted ledger has no record of the decision', async () => {
    const kept: LedgerRecord[] = [];
    const lying: KernelSink = {
      async append(record) { if (record.kind === 'policy') kept.push(JSON.parse(JSON.stringify(record)) as LedgerRecord); },
      async readAll() { return kept.map((r) => JSON.parse(JSON.stringify(r)) as LedgerRecord); },
    };
    const h = harness({ ledger: new StoreLedger(lying) });
    await h.deps.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 'ran');
    const out = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(1);
    const restarted = new StoreLedger(lying);
    expect(await restarted.findReceipts(out.decision_receipt!.header.receipt_id)).toEqual([]);
  });

  it('CHARACTERISE P0-I2-10: the best-effort DB index failing does not block the effect (the JSONL file is the only durable precondition)', async () => {
    const indexer = jest.fn(async () => { throw new Error('db down'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sink = createMemoryStore();
      const h = harness({ ledger: new StoreLedger(sink, indexer) });
      await h.deps.ledger.appendPolicy(await signedPolicy(h.owner), iso);
      const tool = jest.fn(async () => 'ran');
      expect((await runUnderKernel(spendRequest(), tool, h.deps)).verdict).toBe('ALLOW');
      expect(tool).toHaveBeenCalledTimes(1);
      expect(indexer).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.todo('[NOT_CHECKED P0-I2-11] a failed capability RESERVATION means zero effect: origin/main has no reservation (spend totals are summed after the fact, gate.ts header "NOT ATOMIC"), so there is nothing to fail');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// I3 — class from registration; forged / swapped / look-alike ids; widened scope; what a grant binds.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('P0-I3 the class comes from registration, never from the request body', () => {
  describe('flag OFF (KERNEL_CAPABILITY_REGISTRY_ENABLED unset: the production default)', () => {
    it.failing('[FAIL P0-I3-01] a payment closure filed as class "read" must not ALLOW without the spend checks (BREACHED: the class is the caller\'s word)', async () => {
      const h = await armed({}, { payees: [], per_tx_raw: '0', daily_raw: '0', total_raw: '0' }); // owner allows NO spend at all
      const pay = jest.fn(async () => 'MONEY MOVED');
      const out = await runUnderKernel(requestFor('read', { tool: { name: 'x402.pay', class: 'read' } }), pay, h.deps);
      expect(out.verdict).not.toBe('ALLOW');
      expect(pay).toHaveBeenCalledTimes(0);
    });
    it.failing('[FAIL P0-I3-02] a publishing closure filed as class "other" must not ALLOW without HAL (BREACHED: HAL is never asked)', async () => {
      const halCheck = jest.fn(async () => hal({ verdict: 'VETO' }));
      const h = await armed({ halCheck });
      const publish = jest.fn(async () => 'POSTED');
      const out = await runUnderKernel(requestFor('other', { tool: { name: 'social.post', class: 'other' } }), publish, h.deps);
      expect(out.verdict).not.toBe('ALLOW');
      expect(publish).toHaveBeenCalledTimes(0);
    });
    it('CHARACTERISE P0-I3-03: the flag-OFF receipt states the class is caller-asserted, so the limitation is written down, not hidden', async () => {
      const h = await armed();
      const out = await runUnderKernel(requestFor('read'), jest.fn(async () => 1), h.deps);
      expect(out.decision_receipt!.decision.does_not_attest).toContain('tool_class (caller-asserted; there is no tool registry in the MVP)');
      expect(out.decision_receipt!.decision.checks.some((c) => c.name === 'capability')).toBe(false);
    });
  });

  describe('flag ON (capability registry injected)', () => {
    const REGISTERED: Array<[keyof ReturnType<typeof registry>['impls'], string, ToolClass]> = [
      ['formatter', 'impl.formatter', 'read'],
      ['payment', 'impl.payment', 'spend'],
      ['poster', 'impl.poster', 'post'],
    ];

    it.each(REGISTERED)('[PASS P0-I3-04] positive control: %s (%s) under its registered class %s ALLOWs and runs the REGISTERED impl once', async (key, implId, cls) => {
      const e = await enforced();
      const run = e.impls[key];
      const out = await runUnderKernel(requestFor(cls, { tool: { name: implId, class: cls } }), run as unknown as () => Promise<string>, e.deps);
      expect(out.verdict).toBe('ALLOW');
      expect(run).toHaveBeenCalledTimes(1);
    });

    const MISMATCH = REGISTERED.flatMap(([key, implId, registered]) =>
      CLASSES.filter((c) => c !== registered).map((asserted) => [implId, registered, asserted, key] as const),
    );
    it.each(MISMATCH)('[PASS P0-I3-05] %s is registered as %s; a request asserting %s is DENY(impl_class_mismatch) and nothing runs', async (implId, _registered, asserted, key) => {
      const e = await enforced();
      const run = e.impls[key];
      const out = await runUnderKernel(requestFor(asserted, { tool: { name: implId, class: asserted } }), run as unknown as () => Promise<string>, e.deps);
      expect(out.verdict).toBe('DENY');
      expect(codes(out)).toContain('impl_class_mismatch');
      assertZeroEffect(out, e.impls.formatter, e.impls.payment, e.impls.poster);
    });

    it('[PASS P0-I3-06] a forged (never registered) implementation id is DENY(unregistered_tool) and the caller closure never runs', async () => {
      const e = await enforced();
      const evil = jest.fn(async () => 'EFFECT');
      const out = await runUnderKernel(requestFor('read', { tool: { name: 'impl.exporter', class: 'read' } }), evil, e.deps);
      expect(codes(out)).toContain('unregistered_tool');
      assertZeroEffect(out, evil, e.impls.formatter);
    });

    it.each([
      ['names impl.payment, hands over the formatter', 'impl.payment', 'spend', 'formatter'],
      ['names impl.formatter, hands over the payment impl', 'impl.formatter', 'read', 'payment'],
      ['names impl.poster, hands over the formatter', 'impl.poster', 'post', 'formatter'],
    ] as const)('[PASS P0-I3-07] swapped implementation (%s): DENY(impl_reference_mismatch), neither function runs', async (_n, implId, cls, handed) => {
      const e = await enforced();
      const out = await runUnderKernel(requestFor(cls, { tool: { name: implId, class: cls } }), e.impls[handed] as unknown as () => Promise<string>, e.deps);
      expect(codes(out)).toContain('impl_reference_mismatch');
      assertZeroEffect(out, e.impls.formatter, e.impls.payment, e.impls.poster);
    });

    it('[PASS P0-I3-08] a look-alike closure (same source text, different object) is not the registered impl', async () => {
      const e = await enforced();
      const twin = jest.fn(async () => 'formatted');
      const out = await runUnderKernel(requestFor('read', { tool: { name: 'impl.formatter', class: 'read' } }), twin, e.deps);
      expect(codes(out)).toContain('impl_reference_mismatch');
      assertZeroEffect(out, twin, e.impls.formatter);
    });

    const LOOKALIKES: Array<[string, string]> = [
      ['Cyrillic i (U+0456)', 'іmpl.formatter'],
      ['Cyrillic e (U+0435)', 'impl.formattеr'],
      ['fullwidth i (U+FF49)', 'ｉmpl.formatter'],
      ['zero-width space inside', 'impl​.formatter'],
      ['upper case', 'IMPL.FORMATTER'],
      ['trailing dot', 'impl.formatter.'],
      ['trailing NUL', 'impl.formatter\u0000'],
      ['underscore for dot', 'impl_formatter'],
      ['path suffix', 'impl.formatter/..'],
      ['combining dot below', 'impl.formattẹr'],
    ];
    it.each(LOOKALIKES)('[PASS P0-I3-09] look-alike id (%s) is DENY(unregistered_tool), even handed the REAL registered function', async (_n, implId) => {
      const e = await enforced({}, { authorized_impl_hashes: ['impl.formatter'] });
      const out = await runUnderKernel(requestFor('read', { tool: { name: implId, class: 'read' } }), e.impls.formatter as unknown as () => Promise<string>, e.deps);
      expect(out.verdict).toBe('DENY');
      expect(codes(out)).toContain('unregistered_tool');
      assertZeroEffect(out, e.impls.formatter);
    });

    it('CHARACTERISE P0-I3-10: a whitespace- or BOM-padded id resolves (String.prototype.trim) to the canonical registration, and the receipt keeps the padded name', async () => {
      for (const padded of [' impl.formatter ', '﻿impl.formatter', ' impl.formatter']) {
        const e = await enforced();
        const out = await runUnderKernel(requestFor('read', { tool: { name: padded, class: 'read' } }), e.impls.formatter as unknown as () => Promise<string>, e.deps);
        expect(out.verdict).toBe('ALLOW'); // it IS the authorized, registered impl: not an escalation
        expect(e.impls.formatter).toHaveBeenCalledTimes(1);
        expect(out.decision_receipt!.request.tool.name).toBe(padded); // an exact-match audit query on 'impl.formatter' misses it
      }
    });

    it('[PASS P0-I3-11] the registry cannot be widened by registration tricks: non-ASCII ids, a duplicate id, one function under two ids', () => {
      const reg = createCapabilityRegistry();
      const fn: ToolImplementation = async () => 'x';
      reg.register({ implId: 'impl.a', capability: { id: 'format.a', toolClass: 'read' }, run: fn });
      expect(() => reg.register({ implId: 'іmpl.a', capability: { id: 'format.a', toolClass: 'read' }, run: async () => 'y' })).toThrow();
      expect(() => reg.register({ implId: 'impl.b', capability: { id: 'ѕecrets.export', toolClass: 'read' }, run: async () => 'y' })).toThrow();
      expect(() => reg.register({ implId: 'impl.a', capability: { id: 'format.a', toolClass: 'spend' }, run: async () => 'y' })).toThrow();
      expect(() => reg.register({ implId: 'impl.c', capability: { id: 'format.c', toolClass: 'read' }, run: fn })).toThrow();
      expect(() => reg.register({ implId: 'impl.d', capability: { id: 'format.d', toolClass: 'admin' as ToolClass }, run: async () => 'y' })).toThrow();
      expect(reg.size).toBe(1);
    });

    describe('widened scope', () => {
      it('[PASS P0-I3-12] a registered impl the owner did not bind is DENY(impl_unauthorized)', async () => {
        const e = await enforced({}, { authorized_impl_hashes: ['impl.formatter'] });
        const out = await runUnderKernel(requestFor('spend', { tool: { name: 'impl.payment', class: 'spend' } }), e.impls.payment as unknown as () => Promise<string>, e.deps);
        expect(codes(out)).toContain('impl_unauthorized');
        assertZeroEffect(out, e.impls.payment);
      });

      it('[PASS P0-I3-13] adding an id to the signed bindings without re-signing breaks the signature: DENY, nothing runs', async () => {
        const { reg, impls } = registry();
        const h = harness({ capabilityRegistry: reg });
        const signed = await policyV2(h.owner, { authorized_impl_hashes: ['impl.formatter'] });
        await h.ledger.appendPolicy({ policy: { ...signed.policy, authorized_impl_hashes: ['impl.formatter', 'impl.payment'] }, signature: signed.signature }, iso);
        const out = await runUnderKernel(requestFor('spend', { tool: { name: 'impl.payment', class: 'spend' } }), impls.payment as unknown as () => Promise<string>, h.deps);
        expect(out.verdict).toBe('DENY');
        expect(codes(out)).toEqual(expect.arrayContaining(['policy_signature_invalid']));
        assertZeroEffect(out, impls.payment);
      });

      it('[PASS P0-I3-14] a v1 policy (blanket "tool", no bindings) authorizes NO implementation under enforcement', async () => {
        const { reg, impls } = registry();
        const h = harness({ capabilityRegistry: reg });
        await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
        const out = await runUnderKernel(requestFor('read', { tool: { name: 'impl.formatter', class: 'read' } }), impls.formatter as unknown as () => Promise<string>, h.deps);
        expect(codes(out)).toContain('impl_unauthorized');
        assertZeroEffect(out, impls.formatter);
      });

      it('[PASS P0-I3-15] a binding does not widen the action list: a bound payment impl under a policy without "spend" is DENY(action_not_permitted)', async () => {
        const e = await enforced({}, { actions: ['tool'] });
        const out = await runUnderKernel(requestFor('spend', { tool: { name: 'impl.payment', class: 'spend' } }), e.impls.payment as unknown as () => Promise<string>, e.deps);
        expect(codes(out)).toContain('action_not_permitted');
        assertZeroEffect(out, e.impls.payment);
      });
    });
  });

  // Blueprint I3 lists what an authorization must bind. The kernel's grant is a STANDING owner policy:
  // identity (subject), policy (hash), action, expiry and nonce (supersession) are bound and are tested
  // in red-team.test.ts. Argument digest, attempt id and maximum uses are not part of the grant.
  describe('what a grant binds (blueprint I3)', () => {
    it.failing('[FAIL P0-I3-16] a grant must bind the argument digest: one authorization must not cover two different argument digests (BREACHED: args_hash is recorded, not bound)', async () => {
      const h = await armed();
      const tool = jest.fn(async () => 'ran');
      const a = await runUnderKernel(requestFor('read', { args_hash: hashArgs({ file: 'README.md' }) }), tool, h.deps);
      const b = await runUnderKernel(requestFor('read', { args_hash: hashArgs({ file: '../../.env' }) }), tool, h.deps);
      expect([a.verdict, b.verdict].filter((v) => v === 'ALLOW').length).toBeLessThanOrEqual(1);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// AP — a fake owner approval authorizes nothing (the kernel policy, and services/owner-authorization).
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('P0-AP a fake owner approval authorizes nothing', () => {
  describe('the kernel owner policy', () => {
    async function refusedWith(store: (owner: Wallet) => Promise<SignedOwnerPolicy>) {
      const h = harness();
      await h.ledger.appendPolicy(await store(h.owner), iso);
      const tool = jest.fn(async () => 'MONEY MOVED');
      const out = await runUnderKernel(spendRequest(), tool, h.deps);
      assertZeroEffect(out, tool);
      return out;
    }

    it('[PASS P0-AP-01] a genuine signature carried onto a policy with a raised limit is DENY(policy_signature_invalid)', async () => {
      const out = await refusedWith(async (o) => {
        const s = await signedPolicy(o, { per_tx_raw: '10' });
        return { policy: { ...s.policy, per_tx_raw: '1000000' }, signature: s.signature };
      });
      expect(codes(out)).toContain('policy_signature_invalid');
    });

    it('[PASS P0-AP-02] a genuine v1 signature carried onto a policy that adds implementation bindings is DENY', async () => {
      const out = await refusedWith(async (o) => {
        const s = await signedPolicy(o);
        return { policy: { ...s.policy, authorized_impl_hashes: ['impl.payment'] }, signature: s.signature };
      });
      expect(codes(out)).toContain('policy_signature_invalid');
    });

    it('[PASS P0-AP-03] the owner\'s signature under another EIP-712 domain (chainId 1) is DENY', async () => {
      const out = await refusedWith(async (o) => {
        const s = await signedPolicy(o);
        const signature = await o.signTypedData({ ...POLICY_DOMAIN, chainId: 1 }, POLICY_TYPES, policyTypedValue(s.policy));
        return { policy: s.policy, signature };
      });
      expect(codes(out)).toContain('policy_signature_invalid');
    });

    it.each([
      ['empty', '0x'],
      ['one byte', '0x00'],
      ['65 zero bytes', '0x' + '00'.repeat(65)],
      ['not hex', 'owner-approved'],
    ])('[PASS P0-AP-04] a placeholder signature (%s) is never an ALLOW', async (_n, signature) => {
      await refusedWith(async (o) => ({ policy: (await signedPolicy(o)).policy, signature }));
    });

    it.each(['owner_authorization', 'policy', 'approved', 'owner', 'signature', 'hal', 'verdict', 'capability', 'authorized_impl_hashes', 'settled_by'])(
      '[PASS P0-AP-05] a request body carrying "%s" is rejected by the strict parser: nothing persisted, nothing run',
      async (field) => {
        const h = await armed();
        const tool = jest.fn(async () => 'EFFECT');
        const out = await runUnderKernel({ ...requestFor('read'), [field]: field === 'approved' ? true : { verdict: 'PASS' } }, tool, h.deps);
        expect(out.verdict).toBe('DENY');
        expect(codes(out)).toContain('malformed_request');
        expect(out.persisted).toBe(false);
        assertZeroEffect(out, tool);
      },
    );

    it.each(['capability', 'impl_hash', 'approved', 'registered_class'])('[PASS P0-AP-06] an extra tool.%s field is rejected (the request cannot vouch for its own tool)', async (field) => {
      const h = await armed();
      const tool = jest.fn(async () => 'EFFECT');
      const out = await runUnderKernel(requestFor('read', { tool: { name: 'doc.read', class: 'read', [field]: 'spend' } }), tool, h.deps);
      expect(codes(out)).toContain('malformed_request');
      assertZeroEffect(out, tool);
    });
  });

  describe('owner authorization (the wallet approval that widens what an agent may do)', () => {
    const NOW = 1_800_000_000;
    const SUBJECT = AGENT_ID;
    const PARAMS = { scope: 'read' };
    beforeEach(() => __resetOwnerAuthNonces());

    async function approval(signer: Wallet, over: { subject?: string; action?: string; params?: unknown; expiresAt?: number; nonce?: string } = {}) {
      const nonce = over.nonce ?? '0x' + randomBytes(32).toString('hex');
      const expiresAt = over.expiresAt ?? NOW + 300;
      const signature = await signer.signTypedData(OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, {
        subject: over.subject ?? SUBJECT,
        action: over.action ?? 'grant.mint',
        params: paramsHash(over.params ?? PARAMS),
        nonce,
        expiresAt,
      });
      return { signature, nonce, expires_at: expiresAt };
    }
    const check = (owner: Wallet, auth: Awaited<ReturnType<typeof approval>> | null, over: { params?: unknown; action?: 'grant.mint' | 'keys.create' } = {}, chain?: SignatureChain) =>
      checkOwnerAuthorization({ subject: SUBJECT, action: over.action ?? 'grant.mint', params: over.params ?? PARAMS, auth, expectedSigner: owner.address, nowS: NOW, ...(chain ? { chain } : {}) });

    it('[PASS P0-AP-07] positive control: the owner\'s genuine approval for exactly this action verifies', async () => {
      const owner = Wallet.createRandom();
      expect(await check(owner, await approval(owner))).toEqual({ ok: true, signer: owner.address });
    });

    it.each([
      ['signed by another wallet', async (_o: Wallet) => approval(Wallet.createRandom()), {}],
      ['signed for read, presented for write', async (o: Wallet) => approval(o, { params: { scope: 'read' } }), { params: { scope: 'write' } }],
      ['signed for grant.mint, presented for keys.create', async (o: Wallet) => approval(o, { action: 'grant.mint' }), { action: 'keys.create' as const }],
      ['signed for another agent', async (o: Wallet) => approval(o, { subject: '33333333-3333-4333-8333-333333333333' }), {}],
    ])('[PASS P0-AP-08] an approval %s is bad_signature', async (_n, make, over) => {
      const owner = Wallet.createRandom();
      const r = await check(owner, await make(owner), over);
      expect(r).toMatchObject({ ok: false, code: 'bad_signature' });
    });

    it.each([
      ['missing', null, 'owner_authorization_required'],
      ['expired', 'expired', 'expired'],
      ['valid for longer than the cap', 'long', 'lifetime_too_long'],
      ['nonce not 32 bytes', 'short-nonce', 'malformed'],
    ] as const)('[PASS P0-AP-09] an approval that is %s is refused (%s)', async (_n, kind, code) => {
      const owner = Wallet.createRandom();
      const auth =
        kind === null ? null
          : kind === 'expired' ? await approval(owner, { expiresAt: NOW - 1 })
            : kind === 'long' ? await approval(owner, { expiresAt: NOW + MAX_LIFETIME_S + 60 })
              : { ...(await approval(owner)), nonce: '0x1234' };
      expect(await check(owner, auth)).toMatchObject({ ok: false, code });
    });

    it('[PASS P0-AP-10] a forged approval does not burn the owner\'s nonce: the genuine one with the same nonce still verifies afterwards', async () => {
      const owner = Wallet.createRandom();
      const genuine = await approval(owner);
      const forged = { ...genuine, signature: (await approval(Wallet.createRandom(), { nonce: genuine.nonce, expiresAt: genuine.expires_at })).signature };
      expect(await check(owner, forged)).toMatchObject({ ok: false, code: 'bad_signature' });
      expect(await check(owner, genuine)).toMatchObject({ ok: true });
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// VF — an unknown or unavailable verifier gives NOT_CHECKED, never a pass.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('P0-VF an unknown or unavailable verifier is NOT_CHECKED, never a pass', () => {
  /** A smart-wallet owner: an address with no key, whose signature check needs the chain. */
  async function smartWalletCase(chain: SignatureChain, sigSuffix = '') {
    const smart = Wallet.createRandom().address; // stands in for a contract wallet address
    const someone = Wallet.createRandom();
    const policy: OwnerPolicy = {
      subject: AGENT_ID, owner: smart, actions: ['spend', 'tool'], payees: [PAYEE],
      per_tx_raw: '1000000', daily_raw: '5000000', total_raw: '20000000', expires_at: NOW_S + 3600, nonce: '1',
    };
    const signature = (await someone.signTypedData(POLICY_DOMAIN, POLICY_TYPES, policyTypedValue(policy))) + sigSuffix;
    const h = harness({ chain, resolveOwner: async () => ({ status: 'resolved', wallet: smart, assurance: 'wallet-proven' }) });
    await h.ledger.appendPolicy({ policy, signature }, iso);
    return h;
  }
  const unreachable: SignatureChain = { getCode: async () => { throw new Error('ECONNREFUSED'); }, call: async () => { throw new Error('ECONNREFUSED'); } };
  const codeButCallFails: SignatureChain = { getCode: async () => '0x6080', call: async () => { throw new Error('ETIMEDOUT'); } };

  it.each([
    ['getCode unreachable (ERC-1271 owner)', unreachable, ''],
    ['wallet has code, isValidSignature call unreachable', codeButCallFails, ''],
    ['ERC-6492 counterfactual signature, chain unreachable', unreachable, '6492649264926492649264926492649264926492649264926492649264926492'],
  ])('[PASS P0-VF-01] smart-wallet policy signature, %s -> NOT_CHECKED(policy_signature_not_checked), tool 0', async (_n, chain, suffix) => {
    for (const cls of ['spend', 'read'] as const) {
      const h = await smartWalletCase(chain, suffix);
      const tool = jest.fn(async () => 'EFFECT');
      const out = await runUnderKernel(requestFor(cls), tool, h.deps);
      expect(out.verdict).toBe('NOT_CHECKED');
      expect(codes(out)).toContain('policy_signature_not_checked');
      assertZeroEffect(out, tool);
    }
  });

  it('[PASS P0-VF-02] control: a verifier that ANSWERS "not valid" is a DENY (FAILED), not NOT_CHECKED and not a pass', async () => {
    const answersNo: SignatureChain = { getCode: async () => '0x6080', call: async () => '0xffffffff00000000000000000000000000000000000000000000000000000000' };
    const h = await smartWalletCase(answersNo);
    const tool = jest.fn(async () => 'EFFECT');
    const out = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('policy_signature_invalid');
    assertZeroEffect(out, tool);
  });

  it('[PASS P0-VF-03] owner authorization for a smart-wallet owner with the chain unreachable is not_checked, never ok', async () => {
    const someone = Wallet.createRandom();
    const smart = Wallet.createRandom().address;
    const nonce = '0x' + '11'.repeat(32);
    const signature = await someone.signTypedData(OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, { subject: AGENT_ID, action: 'grant.mint', params: paramsHash({}), nonce, expiresAt: 1_800_000_300 });
    __resetOwnerAuthNonces();
    const r = await checkOwnerAuthorization({ subject: AGENT_ID, action: 'grant.mint', params: {}, auth: { signature, nonce, expires_at: 1_800_000_300 }, expectedSigner: smart, nowS: 1_800_000_000, chain: unreachable });
    expect(r).toMatchObject({ ok: false, code: 'not_checked' });
  });

  it('[PASS P0-VF-04] the engine receipt-signature verifier with no engine key configured is NOT_CHECKED, never VERIFIED', async () => {
    const saved = process.env['RECEIPT_SIGNING_KEY'];
    delete process.env['RECEIPT_SIGNING_KEY'];
    try {
      const h = await armed();
      const out = await runUnderKernel(spendRequest(), jest.fn(async () => 1), h.deps);
      const block = { scheme: 'eip191', type: 'kernel-receipt', signer: h.owner.address, signature: '0x' + '11'.repeat(65), content_hash: '0x' + '22'.repeat(32), signed_at: iso };
      expect(verifyReceiptSignature(out.decision_receipt, block as never).status).toBe('NOT_CHECKED');
    } finally {
      if (saved === undefined) delete process.env['RECEIPT_SIGNING_KEY'];
      else process.env['RECEIPT_SIGNING_KEY'] = saved;
    }
  });

  it.failing('[FAIL P0-VF-05] a HAL PASS whose method names no known verifier must not ALLOW a post (BREACHED: the kernel never checks `method`)', async () => {
    const h = await armed({ halCheck: async () => hal({ method: 'definitely-not-a-verifier' }) });
    const post = jest.fn(async () => 'POSTED');
    const out = await runUnderKernel(postRequest(), post, h.deps);
    expect(out.verdict).not.toBe('ALLOW');
    expect(post).toHaveBeenCalledTimes(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// TK — a one-use token yields at most one effect, under a race and on replay.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('P0-TK one-use tokens: concurrent race and replay', () => {
  describe('the owner-authorization nonce (the one single-use token that exists on main)', () => {
    const NOW = 1_800_000_000;
    beforeEach(() => __resetOwnerAuthNonces());
    async function genuine() {
      const owner = Wallet.createRandom();
      const nonce = '0x' + '5a'.repeat(32);
      const auth = { nonce, expires_at: NOW + 300, signature: await owner.signTypedData(OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, { subject: AGENT_ID, action: 'keys.create', params: paramsHash({}), nonce, expiresAt: NOW + 300 }) };
      const present = () => checkOwnerAuthorization({ subject: AGENT_ID, action: 'keys.create', params: {}, auth, expectedSigner: owner.address, nowS: NOW });
      return { present };
    }

    it('[PASS P0-TK-01] 12 concurrent presentations of one approval: exactly one succeeds, 11 are replayed', async () => {
      const { present } = await genuine();
      const results = await Promise.all(Array.from({ length: 12 }, () => present()));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.code === 'replayed')).toHaveLength(11);
    });

    it('[PASS P0-TK-02] a sequential replay of a used approval is refused', async () => {
      const { present } = await genuine();
      expect(await present()).toMatchObject({ ok: true });
      expect(await present()).toMatchObject({ ok: false, code: 'replayed' });
    });

    it.failing('[FAIL P0-TK-03] after a process restart a used approval must not verify again (BREACHED: the nonce memory is in-process; the source states a window of up to MAX_LIFETIME_S)', async () => {
      const { present } = await genuine();
      expect(await present()).toMatchObject({ ok: true });
      __resetOwnerAuthNonces(); // what a restart does to the in-memory nonce set
      expect(await present()).toMatchObject({ ok: false, code: 'replayed' });
    });
  });

  describe('kernel capability consumption (blueprint: one-use tokens consumed by compare-and-set)', () => {
    it.failing('[FAIL P0-TK-04] 10 concurrent presentations of ONE authorized attempt must produce at most one effect (BREACHED: there is no consumption, 10 run)', async () => {
      const h = await armed();
      const tool = jest.fn(async () => 'ran');
      const attempt = requestFor('read', { args_hash: hashArgs({ attempt: 'a-1' }) });
      await Promise.all(Array.from({ length: 10 }, () => runUnderKernel(attempt, tool, h.deps)));
      expect(tool.mock.calls.length).toBeLessThanOrEqual(1);
    });
    it.failing('[FAIL P0-TK-05] replaying an attempt after its effect must be refused (BREACHED: the grant has no attempt id and no use count)', async () => {
      const h = await armed();
      const tool = jest.fn(async () => 'ran');
      const attempt = requestFor('read', { args_hash: hashArgs({ attempt: 'a-1' }) });
      expect((await runUnderKernel(attempt, tool, h.deps)).verdict).toBe('ALLOW');
      expect((await runUnderKernel(attempt, tool, h.deps)).verdict).not.toBe('ALLOW');
    });
    it.todo('[NOT_CHECKED P0-TK-06] when one-use capability tokens exist: compare-and-set consumption under N concurrent presenters, consumption that survives a restart, and an INDETERMINATE effect reconciled rather than retried');
  });
});
