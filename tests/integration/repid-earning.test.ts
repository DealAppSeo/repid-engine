/**
 * Integration test: RepID earning end-to-end against live Supabase.
 *
 * Exercises src/services/repid-earning.ts (CC Sprint 2 + Sprint 3 amend):
 *   - Synthetic trade row inserted with decision='REFUSED'
 *   - recordOutcome() reads it, computes +2 (constitutional refusal), writes
 *     repid_score_events row with idempotency_key='paper_trade:<id>'
 *   - repid_agents.current_repid (CANONICAL — never repid_score per Gemini
 *     divergence warning) reflects the +2 delta
 *   - Cleanup: delete the synthetic trade row + the repid_score_events row +
 *     restore agent's current_repid to its prior value
 *
 * Uses SOPHIA's UUID since she's the most stable spokesperson agent.
 * SOPHIA's current_repid is at 9961 (VETERAN); +2 stays inside the
 * trigger's tier band, so trg_sync_tier won't shift her tier (clean test).
 *
 * Skipped if SUPABASE env not set.
 */

import { db } from '../../src/db';
import { repidEarning } from '../../src/services/repid-earning';

const HAS_DB = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
const describeIfDb = HAS_DB ? describe : describe.skip;

const SOPHIA_UUID = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';
const SOPHIA_NAME = 'SOPHIA';
const TEST_TAG = 'CC-Sprint-8-integration-test';

describeIfDb('RepID earning — REFUSED → +2 end-to-end', () => {
  let insertedTradeId: number | null = null;
  let scorePriorRepid: number = 0;
  let createdEventId: number | null = null;

  beforeAll(async () => {
    // Capture SOPHIA's pre-test current_repid for restoration on teardown
    const { data } = await db.from('repid_agents')
      .select('current_repid')
      .eq('id', SOPHIA_UUID).single();
    scorePriorRepid = (data as any)?.current_repid ?? 0;
  });

  afterAll(async () => {
    // Teardown 1: remove the score event row we created
    if (createdEventId) {
      await db.from('repid_score_events').delete().eq('id', createdEventId);
    }
    // Teardown 2: remove the synthetic trade row
    if (insertedTradeId) {
      await db.from('trade_execution_log').delete().eq('id', insertedTradeId);
    }
    // Teardown 3: restore SOPHIA's current_repid (in case the test fired
    // and updated it) — write the original value; trg_sync_tier handles tier
    if (scorePriorRepid > 0) {
      await db.from('repid_agents')
        .update({ current_repid: scorePriorRepid })
        .eq('id', SOPHIA_UUID);
    }
  });

  it('end-to-end: synthetic REFUSED trade → +2 RepID', async () => {
    // 1. Insert synthetic trade row (mirrors trinity-sophia trade_pipeline shape)
    const { data: ins, error: insErr } = await db.from('trade_execution_log').insert({
      agent_name: SOPHIA_NAME,
      decision: 'REFUSED',
      asset: 'BTC',
      execution_mode: 'paper',
      amount_usd: 0,
      reason: TEST_TAG,
    }).select('id').single();
    expect(insErr).toBeNull();
    expect(ins).not.toBeNull();
    insertedTradeId = (ins as any).id;
    expect(insertedTradeId).toBeGreaterThan(0);

    // 2. Call recordOutcome
    const r = await repidEarning.recordOutcome(insertedTradeId!);

    // Should return success shape (not skipped)
    expect('skipped' in r).toBeFalsy();
    if ('skipped' in r) return; // type guard

    expect(r.delta).toBe(2); // constitutional refusal
    expect(r.reason).toBe('constitutional_refusal_or_hal_veto');
    expect(r.agent_id).toBe(SOPHIA_UUID);
    expect(r.repid_after).toBe(r.repid_before + 2);
    createdEventId = r.event_id;

    // 3. Verify the event row exists with idempotency_key
    const { data: eventRow } = await db.from('repid_score_events')
      .select('event_type, delta, idempotency_key, agent_id')
      .eq('id', createdEventId!).single();
    expect((eventRow as any)?.event_type).toBe('paper_trade_outcome');
    expect((eventRow as any)?.delta).toBe(2);
    expect((eventRow as any)?.idempotency_key).toBe(`paper_trade:${insertedTradeId}`);
    expect((eventRow as any)?.agent_id).toBe(SOPHIA_UUID);

    // 4. Verify SOPHIA's CANONICAL current_repid (NOT Gemini's repid_score
    // divergence column) reflects the delta
    const { data: agentAfter } = await db.from('repid_agents')
      .select('current_repid').eq('id', SOPHIA_UUID).single();
    expect((agentAfter as any)?.current_repid).toBe(scorePriorRepid + 2);
  });

  it('idempotency: re-running recordOutcome on same trade returns skipped', async () => {
    // This test piggybacks on the row inserted by the previous test
    if (!insertedTradeId) {
      console.warn('First test did not insert a trade row; skipping idempotency check');
      return;
    }
    const r = await repidEarning.recordOutcome(insertedTradeId);
    expect('skipped' in r).toBeTruthy();
    if ('skipped' in r) {
      expect(r.skipped).toBe('already_scored');
    }
  });
});
