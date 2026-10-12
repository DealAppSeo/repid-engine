/**
 * kernel-receipt/1 — the invariants, the chain, the ledger's refusals, and the cross-repo vector.
 *
 * Each invariant is tested by taking a receipt that VALIDATES, breaking exactly one thing, RESEALING
 * the hash (so the only thing wrong is the thing under test), and asserting that exactly that code
 * comes back. A test that broke two things at once would pass for either, which is how an invariant
 * ends up enforced by accident.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUnderKernel } from '../gate';
import { decide, parseKernelRequest } from '../decide';
import { parsePolicy, parseSignedPolicy, policyHash } from '../policy';
import { buildReceipt, findForbidden, hashArgs, receiptHash, validateReceipt, verifyReceiptChain, type InvariantCode } from '../receipt';
import { LedgerIntegrityError, StoreLedger, createJsonlStore, createMemoryStore } from '../store';
import type { HalEvidence, KernelReceipt, OwnerPolicy } from '../types';
import { AGENT_ID, harness, iso, postRequest, signedPolicy, spendRequest } from './fixtures';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function reseal(r: KernelReceipt): KernelReceipt {
  r.header.receipt_hash = receiptHash(r);
  return r;
}
function codesOf(r: KernelReceipt, ctx?: { persisted_decision_ids?: ReadonlySet<string> }): InvariantCode[] {
  const v = validateReceipt(r, ctx);
  return v.ok ? [] : [...new Set(v.errors.map((e) => e.code))];
}

const HAL_PASS: HalEvidence = {
  verdict: 'PASS',
  method: 'cross-llm-quorum',
  votes: [{ family: 'a', verdict: 'PASS' }, { family: 'b', verdict: 'PASS' }, { family: 'c', verdict: 'FAIL' }],
  settled_by: null,
  grounded: true,
  same_domain: true,
};

/** A permitted spend: a VALID ALLOW receipt (the decision row). */
async function allowSpend(): Promise<KernelReceipt> {
  const h = harness();
  await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
  const out = await runUnderKernel(spendRequest({ amount_raw: 10000 }), async () => 'ok', h.deps);
  return clone(out.decision_receipt!);
}
async function allowPost(): Promise<KernelReceipt> {
  const h = harness({ halCheck: async () => HAL_PASS });
  await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
  const out = await runUnderKernel(postRequest(), async () => 'ok', h.deps);
  return clone(out.decision_receipt!);
}
async function denied(): Promise<KernelReceipt> {
  const h = harness();
  await h.ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '0' }), iso);
  const out = await runUnderKernel(spendRequest(), async () => 'ok', h.deps);
  return clone(out.decision_receipt!);
}

describe('the baseline receipts are valid (so each break below is the only fault)', () => {
  it('ALLOW spend, ALLOW post and DENY all validate', async () => {
    expect(codesOf(await allowSpend())).toEqual([]);
    expect(codesOf(await allowPost())).toEqual([]);
    expect(codesOf(await denied())).toEqual([]);
  });
});

