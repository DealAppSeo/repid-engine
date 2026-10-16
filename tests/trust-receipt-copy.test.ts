/**
 * The public receipt page may only say what its data says. Pinned against the real conditions of
 * the daily receipts measured 2026-10-16 (E2E_RUN_2026-10-16 breaks #1, #2):
 *   - validators were `trinity-mock-*` on 14 of 16, no validator had a recorded model family, and on
 *     e12e52c7 the provider (trinity-shofet) was one of its own validators;
 *   - no proof was linked, yet step 8 said "This proof is bound to THIS work";
 *   - step 7 was dropped when there was no proof, so the page went 6 -> 8.
 */
type Row = Record<string, unknown>;
const g = global as any;

jest.mock('../src/db', () => {
  const q = (table: string) => {
    let rows: Row[] = [...(((global as any).__rc?.[table] ?? []) as Row[])];
    const c: any = {
      select: () => c,
      eq: (k: string, v: unknown) => { rows = rows.filter((r) => r[k] === v); return c; },
      in: (k: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[k])); return c; },
      not: () => c, order: () => c, limit: () => c,
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: rows, error: null }).then(res, rej),
    };
    return c;
  };
  return { db: { from: (t: string) => q(t) } };
});

const mockBuild = jest.fn();
jest.mock('../src/services/trust-receipt', () => ({
  ...jest.requireActual('../src/services/trust-receipt'),
  buildTrustReceipt: (...a: unknown[]) => mockBuild(...a),
}));

import express from 'express';
import request from 'supertest';
import type { TrustReceipt } from '../src/services/trust-receipt';
import receiptRouter from '../src/routes/v1/receipt-public';

const realBuild = (jest.requireActual('../src/services/trust-receipt') as typeof import('../src/services/trust-receipt')).buildTrustReceipt;
const app = express().use('/api/v1', receiptRouter);
const WSH = '0x' + 'd9'.repeat(32);
const C = 'e12e52c7-0000-4000-8000-000000000001';

/** The shape of a 2026-10-15 daily receipt: settled, paid after delivery, 6 reputation rows, no proof. */
function receipt(over: Partial<TrustReceipt> = {}): TrustReceipt {
  return {
    contract_id: C, settled_at: '2026-10-15T12:00:10Z', price_usdc: '$0.10', price_raw: 100000,
    buyer: 'trinity-nexus', provider: 'trinity-apm', negotiated: false, competing_bids: null,
    won_on_price: null, uncontested: null, settlement_tx: '0xsettle', settlement_url: 'https://sepolia.basescan.org/tx/0xsettle',
    is_simulated: false, payer_wallet: null, payee_wallet: null, wallets_source: null, paid_before_delivery: false,
    reputation_events: [{ agent: 'trinity-apm', event: 'SERVICE_FULFILLED', delta: 15, from: 1356, to: 1371, decay: null }],
    onchain_tx: '0xrep', onchain_url: 'https://sepolia.basescan.org/tx/0xrep', onchain_repid: 1371, onchain_link_is_proven: true,
    zk_proofs: [], work_statement_hash: WSH, work_statement: null, criterion_ratings: null, buyer_satisfaction_score: null,
    validators: { families: [], includes_provider: false }, caveats: [],
    ...over,
  };
}
const page = async (r: TrustReceipt) => {
  mockBuild.mockResolvedValue(r);
  const res = await request(app).get(`/api/v1/receipt/${C}`);
  expect(res.status).toBe(200);
  return res.text as string;
};
const stepNumbers = (html: string) => [...html.matchAll(/<div class="n">(\d+)<\/div>/g)].map((m) => Number(m[1]));
const proof = (wsh: string | null) =>
  ({ scheme: 'plonky3_range_check', is_real: true, statement: {}, work_statement_hash: wsh }) as unknown as TrustReceipt['zk_proofs'][number];

describe('step 3: who checked the work', () => {
  it('mock validators with no recorded family: no claim of different model families', async () => {
    const html = await page(receipt());
    expect(html).not.toContain('deliberately different model families');
    expect(html).not.toContain('someone who did not do it');
    expect(html).toContain('No validator model family is recorded, so this receipt does not claim the validators were independent');
  });

  it('prints the recorded families when there are two or more', async () => {
    const html = await page(receipt({ validators: { families: ['anthropic', 'openai'], includes_provider: false } }));
    expect(html).toContain('Recorded model families of the validators: anthropic, openai.');
  });

  it('all validators on one model: says so, and does not call them different', async () => {
    const html = await page(receipt({ validators: { families: ['llama'], includes_provider: false } }));
    expect(html).toContain('Only one validator model family is recorded: llama.');
    expect(html).not.toContain('different model families');
  });

  it('the provider among its own validators (e12e52c7): the title says so', async () => {
    const html = await page(receipt({ validators: { families: [], includes_provider: true } }));
    expect(html).toContain('the provider was one of its own validators');
    expect(html).not.toContain('validators other than the provider');
  });

  it('no validator record: no claim at all', async () => {
    const html = await page(receipt({ validators: null }));
    expect(html).toContain('This exchange records no validators');
  });
});

