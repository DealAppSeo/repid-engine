/**
 * The DURABLE kernel ledger (KERNEL_LEDGER_BACKEND=supabase, public.kernel_ledger). RT-3/3b/4 are in
 * red-team.test.ts, run once per backend; this file covers what only the durable sink has to get right:
 *   - a restart (a fresh ledger, a fresh deps object) reads the same history, all of it, in order;
 *   - a store it cannot read or write DENIES spends (NOT_CHECKED), loudly, and never reads as empty;
 *   - two replicas over one table cannot fork the chain or overshoot a cap together;
 *   - signed receipts (kernel-receipt/2) read back authentic;
 *   - the env switch: unset is today's file ledger, an unknown value fails closed.
 *
 * No database is reached: fakeLedgerTable stands in for the Supabase client. Owner keys are
 * Wallet.createRandom() and signing keys generateKeyPairSync, in memory for one test.
 */
import { generateKeyPairSync } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createKernelRouter, defaultDeps } from '../../src/routes/kernel';
import { REMOTE_EXECUTION_DOES_NOT_ATTEST, runUnderKernel } from '../../src/kernel/gate';
import { policyHash } from '../../src/kernel/policy';
import { hashArgs, validateReceipt, verifyReceiptAuthenticity } from '../../src/kernel/receipt';
import { LedgerIntegrityError, StoreLedger, createSupabaseStore } from '../../src/kernel/store';
import type { GateDeps } from '../../src/kernel/types';
import { AGENT_ID, fakeLedgerTable, harness, iso, postRequest, signedPolicy, spendRequest } from '../../src/kernel/__tests__/fixtures';

const nth = (i: number) => hashArgs({ resource: 'https://example.invalid/paid', i });
const codes = (r: { reasons: Array<{ code: string }> }) => r.reasons.map((x) => x.code);

const ENV = ['KERNEL_LEDGER_BACKEND', 'KERNEL_RECEIPT_SIGNING_KEY', 'KERNEL_RECEIPT_TRUSTED_SIGNERS'] as const;
const saved: Record<string, string | undefined> = {};
let errors: jest.SpyInstance;
beforeEach(() => {
  ENV.forEach((k) => ((saved[k] = process.env[k]), delete process.env[k]));
  errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  errors.mockRestore();
});

/** An armed harness over a durable table, and a way to start a new process on the same table. */
async function durable(policy: Parameters<typeof signedPolicy>[1] = {}, table = fakeLedgerTable()) {
  const h = harness({ ledger: new StoreLedger(createSupabaseStore(table.client)) });
  await h.deps.ledger.appendPolicy(await signedPolicy(h.owner, policy), iso);
  return { ...h, table, restart: (): GateDeps => ({ ...h.deps, ledger: new StoreLedger(createSupabaseStore(table.client)) }) };
}
function app(deps: GateDeps) {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/kernel', createKernelRouter({ ...deps, decideReserves: true }));
  return a;
}

describe('restart: a new process reads the same ledger', () => {
  it('every record comes back, in order, past a server row cap smaller than the page asked for', async () => {
    const table = fakeLedgerTable({ pageCap: 3 }); // a short page must not read as the end of the ledger
    const s = await durable({ per_tx_raw: '1000000', daily_raw: '99000000', total_raw: '99000000' }, table);
    for (let i = 0; i < 4; i++) expect((await runUnderKernel(spendRequest({ amount_raw: '1000', args_hash: nth(i) }), jest.fn(async () => 1), s.deps)).verdict).toBe('ALLOW');
    expect(table.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]); // policy + 4 x (decision, outcome)
    const fresh = s.restart();
    const latest = (await fresh.ledger.latestPolicy(AGENT_ID))!;
    expect(await fresh.ledger.spentTotals({ agent_id: AGENT_ID, policy_hash: policyHash(latest.policy), since_s: 0 })).toEqual({ daily_raw: '4000', total_raw: '4000' });
    expect((await fresh.ledger.findReceipts('00000000-0000-4000-8000-000000000004')).map((r) => r.decision.executed)).toEqual([false, true]);
    // The new process appends after the last row it read, and the chain continues from that tip.
    expect((await runUnderKernel(spendRequest({ amount_raw: '1000', args_hash: nth(9) }), jest.fn(async () => 1), fresh)).verdict).toBe('ALLOW');
    expect(table.rows.map((r) => r.seq).slice(-2)).toEqual([10, 11]);
  });

  it('a missing row (a gap in seq) refuses the whole ledger: a deleted policy or spend is never read as absent', async () => {
    const s = await durable({ per_tx_raw: '1000000' });
    await runUnderKernel(spendRequest({ amount_raw: '1000' }), jest.fn(async () => 1), s.deps);
    s.table.rows.splice(0, 1); // the policy row, deleted out from under the ledger
    const fresh = s.restart();
    await expect(fresh.ledger.latestPolicy(AGENT_ID)).rejects.toBeInstanceOf(LedgerIntegrityError);
    const tool = jest.fn(async () => 'paid');
    const out = await runUnderKernel(spendRequest({ amount_raw: '1000', args_hash: nth(2) }), tool, fresh);
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(tool).not.toHaveBeenCalled();
  });
});