describe('the eight invariants', () => {
  it('(1) payment other than NOT_APPLICABLE only if the verdict is ALLOW', async () => {
    const r = await denied();
    r.payment.status = 'AUTHORIZED';
    expect(codesOf(reseal(r))).toEqual(['payment_without_allow']);
  });

  it('(2) a DENY or NOT_CHECKED has executed:false', async () => {
    for (const verdict of ['DENY', 'NOT_CHECKED'] as const) {
      const r = await denied();
      r.decision.verdict = verdict;
      r.decision.executed = true;
      expect(codesOf(reseal(r), { persisted_decision_ids: new Set([r.header.receipt_id]) })).toEqual(['executed_without_allow']);
    }
  });

  it('(3) an ALLOW spend is at most effective_per_tx_raw', async () => {
    const r = await allowSpend();
    r.request.amount_raw = '1000001'; // one over the 1000000 limit the policy set
    expect(codesOf(reseal(r))).toEqual(['spend_over_effective_limit']);
    const r0 = await allowSpend();
    r0.decision.limits.effective_per_tx_raw = '0'; // the default
    expect(codesOf(reseal(r0))).toEqual(['spend_over_effective_limit']);
  });

  it('(4) any check that is not PASS makes an ALLOW invalid — NOT_CHECKED never reads as a pass', async () => {
    for (const outcome of ['NOT_CHECKED', 'FAIL'] as const) {
      const r = await allowSpend();
      r.decision.checks.find((c) => c.name === 'policy_signature')!.outcome = outcome;
      const codes = codesOf(reseal(r));
      expect(codes).toContain('allow_with_unresolved_check');
      expect(codes).toContain('allow_missing_required_check');
    }
  });

  it('(4) ...for a post as well as a spend, and an ALLOW missing a required check is invalid even if nothing failed', async () => {
    const post = await allowPost();
    post.decision.checks.find((c) => c.name === 'hal_verdict')!.outcome = 'NOT_CHECKED';
    expect(codesOf(reseal(post))).toContain('allow_with_unresolved_check');

    const spend = await allowSpend();
    spend.decision.checks = spend.decision.checks.filter((c) => c.name !== 'spend_limit');
    expect(codesOf(reseal(spend))).toEqual(['allow_missing_required_check']);

    const none = await allowSpend();
    none.decision.checks = [];
    expect(codesOf(reseal(none))).toContain('allow_missing_required_check');
  });

  it('(5) a vote alone is PROVISIONAL; SETTLED needs settled_by of holdout, known_answer or person', async () => {
    const r = await allowPost();
    expect(r.verification.verdict_label).toBe('PROVISIONAL');
    r.verification.verdict_label = 'SETTLED';
    expect(codesOf(reseal(r))).toEqual(['settled_without_settler']);

    for (const by of ['holdout', 'known_answer', 'person'] as const) {
      const ok = await allowPost();
      ok.verification.verdict_label = 'SETTLED';
      ok.verification.settled_by = by;
      expect(codesOf(reseal(ok))).toEqual([]);
    }
    const bad = await allowPost();
    bad.verification.verdict_label = 'SETTLED';
    (bad.verification as { settled_by: unknown }).settled_by = 'majority';
    expect(codesOf(reseal(bad))).toEqual(['structure']);
  });

  it('(5) a 2-1 vote built from HAL evidence is PROVISIONAL, even if the evidence names no settler', async () => {
    const r = await allowPost();
    expect(r.verification.votes.map((v) => v.verdict)).toEqual(['PASS', 'PASS', 'FAIL']);
    expect(r.verification.verdict_label).toBe('PROVISIONAL');
    expect(r.verification.settled_by).toBeNull();
  });

  it('(5) a NOT_CHECKED or NOT_APPLICABLE verification cannot carry votes, grounding or a settler', async () => {
    const r = await denied();
    r.verification.grounded = true;
    r.verification.counts_toward_band_restore = false;
    expect(codesOf(reseal(r))).toEqual(['unverified_leg_carries_evidence']);
  });

  it('(6) counts_toward_band_restore is derived: grounded && same_domain && !is_simulated', async () => {
    // simulated run, grounded and same-domain: must be false
    const sim = await allowPost();
    expect(sim.verification.grounded && sim.verification.same_domain).toBe(true);
    expect(sim.verification.is_simulated).toBe(true);
    expect(sim.verification.counts_toward_band_restore).toBe(false);
    sim.verification.counts_toward_band_restore = true; // someone "supplies" it
    expect(codesOf(reseal(sim))).toEqual(['band_restore_not_derived']);

    // each missing ingredient independently blocks it
    const h = harness({ env: { network: 'base-sepolia', chain_id: 84532, is_simulated: false }, halCheck: async () => ({ ...HAL_PASS, grounded: false }) });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const ungrounded = (await runUnderKernel(postRequest(), async () => 'ok', h.deps)).decision_receipt!;
    expect(ungrounded.verification.counts_toward_band_restore).toBe(false);
    const h2 = harness({ env: { network: 'base-sepolia', chain_id: 84532, is_simulated: false }, halCheck: async () => ({ ...HAL_PASS, same_domain: false }) });
    await h2.ledger.appendPolicy(await signedPolicy(h2.owner), iso);
    const otherDomain = (await runUnderKernel(postRequest(), async () => 'ok', h2.deps)).decision_receipt!;
    expect(otherDomain.verification.counts_toward_band_restore).toBe(false);

    // and all three present: it counts
    const h3 = harness({ env: { network: 'base-sepolia', chain_id: 84532, is_simulated: false }, halCheck: async () => HAL_PASS });
    await h3.ledger.appendPolicy(await signedPolicy(h3.owner), iso);
    const real = (await runUnderKernel(postRequest(), async () => 'ok', h3.deps)).decision_receipt!;
    expect(real.verification.counts_toward_band_restore).toBe(true);
    expect(codesOf(real)).toEqual([]);
  });

  it('(6) a supplied counts_toward_band_restore is refused at the request, not ignored', () => {
    const p = parseKernelRequest({ ...spendRequest(), counts_toward_band_restore: true });
    expect(p.ok).toBe(false);
  });

  it('(7) executed:true needs a persisted decision row first', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const out = await runUnderKernel(spendRequest(), async () => 'ok', h.deps);
    const outcome = out.final_receipt!;
    expect(outcome.decision.executed).toBe(true);
    // Without the decision row on record, the very same receipt is invalid.
    expect(codesOf(outcome, { persisted_decision_ids: new Set() })).toEqual(['executed_without_persisted_decision']);
    expect(codesOf(outcome)).toEqual(['executed_without_persisted_decision']);
    expect(codesOf(outcome, { persisted_decision_ids: new Set([outcome.header.receipt_id]) })).toEqual([]);

    // ...and the ledger enforces it: an executed row for a call it never decided cannot be appended.
    const fresh = harness();
    await expect(fresh.ledger.appendReceipt(() => clone(outcome))).rejects.toThrow(/executed_without_persisted_decision/);
  });

  it('(7) a DENY cannot be dressed up as executed by appending it with executed:true', async () => {
    const h = harness();
    const denial = await (async () => {
      await h.ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '0' }), iso);
      return (await runUnderKernel(spendRequest(), async () => 'ok', h.deps)).decision_receipt!;
    })();
    await expect(
      h.ledger.appendReceipt((tip) => {
        const r = clone(denial);
        r.decision.executed = true;
        r.header.prev_receipt_id = tip?.receipt_id ?? null;
        r.header.prev_hash = tip?.receipt_hash ?? null;
        return reseal(r);
      }),
    ).rejects.toThrow(/executed_without_allow/);
  });

  it('(8) no key- or secret-shaped material anywhere', async () => {
    const shapes: Array<[string, (r: KernelReceipt) => void]> = [
      ['a bare 32-byte hex string in a free-text field', (r) => { r.decision.reasons[0]!.detail = 'f'.repeat(64); }],
      ['a 0x 32-byte value in a free-text field', (r) => { r.decision.reasons[0]!.detail = '0x' + 'a'.repeat(64); }],
      ['a 0x 32-byte value in the agent name', (r) => { r.subject.agent.agent_name = '0x' + 'b'.repeat(64); }],
      ['a JWT', (r) => { r.request.origin = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'; }],
      ['a PEM block', (r) => { r.request.origin = '-----BEGIN PRIVATE KEY-----'; }],
      ['a vendor key prefix', (r) => { r.request.origin = 'gsk_' + 'A1b2C3d4'.repeat(4); }],
      ['a secret-named key', (r) => { (r.request as unknown as Record<string, unknown>)['private_key'] = 'x'; }],
      ['an api_key-named key', (r) => { (r.header as unknown as Record<string, unknown>)['api_key'] = 'x'; }],
    ];
    for (const [label, mutate] of shapes) {
      const r = await denied();
      mutate(r);
      const codes = codesOf(reseal(r));
      expect({ label, hit: codes.includes('secret_shaped_material') }).toEqual({ label, hit: true });
    }
  });

  it('(8) forbidden keys: claim, prompt, user_id and raw args are refused anywhere in the tree', async () => {
    for (const key of ['claim', 'prompt', 'user_id', 'args', 'raw_args', 'arguments']) {
      const r = await denied();
      (r.decision.checks[0] as unknown as Record<string, unknown>)[key] = 'x';
      expect({ key, codes: codesOf(reseal(r)) }).toEqual({ key, codes: expect.arrayContaining(['forbidden_key']) });
    }
  });

  it('(8) legitimate 0x hashes in the hash fields are not mistaken for keys', async () => {
    const r = await allowSpend();
    expect(findForbidden(r)).toEqual([]);
  });
});

