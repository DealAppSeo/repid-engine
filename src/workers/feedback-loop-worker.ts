import { db } from '../db';
import { getReputationWriter, persistReputationWrite } from '../services/erc8004-reputation';

export class FeedbackLoopWorker {
  async runOnce(injectedWriter?: any) {
    console.log('[FeedbackLoopWorker] Starting cycle...');
    
    // 1. Fetch unprocessed x402 events
    const { data: events, error } = await db
      .from('repid_events')
      .select('*')
      .in('event_type', ['x402_inbound_settled', 'x402_outbound_settled'])
      .is('processed_at', null)
      .limit(50);

    if (error) {
      console.error('[FeedbackLoopWorker] Error fetching events:', error.message);
      return;
    }

    if (!events || events.length === 0) {
      console.log('[FeedbackLoopWorker] No events to process.');
      return;
    }

    console.log(`[FeedbackLoopWorker] Processing ${events.length} events...`);

    const writer = injectedWriter || getReputationWriter();
    if (!writer) {
      console.warn('[FeedbackLoopWorker] Reputation writer not available (check env), skipping loop.');
      return;
    }


    for (const event of events) {
      try {
        const { subject_id, event_data } = event;
        const { data: agent } = await db
          .from('repid_agents')
          .select('id, agent_name, current_repid, tier, erc8004_token_id')
          .eq('id', subject_id)
          .single();

        if (!agent) {
          console.warn(`[FeedbackLoopWorker] Agent ${subject_id} not found, skipping event ${event.id}`);
          continue;
        }

        // Tier check: only process for Established (1000+) tier
        if (agent.current_repid < 1000) {
          console.log(`[FeedbackLoopWorker] Agent ${agent.agent_name} below Established tier (${agent.current_repid}), skipping...`);
          await db.from('repid_events').update({ processed_at: new Date().toISOString() }).eq('id', event.id);
          continue;
        }

        if (!agent.erc8004_token_id) {
          console.warn(`[FeedbackLoopWorker] Agent ${agent.agent_name} has no erc8004_token_id, skipping...`);
          // Mark processed to avoid infinite loops on un-minted agents
          await db.from('repid_events').update({ processed_at: new Date().toISOString() }).eq('id', event.id);
          continue;
        }

        // 2. Perform on-chain write
        const feedbackHash = (event_data as any)?.tx_hash || (event_data as any)?.reputation_tx_hash || '0x0000000000000000000000000000000000000000000000000000000000000000';
        
        console.log(`[FeedbackLoopWorker] Writing RepID ${agent.current_repid} to chain for ${agent.agent_name} (token ${agent.erc8004_token_id})...`);
        
        const result = await writer.writeRepIDFeedback({
          agentTokenId: agent.erc8004_token_id,
          repid: Math.round(agent.current_repid),
          tier: agent.tier,
          endpoint: `https://trustrepid.dev/api/v1/agents/${agent.id}/reputation/payload.json`,
          feedbackURI: `https://trustrepid.dev/api/v1/agents/${agent.id}/reputation/payload.json`,
          feedbackHash
        });

        console.log(`[FeedbackLoopWorker] RepID update confirmed for ${agent.agent_name}: ${result.txHash}`);

        // 3. Mark event as processed
        await db.from('repid_events').update({ 
          processed_at: new Date().toISOString(),
          event_data: { ...(event_data as any), reputation_tx_hash: result.txHash }
        }).eq('id', event.id);

        // 4. Update agent's last_reputation_tx_hash for fast-lookup
        await db.from('repid_agents').update({
          last_reputation_tx_hash: result.txHash
        }).eq('id', agent.id);

        // 5. Persist write record for audit trail
        await persistReputationWrite(db, {
          agent_id: agent.id,
          agent_token_id: agent.erc8004_token_id,
          repid_value: Math.round(agent.current_repid),
          tier: agent.tier,
          tx_hash: result.txHash,
          block_number: result.blockNumber,
          gas_used: result.gasUsed,
          chain_id: writer.chainId,
          contract_address: writer.getContractAddress()
        });

      } catch (e: any) {
        console.error(`[FeedbackLoopWorker] Failed to process event ${event.id}:`, e.message);
      }
    }
  }

  start(intervalMs: number = 60000) {
    console.log(`[FeedbackLoopWorker] Worker started with interval ${intervalMs}ms`);
    // Initial run immediately
    this.runOnce();
    // Schedule periodic runs
    setInterval(() => this.runOnce(), intervalMs);
  }
}

export const feedbackLoopWorker = new FeedbackLoopWorker();
