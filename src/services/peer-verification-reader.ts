import { SupabaseClient } from '@supabase/supabase-js';
import { PeerVerificationQueueEntry } from '../types/peer-verification';

const TRINITY_12_AGENTS = [
  'trinity-mel', 'trinity-shofet', 'trinity-gcm', 'trinity-orch',
  'trinity-w3c', 'trinity-torch', 'trinity-veritas', 'trinity-apm',
  'trinity-chesed', 'trinity-hdm', 'trinity-sophia', 'trinity-nexus'
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

      // Get the source agent's squad_id
      let sourceSquadId: string | null = null;
      const sourceAgentQuery = db.from('repid_agents').select('squad_id').eq('id', queueEntry.source_agent_id);
      
      if (typeof sourceAgentQuery.single === 'function') {
        try {
          const { data: sourceAgent } = await sourceAgentQuery.single();
          sourceSquadId = sourceAgent?.squad_id || null;
        } catch {
          sourceSquadId = null;
        }
      } else {
        const { data: sourceAgentData } = await sourceAgentQuery;
        sourceSquadId = (sourceAgentData && sourceAgentData.length > 0) ? (sourceAgentData[0]?.squad_id || null) : null;
      }
      
      const cleanSourceAgentName = sourceAgentName.toLowerCase().trim();

      // Query all potential verifiers to get their squad_ids
      const verifierMap = new Map<string, string | null>();
      const verifierQuery = db.from('repid_agents').select('agent_name, squad_id');
      
      if (typeof verifierQuery.in === 'function') {
        const { data: verifierAgents } = await verifierQuery.in('agent_name', TRINITY_12_AGENTS);
        if (verifierAgents) {
          for (const va of verifierAgents) {
            verifierMap.set(va.agent_name.toLowerCase().trim(), va.squad_id);
          }
        }
      } else {
        console.log('[PeerVerificationReader] Mock client detected (no .in function), using empty verifier map.');
      }

      // 3. Select verifier: cross-squad or fallback
      let eligibleVerifiers: string[] = [];

      if (sourceSquadId) {
        // Find agents in a DIFFERENT squad
        eligibleVerifiers = TRINITY_12_AGENTS.filter((name) => {
          const cleanName = name.toLowerCase().trim();
          if (cleanName === cleanSourceAgentName) return false;
          
          const squadId = verifierMap.get(cleanName);
          return squadId && squadId !== sourceSquadId;
        });
      }

      // Fallback: if no squad assignment or if cross-squad list is empty
      if (eligibleVerifiers.length === 0) {
        eligibleVerifiers = TRINITY_12_AGENTS.filter(
          (name) => name.toLowerCase().trim() !== cleanSourceAgentName
        );
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
          task_type: 'peer_verify',
          status: 'pending',
          priority: 80,
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