describe('honesty clauses', () => {
  it('does_not_attest must name the cumulative-total gap', async () => {
    const r = await denied();
    r.decision.does_not_attest = r.decision.does_not_attest.filter((s) => !s.startsWith('cumulative_total'));
    expect(codesOf(reseal(r))).toEqual(['does_not_attest_missing_cumulative_total']);
  });

  it('a DENY or NOT_CHECKED with no reason is invalid', async () => {
    const r = await denied();
    r.decision.reasons = [];
    expect(codesOf(reseal(r))).toEqual(['refusal_without_reason']);
  });

  it('blocking must equal verdict !== ALLOW', async () => {
    const r = await denied();
    r.decision.blocking = false;
    expect(codesOf(reseal(r))).toEqual(['blocking_mismatch']);
  });

  it('a simulated environment cannot hold a leg that claims to be real', async () => {
    const r = await allowSpend();
    r.payment.is_simulated = false;
    expect(codesOf(reseal(r))).toEqual(['simulation_mismatch']);
  });

  it('SETTLED payment and MEASURED evidence need a transaction and an observation', async () => {
    const r = await allowSpend();
    r.header.env.is_simulated = false;
    r.payment.is_simulated = false;
    r.verification.is_simulated = false;
    r.payment.status = 'SETTLED';
    expect(codesOf(reseal(r))).toEqual(['settlement_unmeasured']);
    r.payment.settlement_evidence = 'MEASURED';
    expect(codesOf(reseal(r))).toEqual(['settlement_unmeasured']);
    r.payment.tx_hash = '0x' + '1'.repeat(64);
    r.payment.observed_amount_raw = '10000';
    expect(codesOf(reseal(r))).toEqual([]);
  });

  it('header.signer is null in kernel-receipt/1', async () => {
    const r = await denied();
    (r.header as { signer: unknown }).signer = '0x1111111111111111111111111111111111111111';
    expect(codesOf(reseal(r))).toEqual(['structure']);
  });
});