describe('store unreachable: spends are denied, loudly, never read as an empty history', () => {
  it('unreachable at boot: a spend is NOT_CHECKED and the tool never runs; /decide refuses; /policy is 503; the error is logged', async () => {
    const s = await durable({ per_tx_raw: '1000000' });
    s.table.state.down = true;
    const fresh = s.restart();
    const tool = jest.fn(async () => 'paid');
    const out = await runUnderKernel(spendRequest({ amount_raw: '1000', args_hash: nth(1) }), tool, fresh);
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(out.executed).toBe(false);
    expect(tool).not.toHaveBeenCalled();
    const decide = await request(app(fresh)).post('/api/v1/kernel/decide').send(spendRequest({ amount_raw: '1000', args_hash: nth(2) }));
    expect(decide.body.verdict).toBe('NOT_CHECKED');
    expect(decide.body.persisted).toBe(false);
    const policy = await request(app(fresh)).post('/api/v1/kernel/policy').send(await signedPolicy(s.owner, { nonce: '9' }));
    expect(policy.status).toBe(503);
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/kernel ledger store \(kernel_ledger\) read failed.*spends are refused/);
  });

  it('unreachable after boot: the write fails, the tool never runs, and the ledger re-reads when the store is back', async () => {
    const s = await durable({ per_tx_raw: '1000000', daily_raw: '1000000' });
    s.table.state.down = true;
    const tool = jest.fn(async () => 'paid');
    const out = await runUnderKernel(spendRequest({ amount_raw: '1000000', args_hash: nth(1) }), tool, s.deps);
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(codes(out)).toContain('receipt_write_failed');
    expect(tool).not.toHaveBeenCalled();
    s.table.state.down = false;
    expect((await runUnderKernel(spendRequest({ amount_raw: '1000000', args_hash: nth(2) }), tool, s.deps)).verdict).toBe('ALLOW');
    expect((await runUnderKernel(spendRequest({ amount_raw: '1', args_hash: nth(3) }), tool, s.deps)).verdict).toBe('DENY');
    expect(tool).toHaveBeenCalledTimes(1);
  });
});

describe('two replicas over one table', () => {
  it('cannot overshoot the daily cap between them: a write from a stale replica collides on seq, is refused, and the replica re-reads', async () => {
    const s = await durable({ per_tx_raw: '1000000', daily_raw: '2000000', total_raw: '99000000' });
    const a = s.deps;
    const b = s.restart();
    await b.ledger.latestPolicy(AGENT_ID); // B has read the ledger: its view is now the one before A's spend
    const tool = jest.fn(async () => 'paid');
    expect((await runUnderKernel(spendRequest({ amount_raw: '1000000', args_hash: nth(1) }), tool, a)).verdict).toBe('ALLOW');
    const stale = await runUnderKernel(spendRequest({ amount_raw: '1000000', args_hash: nth(2) }), tool, b);
    expect(stale.verdict).toBe('NOT_CHECKED'); // B decided on a stale view; the primary key refused its row
    expect(codes(stale)).toContain('receipt_write_failed');
    expect((await runUnderKernel(spendRequest({ amount_raw: '1000000', args_hash: nth(3) }), tool, b)).verdict).toBe('ALLOW'); // re-read: 1,000,000 left
    expect((await runUnderKernel(spendRequest({ amount_raw: '1000000', args_hash: nth(4) }), tool, a)).verdict).not.toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(2); // 2,000,000 / 1,000,000
  });
});

