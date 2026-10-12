/**
 * POST /decide, POST /policy, GET /receipt/:id — over a real Express app, with an in-memory ledger.
 * The properties that matter are the refusals, again: a dry decision writes nothing, a policy from
 * anyone but the accountable owner is not recorded, and a ledger that cannot be read is a 503, not
 * a 404.
 */
import { Wallet } from 'ethers';
import express from 'express';
import request from 'supertest';
import { createKernelRouter } from '../../routes/kernel';
import { runUnderKernel } from '../gate';
import { POLICY_DOMAIN, POLICY_TYPES, ownerEvidenceFromRoot, policyTypedValue } from '../policy';
import { validateReceipt } from '../receipt';
import type { GateDeps, KernelLedger } from '../types';
import { AGENT_ID, NOW_S, harness, iso, signedPolicy, spendRequest } from './fixtures';

function appWith(deps: GateDeps) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/kernel', createKernelRouter(deps));
  return app;
}

const receiptCount = (h: ReturnType<typeof harness>) => h.sink.records.filter((r) => r.kind === 'receipt').length;
const policyCount = (h: ReturnType<typeof harness>) => h.sink.records.filter((r) => r.kind === 'policy').length;

describe('POST /api/v1/kernel/decide (dry)', () => {
  it('a body the kernel will not read is 400 DENY, and echoes the NAME of the offending key only', async () => {
    const h = harness();
    const res = await request(appWith(h.deps)).post('/api/v1/kernel/decide').send({ ...spendRequest(), prompt: 'LEAKED-PROMPT-TEXT' });
    expect(res.status).toBe(400);
    expect(res.body.verdict).toBe('DENY');
    expect(res.body.persisted).toBe(false);
    expect(JSON.stringify(res.body)).toContain('prompt');
    expect(JSON.stringify(res.body)).not.toContain('LEAKED-PROMPT-TEXT');
  });

  it('with no policy on record: 200, DENY(policy_missing), nothing written', async () => {
    const h = harness();
    const res = await request(appWith(h.deps)).post('/api/v1/kernel/decide').send(spendRequest());
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('DENY');
    expect(res.body.blocking).toBe(true);
    expect(res.body.persisted).toBe(false);
    expect(res.body.reasons.map((r: { code: string }) => r.code)).toContain('policy_missing');
    expect(receiptCount(h)).toBe(0);
    // The preview is a well-formed, valid receipt — and says so by being unchained.
    expect(validateReceipt(res.body.receipt_preview)).toEqual({ ok: true });
    expect(res.body.receipt_preview.header.prev_hash).toBeNull();
    expect(res.body.receipt_preview.decision.executed).toBe(false);
  });

  it('with a good policy: 200 ALLOW — and STILL nothing is written or run', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const res = await request(appWith(h.deps)).post('/api/v1/kernel/decide').send(spendRequest());
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('ALLOW');
    expect(res.body.persisted).toBe(false);
    expect(receiptCount(h)).toBe(0);
  });

  it('a policy store that cannot be read is 200 NOT_CHECKED, which the client must treat as a refusal', async () => {
    const h = harness({ policySource: { latest: async () => { throw new Error('down'); } } });
    const res = await request(appWith(h.deps)).post('/api/v1/kernel/decide').send(spendRequest());
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('NOT_CHECKED');
    expect(res.body.blocking).toBe(true);
  });
});