describe('the chain', () => {
  async function three(): Promise<KernelReceipt[]> {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    await runUnderKernel(spendRequest({ amount_raw: 1 }), async () => 'a', h.deps);
    await runUnderKernel(spendRequest({ amount_raw: 2 }), async () => 'b', h.deps);
    return h.sink.records.flatMap((r) => (r.kind === 'receipt' ? [clone(r.receipt)] : []));
  }

  it('verifies when intact', async () => {
    const rs = await three();
    expect(rs).toHaveLength(4);
    expect(verifyReceiptChain(rs)).toEqual({ ok: true });
  });

  it('an edited entry stops matching its hash', async () => {
    const rs = await three();
    rs[1]!.request.origin = 'tampered';
    expect(verifyReceiptChain(rs)).toMatchObject({ ok: false, index: 1, code: 'hash_mismatch' });
  });

  it('a removed entry breaks the next entry\'s link', async () => {
    const rs = await three();
    rs.splice(1, 1);
    expect(verifyReceiptChain(rs)).toMatchObject({ ok: false, index: 1, code: 'broken_link' });
  });

  it('the first entry has no predecessor', async () => {
    const rs = await three();
    rs.shift();
    expect(verifyReceiptChain(rs)).toMatchObject({ ok: false, index: 0, code: 'bad_start' });
  });

  it('an entry appended off the tip is refused by the ledger', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const r = (await runUnderKernel(spendRequest(), async () => 'a', h.deps)).decision_receipt!;
    await expect(h.ledger.appendReceipt(() => reseal({ ...clone(r), header: { ...clone(r.header), receipt_id: 'other', prev_receipt_id: null, prev_hash: null } }))).rejects.toThrow(/broken_link/);
  });
});

