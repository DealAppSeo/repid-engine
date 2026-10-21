/**
 * XC1 L1-GATE RE-GRADE of the kernel fixes (PR #1453) — new probes only. XC1, 2026-10-21.
 *
 * Report: E:\dev\reports\2026-10-21\XC1_KERNEL_REGRADE.md. READ-ONLY on src/: nothing under src/ is
 * edited, even temporarily. Owner keys are Wallet.createRandom() (memory only, never funded); no chain
 * is dialled; the only network is a loopback HTTP server this file starts (a stand-in PostgREST).
 *
 * WHY THIS FILE EXISTS. CC1's fixes flip the ten #1444 probes. Each probe below aims at a shape the
 * old probe did not try: the same payment under another field spelling, the spend class instead of
 * read, a padded implementation id on a spend, two live processes on one store, the real supabase-js
 * client against a missing table, a full receipt rewrite instead of a strip.
 *
 * ONE FILE, TWO CODE BASES. It is committed on main (before #1453) and graded on #1453. Every probe
 * pins its expected result on BOTH, so it is green on either and turns red the moment a result
 * changes:   probe(name, { main, fixes }, fn)   PASS -> it(...)   FAIL -> it.failing(...).
 * "fixes" = the kernel-fix code is present (StoreLedger.prototype.indeterminate exists). A FAIL is a
 * SECURE expectation that code does not meet; every FAIL here was also run as a plain `it` and failed
 * at its own assertion (report §2).
 */
import { Wallet } from 'ethers';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createCapabilityRegistry } from '../../src/kernel/capability-registry';
import { CAPABILITY_ENFORCED_CHECK, CUMULATIVE_TOTAL_NOTE, REQUIRED_CHECKS, TOTAL_CAP_SCOPE_NOTE, parseKernelRequest } from '../../src/kernel/decide';
import { runUnderKernel } from '../../src/kernel/gate';
import { POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2 } from '../../src/kernel/policy';
import { DEFAULT_ENV, buildReceipt, hashArgs, receiptHash, validateReceipt } from '../../src/kernel/receipt';
import { StoreLedger, createJsonlStore } from '../../src/kernel/store';
import type { GateDeps, HalEvidence, KernelReceipt, KernelSink, OwnerPolicy } from '../../src/kernel/types';
import { AGENT_ID, NOW_S, PAYEE, harness, iso, postRequest, signedPolicy, spendRequest } from '../../src/kernel/__tests__/fixtures';
import * as ownerAuth from '../../src/services/owner-authorization';
import { OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, __resetOwnerAuthNonces, checkOwnerAuthorization, paramsHash } from '../../src/services/owner-authorization';
import { createLocalStore } from '../../src/selfhost/local-store';

// ── which code is under test ──────────────────────────────────────────────────────────────────
type Status = 'PASS' | 'FAIL';
const FIXES = typeof (StoreLedger.prototype as unknown as { indeterminate?: unknown }).indeterminate === 'function';
const probe = (name: string, on: { main: Status; fixes: Status }, fn: () => Promise<void>, timeout?: number) =>
  ((FIXES ? on.fixes : on.main) === 'PASS' ? it : it.failing)(`${name} [main ${on.main} / #1453 ${on.fixes}]`, fn, timeout);

// The #1453 owner-auth surface, reached by name so this file compiles on main where it is absent.
interface NonceLedgerLike { claim(signer: string, nonce: string, expiresAt: number): Promise<'claimed' | 'replayed'> }
const fixesApi = ownerAuth as unknown as {
  tableNonceLedger?: (client: () => unknown) => NonceLedgerLike;
  __setOwnerAuthNonceLedger?: (l: NonceLedgerLike) => void;
};
function requireFixesApi() {
  expect(typeof fixesApi.tableNonceLedger).toBe('function'); // main: there is no durable nonce ledger at all
  return { tableNonceLedger: fixesApi.tableNonceLedger!, setLedger: fixesApi.__setOwnerAuthNonceLedger! };
}
/** Leave an offline in-process ledger installed, as the #1453 jest setup file does, for later files. */
function restoreOfflineLedger() {
  if (!fixesApi.__setOwnerAuthNonceLedger) return;
  const used = new Set<string>();
  fixesApi.__setOwnerAuthNonceLedger({ async claim(s, n) { const k = `${s}:${n}`; if (used.has(k)) return 'replayed'; used.add(k); return 'claimed'; } });
}

