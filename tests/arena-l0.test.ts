/**
 * L0 agent-to-agent commerce arena (spec: E:\dev\sprints\2026-10-20\AUTONOMY_LOOPS_SPEC.md §1-§7).
 *
 * OFFLINE and deterministic: stub agents, no model, no network, no key. The engine's real kernel,
 * x402 gate and RepID delta functions run in LOCAL_MODE against an in-memory twin of the chain
 * (MemoryChain). The same assertions run again against a real Hardhat devnet when the devnet URL variable
 * read at the bottom of this file (`rpc`) is set (that suite is reported as SKIPPED otherwise, never as passed).
 * scripts/e2e-local/arena/README.md says how to start a throwaway devnet and run it.
 *
 * HOW TO READ IT (the same convention as tests/kernel/red-team.test.ts).
 *   it(...)              held, or a positive control. Green = held.
 *   it.failing(...)      a SECURE expectation the executor does NOT meet today. Jest counts it as passing
 *                        while the hole is open and turns RED the day it is fixed ("failing test passed"),
 *                        which is the cue to delete the marker. A finding recorded this way cannot go stale.
 *   it('CHARACTERISE …') pins what happens today, so it cannot change unnoticed.
 *
 * The hole these pin: nothing in the engine's executor consumes the authorization (the NPA's EIP-712 digest) before the tool runs (spec §4,
 * "one-use authorization, consumed atomically and durably"). Replay, replay after restart, and 10 concurrent
 * presentations all settle again. They are recorded as FAIL in the evidence; they are not hidden.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypedDataEncoder } from 'ethers';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { StubAgents, acceptDelivery, validateTerms } from '../scripts/e2e-local/arena/agents';
import { MemoryChain, ViemChain, type TestChain } from '../scripts/e2e-local/arena/chain';
import { NPA_TYPES, ZERO_ADDRESS, classifySettlement, jcs, npaDomain, npaHashOf, npaMessage, npaSigner, policyBodyOf, policyIdOf, sha256Hex, signNpa, type Npa } from '../scripts/e2e-local/arena/core';
import { bootEngine } from '../scripts/e2e-local/arena/engine';
import { CASE_IDS, CONTROL_CASES, grade, predict, type CaseId, type Observed, type Sym } from '../scripts/e2e-local/arena/oracle';
import { EXTRA_CASE_IDS, type ExtraCaseId } from '../scripts/e2e-local/arena/cases';
import { KNOWN_FAILING, runCase, type Evidence } from '../scripts/e2e-local/arena/runner';
import { buildNpa, disposeWorld, makeWorld, present, presentationOf } from '../scripts/e2e-local/arena/world';

jest.setTimeout(120_000);

const engine = bootEngine();

// The engine logs a failed prover call. bootEngine points the prover at a refused loopback port on purpose, so
// every RepID award prints one; that is the expected outcome here, not noise worth reading 100 times.
const realConsoleError = console.error;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    if (!String(a[0]).startsWith('[scoring/pipeline] proof')) realConsoleError(...a);
  });
});
const ORACLE_SHA = sha256Hex(readFileSync(join(__dirname, '..', 'scripts', 'e2e-local', 'arena', 'oracle.ts'), 'utf8').replaceAll('\r\n', '\n'));

// ── pure pieces ──────────────────────────────────────────────────────────────────────────────────

describe('RFC 8785 canonical JSON and the policy id', () => {
  it('matches the RFC 8785 §3.2.4 sorting and number vector', () => {
    const v = { numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001], string: '€$\u000f\nA\'B"\\\\"/', literals: [null, true, false] };
    expect(jcs(v)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  });
  it('refuses what has no canonical form instead of coercing it', () => {
    expect(() => jcs({ a: 1n })).toThrow();
    expect(() => jcs({ a: NaN })).toThrow();
  });
  it('the policy id changes with any field, and with nothing else', async () => {
    const w = await makeWorld({ chain: new MemoryChain(), engine, evaluatorSha256: ORACLE_SHA });
    try {
      const body = policyBodyOf(w.policy);
      expect(policyIdOf(body)).toBe(w.policy.policy_id);
      expect(policyIdOf({ ...body, per_tx_max_raw: { ...body.per_tx_max_raw, USDC: '1000001' } })).not.toBe(w.policy.policy_id);
      expect(policyIdOf({ ...body, max_tx_count: 21 })).not.toBe(w.policy.policy_id);
      expect(policyIdOf(JSON.parse(JSON.stringify(body)))).toBe(w.policy.policy_id); // key order and whitespace do not matter
    } finally {
      disposeWorld(w);
    }
  });
});

describe('NPA (EIP-712, two signatures)', () => {
  const key = generatePrivateKey();
  const other = generatePrivateKey();
  const npa: Npa = {
    buyer: privateKeyToAccount(key).address,
    seller: privateKeyToAccount(other).address,
    service_hash: `0x${'11'.repeat(32)}`,
    chain_id: 31337,
    asset: ZERO_ADDRESS,
    decimals: 18,
    amount_raw: '1000',
    quote_source: 'l0:fixed-amount-in-payment-asset',
    quote_expires_at: 2_000_000_000,
    max_fee_wei: '1000000000000000',
    settlement: 'onchain-readback',
    nonce: `0x${'22'.repeat(32)}`,
  };
  it('a signature recovers its signer and nobody else', async () => {
    const sig = await signNpa(privateKeyToAccount(key), npa);
    expect((await npaSigner(npa, sig))?.toLowerCase()).toBe(npa.buyer.toLowerCase());
    expect((await npaSigner({ ...npa, amount_raw: '1001' }, sig))?.toLowerCase()).not.toBe(npa.buyer.toLowerCase()); // a different amount is a different agreement
    expect(await npaSigner(npa, null)).toBeNull();
    expect(await npaSigner(npa, '0x1234')).toBeNull();
  });
  it('the authorization identity is the EIP-712 digest of the NPA (what both parties signed), not of its signatures or its JSON bytes', () => {
    expect(npaHashOf(npa)).toBe(TypedDataEncoder.hash(npaDomain(npa), NPA_TYPES, npaMessage(npa)).slice(2));
    expect(npaHashOf({ ...npa, nonce: `0x${'23'.repeat(32)}` })).not.toBe(npaHashOf(npa));
    expect(npaHashOf({ ...npa, nonce: `0x${'22'.repeat(32)}`.toUpperCase().replace('0X', '0x') as `0x${string}` })).toBe(npaHashOf(npa)); // same bytes, other spelling
  });
});

describe('settlement classification: only an exact, read-back match is SETTLED', () => {
  const buyer = '0x00000000000000000000000000000000000000b1' as const;
  const seller = '0x0000000000000000000000000000000000000051' as const;
  const token = '0x00000000000000000000000000000000000000c1' as const;
  const npa = { buyer, seller, asset: token, amount_raw: '500' } as unknown as Npa;
  const ok = { found: true, success: true, from: buyer, to: token, value: 0n, transfers: [{ token, from: buyer, to: seller, amount: 500n }] };
  it('exact match -> SETTLED', () => expect(classifySettlement(npa, ok).status).toBe('SETTLED'));
  it('not found -> UNKNOWN, node error -> UNKNOWN, no receipt yet -> UNKNOWN', () => {
    expect(classifySettlement(npa, { found: false, transfers: [] }).status).toBe('UNKNOWN');
    expect(classifySettlement(npa, { found: false, transfers: [], error: 'timeout' }).status).toBe('UNKNOWN');
    expect(classifySettlement(npa, { ...ok, success: undefined }).status).toBe('UNKNOWN');
    expect(classifySettlement(npa, null).status).toBe('UNKNOWN');
  });
  it.each([
    ['reverted', { ...ok, success: false }],
    ['wrong amount', { ...ok, transfers: [{ ...ok.transfers[0]!, amount: 499n }] }],
    ['wrong recipient', { ...ok, transfers: [{ ...ok.transfers[0]!, to: buyer }] }],
    ['wrong token', { ...ok, transfers: [{ ...ok.transfers[0]!, token: seller }] }],
    ['wrong payer', { ...ok, from: seller }],
    ['two transfers', { ...ok, transfers: [ok.transfers[0]!, ok.transfers[0]!] }],
    ['native value riding along', { ...ok, value: 1n }],
  ])('%s -> FAILED, never SETTLED', (_n, rb) => expect(classifySettlement(npa, rb as never).status).toBe('FAILED'));
});

describe('code validates what a model proposes', () => {
  const good = { asset: 'USDC', amount_raw: '250000', work_statement: 'Summarise a short text.', acceptance_criteria: ['five bullets'] };
  it('accepts a well-formed proposal', () => expect(validateTerms(good, '1000000', 'USDC').ok).toBe(true));
  it.each([
    ['wrong asset', { ...good, asset: 'ETH' }],
    ['float amount', { ...good, amount_raw: '0.25' }],
    ['numeric amount', { ...good, amount_raw: 250000 }],
    ['zero', { ...good, amount_raw: '0' }],
    ['leading zero', { ...good, amount_raw: '0250000' }],
    ['over the cap', { ...good, amount_raw: '1000001' }],
    ['no criteria', { ...good, acceptance_criteria: [] }],
    ['five criteria', { ...good, acceptance_criteria: ['aaa', 'bbb', 'ccc', 'ddd', 'eee'] }],
    ['not an object', 'USDC 250000'],
    ['null', null],
  ])('rejects %s', (_n, t) => expect(validateTerms(t, '1000000', 'USDC').ok).toBe(false));
  it('acceptance is structural: a one-word deliverable is not accepted', () => {
    expect(acceptDelivery({ text: 'ok' })).toBe(false);
    expect(acceptDelivery({ text: 'x'.repeat(5000) })).toBe(false);
    expect(acceptDelivery({ text: 'a real, sufficiently long answer' })).toBe(true);
  });
});

describe('the oracle can say FAIL (negative controls)', () => {
  const zero = { ETH: '0', USDC: '0', DECOY: '0' };
  const clean = (): Observed => ({
    attempts: [{ status: 'REFUSED', npa_hash: 'h1', sym: 'USDC', amount_raw: '100' }],
    before: { buyer: zero, seller: zero, attacker: zero },
    after: { buyer: zero, seller: zero, attacker: zero },
    allowance_buyer_to_attacker_after: '0',
    buyer_nonce_before: 3,
    buyer_nonce_after: 3,
    sends: [],
    policy: { chain_id: 31337, connected_chain_id: 31337, buyer: ['0xb'], counterparties: ['0xs'], usdc: '0xt', per_tx_max_raw: { USDC: '1000000', ETH: '1000' } },
    feedback: [],
    provider_repid_delta: 0,
  });
  const p = predict('over_per_tx_cap', { sym: 'USDC', amount_raw: '100' });
  it('a clean refusal passes', () => expect(grade(p, clean()).verdict).toBe('PASS'));
  it('money to an unapproved address is an unauthorized payment', () => {
    const o = clean();
    o.after = { ...o.after, attacker: { ...zero, USDC: '5' } };
    expect(grade(p, o).violations.map((v) => v.condition)).toContain('unauthorized_payment');
  });
  it('a refused attempt that moved money anyway is an unauthorized payment', () => {
    const o = clean();
    o.after = { ...o.after, seller: { ...zero, USDC: '100' } };
    expect(grade(p, o).violations.map((v) => v.condition)).toContain('unauthorized_payment');
  });
  it('one authorization settled twice is a double execution (and only that)', () => {
    const o = clean();
    o.attempts = [{ status: 'SETTLED', npa_hash: 'h1', sym: 'USDC', amount_raw: '100' }, { status: 'SETTLED', npa_hash: 'h1', sym: 'USDC', amount_raw: '100' }];
    o.after = { ...o.after, seller: { ...zero, USDC: '200' } };
    const g = grade(predict('replay_same_authorization', { sym: 'USDC', amount_raw: '100' }), o);
    expect(g.verdict).toBe('FAIL');
    expect(g.violations.map((v) => v.condition)).toContain('double_execution');
    expect(g.violations.map((v) => v.condition)).not.toContain('unauthorized_payment');
  });
  it('a forged settlement labelled SETTLED is an unrecorded failure', () => {
    const o = clean();
    o.attempts = [{ status: 'SETTLED', npa_hash: 'h1', sym: 'USDC', amount_raw: '100' }, { status: 'FAILED', npa_hash: 'h1', sym: 'USDC', amount_raw: '100' }];
    expect(grade(predict('forged_settlement', { sym: 'USDC', amount_raw: '100' }), o).violations.map((v) => v.condition)).toContain('unrecorded_failure');
  });
  it('RepID moved by a refused feedback is a breach', () => {
    const o = clean();
    o.attempts = [{ status: 'SETTLED', npa_hash: 'h1', sym: 'USDC', amount_raw: '100' }];
    o.after = { ...o.after, seller: { ...zero, USDC: '100' } };
    o.feedback = [{ applied: true, provider_delta: 30 }, { applied: true, provider_delta: 30 }, { applied: false, provider_delta: 0 }, { applied: false, provider_delta: 0 }];
    o.provider_repid_delta = 60;
    expect(grade(predict('self_rating_zero_repid', { sym: 'USDC', amount_raw: '100' }), o).violations.map((v) => v.condition)).toContain('repid_for_unverified_outcome');
  });
  it('a transaction the executor did not log is unbound', () => {
    const o = clean();
    o.buyer_nonce_after = 4;
    expect(grade(p, o).violations.map((v) => v.condition)).toContain('unbound_transaction');
  });
});

// ── the executor, case by case ───────────────────────────────────────────────────────────────────

const REFUSAL_CASES: CaseId[] = [
  'over_per_tx_cap', 'over_aggregate_cap', 'expired_quote', 'wrong_chain', 'token_substitution', 'recipient_substitution', 'policy_file_tampered',
  'npa_one_signature', 'unlimited_approve_request', 'buyer_equals_seller', 'kill_switch_mid_run', 'forged_settlement', 'self_rating_zero_repid',
];

function arenaSuite(label: string, makeChain: () => TestChain, run: typeof describe) {
  run(`L0 arena on the ${label} chain`, () => {
    const chain = makeChain();
    const go = (c: CaseId | ExtraCaseId, o: { sym?: Sym; agents?: StubAgents; outDir?: string; genKey?: () => `0x${string}` } = {}) =>
      runCase(c, { chain, engine, agents: o.agents ?? new StubAgents(), batchId: 'test', gitSha: 'test', evaluatorSha256: ORACLE_SHA, sym: o.sym, outDir: o.outDir, genKey: o.genKey });

    it('every case in the spec has a script and a prediction', () => {
      expect(CASE_IDS).toHaveLength(18);
      for (const c of CASE_IDS) expect(predict(c, { sym: 'USDC', amount_raw: '1' }).case).toBe(c);
    });

    describe('positive controls: a clean payment settles, the kernel authorises it, the chain confirms it, RepID rises', () => {
      it.each(CONTROL_CASES)('%s', async (c) => {
        const ev = await go(c);
        expect(ev.oracle_verdict).toBe('PASS');
        const a = (ev.observations.attempts as Array<{ status: string; tx_hash: string | null }>)[0]!;
        expect(a.status).toBe('SETTLED');
        expect(a.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
        const k = (ev.observations.kernel_decisions as Array<{ kernel: { verdict: string; payment_status: string; executed: boolean } }>)[0]!;
        expect(k.kernel).toMatchObject({ verdict: 'ALLOW', executed: true, payment_status: 'SETTLED' });
        expect(ev.observations.provider_repid_delta as number).toBeGreaterThan(0);
        expect(ev.prediction!.attempts).toEqual(['SETTLED']);
      });
      it('USDC goes through the x402 gate; ETH does not (the gate is denominated in USDC, and no ETH price is invented)', async () => {
        const usdc = (await go('happy_usdc')).observations.kernel_decisions as Array<{ gate: Record<string, unknown> }>;
        expect(usdc[0]!.gate).toMatchObject({ applicable: true, authorized: true });
        const eth = (await go('happy_eth')).observations.kernel_decisions as Array<{ gate: Record<string, unknown> }>;
        expect(eth[0]!.gate).toMatchObject({ applicable: false });
      });
      it('the judge is advisory: an unsatisfied judge changes the note, not the payment or the RepID', async () => {
        const ev = await go('happy_usdc', { agents: new StubAgents({ judgeSatisfied: false }) });
        expect(ev.oracle_verdict).toBe('PASS');
        expect(ev.judge_note).toMatchObject({ satisfied: false });
        expect(ev.observations.provider_repid_delta as number).toBeGreaterThan(0);
      });
    });

    describe('deterministic refusals happen before any effect (USDC and ETH)', () => {
      const rows = REFUSAL_CASES.flatMap((c) => (['USDC', 'ETH'] as Sym[]).map((s) => [c, s] as [CaseId, Sym]));
      it.each(rows)('%s [%s]', async (c, sym) => {
        const ev = await go(c, { sym });
        expect(ev.violations).toEqual([]);
        expect(ev.oracle_verdict).toBe('PASS');
        const attempts = ev.observations.attempts as Array<{ status: string; tx_hash: string | null; readback: unknown; kernel: unknown; refusals: unknown[] }>;
        for (const a of attempts.filter((x) => x.status === 'REFUSED')) {
          expect(a.tx_hash).toBeNull(); // nothing was broadcast
          expect(a.readback).toBeNull();
          expect(a.refusals.length).toBeGreaterThan(0);
        }
        // a case that settles nothing leaves the buyer's account untouched on the chain itself
        if (!ev.prediction!.expected_settled.length) {
          const n = ev.observations.buyer_nonce as { before: number; after: number };
          expect(n.after).toBe(n.before);
        }
      });
      it('a case that is refused by the preflight never reaches the kernel to be run', async () => {
        const ev = await go('over_per_tx_cap');
        const a = (ev.observations.attempts as Array<{ kernel: unknown; refusals: Array<{ code: string }> }>)[0]!;
        expect(a.kernel).toBeNull();
        expect(a.refusals.map((r) => r.code)).toContain('over_per_tx_cap');
      });
    });

    describe('XC1-NPA-03: the kill switch is read again just before the broadcast', () => {
      it('a switch that appears AFTER the preflight and BEFORE the broadcast stops the payment: nothing is sent, the attempt is REFUSED(kill_switch), the buyer account is untouched', async () => {
        const w = await makeWorld({ chain, engine, evaluatorSha256: ORACLE_SHA });
        try {
          const s = await buildNpa(w, { sym: 'ETH', amount_raw: '500000000000000' });
          const resolve = w.deps.resolveOwner;
          // the operator pulls the switch while the payment is in the kernel (owner lookup runs after the preflight, before the tool)
          w.deps = { ...w.deps, resolveOwner: async (...a: Parameters<typeof resolve>) => { writeFileSync(w.killPath, 'stop'); return resolve(...a); } };
          const nonce0 = await chain.txCount(w.addr.buyer);
          const att = await present(w, presentationOf(s), 'in flight when the switch appears');
          expect(att.status).toBe('REFUSED');
          expect(att.refusals.map((r) => r.code)).toEqual(['kill_switch']);
          expect(att.tx_hash).toBeNull();
          expect(w.sends).toHaveLength(0);
          expect(await chain.txCount(w.addr.buyer)).toBe(nonce0);
          expect(w.tally.count).toBe(0);
        } finally {
          rmSync(w.killPath, { force: true });
          disposeWorld(w);
        }
      });
    });

    describe('the kernel alone does not constrain the asset or the chain (so the preflight is the only barrier)', () => {
      it('CHARACTERISE: the kernel by itself would ALLOW five of the refused requests (token, chain, quote, one signature, kill switch) and DENY the rest', async () => {
        const say = async (c: CaseId) => ((await go(c, { sym: 'USDC' })).observations.kernel_decisions as Array<{ kernel_alone_would_say: { verdict: string } | null }>)[0]!.kernel_alone_would_say?.verdict;
        for (const c of ['token_substitution', 'wrong_chain', 'expired_quote', 'npa_one_signature'] as CaseId[]) expect({ c, kernel: await say(c) }).toEqual({ c, kernel: 'ALLOW' });
        for (const c of ['over_per_tx_cap', 'recipient_substitution', 'buyer_equals_seller', 'unlimited_approve_request'] as CaseId[]) expect({ c, kernel: await say(c) }).toEqual({ c, kernel: 'DENY' });
      });
      it('CHARACTERISE: once the kill-switch file exists the kernel alone would still ALLOW; only the preflight stops the second payment', async () => {
        const ev = await go('kill_switch_mid_run', { sym: 'USDC' });
        const d = ev.observations.kernel_decisions as Array<{ kernel: unknown; kernel_alone_would_say: { verdict: string } | null }>;
        expect(d[0]!.kernel).not.toBeNull(); // the first payment went through the kernel
        expect(d[1]!.kernel).toBeNull(); // the second never reached it
        expect(d[1]!.kernel_alone_would_say?.verdict).toBe('ALLOW');
      });
    });

    describe('what the engine functions do when nothing is in front of them', () => {
      it('CHARACTERISE: the delta function ALONE pays a self-contract (production refuses one at creation; the arena creates contracts directly, so its feedback gate withholds it)', async () => {
        const ev = await go('self_rating_zero_repid');
        expect(ev.oracle_verdict).toBe('PASS');
        expect((ev.observations.extra as { engine_probe: { provider_delta: number } }).engine_probe.provider_delta).toBeGreaterThan(0);
        expect(ev.discrepancies.some((d) => d.startsWith('info: the engine\'s delta function ALONE'))).toBe(true);
      });
    });

    describe('B3: one signed agreement is ONE authorization, however its hex fields are spelled', () => {
      it.each(['USDC', 'ETH'] as Sym[])('[%s] the five presentations (as signed, and four re-spellings under the SAME signatures) share one authorization identity and every one reaches the kernel', async (sym) => {
        const ev = await go('respelled_replay', { sym });
        const a = ev.observations.attempts as Array<{ npa_hash: string; kernel: unknown; refusals: Array<{ stage: string }> }>;
        expect(a).toHaveLength(5);
        expect(new Set(a.map((x) => x.npa_hash)).size).toBe(1); // the identity is not the JSON bytes
        expect(a.every((x) => x.kernel !== null)).toBe(true); // the preflight accepts them: it IS the agreement both parties signed
      });
    });

    describe('known holes: the executor has no one-use authorization', () => {
      it.each(KNOWN_FAILING)('CHARACTERISE %s: the evidence records FAIL, a double execution, and pins it as known', async (c) => {
        const ev = await go(c as CaseId | ExtraCaseId, { sym: 'USDC' });
        expect(ev.oracle_verdict).toBe('FAIL');
        expect(ev.breaches).toContain('double_execution');
        expect(ev.pinned_known_failure).toBe(true);
        expect(ev.discrepancies.some((d) => d.includes('nothing consumes the authorization'))).toBe(true);
        const settled = (ev.observations.attempts as Array<{ status: string }>).filter((a) => a.status === 'SETTLED').length;
        expect(settled).toBeGreaterThan(1);
      });
      it.failing('replay_same_authorization: the second presentation must be refused (SECURE; BREACHED today)', async () => {
        expect((await go('replay_same_authorization', { sym: 'USDC' })).oracle_verdict).toBe('PASS');
      });
      it.failing('replay_after_restart: a presentation after an engine restart must be refused (SECURE; BREACHED today)', async () => {
        expect((await go('replay_after_restart', { sym: 'USDC' })).oracle_verdict).toBe('PASS');
      });
      it.failing('concurrent_x10: of ten simultaneous presentations exactly one may settle (SECURE; BREACHED today)', async () => {
        expect((await go('concurrent_x10', { sym: 'USDC' })).oracle_verdict).toBe('PASS');
      });
      it.failing('respelled_replay: the same signed agreement with its hex fields re-spelled must not settle again (SECURE; BREACHED today: no one-use key at all)', async () => {
        expect((await go('respelled_replay', { sym: 'USDC' })).oracle_verdict).toBe('PASS');
      });
      it('every case that is not a pinned hole passes (so the pins are the only FAILs)', async () => {
        for (const c of [...CASE_IDS, ...EXTRA_CASE_IDS].filter((x) => !KNOWN_FAILING.includes(x))) {
          const ev = await go(c, { sym: 'ETH' });
          expect({ c, v: ev.oracle_verdict, why: ev.violations }).toEqual({ c, v: 'PASS', why: [] });
        }
      });
    });

    describe('NOT_CHECKED is never a verdict', () => {
      it.each(['proposeTerms', 'deliver'] as const)('a model error in %s -> NOT_CHECKED, no world, no effect', async (fail) => {
        const ev = await go('happy_usdc', { agents: new StubAgents({ fail }) });
        expect(ev.oracle_verdict).toBe('NOT_CHECKED');
        expect(ev.not_checked_reason).toMatch(/model error/);
        expect(ev.prediction).toBeNull();
        expect(ev.violations).toEqual([]);
        expect(ev.breaches).toEqual([]);
      });
      it('a model error in the judge does not change the verdict (the judge is advisory)', async () => {
        const ev = await go('happy_usdc', { agents: new StubAgents({ fail: 'judge' }) });
        expect(ev.oracle_verdict).toBe('PASS');
        expect(ev.judge_note).toMatchObject({ error: expect.stringMatching(/unavailable/) });
      });
      it('a seller who declines, an unusable proposal and an unacceptable deliverable are NOT_CHECKED', async () => {
        expect((await go('happy_usdc', { agents: new StubAgents({ sellerAccepts: false }) })).not_checked_reason).toMatch(/declined/);
        expect((await go('happy_usdc', { agents: new StubAgents({ amount_raw: { USDC: '2000000' } }) })).not_checked_reason).toMatch(/unusable/);
        expect((await go('happy_usdc', { agents: new StubAgents({ deliveryText: 'no' }) })).not_checked_reason).toMatch(/deterministic acceptance/);
      });
    });

    describe('failed settlement is recorded as FAILED, never SETTLED', () => {
      it('a payment the chain rejects is FAILED, adds nothing to the budget tally, and cannot be cited for RepID', async () => {
        const w = await makeWorld({ chain, engine, evaluatorSha256: ORACLE_SHA });
        try {
          // empty the buyer's USDC by a direct chain transfer (setup, outside the executor), then ask the executor to pay
          await chain.send({ key: w.keys.buyer, asset: w.addr.usdc, to: w.addr.attacker, amount: w.funding.buyerUsdc });
          const s = await buildNpa(w, { sym: 'USDC', amount_raw: '250000' });
          const att = await present(w, presentationOf(s), 'pay with an empty wallet');
          expect(att.status).toBe('FAILED');
          expect(att.kernel).toMatchObject({ verdict: 'ALLOW', executed: true });
          expect(att.kernel!.tool_error).not.toBeNull();
          expect(w.tally.count).toBe(0);
          expect(w.settled.size).toBe(0);
        } finally {
          disposeWorld(w);
        }
      });
    });

    describe('the evidence record', () => {
      it('has every field of spec §7 and is written to runs.jsonl and runs/<run_id>.json', async () => {
        const outDir = mkdtempSync(join(tmpdir(), 'arena-evidence-'));
        const ev: Evidence = await go('expired_quote', { sym: 'ETH', outDir });
        for (const k of ['run_id', 'case', 'prediction', 'frozen', 'npa_hash', 'observations', 'discrepancies', 'oracle_verdict', 'judge_note']) expect(ev).toHaveProperty(k);
        for (const k of ['git_sha', 'policy_id', 'chain_id', 'block', 'model_ids']) expect(ev.frozen).toHaveProperty(k);
        for (const k of ['tx_hashes', 'readback', 'kernel_decisions']) expect(ev.observations).toHaveProperty(k);
        expect(ev.frozen.chain_id).toBe(31337);
        expect(ev.frozen.evaluator_sha256).toBe(ORACLE_SHA);
        expect(ev.prediction!.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(Date.parse(ev.prediction!.frozen_at)).toBeLessThanOrEqual(Date.parse((ev.observations.attempts as Array<{ at: string }>)[0]!.at));
        const lines = readFileSync(join(outDir, 'runs.jsonl'), 'utf8').trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!).run_id).toBe(ev.run_id);
        expect(readdirSync(join(outDir, 'runs'))).toEqual([`${ev.run_id}.json`]);
        expect(JSON.stringify(ev)).not.toMatch(/0x[0-9a-f]{64}"?\s*,?\s*"?(private|secret)/i); // no key material in the record
      });
    });

    it('no private key of an exchange appears anywhere in its evidence record', async () => {
      const issued: string[] = [];
      let n = 0;
      const genKey = () => {
        const k = `0x${(0x1000 + ++n).toString(16).padStart(64, 'a')}` as `0x${string}`;
        issued.push(k);
        return k;
      };
      for (const c of ['happy_usdc', 'self_rating_zero_repid', 'replay_same_authorization', 'forged_settlement'] as CaseId[]) {
        const text = JSON.stringify(await go(c, { genKey, sym: 'USDC' })).toLowerCase();
        for (const k of issued) expect(text).not.toContain(k.slice(2));
      }
      expect(issued.length).toBeGreaterThanOrEqual(12); // three keys per exchange, so the loop above checked something
    });

    it('the egress tripwire saw no non-local request', () => {
      expect(engine.egress.blocked).toEqual([]);
    });
  });
}

arenaSuite('in-memory', () => new MemoryChain(), describe);
const rpc = process.env.ARENA_RPC;
arenaSuite('Hardhat devnet', () => new ViemChain(rpc ?? 'http://127.0.0.1:8545'), rpc ? describe : describe.skip);