describe('the JSONL ledger refuses to read a damaged file as an empty one', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kernel-test-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('survives a restart: policy and chain come back from the file', async () => {
    const path = join(dir, 'ledger.jsonl');
    const first = harness();
    const ledger1 = new StoreLedger(createJsonlStore(path));
    await ledger1.appendPolicy(await signedPolicy(first.owner), iso);
    const deps1 = { ...first.deps, ledger: ledger1 };
    await runUnderKernel(spendRequest({ amount_raw: 7 }), async () => 'a', deps1);

    const ledger2 = new StoreLedger(createJsonlStore(path)); // a new process
    expect((await ledger2.latestPolicy(AGENT_ID))?.policy.nonce).toBe('1');
    const totals = await ledger2.spentTotals({ agent_id: AGENT_ID, policy_hash: policyHash((await ledger2.latestPolicy(AGENT_ID))!.policy), since_s: 0 });
    expect(totals).toEqual({ daily_raw: '7', total_raw: '7' });
    const out = await runUnderKernel(spendRequest({ amount_raw: 1 }), async () => 'b', { ...first.deps, ledger: ledger2 });
    expect(out.verdict).toBe('ALLOW');
    expect(out.decision_receipt!.header.prev_hash).not.toBeNull(); // chained onto the earlier process's entries
  });

  it('a missing file is an empty ledger, not an error', async () => {
    expect(await createJsonlStore(join(dir, 'nope.jsonl')).readAll()).toEqual([]);
  });

  it('a line that does not parse makes the ledger THROW, which the gate turns into NOT_CHECKED', async () => {
    const path = join(dir, 'ledger.jsonl');
    const h = harness();
    const ledger = new StoreLedger(createJsonlStore(path));
    await ledger.appendPolicy(await signedPolicy(h.owner), iso);
    appendFileSync(path, '{this is not json\n');

    const reread = new StoreLedger(createJsonlStore(path));
    await expect(reread.latestPolicy(AGENT_ID)).rejects.toBeInstanceOf(LedgerIntegrityError);

    const tool = jest.fn();
    const out = await runUnderKernel(spendRequest(), tool, { ...h.deps, ledger: reread });
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(tool).not.toHaveBeenCalled();
  });

  it('an edited receipt in the file breaks the chain on load', async () => {
    const path = join(dir, 'ledger.jsonl');
    const h = harness();
    const ledger = new StoreLedger(createJsonlStore(path));
    await ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '0' }), iso);
    await runUnderKernel(spendRequest(), async () => 'a', { ...h.deps, ledger });
    const text = readFileSync(path, 'utf8').replace('"origin":"Cli"', '"origin":"Xxx"');
    writeFileSync(path, text);
    await expect(new StoreLedger(createJsonlStore(path)).findReceipts('x')).rejects.toBeInstanceOf(LedgerIntegrityError);
  });

  it('the file holds one line per record and never a raw argument', async () => {
    const path = join(dir, 'ledger.jsonl');
    const h = harness();
    const ledger = new StoreLedger(createJsonlStore(path));
    await ledger.appendPolicy(await signedPolicy(h.owner), iso);
    await runUnderKernel(spendRequest({ amount_raw: 5 }), async () => 'a', { ...h.deps, ledger });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3); // policy, decision row, outcome row
    expect(readFileSync(path, 'utf8')).not.toContain('example.invalid');
  });
});

describe('the signed policy', () => {
  const base = { subject: AGENT_ID, owner: '0x000000000000000000000000000000000000dEaD', actions: ['spend'], expires_at: 1_800_003_600, nonce: '1' };

  it('MISSING limits are "0" and are reported as defaulted', () => {
    const p = parsePolicy(base);
    expect(p.ok && p.policy).toMatchObject({ per_tx_raw: '0', daily_raw: '0', total_raw: '0' });
    expect(p.ok && p.defaulted).toEqual(['per_tx_raw', 'daily_raw', 'total_raw']);
    const some = parsePolicy({ ...base, per_tx_raw: '500' });
    expect(some.ok && some.policy).toMatchObject({ per_tx_raw: '500', daily_raw: '0', total_raw: '0' });
    expect(some.ok && some.defaulted).toEqual(['daily_raw', 'total_raw']);
  });

  it('a PRESENT but malformed limit is an error — never quietly 0, never quietly accepted', () => {
    for (const bad of ['-5', '1.5', '1e3', 'ten', '', -1, 1.5, {}, true]) {
      expect(parsePolicy({ ...base, per_tx_raw: bad }).ok).toBe(false);
    }
  });

  it('is strict: unknown keys, duplicate or unknown actions, bad addresses, missing expiry', () => {
    expect(parsePolicy({ ...base, extra: 1 }).ok).toBe(false);
    expect(parsePolicy({ ...base, actions: ['spend', 'spend'] }).ok).toBe(false);
    expect(parsePolicy({ ...base, actions: ['teleport'] }).ok).toBe(false);
    expect(parsePolicy({ ...base, actions: ['tool:fs.read', 'post'] }).ok).toBe(true);
    expect(parsePolicy({ ...base, owner: 'not-an-address' }).ok).toBe(false);
    expect(parsePolicy({ ...base, expires_at: undefined }).ok).toBe(false);
    expect(parsePolicy({ ...base, nonce: '-1' }).ok).toBe(false);
    expect(parsePolicy('policy').ok).toBe(false);
    expect(parseSignedPolicy({ policy: base, signature: 'nope' }).ok).toBe(false);
    expect(parseSignedPolicy({ policy: base, signature: '0x' + 'ab'.repeat(65), extra: 1 }).ok).toBe(false);
    expect(parseSignedPolicy({ policy: base, signature: '0x' + 'ab'.repeat(65) }).ok).toBe(true);
  });

  it('policyHash changes when any signed field changes', () => {
    const p = parsePolicy({ ...base, per_tx_raw: '1' });
    if (!p.ok) throw new Error('unreachable');
    const h0 = policyHash(p.policy);
    const variants: Partial<OwnerPolicy>[] = [{ per_tx_raw: '2' }, { daily_raw: '1' }, { total_raw: '1' }, { expires_at: 1_800_003_601 }, { nonce: '2' }, { actions: ['post'] }, { subject: 'other' }];
    for (const v of variants) expect(policyHash({ ...p.policy, ...v })).not.toBe(h0);
  });

  it('an edited policy no longer verifies: raising the limit after signing is DENY(policy_signature_invalid)', async () => {
    const h = harness();
    const signed = await signedPolicy(h.owner, { per_tx_raw: '0' });
    signed.policy.per_tx_raw = '1000000'; // the attacker widens it after the owner signed
    await h.ledger.appendPolicy(signed, iso);
    const tool = jest.fn();
    const out = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(out.reasons.map((r) => r.code)).toContain('policy_signature_invalid');
    expect(tool).not.toHaveBeenCalled();
  });
});

