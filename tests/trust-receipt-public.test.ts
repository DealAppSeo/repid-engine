/**
 * The public receipt must be shareable AND must never leak the work.
 *
 * This endpoint is unauthenticated on purpose — "you can check this without
 * trusting us" is the entire argument, and a receipt behind an API key does not
 * make it. That makes the privacy boundary load-bearing: everything served is
 * either already on-chain and world-readable, or a fact ABOUT the exchange.
 * The contract `payload` (what someone asked) and `result` (what they paid for)
 * are neither, and must never appear.
 */
import { buildTrustReceipt } from '../src/services/trust-receipt';

const SECRET_PAYLOAD = 'CONFIDENTIAL-QUESTION-DO-NOT-PUBLISH';
const SECRET_RESULT = 'CONFIDENTIAL-ANSWER-DO-NOT-PUBLISH';

const rows: Record<string, unknown> = {
  service_contracts: {
    id: 'c1', status: 'settled', agreed_price_usdc_raw: 100000,
    buyer_agent_id: 'buyer-1', provider_agent_id: 'prov-1', settled_at: '2026-08-01T00:00:00Z',
    // Present on the real row. If a future edit widens the select, these must
    // still not reach the response.
    payload: { question: SECRET_PAYLOAD }, result: { answer: SECRET_RESULT },
  },
  repid_agents: { agent_name: 'trinity-test' },
  x402_settlements: { tx_hash: '0xsettle', is_simulated: false, status: 'settled' },
  a2a_awards: { competing_bid_count: 2, was_lowest_price: true, is_uncontested: false },
  erc8004_reputation_writes: { tx_hash: '0xonchain', repid_value: 1701 },
};

jest.mock('../src/db', () => {
  const make = (table: string) => {
    const c: any = {
      select: () => c, eq: () => c, order: () => c, limit: () => c, not: () => c,
      maybeSingle: () => Promise.resolve({ data: (rowsRef as any)[table] ?? null, error: null }),
      then: (r: any) => r({ data: table === 'repid_score_events' ? [] : [], error: null }),
    };
    return c;
  };
  const rowsRef: Record<string, unknown> = {};
  return { db: { from: (t: string) => make(t) }, __rows: rowsRef };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbMock = jest.requireMock('../src/db') as { __rows: Record<string, unknown> };
Object.assign(dbMock.__rows, rows);

describe('public trust receipt', () => {
  it('never contains the contract payload or result', async () => {
    const receipt = await buildTrustReceipt('c1');
    expect(receipt).not.toBeNull();
    const serialised = JSON.stringify(receipt);
    expect(serialised).not.toContain(SECRET_PAYLOAD);
    expect(serialised).not.toContain(SECRET_RESULT);
    expect(serialised).not.toContain('CONFIDENTIAL');
  });

  it('exposes only the agreed field set', async () => {
    const receipt = await buildTrustReceipt('c1');
    const allowed = new Set([
      'contract_id', 'settled_at', 'price_usdc', 'price_raw', 'buyer', 'provider',
      'negotiated', 'competing_bids', 'won_on_price', 'uncontested',
      'settlement_tx', 'settlement_url', 'is_simulated', 'reputation_events',
      'onchain_tx', 'onchain_url', 'onchain_repid', 'onchain_link_is_proven',
      'zk_proofs', 'caveats', 'paid_before_delivery',
      // ZK BIND T1. Deliberately allowed: it is a HASH over digests, never the
      // work — work-statement.test.ts proves the preimage cannot contain the
      // deliverable body. Publishing it is the point, since a third party must
      // be able to recompute and compare it.
      'work_statement_hash',
    ]);
    // A new field is not automatically safe to publish — this fails until
    // someone decides it is, which is the point.
    for (const k of Object.keys(receipt!)) expect(allowed.has(k)).toBe(true);
  });

  /**
   * The receipt's central claim is "paid only after verified delivery". It was
   * printed for every exchange regardless of the data, and it was false for the
   * pre-2026-08-01 rows: 18dd4e05 settled at 04:32:31.72 and was fulfilled at
   * 04:33:23.54, 52s later. A receipt that tells the flattering version is the
   * exact failure it exists to expose.
   */
  describe('pay-vs-deliver ordering is read from the row, never assumed', () => {
    const withTimes = (settleAt: string | null, fulfilledAt: string | null) => {
      Object.assign(dbMock.__rows, {
        service_contracts: { ...(rows.service_contracts as object), fulfilled_at: fulfilledAt },
        x402_settlements: { tx_hash: '0xsettle', is_simulated: false, status: 'settled', created_at: settleAt },
      });
    };
    afterEach(() => Object.assign(dbMock.__rows, rows));

    it('flags an exchange that paid at escrow, and says how early', async () => {
      withTimes('2026-07-23T04:32:31.723Z', '2026-07-23T04:33:23.538Z');
      const r = await buildTrustReceipt('c1');
      expect(r!.paid_before_delivery).toBe(true);
      expect(r!.caveats.join(' ')).toMatch(/moved BEFORE delivery.*52s/);
    });

    it('does not flag an exchange settled after fulfilment', async () => {
      withTimes('2026-08-01T05:09:07.741Z', '2026-08-01T05:09:06.934Z');
      const r = await buildTrustReceipt('c1');
      expect(r!.paid_before_delivery).toBe(false);
      expect(r!.caveats.join(' ')).not.toMatch(/BEFORE delivery/);
    });

    it('says it cannot tell rather than guessing when a timestamp is missing', async () => {
      withTimes('2026-08-01T05:09:07.741Z', null);
      const r = await buildTrustReceipt('c1');
      expect(r!.paid_before_delivery).toBeNull();
      expect(r!.caveats.join(' ')).toMatch(/Cannot establish whether payment preceded delivery/);
    });
  });

  it('returns null for an unknown contract rather than an empty shell', async () => {
    Object.assign(dbMock.__rows, { service_contracts: null });
    expect(await buildTrustReceipt('nope')).toBeNull();
    Object.assign(dbMock.__rows, rows);
  });
});
