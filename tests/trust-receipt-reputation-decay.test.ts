/**
 * `decay: null` and `decay: 0` on a receipt's reputation events are DIFFERENT
 * FACTS, and this pins that they are published differently.
 *
 * The engine writes `repid_before` PRE-decay and `repid_after` as
 * clamp(decayed + delta), so decay moves a score without ever appearing in
 * `delta`. A receipt that publishes only from/to/delta is therefore not a
 * closed accounting, and an outsider comparing `to - from` against `delta` is
 * really testing whether decay happened to be zero.
 *
 * Publishing the decay closes it — but only if "nobody recorded a decay" is
 * distinguishable from "a writer recorded no decay". Collapsing the first into
 * `0` would hand the verifier a number nobody asserted and let it answer
 * VERIFIED on the strength of it: not-checked scored as checked, in the one
 * artifact whose entire purpose is that its verdict can be trusted by someone
 * who cannot read the code.
 *
 * This is not hypothetical. Measured against the live ledger on 2026-09-04,
 * `metadata.decayApplied` is absent on ALL 1,339 contract-linked events — so
 * `null` is the answer every real receipt gets today, and the `0` branch is the
 * one that is currently unreachable.
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
              ? {
                  id: 'c1',
                  status: 'settled',
                  agreed_price_usdc_raw: 100000,
                  buyer_agent_id: 'buyer-1',
                  provider_agent_id: 'prov-1',
                  settled_at: '2026-09-01T00:00:00Z',
                }
              : table === 'repid_agents'
                ? { agent_name: 'trinity-test' }
                : null,
          error: null,
        }),
      then: (r: any) =>
        r({ data: table === 'repid_score_events' ? EVENTS : [], error: null }),
    };
    return c;
  };
  return { db: { from: (t: string) => make(t) } };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildTrustReceipt } = require('../src/services/trust-receipt');

type RepEvent = { decay: number | null; delta: number; from: number; to: number };

async function eventsFrom(metadata: unknown): Promise<RepEvent[]> {
  EVENTS.length = 0;
  EVENTS.push({
    agent_id: 'prov-1',
    event_type: 'SERVICE_FULFILLED',
    delta: 20,
    repid_before: 1000,
    repid_after: 1020,
    metadata,
  });
  const receipt = await buildTrustReceipt('c1');
  return receipt!.reputation_events as RepEvent[];
}

describe('receipt reputation events: absent decay is not zero decay', () => {
  it('publishes null when no writer recorded a decay', async () => {
    const [e] = await eventsFrom({ mode: 'live' }); // metadata present, key absent
    expect(e!.decay).toBeNull();
  });

  it('publishes null when there is no metadata at all', async () => {
    const [e] = await eventsFrom(null);
    expect(e!.decay).toBeNull();
  });

  it('publishes 0 — not null — when a writer recorded no decay', async () => {
    const [e] = await eventsFrom({ decayApplied: 0 });
    expect(e!.decay).toBe(0);
  });

  it('publishes the recorded amount when there was one', async () => {
    const [e] = await eventsFrom({ decayApplied: 30 });
    expect(e!.decay).toBe(30);
  });

  it('still carries the from/to/delta the verifier needs alongside it', async () => {
    const [e] = await eventsFrom({ decayApplied: 0 });
    expect(e).toMatchObject({ delta: 20, from: 1000, to: 1020 });
  });
});