// ── the cross-repo vector ───────────────────────────────────────────────────────────────────────

/**
 * SHARED VECTOR — trustshell's tests/kernel-client.test.ts pins this same receipt and the same
 * hash, and the same hash of the schema file. If either side changes how a receipt is fingerprinted,
 * or what shape it has, one of the two suites goes red. (Same pattern as the owner-authorization
 * vector in tests/owner-authorization.test.ts.)
 */
const SCHEMA_SHA256 = '9519068e49073f2d5de094e5acbbe157af41555bb5a9bcb56d03c94cdd1ac5d9';
const VECTOR_HASH = '0x228b214a84c41fcd1a56f49e4e82c0b5c596f894badc149be8cc48412417da9e';
const VECTOR_ARGS_HASH = '0xd82cf87614b294f236e7d71bdbc831d606503ec1f6446013321450df46425440';
const VECTOR_OWNER = '0x1111111111111111111111111111111111111111';

function vectorReceipt(): KernelReceipt {
  const policy: OwnerPolicy = { subject: AGENT_ID, owner: VECTOR_OWNER, actions: ['spend'], per_tx_raw: '0', daily_raw: '5000000', total_raw: '20000000', expires_at: 1_800_003_600, nonce: '1' };
  const request = {
    agent: { agent_id: AGENT_ID, agent_name: 'kernel-demo-agent' },
    tool: { name: 'x402.pay', class: 'spend' as const },
    origin: 'Cli',
    args_hash: hashArgs({ resource: 'https://example.invalid/paid' }),
    amount_raw: 10000,
    payee: '0x000000000000000000000000000000000000dEaD',
    asset: 'USDC',
    chain_id: 84532,
  };
  const owner = { status: 'resolved' as const, wallet: VECTOR_OWNER, assurance: 'wallet-proven' };
  const decision = decide({
    request,
    now_s: 1_800_000_000,
    owner,
    policy: { state: 'loaded', policy, policy_hash: policyHash(policy), signature: 'VERIFIED', revocation: 'VERIFIED' },
    spent: { state: 'ok', daily_raw: '0', total_raw: '0' },
    hal: { state: 'not_needed' },
  });
  return buildReceipt({
    receipt_id: '00000000-0000-4000-8000-000000000001',
    prev: null,
    created_at: '2027-01-15T08:00:00.000Z',
    env: { network: 'base-sepolia', chain_id: 84532, is_simulated: true },
    request,
    owner,
    decision,
    executed: false,
    phase: 'decision',
    hal: { state: 'not_needed' },
  });
}

