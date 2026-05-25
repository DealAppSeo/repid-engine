import { SupabaseClient } from '@supabase/supabase-js';
import { PeerVerificationQueueEntry } from '../types/peer-verification';

export async function enqueueVerification(
  db: SupabaseClient,
  params: {
    source_response_id: string;
    source_agent_id: string;
    certainty_at_claim: number;
    claim_text: string;
    threshold?: number;
  }
): Promise<PeerVerificationQueueEntry | null> {
  const threshold = params.threshold ?? 0.85;
  try {
    // Check if duplicate exists
    const { data: existing } = await db
      .from('peer_verification_queue')
      .select('id')
      .eq('source_response_id', params.source_response_id)
      .maybeSingle();

    if (existing) {
      console.log(`[PeerVerificationWriter] Job already exists for response ${params.source_response_id}`);
      return null;
    }

    const { data, error } = await db
      .from('peer_verification_queue')
      .insert({
        source_response_id: params.source_response_id,
        source_agent_id: params.source_agent_id,
        certainty_at_claim: params.certainty_at_claim,
        verification_status: 'pending',
        threshold_used: threshold,
        claim_text: params.claim_text,
      })
      .select('*')
      .single();

    if (error) {
      throw error;
    }

    console.log(`[PeerVerificationWriter] Enqueued verification job ${data.id} for response ${params.source_response_id}`);
    return data as PeerVerificationQueueEntry;
  } catch (err: any) {
    console.error(`[PeerVerificationWriter] Error enqueuing verification:`, err.message);
    return null;
  }
}
