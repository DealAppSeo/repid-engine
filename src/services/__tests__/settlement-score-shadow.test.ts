/**
 * The settlement-score shadow's two load-bearing properties:
 *   1. the would-be delta is EXACTLY what the live writer would apply
 *      (`applyServiceSatisfiedDeltas`), so the measurement is not a second,
 *      drifting copy of the arithmetic; and
 *   2. it MOVES NO SCORE — flag off it does nothing at all, flag on it writes
 *      only to `trinity_agent_logs` and never to `repid_agents` or
 *      `repid_score_events`.
 *
 * Property 2 is the reason the module may ship un-ratified, so it is asserted
 * against a recording db mock (LESSONS 3: name the caller — here, name every
 * table the wired path touches), not merely by reading the source.
 */

// Recording mock: never throws, logs every table/op so the test can prove which
// tables the wired path touched. Exposed on the mocked module as `__calls`.
jest.mock('../../db', () => {
  const calls: Array<{ table: string; op: string }> = [];
  const builder = (table: string): any => {
    const b: any = {
      select: () => {
        calls.push({ table, op: 'select' });
        return b;
      },
      eq: () => b,
      maybeSingle: async () => ({
        data: table === 'repid_agents' ? { current_repid: 1000 } : null,
        error: null,
      }),
      insert: (_row: any) => {
        calls.push({ table, op: 'insert' });
        const res: any = Promise.resolve({ data: { id: 'log-1' }, error: null });
        res.select = () => ({
          single: async () => ({ data: { id: 'log-1' }, error: null }),
          maybeSingle: async () => ({ data: { id: 'log-1' }, error: null }),
        });
        return res;
      },
      update: () => {
        calls.push({ table, op: 'update' });
        return b;
      },
    };
    return b;
  };
  return {
    db: { from: (table: string) => { calls.push({ table, op: 'from' }); return builder(table); } },
    __calls: calls,
  };
});

import {
  computeSettlementScoreDeltas,
  observeSettlementScore,
  settlementScoreShadowEnabled,
  type SettlementContract,
} from '../settlement-score-shadow';

const { __calls } = jest.requireMock('../../db') as { __calls: Array<{ table: string; op: string }> };

const FLAG = 'SETTLEMENT_SCORE_SHADOW_ENABLED';
const contract = (over: Partial<SettlementContract> = {}): SettlementContract => ({
  id: 'contract-1',
  provider_agent_id: 'provider-uuid',
  buyer_agent_id: 'buyer-uuid',
  buyer_satisfaction_score: 1,
  metadata: {},
  payload: {},
  x402_payment_id: null,
  ...over,
});

describe('computeSettlementScoreDeltas — the SAME arithmetic as applyServiceSatisfiedDeltas', () => {
  it('multiplies BOTH parties by satisfaction and rounds (30·s, 15·s)', () => {
    expect(computeSettlementScoreDeltas({ satisfactionScore: 1, isSimulated: false }))
      .toMatchObject({ providerDelta: 30, buyerDelta: 15, event_type: 'SERVICE_SATISFIED' });
    // 0.5 → provider round(15)=15, buyer round(7.5)=8 (half-up, exactly Math.round).
    expect(computeSettlementScoreDeltas({ satisfactionScore: 0.5, isSimulated: false }))
      .toMatchObject({ providerDelta: 15, buyerDelta: 8 });
  });

  it('scores nothing at satisfaction 0 — the TORCH→SHOFET case', () => {
    expect(computeSettlementScoreDeltas({ satisfactionScore: 0, isSimulated: false }))
      .toMatchObject({ providerDelta: 0, buyerDelta: 0 });
  });

  it('a null (never-rated) score scores nothing rather than guessing', () => {
    expect(computeSettlementScoreDeltas({ satisfactionScore: null, isSimulated: false }).providerDelta).toBe(0);
    expect(computeSettlementScoreDeltas({ satisfactionScore: undefined, isSimulated: false }).buyerDelta).toBe(0);
  });

  it('a simulated contract zeroes both, by the same gate the live writer uses', () => {
    expect(computeSettlementScoreDeltas({ satisfactionScore: 1, isSimulated: true }))
      .toMatchObject({ providerDelta: 0, buyerDelta: 0, isSimulated: true });
  });

  it('clamps an out-of-range score to [0,1] as the DB CHECK requires', () => {
    expect(computeSettlementScoreDeltas({ satisfactionScore: 5, isSimulated: false }).providerDelta).toBe(30);
    expect(computeSettlementScoreDeltas({ satisfactionScore: -3, isSimulated: false }).providerDelta).toBe(0);
  });
});

describe('observeSettlementScore — default OFF, and MOVES NO SCORE when on', () => {
  const prev = process.env[FLAG];
  beforeEach(() => { __calls.length = 0; });
  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  it('is OFF unless explicitly enabled', () => {
    delete process.env[FLAG];
    expect(settlementScoreShadowEnabled()).toBe(false);
    process.env[FLAG] = 'true';
    expect(settlementScoreShadowEnabled()).toBe(true);
  });

  it('reads nothing and writes nothing while disabled — zero db interaction, verdict disabled', async () => {
    delete process.env[FLAG];
    const o = await observeSettlementScore({ contract: contract() });
    expect(o.verdict).toBe('disabled');
    expect(o.verdict).not.toBe('observed'); // 'disabled' must never be mistaken for a real observation
    expect(__calls).toHaveLength(0); // the strong claim: not a single db call while off
  });

  it('when enabled, records ONLY to trinity_agent_logs — never writes repid_agents or repid_score_events', async () => {
    process.env[FLAG] = 'true';
    const o = await observeSettlementScore({ contract: contract({ buyer_satisfaction_score: 1 }) });

    expect(o.verdict).toBe('observed');
    expect(o.wouldProviderDelta).toBe(30);
    expect(o.wouldBuyerDelta).toBe(15);
    expect(o.providerRepidBefore).toBe(1000);
    expect(o.wouldProviderRepidAfterNaive).toBe(1030); // NAIVE preview only; no decay/clamp/gate

    // The invariant that lets this ship un-ratified: the ONLY write is the shadow log.
    const writes = __calls.filter((c) => c.op === 'insert' || c.op === 'update');
    expect(writes).toEqual([{ table: 'trinity_agent_logs', op: 'insert' }]);
    expect(__calls.some((c) => c.table === 'repid_score_events')).toBe(false);
    expect(__calls.some((c) => c.table === 'repid_agents' && (c.op === 'insert' || c.op === 'update'))).toBe(false);
  });

  it('records a satisfaction-0 settlement as observed with zero deltas (the finding, not a failure)', async () => {
    process.env[FLAG] = 'true';
    const o = await observeSettlementScore({ contract: contract({ buyer_satisfaction_score: 0 }) });
    expect(o.verdict).toBe('observed');
    expect(o.wouldProviderDelta).toBe(0);
    expect(o.wouldBuyerDelta).toBe(0);
    // Still recorded — a zero-delta settlement is coverage, and a silent shadow log reads as "nothing happened".
    expect(__calls).toContainEqual({ table: 'trinity_agent_logs', op: 'insert' });
  });
});