describe('/decide under the durable backend', () => {
  it('a spend ALLOW is a reservation: persisted, chained, says the kernel did not run it, and is listed as indeterminate', async () => {
    const s = await durable({ per_tx_raw: '1000000' });
    const res = await request(app(s.deps)).post('/api/v1/kernel/decide').send(spendRequest({ amount_raw: '1000' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verdict: 'ALLOW', blocking: false, persisted: true, runnable: false });
    const r = res.body.receipt;
    expect(validateReceipt(r, { persisted_decision_ids: new Set([r.header.receipt_id]) })).toEqual({ ok: true });
    expect(r.decision.executed).toBe(false);
    expect(r.decision.does_not_attest).toContain(REMOTE_EXECUTION_DOES_NOT_ATTEST);
    const fresh = s.restart();
    expect(await fresh.ledger.findReceipts(r.header.receipt_id)).toEqual([r]);
    expect(await (fresh.ledger as StoreLedger).indeterminate()).toEqual([r.header.receipt_id]);
    // The same payment effect cannot be reserved twice (one-use authorization).
    const again = await request(app(fresh)).post('/api/v1/kernel/decide').send(spendRequest({ amount_raw: '1000' }));
    expect(again.body.verdict).toBe('DENY');
    expect(again.body.persisted).toBe(false);
  });

  it('a refusal writes nothing, and anything other than a spend stays the dry preview', async () => {
    const s = await durable({ per_tx_raw: '0' });
    const before = s.table.rows.length;
    const deny = await request(app(s.deps)).post('/api/v1/kernel/decide').send(spendRequest({ amount_raw: '1000' }));
    expect(deny.body).toMatchObject({ verdict: 'DENY', persisted: false });
    const post = await request(app(s.deps)).post('/api/v1/kernel/decide').send(postRequest());
    expect(post.body.persisted).toBe(false);
    expect(post.body.receipt_preview).not.toBeNull();
    expect(s.table.rows.length).toBe(before);
  });
});

describe('signed receipts (kernel-receipt/2) on the durable path', () => {
  it('a receipt sealed with KERNEL_RECEIPT_SIGNING_KEY reads back from the table authentic, after a restart', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env['KERNEL_RECEIPT_SIGNING_KEY'] = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    process.env['KERNEL_RECEIPT_TRUSTED_SIGNERS'] = `0x${Buffer.from(String(publicKey.export({ format: 'jwk' }).x), 'base64url').toString('hex')}`;
    const s = await durable({ per_tx_raw: '1000000' });
    const out = await runUnderKernel(spendRequest({ amount_raw: '1000' }), jest.fn(async () => 1), s.deps);
    expect(out.decision_receipt!.header.schema).toBe('kernel-receipt/2');
    const back = await s.restart().ledger.findReceipts(out.decision_receipt!.header.receipt_id);
    expect(back.map((r) => verifyReceiptAuthenticity(r).status)).toEqual(['AUTHENTIC', 'AUTHENTIC']);
    expect(back[0]).toEqual(out.decision_receipt);
  });
});

describe('KERNEL_LEDGER_BACKEND', () => {
  it('unset: today exactly (the file ledger, /decide a dry preview)', () => {
    const d = defaultDeps();
    expect(d.decideReserves).toBeUndefined();
    expect(d.ledger).toBeInstanceOf(StoreLedger);
  });
  it('"supabase": the durable ledger, and /decide reserves', () => {
    process.env['KERNEL_LEDGER_BACKEND'] = 'supabase';
    jest.spyOn(console, 'warn').mockImplementationOnce(() => undefined);
    const d = defaultDeps();
    expect(d.decideReserves).toBe(true);
    expect(d.ledger).toBeInstanceOf(StoreLedger);
  });
  it('anything else fails closed: every ledger read throws (a typo must not quietly mean "ephemeral"), and it says so', async () => {
    process.env['KERNEL_LEDGER_BACKEND'] = 'supabse';
    const d = defaultDeps();
    await expect(d.ledger.latestPolicy(AGENT_ID)).rejects.toThrow(/KERNEL_LEDGER_BACKEND/);
    expect(errors).toHaveBeenCalled();
  });
});
