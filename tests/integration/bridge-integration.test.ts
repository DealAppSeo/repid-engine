import { db } from '../../src/db';
import { applyServiceFulfilledDeltas } from '../../src/services/validation-repid-delta';
import { FeedbackLoopWorker } from '../../src/workers/feedback-loop-worker';
import crypto from 'crypto';
// PROD-SAFETY: this suite inserts/updates/deletes real rows in the resolved
// Supabase project AND injects a mock on-chain writer. Run against production it
// stamps live repid_events processed_at with a fake tx hash, so the real
// FeedbackLoopWorker skips those settlements (they never hit chain). Refuse to run
// against the prod project — ref is derived from SUPABASE_URL, never hardcoded here.
// Reuses the shared guard in tests/helpers/prod-guard.ts.
import {
  assertNotProductionSupabase,
  isProductionSupabase,
} from '../helpers/prod-guard';

// Mock pgQuery to fetch from the actual db using supabase-js db client!
jest.mock('../../src/db/direct-pg', () => {
  return {
    pgQuery: jest.fn().mockImplementation(async (query: string, params: any[]) => {
      // Direct query emulation: retrieve unprocessed events
      const { data, error } = await db
        .from('repid_events')
        .select('*')
        .in('event_type', params[0])
        .is('processed_at', null);

      if (error) throw error;
      return data;
    })
  };
});

// Setup mock writer.
// PROD-SAFETY: even if the suite-level guard is bypassed, the mock writer itself
// refuses to produce a fake tx hash when pointed at the prod Supabase project —
// so it can NEVER cause a real repid_events row to be stamped processed_at with a
// mock hash in production.
const mockWriter = {
  chainId: 84532,
  getContractAddress: () => '0xMockContractAddress',
  writeRepIDFeedback: jest.fn().mockImplementation(async () => {
    if (isProductionSupabase(process.env.SUPABASE_URL)) {
      throw new Error(
        'refusing to run mock reputation writer against production Supabase — ' +
          'a mock tx hash must never be written to a real repid_events row',
      );
    }
    return {
      txHash: '0xmock_confirmed_tx_hash_for_bridge',
      blockNumber: 123456,
      gasUsed: 150000n
    };
  })
};