const codes = (r: { reasons: Array<{ code: string }> }) => r.reasons.map((x) => x.code);
const hal = (over: Partial<HalEvidence> = {}): HalEvidence => ({
  verdict: 'PASS', method: 'hal-fact-check/cross-llm-quorum',
  votes: [{ family: 'gpt-oss', verdict: 'PASS' }, { family: 'qwen', verdict: 'PASS' }],
  settled_by: null, grounded: false, same_domain: false, ...over,
});
async function armed(over: Partial<GateDeps> = {}, policy: Partial<OwnerPolicy> = {}) {
  const h = harness(over);
  await h.ledger.appendPolicy(await signedPolicy(h.owner, policy), iso);
  return h;
}
const readReq = (name = 'doc.read', over: Record<string, unknown> = {}) => ({
  agent: { agent_id: AGENT_ID, agent_name: 'kernel-demo-agent' }, tool: { name, class: 'read' }, origin: 'Cli', args_hash: hashArgs({ doc: 'x' }), ...over,
});
/** Flag ON: a boot-populated registry and a signed v2 policy binding every impl. */
async function enforced(over: Partial<GateDeps> = {}) {
  const impls = { payment: jest.fn(async () => 'paid'), formatter: jest.fn(async () => 'formatted') };
  const reg = createCapabilityRegistry();
  reg.register({ implId: 'impl.payment', capability: { id: 'payment.x402', toolClass: 'spend' }, run: impls.payment });
  reg.register({ implId: 'impl.formatter', capability: { id: 'format.markdown', toolClass: 'read' }, run: impls.formatter });
  const h = harness({ capabilityRegistry: reg, halCheck: async () => hal(), ...over });
  const policy: OwnerPolicy = {
    subject: AGENT_ID, owner: h.owner.address, actions: ['spend', 'tool'], payees: [PAYEE],
    per_tx_raw: '1000000', daily_raw: '5000000', total_raw: '20000000', expires_at: NOW_S + 3600, nonce: '1',
    authorized_impl_hashes: ['impl.payment', 'impl.formatter'],
  };
  await h.deps.ledger.appendPolicy({ policy, signature: await h.owner.signTypedData(POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyTypedValueV2(policy)) }, iso);
  return { ...h, impls };
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const reseal = (r: KernelReceipt): KernelReceipt => { const c = clone(r); c.header.receipt_hash = receiptHash(c); return c; };
/** Literal, so this file does not depend on #1453 exporting it. */
const CLASS_DISCLAIMER = 'tool_class (caller-asserted; there is no tool registry in the MVP)';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// TK — one-use authorization: shapes the #1444 probes (identical read re-presented) did not try.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('XC1-TK one-use authorization beyond the identical-read shape', () => {
  probe('[XC1-TK-07] one argument digest must authorize at most one payment, whatever the caller writes in fields that do not change the payment (tool name, asset label, chain_id)', { main: 'FAIL', fixes: 'PASS' }, async () => {
    const h = await armed();
    const pay = jest.fn(async () => 'paid 10000 to PAYEE');
    const first = await runUnderKernel(spendRequest(), pay, h.deps);
    expect(first.verdict).toBe('ALLOW'); // positive control: the harness pays once
    for (const v of [
      { tool: { name: 'x402.pay ', class: 'spend' } },
      { tool: { name: 'X402.PAY', class: 'spend' } },
      { asset: 'USDC ' },
      { asset: null },
      { chain_id: null },
      { chain_id: 1 },
    ]) await runUnderKernel(spendRequest(v), pay, h.deps);
    expect(pay).toHaveBeenCalledTimes(1);
  });

  probe('[XC1-TK-07c] control: the fields the key DOES normalise (args_hash letter case, payee letter case, origin) are one authorization', { main: 'FAIL', fixes: 'PASS' }, async () => {
    const h = await armed();
    const pay = jest.fn(async () => 'paid');
    expect((await runUnderKernel(spendRequest(), pay, h.deps)).verdict).toBe('ALLOW');
    const base = spendRequest();
    for (const v of [{ args_hash: (base.args_hash as string).toUpperCase().replace('0X', '0x') }, { payee: PAYEE.toLowerCase() }, { origin: 'Api' }]) {
      const out = await runUnderKernel(spendRequest(v), pay, h.deps);
      expect(codes(out)).toContain('authorization_consumed');
    }
    expect(pay).toHaveBeenCalledTimes(1);
  });

  probe('[XC1-TK-08] flag ON: a spend replayed under a padded implementation id (it resolves, by trim, to the same registered payment impl) must not pay twice', { main: 'FAIL', fixes: 'PASS' }, async () => {
    const e = await enforced();
    const req = (name: string) => spendRequest({ tool: { name, class: 'spend' } });
    expect((await runUnderKernel(req('impl.payment'), e.impls.payment as unknown as () => Promise<string>, e.deps)).verdict).toBe('ALLOW');
    for (const padded of [' impl.payment', 'impl.payment ', '\uFEFFimpl.payment']) {
      await runUnderKernel(req(padded), e.impls.payment as unknown as () => Promise<string>, e.deps);
    }
    expect(e.impls.payment).toHaveBeenCalledTimes(1);
  });

  probe('[XC1-TK-09] 10 concurrent presentations of ONE spend, and of ONE post, give at most one effect each (TK-04 was a read)', { main: 'FAIL', fixes: 'PASS' }, async () => {
    const h = await armed({ halCheck: async () => hal() });
    const pay = jest.fn(async () => 'paid');
    const post = jest.fn(async () => 'posted');
    await Promise.all(Array.from({ length: 10 }, () => runUnderKernel(spendRequest(), pay, h.deps)));
    await Promise.all(Array.from({ length: 10 }, () => runUnderKernel(postRequest(), post, h.deps)));
    expect(pay).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  probe('[XC1-TK-10] flag ON: a registered payment replayed after a restart of the on-disk ledger is refused', { main: 'FAIL', fixes: 'PASS' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xc1-l1-'));
    try {
      const path = join(dir, 'ledger.jsonl');
      const e = await enforced({ ledger: new StoreLedger(createJsonlStore(path)) });
      const req = spendRequest({ tool: { name: 'impl.payment', class: 'spend' } });
      expect((await runUnderKernel(req, e.impls.payment as unknown as () => Promise<string>, e.deps)).verdict).toBe('ALLOW');
      const restarted = { ...e.deps, ledger: new StoreLedger(createJsonlStore(path)) };
      const again = await runUnderKernel(req, e.impls.payment as unknown as () => Promise<string>, restarted);
      expect(again.verdict).not.toBe('ALLOW');
      expect(e.impls.payment).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// I2-08R — the re-specified I2-08 (report §3 adjudication): the effect cannot be un-run once the
// decision row is durable (I2-03/I2-07), so the secure property is "INDETERMINATE, durable, never
// retried", checked here on a real on-disk ledger and across a restart.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('XC1-I2-08R a failed OUTCOME append leaves an INDETERMINATE call that is never retried', () => {
  probe('[XC1-I2-08R] the effect ran once, the result is withheld, a restarted ledger lists the call as INDETERMINATE, and a retry is refused with no second effect', { main: 'FAIL', fixes: 'PASS' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xc1-l1-'));
    try {
      const path = join(dir, 'ledger.jsonl');
      const disk = createJsonlStore(path);
      let receipts = 0;
      const failSecond: KernelSink = {
        async append(rec) {
          if (rec.kind === 'receipt' && ++receipts === 2) throw new Error('disk full');
          return disk.append(rec);
        },
        readAll: () => disk.readAll(),
      };
      const h = harness({ ledger: new StoreLedger(failSecond) });
      await h.deps.ledger.appendPolicy(await signedPolicy(h.owner), iso);
      const pay = jest.fn(async () => 'MONEY MOVED');
      const out = await runUnderKernel(spendRequest(), pay, h.deps);
      expect(pay).toHaveBeenCalledTimes(1);
      expect(out.outcome_unrecorded).toBe(true);
      expect(out.result).toBeUndefined();
      const restarted = new StoreLedger(createJsonlStore(path)) as unknown as { indeterminate?: () => Promise<string[]> };
      expect(typeof restarted.indeterminate).toBe('function');
      expect(await restarted.indeterminate!()).toEqual([out.decision_receipt!.header.receipt_id]);
      const retry = await runUnderKernel(spendRequest(), pay, { ...h.deps, ledger: restarted as unknown as StoreLedger });
      expect(retry.verdict).toBe('DENY');
      expect(pay).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// I3 / RT-6 — flag OFF the class is the caller's word. #1453 closes it for read/other under an owner
// with no spend authority. These try the classes and owners it does not cover.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('XC1-I3 flag OFF: the caller-asserted class, past the read/other shape', () => {
  probe('[XC1-I3-17] a payment closure filed as class "post" must not run under an owner who authorized NO spending (I3-01 was fixed for read/other only)', { main: 'FAIL', fixes: 'FAIL' }, async () => {
    const h = await armed({ halCheck: async () => hal() }, { actions: ['post'], payees: [], per_tx_raw: '0', daily_raw: '0', total_raw: '0' });
    const pay = jest.fn(async () => 'MONEY MOVED');
    const out = await runUnderKernel(postRequest({ tool: { name: 'x402.pay', class: 'post' } }), pay, h.deps);
    expect(out.verdict).not.toBe('ALLOW');
    expect(pay).toHaveBeenCalledTimes(0);
  });

  probe('[XC1-RT-6a] an owner who authorized 1 USDC per payment to ONE payee: a payment closure filed as "read" must not run (no cap, no payee list binds it)', { main: 'FAIL', fixes: 'FAIL' }, async () => {
    const h = await armed({}, { actions: ['spend', 'tool'], payees: [PAYEE], per_tx_raw: '1000000', daily_raw: '1000000', total_raw: '1000000' });
    const pay = jest.fn(async () => 'paid 1000 USDC to 0xattacker');
    const out = await runUnderKernel(readReq('x402.pay'), pay, h.deps);
    expect(out.verdict).not.toBe('ALLOW');
    expect(pay).toHaveBeenCalledTimes(0);
  });

  probe('[XC1-RT-6b] with HAL not wired, a publishing closure filed as "read" under a spend-capable owner must not run without HAL (I3-02 was fixed for "other" only)', { main: 'FAIL', fixes: 'FAIL' }, async () => {
    const h = await armed(); // the fixture owner authorizes spend, post and tool; no halCheck in deps
    const publish = jest.fn(async () => 'POSTED');
    const out = await runUnderKernel(readReq('social.post'), publish, h.deps);
    expect(out.verdict).not.toBe('ALLOW');
    expect(publish).toHaveBeenCalledTimes(0);
  });

  probe('[XC1-RT-6c] control: flag ON closes RT-6a, the registered payment impl filed as "read" is refused and runs 0 times', { main: 'PASS', fixes: 'PASS' }, async () => {
    const e = await enforced();
    const out = await runUnderKernel(readReq('impl.payment'), e.impls.payment as unknown as () => Promise<string>, e.deps);
    expect(out.verdict).toBe('DENY');
    expect(e.impls.payment).toHaveBeenCalledTimes(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// VF — the HAL method allow-list.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('XC1-VF the HAL method allow-list', () => {
  probe('[XC1-VF-06] a look-alike of a known method (padded, other case, zero-width) is NOT_CHECKED, never a pass', { main: 'FAIL', fixes: 'PASS' }, async () => {
    for (const method of ['fact-check ', 'Fact-Check', '\u200bfact-check', 'hal-fact-check/cross-llm-quorum/']) {
      const h = await armed({ halCheck: async () => hal({ method }) });
      const post = jest.fn(async () => 'POSTED');
      const out = await runUnderKernel(postRequest(), post, h.deps);
      expect(out.verdict).toBe('NOT_CHECKED');
      expect(post).toHaveBeenCalledTimes(0);
    }
  });

  probe('[XC1-VF-07] a PASS through the method whose only honest answer is ABSTAIN (hal-fact-check/no-deliverable) must not ALLOW a post', { main: 'FAIL', fixes: 'FAIL' }, async () => {
    const h = await armed({ halCheck: async () => hal({ method: 'hal-fact-check/no-deliverable' }) });
    const post = jest.fn(async () => 'POSTED');
    const out = await runUnderKernel(postRequest(), post, h.deps);
    expect(out.verdict).not.toBe('ALLOW');
    expect(post).toHaveBeenCalledTimes(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// RS / RT-7 — receipt forgery past the strip shape. The secure property is "validateReceipt alone
// cannot be fooled"; #1453 makes the bare strip fail, a forger who also restores the disclaimer passes.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('XC1-RS receipt forgery past the strip shape', () => {
  probe('[XC1-RS-09] an enforced capability DENY rewritten into a self-consistent flag-OFF ALLOW (rows stripped, disclaimer present, verdict flipped) and resealed must not validate', { main: 'FAIL', fixes: 'FAIL' }, async () => {
    const e = await enforced();
    const evil = jest.fn(async () => 'EXFIL');
    const deny = await runUnderKernel(readReq('impl.exporter'), evil, e.deps);
    expect(deny.verdict).toBe('DENY');
    const c = clone(deny.decision_receipt!);
    c.decision.checks = c.decision.checks.filter((x) => x.name !== 'capability' && x.name !== CAPABILITY_ENFORCED_CHECK);
    if (!c.decision.does_not_attest.includes(CLASS_DISCLAIMER)) c.decision.does_not_attest.push(CLASS_DISCLAIMER);
    if (!c.decision.checks.some((x) => x.name === 'spend_authority')) c.decision.checks.push({ name: 'spend_authority', outcome: 'PASS', source: 'forged' });
    c.decision.verdict = 'ALLOW';
    c.decision.blocking = false;
    c.decision.reasons = [];
    expect(validateReceipt(reseal(c)).ok).toBe(false);
  });

  probe('[XC1-RT-7b] a receipt fabricated from nothing that copies the public class disclaimer must not validate as an authentic ALLOW', { main: 'FAIL', fixes: 'FAIL' }, async () => {
    const wallet = '0x00000000000000000000000000000000000000aa';
    const parsed = parseKernelRequest(spendRequest({ amount_raw: '1000000' }));
    if (!parsed.ok) throw new Error('fixture should parse');
    const forged = buildReceipt({
      receipt_id: '00000000-0000-4000-8000-0000000000fe', prev: null, created_at: iso, env: DEFAULT_ENV, request: parsed.request,
      owner: { status: 'resolved', wallet, assurance: 'wallet-proven' },
      decision: {
        verdict: 'ALLOW', blocking: false, executed: false, reasons: [],
        checks: REQUIRED_CHECKS.spend.map((name) => ({ name, outcome: 'PASS' as const, source: 'forged' })),
        does_not_attest: [CUMULATIVE_TOTAL_NOTE, TOTAL_CAP_SCOPE_NOTE, CLASS_DISCLAIMER],
        policy: { policy_hash: '0x' + 'ab'.repeat(32), signer: wallet, signature: 'VERIFIED', expires_at: 4_000_000_000, revocation: 'VERIFIED' },
        limits: { per_tx_raw: '9999999999', daily_raw: '9999999999', total_raw: '9999999999', effective_per_tx_raw: '9999999999', binding_term: 'per_tx' },
        laya: { lane: null, mode: 'shadow', consulted: false },
      },
      executed: false, phase: 'decision', hal: { state: 'not_needed' },
    });
    expect(validateReceipt(forged).ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// TK-03R — owner-approval nonces: LOCAL_MODE across a REAL restart and across two live processes;
// the production path with the real supabase-js client against a PostgREST that lacks the table;
// and whether the claim is atomic under concurrency.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('XC1-TK-03R the durable owner-approval nonce', () => {
  const NOW = 1_800_000_000;
  const offlineChain = { getCode: async () => '0x', call: async () => { throw new Error('offline'); } };
  async function approval(owner = Wallet.createRandom()) {
    const nonce = '0x' + randomBytes(32).toString('hex');
    const auth = { nonce, expires_at: NOW + 300, signature: await owner.signTypedData(OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, { subject: AGENT_ID, action: 'keys.create', params: paramsHash({}), nonce, expiresAt: NOW + 300 }) };
    const present = () => checkOwnerAuthorization({ subject: AGENT_ID, action: 'keys.create', params: {}, auth, expectedSigner: owner.address, nowS: NOW, chain: offlineChain });
    return { owner, auth, present };
  }
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); __resetOwnerAuthNonces(); });
  afterEach(() => { warn.mockRestore(); restoreOfflineLedger(); });

  probe('[XC1-TK-03R-a] LOCAL_MODE, a REAL restart: two node processes in sequence with the default db wiring; the second refuses the used approval', { main: 'FAIL', fixes: 'PASS' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xc1-l1-'));
    try {
      const { owner, auth } = await approval();
      const script = join(dir, 'present.js');
      const target = resolve(__dirname, '../../src/services/owner-authorization.ts').replace(/\\/g, '/');
      writeFileSync(script, [
        `const { checkOwnerAuthorization } = require(${JSON.stringify(target)});`,
        `const chain = { getCode: async () => '0x', call: async () => { throw new Error('offline'); } };`,
        `const a = JSON.parse(process.env.XC1_AUTH);`,
        `checkOwnerAuthorization({ subject: ${JSON.stringify(AGENT_ID)}, action: 'keys.create', params: {}, auth: a, expectedSigner: process.env.XC1_SIGNER, nowS: ${NOW}, chain })`,
        `  .then((r) => { process.stdout.write('RESULT ' + JSON.stringify({ ok: r.ok, code: r.code || null }) + '\\n'); process.exit(0); });`,
      ].join('\n'));
      const env = { ...process.env, LOCAL_MODE: 'true', LOCAL_STORE_PATH: join(dir, 'store.db'), XC1_AUTH: JSON.stringify(auth), XC1_SIGNER: owner.address, TS_NODE_TRANSPILE_ONLY: 'true', TS_NODE_PROJECT: resolve(__dirname, '../../tsconfig.json') };
      const run = () => {
        const out = execFileSync(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), script], { env, cwd: resolve(__dirname, '../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7)) as { ok: boolean; code: string | null };
      };
      expect(run()).toEqual({ ok: true, code: null });
      expect(run()).toEqual({ ok: false, code: 'replayed' });
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* a SQLite handle can linger on Windows */ }
    }
  }, 120_000);

  probe('[XC1-TK-03R-b] two LIVE engine processes on one LOCAL_MODE store must not both accept one owner approval', { main: 'FAIL', fixes: 'FAIL' }, async () => {
    const { tableNonceLedger, setLedger } = requireFixesApi();
    const dir = mkdtempSync(join(tmpdir(), 'xc1-l1-'));
    try {
      const file = join(dir, 'store.db');
      const a = createLocalStore(file); // process A opens the store
      const b = createLocalStore(file); // process B opens it too (a rolling restart, a second worker)
      const { present } = await approval();
      setLedger(tableNonceLedger(() => a));
      expect(await present()).toMatchObject({ ok: true });
      __resetOwnerAuthNonces(); // B has its own process memory
      setLedger(tableNonceLedger(() => b));
      expect(await present()).toMatchObject({ ok: false, code: 'replayed' });
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* lingering handle */ }
    }
  });

  probe('[XC1-TK-03R-c] two live processes on one LOCAL_MODE store: a write from one must not erase the other\'s claims (else a restart re-opens them)', { main: 'FAIL', fixes: 'FAIL' }, async () => {
    const { tableNonceLedger, setLedger } = requireFixesApi();
    const dir = mkdtempSync(join(tmpdir(), 'xc1-l1-'));
    try {
      const file = join(dir, 'store.db');
      const a = createLocalStore(file);
      const b = createLocalStore(file);
      const one = await approval();
      const two = await approval();
      setLedger(tableNonceLedger(() => a));
      expect(await one.present()).toMatchObject({ ok: true }); // A records approval one
      __resetOwnerAuthNonces();
      setLedger(tableNonceLedger(() => b));
      expect(await two.present()).toMatchObject({ ok: true }); // B records approval two, rewriting the table from its stale copy
      __resetOwnerAuthNonces();
      const c = createLocalStore(file); // a restart reads the file
      setLedger(tableNonceLedger(() => c));
      expect(await one.present()).toMatchObject({ ok: false, code: 'replayed' });
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* lingering handle */ }
    }
  });

  probe('[XC1-TK-03R-d] the claim itself on the LOCAL_MODE store: 12 concurrent claims of one (signer, nonce) must yield one "claimed"', { main: 'FAIL', fixes: 'FAIL' }, async () => {
    const { tableNonceLedger } = requireFixesApi();
    const dir = mkdtempSync(join(tmpdir(), 'xc1-l1-'));
    try {
      const store = createLocalStore(join(dir, 'store.db')); // one process's db
      const ledger = tableNonceLedger(() => store);
      const signer = '0x' + 'aa'.repeat(20);
      const nonce = '0x' + '11'.repeat(32);
      const r = await Promise.all(Array.from({ length: 12 }, () => ledger.claim(signer, nonce, NOW + 300)));
      expect(r.filter((x) => x === 'claimed')).toHaveLength(1);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* lingering handle */ }
    }
  });

  probe('[XC1-TK-03R-e] in one process the claim IS atomic: 12 concurrent presentations of a fresh approval give exactly 1 ok, and right after a restart give 0', { main: 'FAIL', fixes: 'PASS' }, async () => {
    const { tableNonceLedger, setLedger } = requireFixesApi();
    const dir = mkdtempSync(join(tmpdir(), 'xc1-l1-'));
    try {
      const file = join(dir, 'store.db');
      const { present } = await approval();
      const before = createLocalStore(file);
      setLedger(tableNonceLedger(() => before));
      const first = await Promise.all(Array.from({ length: 12 }, () => present()));
      expect(first.filter((x) => x.ok)).toHaveLength(1);
      __resetOwnerAuthNonces();
      const reopened = createLocalStore(file); // the restarted process
      setLedger(tableNonceLedger(() => reopened));
      const after = await Promise.all(Array.from({ length: 12 }, () => present()));
      expect(after.filter((x) => x.ok)).toHaveLength(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* lingering handle */ }
    }
  });

  // A loopback stand-in for PostgREST: the table can be absent (404 PGRST205, PostgREST 12's answer)
  // or present with the migration's primary key (a duplicate insert is 409 with code 23505).
  async function postgrest() {
    const state = { tablePresent: false, rows: [] as Array<{ signer: string; nonce: string }> };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const send = (status: number, body?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
      const url = new URL(req.url ?? '/', 'http://x');
      if (!url.pathname.endsWith('/rest/v1/owner_auth_nonces')) return send(404, { code: 'PGRST125', message: 'not found' });
      if (!state.tablePresent) return send(404, { code: 'PGRST205', details: null, hint: null, message: "Could not find the table 'public.owner_auth_nonces' in the schema cache" });
      if (req.method === 'GET') {
        const eqv = (k: string) => (url.searchParams.get(k) ?? '').replace(/^eq\./, '');
        return send(200, state.rows.filter((r) => r.signer === eqv('signer') && r.nonce === eqv('nonce')).map((r) => ({ nonce: r.nonce })));
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const rows = [].concat(JSON.parse(body)) as Array<{ signer: string; nonce: string }>;
        for (const r of rows) {
          if (state.rows.some((x) => x.signer === r.signer && x.nonce === r.nonce)) return send(409, { code: '23505', details: 'Key (signer, nonce) already exists.', hint: null, message: 'duplicate key value violates unique constraint "owner_auth_nonces_pkey"' });
        }
        state.rows.push(...rows);
        send(201);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const client = createClient(`http://127.0.0.1:${port}`, 'dummy-key', { auth: { persistSession: false, autoRefreshToken: false } });
    return { state, client, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  probe('[XC1-TK-03R-f] PROD path, real supabase-js client, table NOT applied: the approval is not_checked (fail closed) and its nonce is not burned; once applied it verifies once, then is replayed', { main: 'FAIL', fixes: 'PASS' }, async () => {
    const { tableNonceLedger, setLedger } = requireFixesApi();
    const pg = await postgrest();
    try {
      setLedger(tableNonceLedger(() => pg.client));
      const { present } = await approval();
      expect(await present()).toMatchObject({ ok: false, code: 'not_checked' });
      expect(await present()).toMatchObject({ ok: false, code: 'not_checked' });
      pg.state.tablePresent = true; // Sean applies the migration
      expect(await present()).toMatchObject({ ok: true });
      __resetOwnerAuthNonces(); // and the engine restarts
      expect(await present()).toMatchObject({ ok: false, code: 'replayed' });
    } finally {
      await pg.close();
    }
  });

  probe('[XC1-TK-03R-g] PROD path across replicas: two concurrent claims of one (signer, nonce) through the real client give one "claimed"; the PK conflict (409/23505) reads as "replayed"', { main: 'FAIL', fixes: 'PASS' }, async () => {
    const { tableNonceLedger } = requireFixesApi();
    const pg = await postgrest();
    try {
      pg.state.tablePresent = true;
      const ledger = tableNonceLedger(() => pg.client);
      const r = await Promise.all(Array.from({ length: 6 }, () => ledger.claim('0x' + 'bb'.repeat(20), '0x' + '22'.repeat(32), NOW + 300)));
      expect(r.filter((x) => x === 'claimed')).toHaveLength(1);
      expect(r.filter((x) => x === 'replayed')).toHaveLength(5);
    } finally {
      await pg.close();
    }
  });
});
