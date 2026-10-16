/**
 * A shadow score row is not reputation, so a receipt must not publish it as a gain.
 *
 * `is_shadow` rows record what a would-be policy would have paid. The DB applier forces their
 * applied delta to 0, so they move nothing. Before this fix the receipt listed them beside the
 * real rows: "+15  1371 -> 1371", a gain that never happened, and a ledger the receipt's own
 * verifier could not balance.
 */
const EVENTS: Array<Record<string, unknown>> = [];

jest.mock('../src/db', () => {
  const make = (table: string) => {
    const c: any = {
      select: () => c,
      eq: () => c,
      order: () => c,
      limit: () => c,
      not: () => c,
      maybeSingle: () =>
        Promise.resolve({
          data:
            table === 'service_contracts'
              ? { id: 'c1', status: 'settled', agreed_price_usdc_raw: 100000, buyer_agent_id: 'buyer-1', provider_agent_id: 'prov-1', settled_at: '2026-10-15T12:02:35Z' }
              : table === 'repid_agents'
                ? { agent_name: 'trinity-test' }
                : null,
          error: null,
        }),
      then: (r: any) => r({ data: table === 'repid_score_events' ? EVENTS : [], error: null }),
    };
    return c;
  };
  return { db: { from: (t: string) => make(t) } };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildTrustReceipt } = require('../src/services/trust-receipt');

describe('receipt reputation events exclude shadow rows', () => {
  beforeEach(() => {
    EVENTS.length = 0;
    EVENTS.push(
      { agent_id: 'prov-1', event_type: 'SERVICE_SATISFIED', delta: 15, repid_before: 1371, repid_after: 1371, is_shadow: true, metadata: { mode: 'SHADOW_NO_MUTATION' } },
      { agent_id: 'prov-1', event_type: 'SERVICE_SATISFIED', delta: 15, repid_before: 1371, repid_after: 1386, is_shadow: false, metadata: {} },
      { agent_id: 'buyer-1', event_type: 'SERVICE_SATISFIED', delta: 8, repid_before: 2280, repid_after: 2288, is_shadow: null, metadata: {} },
    );
  });

  it('publishes only the rows that moved a score', async () => {
    const r = await buildTrustReceipt('c1');
    expect(r!.reputation_events).toHaveLength(2);
    expect(r!.reputation_events.map((e: any) => [e.delta, e.from, e.to])).toEqual([[15, 1371, 1386], [8, 2280, 2288]]);
  });

  it('every published row balances: to - from = delta when no decay was recorded', async () => {
    const r = await buildTrustReceipt('c1');
    for (const e of r!.reputation_events as Array<{ delta: number; from: number; to: number }>) {
      expect(e.to - e.from).toBe(e.delta);
    }
  });
});