describe('steps are numbered in the order shown, with no gap', () => {
  it('no proof (every daily receipt before E1): 1..7, not 1..6 then 8', async () => {
    expect(stepNumbers(await page(receipt()))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('nothing optional present: 1..4', async () => {
    const html = await page(receipt({ reputation_events: [], onchain_url: null, onchain_tx: null, work_statement_hash: null }));
    expect(stepNumbers(html)).toEqual([1, 2, 3, 4]);
  });

  it('everything present: 1..8', async () => {
    expect(stepNumbers(await page(receipt({ zk_proofs: [proof(WSH)] })))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('step 8: a proof is tied to this work only when one is', () => {
  it('no proof listed: no "bound"/"recorded against" claim, and the page says no proof carries the hash', async () => {
    const html = await page(receipt());
    expect(html).not.toContain('This proof is bound to THIS work');
    expect(html).not.toContain('recorded against THIS work');
    expect(html).toContain('No proof on this receipt is recorded against this hash.');
    expect(html).toContain(WSH); // the hash itself is still published, so it can be recomputed
  });

  it('a listed proof with a DIFFERENT hash does not earn the claim', async () => {
    const html = await page(receipt({ zk_proofs: [proof('0x' + 'aa'.repeat(32))] }));
    expect(html).not.toContain('recorded against THIS work');
    expect(html).not.toContain('bound to THIS work');
  });

  it('a listed proof with no hash (proofs minted before E1) does not earn it either', async () => {
    const html = await page(receipt({ zk_proofs: [proof(null)] }));
    expect(html).not.toContain('recorded against THIS work');
    expect(html).not.toContain('bound to THIS work');
  });

  it('a listed proof carrying this exact hash: says so, and says what it does NOT prove', async () => {
    const html = await page(receipt({ zk_proofs: [proof(WSH)] }));
    expect(html).toContain('This proof is recorded against THIS work');
    expect(html).toContain('It does not commit to this hash');
    expect(html).not.toContain('This proof is bound to THIS work');
  });
});

describe('the validators record is derived from the contract, families only', () => {
  const PROVIDER = 'prov-1';
  const seed = (validators: unknown, agents: Row[]) => {
    g.__rc = {
      service_contracts: [{
        id: C, status: 'settled', agreed_price_usdc_raw: 100000, buyer_agent_id: 'buyer-1', provider_agent_id: PROVIDER,
        validators, result: { answer: 'CONFIDENTIAL-ANSWER' },
      }],
      repid_agents: [{ id: 'buyer-1', agent_name: 'trinity-nexus' }, { id: PROVIDER, agent_name: 'trinity-shofet', model_family: null }, ...agents],
    };
  };

  it('the live case: mock validators, no family recorded', async () => {
    seed(['MEDIATOR', 'trinity-mock-it-buyer-1782521963794'], [
      { agent_name: 'MEDIATOR', model_family: null }, { agent_name: 'trinity-mock-it-buyer-1782521963794', model_family: null },
    ]);
    const r = await realBuild(C);
    expect(r!.validators).toEqual({ families: [], includes_provider: false });
  });

  it('the provider among its validators, families deduped and sorted, names not published', async () => {
    seed(['MEDIATOR', 'HUMAN', 'trinity-shofet'], [
      { agent_name: 'MEDIATOR', model_family: 'openai' }, { agent_name: 'HUMAN', model_family: 'anthropic' },
      { agent_name: 'HUMAN', model_family: 'openai' },
    ]);
    const r = await realBuild(C);
    expect(r!.validators).toEqual({ families: ['anthropic', 'openai'], includes_provider: true });
    const json = JSON.stringify(r);
    expect(json).not.toContain('MEDIATOR');
    expect(json).not.toContain('CONFIDENTIAL-ANSWER');
  });

  it('no validators key on the result: null, not an empty "checked" record', async () => {
    seed(null, []);
    expect((await realBuild(C))!.validators).toBeNull();
  });
});