describe('Bridge Integration E2E Trace', () => {
  // HARD GUARD: refuse to run this write-path + mock-writer suite against the
  // production Supabase project. Throwing here fails the suite loudly rather than
  // silently corrupting the live on-chain reputation queue.
  beforeAll(() => {
    assertNotProductionSupabase(process.env.SUPABASE_URL);
  });

  const buyer_agent_id = '84f2d7de-5bb9-4f3b-92ca-aecc7c498271';
  const provider_agent_id = '32e0e809-c1c4-4405-913f-135c8a2d6626'; // trinity-shofet (Established, token 5863)
  const service_id = '0edfc364-ad2a-4b3a-bdc4-20b03ab92e21';

  let simSettlementId: string;
  let simContractId: string;
  let simEventId: string;

  let realSettlementId: string;
  let realContractId: string;
  let realEventId: string;

  afterAll(async () => {
    // PROD-SAFETY: never issue cleanup deletes against the prod project (also
    // covers the case where beforeAll threw before any test rows were created).
    if (isProductionSupabase(process.env.SUPABASE_URL)) return;
    // Cleanup
    if (simEventId) {
      await db.from('repid_events').delete().eq('id', simEventId);
    }
    if (realEventId) {
      await db.from('repid_events').delete().eq('id', realEventId);
    }
    await db.from('service_contracts').delete().in('id', [simContractId, realContractId]);
    await db.from('x402_settlements').delete().in('id', [simSettlementId, realSettlementId]);
  });

  it('verifies simulated vs real service contracts end-to-end', async () => {
    // 1. Create simulated settlement and contract
    simSettlementId = crypto.randomUUID();
    const { error: simSetErr } = await db.from('x402_settlements').insert({
      id: simSettlementId,
      tip_id: 'tip_sim_test',
      prediction_topic: 'sim_test',
      amount: 10000,
      asset: 'USDC',
      status: 'settled',
      is_simulated: true,
      provider_agent_id,
      requestor_agent_id: buyer_agent_id,
      settlement_attempt_count: 1
    });
    expect(simSetErr).toBeNull();

    simContractId = crypto.randomUUID();
    const { error: simContErr } = await db.from('service_contracts').insert({
      id: simContractId,
      service_id,
      buyer_agent_id,
      provider_agent_id,
      agreed_price_usdc_raw: 10000,
      payload: { content: 'hello', criteria: ['world'] },
      status: 'pending',
      x402_payment_id: simSettlementId,
      metadata: { is_simulated: true, task_type: 'verification' }
    });
    expect(simContErr).toBeNull();

    await db.from('service_contracts').update({ status: 'escrowed', escrowed_at: new Date().toISOString() }).eq('id', simContractId);
    await db.from('service_contracts').update({ status: 'fulfilled', result: { verdict: 'PASS' }, fulfilled_at: new Date().toISOString() }).eq('id', simContractId);

    // Call applyServiceFulfilledDeltas
    await applyServiceFulfilledDeltas({
      id: simContractId,
      service_id,
      provider_agent_id,
      buyer_agent_id
    });

    // Verify repid_events insertion for simulated contract
    const { data: simEvent, error: simEvFetchErr } = await db
      .from('repid_events')
      .select('*')
      .eq('event_type', 'service_fulfilled_settled')
      .eq('event_data->metadata->>contract_id', simContractId)
      .maybeSingle();

    expect(simEvFetchErr).toBeNull();
    expect(simEvent).not.toBeNull();
    expect(simEvent?.event_data.is_simulated).toBe(true);
    simEventId = simEvent!.id;

    // 2. Create real (non-simulated) settlement and contract
    realSettlementId = crypto.randomUUID();
    const { error: realSetErr } = await db.from('x402_settlements').insert({
      id: realSettlementId,
      tip_id: 'tip_real_test',
      prediction_topic: 'real_test',
      amount: 10000,
      asset: 'USDC',
      status: 'settled',
      is_simulated: false,
      provider_agent_id,
      requestor_agent_id: buyer_agent_id,
      settlement_attempt_count: 1
    });
    expect(realSetErr).toBeNull();

    realContractId = crypto.randomUUID();
    const { error: realContErr } = await db.from('service_contracts').insert({
      id: realContractId,
      service_id,
      buyer_agent_id,
      provider_agent_id,
      agreed_price_usdc_raw: 10000,
      payload: { content: 'hello', criteria: ['world'] },
      status: 'pending',
      x402_payment_id: realSettlementId,
      metadata: { is_simulated: false, task_type: 'verification' }
    });
    expect(realContErr).toBeNull();

    await db.from('service_contracts').update({ status: 'escrowed', escrowed_at: new Date().toISOString() }).eq('id', realContractId);
    await db.from('service_contracts').update({ status: 'fulfilled', result: { verdict: 'PASS' }, fulfilled_at: new Date().toISOString() }).eq('id', realContractId);

    // Call applyServiceFulfilledDeltas
    await applyServiceFulfilledDeltas({
      id: realContractId,
      service_id,
      provider_agent_id,
      buyer_agent_id
    });

    // Verify repid_events insertion for real contract
    const { data: realEvent, error: realEvFetchErr } = await db
      .from('repid_events')
      .select('*')
      .eq('event_type', 'service_fulfilled_settled')
      .eq('event_data->metadata->>contract_id', realContractId)
      .maybeSingle();

    expect(realEvFetchErr).toBeNull();
    expect(realEvent).not.toBeNull();
    expect(realEvent?.event_data.is_simulated).toBe(false);
    realEventId = realEvent!.id;

    // 3. Run FeedbackLoopWorker once with injected mock writer
    const worker = new FeedbackLoopWorker();
    await worker.runOnce(mockWriter);

    // Check simulated event (processed_at should be not null, but mock writer not called)
    const { data: simEventAfter } = await db.from('repid_events').select('processed_at').eq('id', simEventId).single();
    expect(simEventAfter?.processed_at).not.toBeNull();

    // Check real event (processed_at should be not null, and mock writer called)
    const { data: realEventAfter } = await db.from('repid_events').select('*').eq('id', realEventId).single();
    expect(realEventAfter?.processed_at).not.toBeNull();
    expect(realEventAfter?.event_data.reputation_tx_hash).toBe('0xmock_confirmed_tx_hash_for_bridge');

    // Confirm that the mock writer was only called for the real event, not the simulated one
    expect(mockWriter.writeRepIDFeedback).toHaveBeenCalledTimes(1);
    expect(mockWriter.writeRepIDFeedback).toHaveBeenCalledWith(expect.objectContaining({
      agentTokenId: '5863', // shofet token id
      repid: expect.any(Number),
      tier: 'ESTABLISHED'
    }));
  });
});