/** A small JSON-Schema walker: the constructs kernel-receipt.v1.json uses, and nothing else. */
function schemaErrors(node: unknown, schema: any, root: any, path: string, out: string[]): void {
  if (schema.$ref) {
    const target = schema.$ref.replace('#/', '').split('/').reduce((a: any, k: string) => a?.[k], root);
    return schemaErrors(node, target, root, path, out);
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((s: any) => { const e: string[] = []; schemaErrors(node, s, root, path, e); return e.length === 0; });
    if (passing.length !== 1) out.push(`${path}: matches ${passing.length} of oneOf`);
    return;
  }
  if ('const' in schema && node !== schema.const) out.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(node)) out.push(`${path}: not in enum`);
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const is = (t: string): boolean =>
      t === 'string' ? typeof node === 'string'
      : t === 'integer' ? Number.isInteger(node)
      : t === 'boolean' ? typeof node === 'boolean'
      : t === 'null' ? node === null
      : t === 'array' ? Array.isArray(node)
      : t === 'object' ? node !== null && typeof node === 'object' && !Array.isArray(node)
      : false;
    if (!types.some(is)) { out.push(`${path}: expected ${types.join('|')}`); return; }
  }
  if (typeof node === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(node)) out.push(`${path}: pattern`);
    if (schema.minLength && node.length < schema.minLength) out.push(`${path}: too short`);
  }
  if (Array.isArray(node) && schema.items) node.forEach((v, i) => schemaErrors(v, schema.items, root, `${path}[${i}]`, out));
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) out.push(`${path}: missing ${k}`);
    if (schema.additionalProperties === false) for (const k of Object.keys(obj)) if (!(k in (schema.properties ?? {}))) out.push(`${path}: unexpected ${k}`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in obj) schemaErrors(obj[k], sub, root, `${path}.${k}`, out);
  }
}

describe('the shared vector and the schema file', () => {
  const schemaPath = join(__dirname, '..', 'schema', 'kernel-receipt.v1.json');
  const schemaText = readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(schemaText);

  it('the vector hashes to the pinned value and validates', () => {
    const r = vectorReceipt();
    expect(r.request.args_hash).toBe(VECTOR_ARGS_HASH);
    expect(r.header.receipt_hash).toBe(VECTOR_HASH);
    expect(receiptHash(r)).toBe(VECTOR_HASH);
    expect(validateReceipt(r)).toEqual({ ok: true });
    expect(r.decision.verdict).toBe('DENY');
    expect(r.decision.reasons[0]!.code).toBe('spend_limit_zero');
  });

  it('the vector satisfies the schema, and the schema rejects what it should', () => {
    const errors: string[] = [];
    schemaErrors(vectorReceipt(), schema, schema, 'receipt', errors);
    expect(errors).toEqual([]);

    const bad = clone(vectorReceipt());
    (bad.decision as unknown as Record<string, unknown>)['verdict'] = 'MAYBE';
    (bad.header as unknown as Record<string, unknown>)['extra'] = 1;
    delete (bad as unknown as Record<string, unknown>)['payment'];
    const e2: string[] = [];
    schemaErrors(bad, schema, schema, 'receipt', e2);
    expect(e2.length).toBeGreaterThanOrEqual(3);
  });

  it('the schema file and the code agree on the enumerations', () => {
    const props = schema.properties;
    expect(props.request.properties.tool.properties.class.enum).toEqual(['read', 'spend', 'post', 'other']);
    expect(props.decision.properties.verdict.enum).toEqual(['ALLOW', 'DENY', 'NOT_CHECKED']);
    expect(props.verification.properties.settled_by.oneOf[0].enum).toEqual(['holdout', 'known_answer', 'person']);
    expect(props.header.properties.schema.const).toBe('kernel-receipt/1');
  });

  it('the schema file is byte-for-byte what trustshell pins', () => {
    expect(createHash('sha256').update(schemaText).digest('hex')).toBe(SCHEMA_SHA256);
  });
});

describe('the memory store is a real sink', () => {
  it('copies on the way in and out, so a caller cannot edit history', async () => {
    const s = createMemoryStore();
    const r = clone(vectorReceipt());
    await s.append({ kind: 'receipt', receipt: r });
    r.request.origin = 'edited-after-write';
    const [back] = await s.readAll();
    expect(back && back.kind === 'receipt' && back.receipt.request.origin).toBe('Cli');
  });
});
