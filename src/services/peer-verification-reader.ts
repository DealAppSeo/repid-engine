import { SupabaseClient } from '@supabase/supabase-js';
import { PeerVerificationQueueEntry } from '../types/peer-verification';

const VERIFIER_POOL = [
  'trinity-mel', 'trinity-shofet', 'trinity-gcm',
  'trinity-torch', 'trinity-chesed', 'trinity-veritas',
  'trinity-hdm', 'trinity-w3c', 'trinity-nexus',
  'trinity-apm', 'trinity-sophia', 'trinity-orch'
];
const POLL_INTERVAL_MS = 30000;
let readerInterval: NodeJS.Timeout | null = null;

async function getAgentName(db: SupabaseClient, agentId: string): Promise<string> {
  const { data, error } = await db
    .from('repid_agents')
    .select('agent_name')
    .eq('id', agentId)
    .single();

  if (error || !data) {
    return 'unknown-agent';
  }
  return data.agent_name;
}

export async function processPeerVerificationQueue(db: SupabaseClient): Promise<void> {
  try {
    // 1. Fetch pending queue entries
    const { data: pending, error } = await db
      .from('peer_verification_queue')
      .select('*')
      .eq('verification_status', 'pending')
      .limit(10);

    if (error) {
      console.error('[PeerVerificationReader] Error fetching pending queue:', error.message);
      return;
    }

    if (!pending || pending.length === 0) {
      return;
    }

    for (const entry of pending) {
      // 2. Claim row by setting status to in_review
      const { data: claimed, error: claimErr } = await db
        .from('peer_verification_queue')
        .update({ verification_status: 'in_review' })
        .eq('id', entry.id)
        .eq('verification_status', 'pending')
        .select('*')
        .single();

      if (claimErr || !claimed) {
        continue; // Already claimed or error
      }

      const queueEntry = claimed as PeerVerificationQueueEntry;
      const sourceAgentName = await getAgentName(db, queueEntry.source_agent_id);

      // 3. UUID-based verifier selection (excluding the source agent)
      const { data: verifierAgents } = await db
        .from('repid_agents')
        .select('id, agent_name')
        .in('agent_name', VERIFIER_POOL);

      const eligibleVerifiers = verifierAgents
        ?.filter((agent) => agent.id !== queueEntry.source_agent_id)
        .map((agent) => agent.agent_name) || [];

      if (eligibleVerifiers.length === 0) {
        // Fallback if the pool somehow is empty (e.g. source is the only verifier)
        eligibleVerifiers.push(VERIFIER_POOL[0] ?? 'trinity-mel');
      }

      // Stateless deterministic round-robin based on queue ID
      const chosenVerifier = eligibleVerifiers[Number(queueEntry.id) % eligibleVerifiers.length];

      // 4. Dispatch task to trinity_tasks
      const { data: task, error: taskErr } = await db
        .from('trinity_tasks')
        .insert({
          title: `[PEER_VERIFY] Verify response from ${sourceAgentName}`,
          description: `Verify the following claim: "${queueEntry.claim_text || ''}"\n\nSubmit your response using POST /api/v1/peer-verification/respond with queue_id: ${queueEntry.id}`,
          assigned_to: chosenVerifier,
          agent_assigned: chosenVerifier,
          task_type: 'peer_verify',
          status: 'pending',
          priority: 95,
          metadata: {
            peer_verification_queue_id: queueEntry.id,
            source_response_id: queueEntry.source_response_id,
            certainty_at_claim: queueEntry.certainty_at_claim,
            claim_text: queueEntry.claim_text,
          },
        })
        .select('id')
        .single();

      if (taskErr) {
        console.error(`[PeerVerificationReader] Error dispatching task for queue ${queueEntry.id}:`, taskErr.message);
        // Revert status to pending on failure
        await db
          .from('peer_verification_queue')
          .update({ verification_status: 'pending' })
          .eq('id', queueEntry.id);
        continue;
      }

      console.log(
        `[PeerVerificationReader] Dispatched queue entry ${queueEntry.id} to verifier ${chosenVerifier} (Task ID: ${task.id})`
      );
    }
  } catch (err: any) {
    console.error('[PeerVerificationReader] Polling error:', err.message);
  }
}

export function startPeerVerificationReader(db: SupabaseClient): void {
  if (readerInterval) {
    clearInterval(readerInterval);
  }
  console.log('[PeerVerificationReader] Starting polling loop');
  readerInterval = setInterval(() => processPeerVerificationQueue(db), POLL_INTERVAL_MS);
}

export function stopPeerVerificationReader(): void {
  if (readerInterval) {
    clearInterval(readerInterval);
    readerInterval = null;
    console.log('[PeerVerificationReader] Polling loop stopped');
  }
}
