import { db } from '../../src/db';
import { applyServiceFulfilledDeltas } from '../../src/services/validation-repid-delta';
import { FeedbackLoopWorker } from '../../src/workers/feedback-loop-worker';
import { describeIfSchema } from '../helpers/describe-if-schema';
import crypto from 'crypto';

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

// Setup mock writer
const mockWriter = {
  chainId: 84532,
  getContractAddress: () => '0xMockContractAddress',
  writeRepIDFeedback: jest.fn().mockResolvedValue({
    txHash: '0xmock_confirmed_tx_hash_for_bridge',
    blockNumber: 123456,
    gasUsed: 150000n
  })
};

describeIfSchema('Bridge Integration E2E Trace', () => {
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
