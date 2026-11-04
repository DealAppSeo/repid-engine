/**
 * t12-e2e-proof.test.ts — P0 regression: SERVICE_AWARD_FENCE gates canonical RepID (D-130 M3b).
 *
 * The marquee harness awarded a canonical SERVICE_FULFILLED (+moved repid_agents.current_repid) in Stage 3
 * regardless of HAL verdict / x402 / attestation. This pins the fence wiring:
 *   - flag OFF (default): the canonical move + canonical SERVICE_FULFILLED still happen (the documented defect);
 *   - flag ON: the award is DEMOTED — no current_repid write, no canonical event; recorded on the proof row.
 * Teeth: remove `serviceAwardFenceEnabled() && !fence.canonical` and the ON case moves canonical again → this fails.
 *
 * The real service-award-fence is used (not mocked); every other dependency is a recording/stub mock.
 */
jest.mock('../../db', () => {
  const calls: { table: string; op: string; arg?: any }[] = [];
  const db: any = {
    __calls: calls,
    from(table: string) {
      const api: any = {
        select: () => api,
        eq: () => api,
        update: (arg: any) => { calls.push({ table, op: 'update', arg }); return api; },
        insert: (arg: any) => {
          calls.push({ table, op: 'insert', arg });
          const id = table === 't12_e2e_proofs' ? 7 : 42;
          return { select: () => ({ maybeSingle: async () => ({ data: { id }, error: null }) }) };
        },
        maybeSingle: async () => ({ data: { id: 'agent-1', current_repid: 100 }, error: null }),
      };
      return api;
    },
  };
  return { db };
});
jest.mock('../../hal/service', () => ({ halService: { evaluate: jest.fn(async () => ({ hal_score: 0.2, decision: 'veto' })) } }));
jest.mock('../../scoring/pipeline', () => ({ resolveHalStrictness: () => 2 }));
jest.mock('../../services/x402-real-settler', () => ({ settleX402Payment: jest.fn(async () => ({ tx_hash: null, settlement_source: 'pending_funding' })) }));
jest.mock('../../scoring/score-event-writer', () => ({ insertScoreEvent: jest.fn(async () => ({ ok: true, id: 99 })) }));
jest.mock('../../routes/score-event-guard', () => ({ scoreEventGuardEnforced: () => false }));

import { runE2EProof } from '../t12-e2e-proof';
import { db } from '../../db';

const calls = (db as any).__calls as { table: string; op: string; arg?: any }[];
const has = (table: string, op: string): boolean => calls.some((c) => c.table === table && c.op === op);
const proofRow = (): any => calls.find((c) => c.table === 't12_e2e_proofs' && c.op === 'insert')?.arg;

beforeEach(() => { calls.length = 0; delete process.env.SERVICE_AWARD_FENCE; });

describe('t12-e2e-proof — SERVICE_AWARD_FENCE gates canonical RepID (P0)', () => {
  const input = { runId: 'r1', agent: 'trinity-torch', output: 'a deliverable' };

  it('flag OFF (default): awards canonical SERVICE_FULFILLED on an UNVERIFIED (veto) output — the documented defect', async () => {
    const row = await runE2EProof(input);
    expect(has('repid_agents', 'update')).toBe(true); // canonical score moved
    const ev = calls.find((c) => c.table === 'repid_score_events' && c.op === 'insert');
    expect(ev?.arg?.event_type).toBe('SERVICE_FULFILLED'); // canonical event written
    expect(row.repid_event_id).toBe(42);
    expect(row.stages_real.repid).toBe(true);
    expect(proofRow()?.metadata?.repid_award_demoted).toBeUndefined(); // OFF ⇒ no demotion marker
  });

  it('flag ON: DEMOTES the award — no canonical move, no canonical event, recorded on the proof row', async () => {
    process.env.SERVICE_AWARD_FENCE = '1';
    const row = await runE2EProof(input);
    expect(has('repid_agents', 'update')).toBe(false); // canonical score NOT moved
    expect(has('repid_score_events', 'insert')).toBe(false); // no canonical event
    expect(row.repid_event_id).toBeNull();
    expect(row.stages_real.repid).toBe(false);
    expect(proofRow()?.metadata?.repid_award_demoted).toBe(true);
    expect(proofRow()?.metadata?.repid_demote_reasons).toEqual(
      expect.arrayContaining(['unverified_outcome:vetoed', 'independence_not_established:unknown', 'no_idempotency_key']),
    );
  });
});
