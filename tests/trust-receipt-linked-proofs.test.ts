/**
 * E1: the receipt lists the proofs minted for its exchange, and each one is checkable with no key.
 *
 * Two exact links, no time-window guessing:
 *   - repid_zkp_proofs.contract_id = the contract (proofs drained after the 2026-10-16 enqueue fix);
 *   - repid_score_events.zk_proof_id = repid_zkp_proofs.job_id (every earlier proof: on 2026-10-16
 *     prod had 68 such proofs for 17 contracts and 0 of them carried contract_id).
 */
const C = 'c0ffee00-0000-4000-8000-000000000001';
const PROVIDER = 'prov-0000-0000-0000-000000000001';
const BUYER = 'buyer-000-0000-0000-000000000001';
const JOB_EVENT = '94e855e0-0000-4000-8000-00000000aaaa'; // linked only through the score event
const JOB_CONTRACT = '94e855e0-0000-4000-8000-00000000bbbb'; // linked only through contract_id
const JOB_OTHER = '94e855e0-0000-4000-8000-00000000cccc'; // a real proof for some other contract
const WSH = '0x' + 'd9'.repeat(32);
const STATEMENT = { agent_id: PROVIDER, tier: 'ESTABLISHED', repid_score: 1371, threshold: 999 };

type Row = Record<string, unknown>;
const g = global as any;

let nextId = 1;
function proof(job: string, over: Row = {}): Row {
  return {
    id: nextId++, job_id: job, agent_id: PROVIDER, scheme: 'plonky3_range_check', is_real: true,
    statement: STATEMENT, eas_attestation_uid: '0x' + 'ea'.repeat(32), work_statement_hash: null,
    created_at: '2026-10-15T12:00:05Z', proof_bytes: 'UFJPT0Y=', contract_id: null, ...over,
  };
}

function seed() {
  g.__tr = {
    service_contracts: [{
      id: C, status: 'settled', agreed_price_usdc_raw: 100000, buyer_agent_id: BUYER, provider_agent_id: PROVIDER,
      settled_at: '2026-10-15T12:00:10Z', fulfilled_at: '2026-10-15T12:00:01Z', work_statement_hash: WSH,
    }],
    repid_agents: [{ id: BUYER, agent_name: 'trinity-nexus' }, { id: PROVIDER, agent_name: 'trinity-apm' }],
    x402_settlements: [],
    a2a_awards: [],
    erc8004_reputation_writes: [],
    repid_score_events: [
      { contract_id: C, agent_id: PROVIDER, event_type: 'SERVICE_FULFILLED', delta: 15, repid_before: 1356, repid_after: 1371, metadata: {}, zk_proof_id: JOB_EVENT },
      { contract_id: C, agent_id: PROVIDER, event_type: 'SERVICE_SATISFIED', delta: 15, repid_before: 1371, repid_after: 1371, metadata: {}, zk_proof_id: null },
    ],
    repid_zkp_proofs: [
      proof(JOB_EVENT),
      proof(JOB_CONTRACT, { contract_id: C, work_statement_hash: WSH, created_at: '2026-10-15T12:00:09Z' }),
      proof(JOB_OTHER, { contract_id: 'some-other-contract' }),
    ],
  };
}

// A table-aware fake: eq/in filter rows, order/limit apply, maybeSingle returns the first.
jest.mock('../src/db', () => {
  const q = (table: string) => {
    let rows: Row[] = [...(((global as any).__tr?.[table] ?? []) as Row[])];
    const c: any = {
      select: () => c,
      eq: (k: string, v: unknown) => { rows = rows.filter((r) => r[k] === v); return c; },
      in: (k: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[k])); return c; },
      not: () => c,
      order: (k: string, o?: { ascending?: boolean }) => {
        rows.sort((a, b) => String(a[k] ?? '').localeCompare(String(b[k] ?? '')) * (o?.ascending === false ? -1 : 1));
        return c;
      },
      limit: (n: number) => { rows = rows.slice(0, n); return c; },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: rows, error: null }).then(res, rej),
    };
    return c;
  };
  return { db: { from: (t: string) => q(t) } };
});

const mockVerifyCalls: Array<[string, Row]> = [];
jest.mock('../src/zkp/range-check-verify', () => ({
  verifyRangeCheck: (bytes: string, statement: Row) => {
    mockVerifyCalls.push([bytes, statement]);
    return { verified: true, error: null, proof_size_bytes: 5, verifier_version: 'test', scheme: 'plonky3_range_check' };
  },
}));

import express from 'express';
import request from 'supertest';
import { buildTrustReceipt } from '../src/services/trust-receipt';
import receiptRouter, { PROOF_CHECK_LIMIT_PER_MIN } from '../src/routes/v1/receipt-public';

