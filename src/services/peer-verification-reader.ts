import { SupabaseClient } from '@supabase/supabase-js';
import { PeerVerificationQueueEntry } from '../types/peer-verification';
import {
  peerVerifyPanelEnabled,
  PANEL_VERIFIER_POOL,
  PANEL_PROVIDER_HINTS,
} from './peer-verify-consensus';
import { classifyPeerVerifyClaim, prefilterMode } from './peer-verify-prefilter';
import { isProducerHalted } from './producer-halt';
import { checkBirthRate } from './birth-rate-breaker';
import { rootLineage } from './task-lineage';

const VERIFIER_POOL = ['trinity-mel', 'trinity-shofet', 'trinity-gcm'];
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
    // L2 breaker 2.1 — producer kill-switch (drain-only). The reader turns queue
    // entries into new peer_verify trinity_tasks; that is a producer action. When
    // peer_verify producers are halted (PRODUCER_HALT_CLASSES), do not claim or
    // spawn — leave entries 'pending' so they resume the moment the lever is
    // cleared, while workers keep draining any peer_verify tasks already in
    // flight. Fail-safe (only ever skips a spawn), fail-loud.
    if (isProducerHalted('peer_verify')) {
      console.log(
        '[PeerVerificationReader] peer_verify producer halted (PRODUCER_HALT_CLASSES) ' +
          '— skipping spawn cycle; queued entries left pending (breaker 2.1)'
      );
      return;
    }

    // L2 breaker 2.0 — automatic birth-rate control (drain-only). Before spawning
    // this cycle's peer_verify tasks, check whether peer_verify producers are
    // already outpacing drainage (pending vs completed-in-window). In enforce mode
    // an exceeded rate skips the spawn cycle (queued entries left pending, workers
    // keep draining); in shadow mode we only log what WOULD halt. Fail-open on any
    // count error (never wedge the producer on a flaky query). Fail-loud.
    const birthRate = await checkBirthRate(db, 'peer_verify');
    if (birthRate.exceeded) {
      console.log(
        `[PeerVerificationReader] peer_verify birth-rate ${birthRate.mode === 'enforce' ? 'HALTED' : 'WOULD halt'} ` +
          `(${birthRate.reason}; pending=${birthRate.pending} completed=${birthRate.completed}) (breaker 2.0)`
      );
      if (birthRate.halted) return;
    }

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

      // 2b. PREQUALIFYING FILTER — skip non-verifiable claims (drill/cron status
      // summaries, recursive peer-verify outputs, empty) before spending any
      // verifier LLM call. ~91% of enqueued claims are non-verifiable garbage
      // (reports/2026-07-09/PEER_VERIFY_FINDINGS.md). Mode: off | shadow | enforce.
      const cls = classifyPeerVerifyClaim(queueEntry.claim_text, queueEntry.certainty_at_claim);
      if (!cls.verifiable) {
        const mode = prefilterMode();
        if (mode !== 'off') {
          console.log(
            `[PeerVerificationReader] PREFILTER(${mode}) queue ${queueEntry.id} non-verifiable (${cls.reason})` +
              (mode === 'enforce' ? ' — skipped, no panel spawned.' : ' — would skip (shadow).')
          );
        }
        if (mode === 'enforce') {
          await db
            .from('peer_verification_queue')
            .update({ verification_status: 'skipped', completed_at: new Date().toISOString() })
            .eq('id', queueEntry.id);
          continue;
        }
      }

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

      // ---------------------------------------------------------------------
      // BLIND 2-of-3 PANEL PATH (flag PEER_VERIFY_PANEL_ENABLED, default false)
      // Dispatch 3 INDEPENDENT verifiers — distinct agents + distinct provider
      // hints. Each is a separate trinity_tasks row so verifiers work in
      // isolation (BLIND: no verifier sees another's verdict; consensus is
      // computed only after votes land in peer_verification_votes). Legacy
      // single-verifier path below is untouched when the flag is off.
      // ---------------------------------------------------------------------
      if (peerVerifyPanelEnabled()) {
        // Pick up to 3 distinct verifiers from the pool (excluding source).
        const panelPool = PANEL_VERIFIER_POOL.filter((name) =>
          eligibleVerifiers.includes(name)
        );
        const panel = (panelPool.length >= 1 ? panelPool : eligibleVerifiers).slice(0, 3);

        if (panel.length < 2) {
          console.warn(
            `[PeerVerificationReader] PANEL: only ${panel.length} eligible verifier(s) for queue ${queueEntry.id}; ` +
              `2-of-3 consensus not possible — leaving in_review for retry.`
          );
          await db
            .from('peer_verification_queue')
            .update({ verification_status: 'pending' })
            .eq('id', queueEntry.id);
          continue;
        }

        let dispatched = 0;
        for (const verifierName of panel) {
          const provider = PANEL_PROVIDER_HINTS[verifierName] ?? null;
          const { error: panelTaskErr } = await db
            .from('trinity_tasks')
            .insert({
              title: `[PEER_VERIFY_PANEL] Verify response from ${sourceAgentName}`,
              description:
                `BLIND panel vote. Verify the following claim INDEPENDENTLY (do not ` +
                `coordinate with other verifiers): "${queueEntry.claim_text || ''}"\n\n` +
                `Submit your vote using POST /api/v1/peer-verification/respond with ` +
                `queue_id: ${queueEntry.id} and verifier_agent_id: ${verifierName}.`,
              assigned_to: verifierName,
              agent_assigned: verifierName,
              task_type: 'peer_verify',
              status: 'pending',
              priority: 80,
              metadata: {
                peer_verification_queue_id: queueEntry.id,
                source_response_id: queueEntry.source_response_id,
                certainty_at_claim: queueEntry.certainty_at_claim,
                claim_text: queueEntry.claim_text,
                panel: 'blind_2of3',
                panel_verifier: verifierName,
                provider_hint: provider,
              },
              // L2 breaker 2.2 — lineage. Recorded as a ROOT, and that is a
              // MEASURED LIMIT, not an assumption: `peer_verification_queue`
              // carries no task reference of any kind (12 columns enumerated
              // 2026-07-27; `source_response_id` has no FK), so the task that
              // produced this claim is genuinely unknown here. Inventing a
              // parent would be worse than recording the truth. See the KNOWN
              // GAP section in task-lineage.ts — closing it needs the upstream
              // producer to carry the originating task id into the queue row.
              // Until then breaker 2.3 bounds this specific recursion.
              ...rootLineage(),
            });
          if (panelTaskErr) {
            console.error(
              `[PeerVerificationReader] PANEL dispatch error queue ${queueEntry.id} verifier ${verifierName}:`,
              panelTaskErr.message
            );
          } else {
            dispatched += 1;
          }
        }

        console.log(
          `[PeerVerificationReader] PANEL dispatched queue ${queueEntry.id} to ${dispatched} verifier(s): ` +
            `${panel.join(', ')} (blind 2-of-3)`
        );
        continue; // panel path done for this entry
      }

      // ---------------------------------------------------------------------
      // LEGACY SINGLE-VERIFIER PATH (default; unchanged)
      // ---------------------------------------------------------------------
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
          priority: 80,
          metadata: {
            peer_verification_queue_id: queueEntry.id,
            source_response_id: queueEntry.source_response_id,
            certainty_at_claim: queueEntry.certainty_at_claim,
            claim_text: queueEntry.claim_text,
          },
          // L2 breaker 2.2 — ROOT for the same measured reason as the panel
          // path above (the queue row carries no task reference).
          ...rootLineage(),
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
