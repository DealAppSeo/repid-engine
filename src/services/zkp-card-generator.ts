import { db } from '../db';
import { inheritProvenance } from './provenance';

export interface ZKPCardEvent {
  agent_name: string;
  task_id?: number;
  task_title?: string;
  event_type: 'task_completion' | 'substance_gate_fire' | 'constitutional_refusal';
}

export async function generateCard(event: ZKPCardEvent): Promise<string | null> {
  if (process.env.ZKP_CARDS_ENABLED !== 'true') return null;

  try {
    // 1. Pull agent RepID at event time
    const { data: agentData } = await db.from('repid_agents')
      .select('current_repid')
      .eq('id', event.agent_name)
      .maybeSingle();
      
    const agent_repid = agentData?.current_repid || 0;

    // 2. Pull the latest proof hash
    const { data: proofData } = await db.from('repid_proof_queue')
      .select('proof_hash, proof_bytes')
      .eq('agent_id', event.agent_name)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const zkp_proof_hash = proofData?.proof_hash || proofData?.proof_bytes || 'no_proof_available';

    // 3. Pull task metadata for tier inheritance
    let parentMetadata = {};
    if (event.task_id) {
      const { data: taskData } = await db.from('trinity_tasks')
        .select('metadata')
        .eq('id', event.task_id)
        .maybeSingle();
      if (taskData && taskData.metadata) {
        parentMetadata = taskData.metadata;
      }
    }
    const metadata = inheritProvenance(parentMetadata, 'zkp_cards');

    // 4. Insert into zkp_cards
    const { data: cardData, error } = await db.from('zkp_cards').insert({
      agent_name: event.agent_name,
      agent_repid,
      event_type: event.event_type,
      task_id: event.task_id,
      task_title: event.task_title,
      zkp_proof_hash,
      verification_url: 'https://trustshell.dev/verify/placeholder',
      metadata
    }).select('card_id').single();

    if (error) {
      console.error('[ZKP_CARDS] Insert error:', error);
      throw error;
    }

    // 5. Update the verification_url with actual card_id
    const verificationUrl = `https://trustshell.dev/verify/${cardData.card_id}`;
    await db.from('zkp_cards')
      .update({ verification_url: verificationUrl })
      .eq('card_id', cardData.card_id);

    console.log(`[ZKP_CARDS] Generated card ${cardData.card_id} for event ${event.event_type}`);
    return cardData.card_id;

  } catch (error) {
    console.error('[ZKP_CARDS] Generator failed:', error);
    return null;
  }
}