const app = express().use('/api/v1', receiptRouter);

beforeEach(() => { seed(); mockVerifyCalls.length = 0; });

describe('receipt lists the proofs linked to its exchange', () => {
  it('finds a proof through its score event even though the proof row has no contract_id', async () => {
    const r = await buildTrustReceipt(C);
    const jobs = r!.zk_proofs.map((p) => p.job_id);
    expect(jobs).toEqual([JOB_EVENT, JOB_CONTRACT]); // oldest first; JOB_OTHER excluded
    expect(r!.zk_proofs[0]).toMatchObject({
      agent: 'trinity-apm', scheme: 'plonky3_range_check', is_real: true, statement: STATEMENT,
      eas_attestation_uid: '0x' + 'ea'.repeat(32), work_statement_hash: null,
      proof_url: `/api/v1/receipt/${C}/proof/${JOB_EVENT}`,
    });
    expect(r!.zk_proofs[1]!.work_statement_hash).toBe(WSH);
  });

  it('never publishes the proof bytes in the receipt itself', async () => {
    expect(JSON.stringify(await buildTrustReceipt(C))).not.toContain('UFJPT0Y=');
  });

  it('a retried job with two proof rows is listed once, newest row', async () => {
    g.__tr.repid_zkp_proofs.push(proof(JOB_EVENT, { id: 99, created_at: '2026-10-15T12:00:07Z', eas_attestation_uid: '0xnewer' }));
    const r = await buildTrustReceipt(C);
    const ev = r!.zk_proofs.filter((p) => p.job_id === JOB_EVENT);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.eas_attestation_uid).toBe('0xnewer');
  });

  it('no linked proof: an empty list, not someone else\'s proof', async () => {
    g.__tr.repid_score_events = [];
    g.__tr.repid_zkp_proofs = [proof(JOB_OTHER, { contract_id: 'some-other-contract' })];
    expect((await buildTrustReceipt(C))!.zk_proofs).toEqual([]);
  });

  it('the HTML page lists each proof with a verify link', async () => {
    const res = await request(app).get(`/api/v1/receipt/${C}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`href="/api/v1/receipt/${C}/proof/${JOB_EVENT}"`);
    expect(res.text).toContain(`href="/api/v1/receipt/${C}/proof/${JOB_CONTRACT}"`);
  });
});

describe('GET /receipt/:id/proof/:job — keyless proof check', () => {
  it('serves the bytes, the statement and a server-side verification, with no API key', async () => {
    const res = await request(app).get(`/api/v1/receipt/${C}/proof/${JOB_EVENT}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      contract_id: C, job_id: JOB_EVENT, scheme: 'plonky3_range_check', statement: STATEMENT,
      proof_bytes: 'UFJPT0Y=', verification: { verified: true },
    });
    expect(mockVerifyCalls).toEqual([['UFJPT0Y=', STATEMENT]]);
  });

  it('refuses a real proof that belongs to a different contract', async () => {
    const res = await request(app).get(`/api/v1/receipt/${C}/proof/${JOB_OTHER}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('proof_not_linked');
    expect(mockVerifyCalls).toHaveLength(0);
  });

  it('404s an unknown contract', async () => {
    expect((await request(app).get(`/api/v1/receipt/nope/proof/${JOB_EVENT}`)).status).toBe(404);
  });

  it('a row with no bytes is reported unverified, not passed', async () => {
    g.__tr.repid_zkp_proofs[0] = proof(JOB_EVENT, { proof_bytes: null });
    const res = await request(app).get(`/api/v1/receipt/${C}/proof/${JOB_EVENT}`);
    expect(res.status).toBe(200);
    expect(res.body.verification.verified).toBe(false);
    expect(mockVerifyCalls).toHaveLength(0);
  });
});

// LAST in the file: it spends this router's per-IP budget.
describe('the keyless proof check is rate-limited per network address', () => {
  it(`answers 429 after ${PROOF_CHECK_LIMIT_PER_MIN} calls a minute`, async () => {
    const url = `/api/v1/receipt/${C}/proof/${JOB_EVENT}`;
    const ip = { 'X-Real-IP': '203.0.113.7' };
    for (let i = 0; i < PROOF_CHECK_LIMIT_PER_MIN; i++) expect((await request(app).get(url).set(ip)).status).toBe(200);
    expect((await request(app).get(url).set(ip)).status).toBe(429);
    // Another address is unaffected.
    expect((await request(app).get(url).set({ 'X-Real-IP': '203.0.113.8' })).status).toBe(200);
  });
});