describe('POST /api/v1/kernel/policy', () => {
  const body = async (h: ReturnType<typeof harness>, over = {}) => await signedPolicy(h.owner, over);

  it('records a policy the accountable owner signed, and says which limits it left at zero', async () => {
    const h = harness();
    const s = await body(h);
    const { per_tx_raw: _a, daily_raw: _b, total_raw: _c, ...noLimits } = s.policy;
    // re-sign the version with the limits omitted: "omitted" is what the owner signed as "0"
    const signature = await h.owner.signTypedData(POLICY_DOMAIN, POLICY_TYPES, policyTypedValue({ ...noLimits, per_tx_raw: '0', daily_raw: '0', total_raw: '0' }));
    const res = await request(appWith(h.deps)).post('/api/v1/kernel/policy').send({ policy: noLimits, signature });
    expect(res.status).toBe(201);
    expect(res.body.limits_defaulted_to_zero).toEqual(['per_tx_raw', 'daily_raw', 'total_raw']);
    expect(policyCount(h)).toBe(1);
  });

  it('a valid signature from someone who is NOT the accountable owner is 403 and is not recorded', async () => {
    const h = harness();
    const stranger = Wallet.createRandom();
    const res = await request(appWith(h.deps)).post('/api/v1/kernel/policy').send(await signedPolicy(stranger));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('signer_not_owner');
    expect(policyCount(h)).toBe(0);
  });

  it('a policy over the owner\'s name with a signature that is not theirs is 403', async () => {
    const h = harness();
    const impostor = Wallet.createRandom();
    const res = await request(appWith(h.deps)).post('/api/v1/kernel/policy').send(await signedPolicy(impostor, { claimedOwner: h.owner.address }));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('bad_signature');
    expect(policyCount(h)).toBe(0);
  });

  it('an agent nobody answers for cannot be given a policy (403); an owner that cannot be established is 503, not 403', async () => {
    const none = harness({ resolveOwner: async () => ({ status: 'none', wallet: null, assurance: null }) });
    expect((await request(appWith(none.deps)).post('/api/v1/kernel/policy').send(await signedPolicy(none.owner))).status).toBe(403);
    const unknown = harness({ resolveOwner: async () => { throw new Error('db down'); } });
    const res = await request(appWith(unknown.deps)).post('/api/v1/kernel/policy').send(await signedPolicy(unknown.owner));
    expect(res.status).toBe(503);
    expect(policyCount(unknown)).toBe(0);
  });

  it('an unreachable chain for the signature check is 503 (NOT_CHECKED), not a verdict on the signature', async () => {
    const h = harness({ chain: { getCode: async () => { throw new Error('rpc'); }, call: async () => { throw new Error('rpc'); } } });
    const impostor = Wallet.createRandom();
    const res = await request(appWith(h.deps)).post('/api/v1/kernel/policy').send(await signedPolicy(impostor, { claimedOwner: h.owner.address }));
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('signature_not_checked');
    expect(policyCount(h)).toBe(0);
  });

  it('is strict about the body, refuses an already-expired policy, and enforces a rising nonce', async () => {
    const h = harness();
    const app = appWith(h.deps);
    const good = await body(h, { nonce: '5' });
    expect((await request(app).post('/api/v1/kernel/policy').send({ ...good, extra: 1 })).status).toBe(400);
    expect((await request(app).post('/api/v1/kernel/policy').send({ policy: { ...good.policy, per_tx_raw: '-1' }, signature: good.signature })).status).toBe(400);
    expect((await request(app).post('/api/v1/kernel/policy').send(await body(h, { expires_at: NOW_S - 1 }))).status).toBe(400);
    expect((await request(app).post('/api/v1/kernel/policy').send(good)).status).toBe(201);
    expect((await request(app).post('/api/v1/kernel/policy').send(good)).status).toBe(409); // replay
    expect((await request(app).post('/api/v1/kernel/policy').send(await body(h, { nonce: '4' }))).status).toBe(409); // older
    expect((await request(app).post('/api/v1/kernel/policy').send(await body(h, { nonce: '6', per_tx_raw: '0' }))).status).toBe(201);
    expect(policyCount(h)).toBe(2);
  });

  it('end to end: set a zero-limit policy over HTTP, then the dry decision refuses a spend', async () => {
    const h = harness();
    const app = appWith(h.deps);
    expect((await request(app).post('/api/v1/kernel/policy').send(await body(h, { per_tx_raw: '0' }))).status).toBe(201);
    const res = await request(app).post('/api/v1/kernel/decide').send(spendRequest({ amount_raw: 10000 }));
    expect(res.body.verdict).toBe('DENY');
    expect(res.body.reasons.map((r: { code: string }) => r.code)).toContain('spend_limit_zero');
  });
});

describe('GET /api/v1/kernel/receipt/:id', () => {
  it('404 for a call the ledger has not seen; 400 for an id that is not one', async () => {
    const h = harness();
    const app = appWith(h.deps);
    expect((await request(app).get('/api/v1/kernel/receipt/00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
    expect((await request(app).get('/api/v1/kernel/receipt/..%2Fetc').send()).status).toBe(400);
  });

  it('returns the latest entry for the call and the hashes of all of them', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const out = await runUnderKernel(spendRequest(), async () => 'ok', h.deps);
    const id = out.decision_receipt!.header.receipt_id;
    const res = await request(appWith(h.deps)).get(`/api/v1/kernel/receipt/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.receipt.decision.executed).toBe(true);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries.map((e: { executed: boolean }) => e.executed)).toEqual([false, true]);
  });

  it('a ledger that cannot be read is 503, not 404: unreadable is not absent', async () => {
    const h = harness();
    const broken: KernelLedger = {
      appendReceipt: (b) => h.ledger.appendReceipt(b),
      appendPolicy: (p, t) => h.ledger.appendPolicy(p, t),
      latestPolicy: (s) => h.ledger.latestPolicy(s),
      spentTotals: (q) => h.ledger.spentTotals(q),
      findReceipts: async () => { throw new Error('EIO'); },
    };
    const res = await request(appWith({ ...h.deps, ledger: broken })).get(`/api/v1/kernel/receipt/${AGENT_ID}`);
    expect(res.status).toBe(503);
  });
});

describe('ownerEvidenceFromRoot flattens accountable-root\'s tri-state', () => {
  it('resolved / none / unknown', () => {
    expect(ownerEvidenceFromRoot({ ok: true, root: { kind: 'owner', agentId: 'a', wallet: '0x000000000000000000000000000000000000dEaD', assurance: 'wallet-proven', subjectId: 'a', via: 'own-binding', grantPath: [] } })).toMatchObject({ status: 'resolved', assurance: 'wallet-proven' });
    for (const code of ['no_root', 'not_found', 'not_grantee', 'chain_dead', 'cycle', 'too_deep'] as const) {
      expect(ownerEvidenceFromRoot({ ok: false, code, message: 'x' }).status).toBe('none');
    }
    for (const code of ['not_checked', 'ambiguous'] as const) {
      expect(ownerEvidenceFromRoot({ ok: false, code, message: 'x' }).status).toBe('unknown');
    }
  });
});
