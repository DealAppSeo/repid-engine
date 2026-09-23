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
import { shouldParkForHalt } from './emergency-halt';

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
    // L0 gate 0.4 — global emergency halt, checked BEFORE the per-class breakers
    // below: the global switch subsumes them, and checking it first means a
    // halted fleet does not spend a birth-rate count query per tick.
    if (await shouldParkForHalt(db, 'PeerVerificationReader')) return;

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

    // 1. Fetch pending queue entries, plus any whose LEASE HAS EXPIRED.
    //
    // A claim and its verdict are two steps (claim here, verdict via POST
    // /respond after an LLM call and an HMAC sign). Nothing releases the row if
    // the middle fails, so before `claimed_at` existed a dead verifier stranded
    // the row permanently: 62,841 sit in `in_review` with verifier_agent_id NULL,
    // frozen since 2026-07-21 [MEASURED 2026-09-22].
    //
    // Those legacy rows are NOT picked up here, and that is deliberate rather
    // than an oversight: `claimed_at` is NULL on every row claimed before the
    // migration, and NULL never satisfies `< staleBefore`. Reclaiming them would
    // produce no fact-verified row anyway — this table has no artifact column for
    // evidence and no task reference to recover one from. Draining them is a
    // separate, explicit decision.
    const leaseTtlMin = Number(process.env['PEER_VERIFY_LEASE_TTL_MIN'] ?? 30);
    const staleBefore = new Date(Date.now() - leaseTtlMin * 60_000).toISOString();

    const { data: pendingRows, error } = await db
      .from('peer_verification_queue')
      .select('*')
      .eq('verification_status', 'pending')
      .limit(10);

    if (error) {
      console.error('[PeerVerificationReader] Error fetching pending queue:', error.message);
      return;
    }

    // L2 breaker 2.4 — NEVER RECLAIM A LEASE NOTHING CAN CLEAR.
    //
    // The verdict that releases a row is posted by the PANEL. When
    // PEER_VERIFY_PANEL_ENABLED is false the panel never runs, so a reclaimed row
    // is guaranteed — not merely likely — to expire again, be reclaimed again, and
    // spawn another peer_verify task every TTL, for ever.
    //
    // That is not hypothetical. MEASURED 2026-09-23: 7 queue rows produced 339
    // peer_verify tasks in 8 hours. 7 rows x 2 reclaims/hr (30m TTL) x 3 panel
    // members = 42 tasks/hr, which is the plateau the fleet actually ran at, to the
    // task. Across all 140,194 rows this table has ever held, `verifier_agent_id`
    // is non-null on ZERO of them — no verdict has ever landed, so every claim
    // this reader has ever made was already certain to expire.
    //
    // The lease migration said this in advance and was not followed:
    //   "a reclaimed row re-wedges on the next provider hiccup. The column is the
    //    fix; the reclaim is a separate, later decision that this migration
    //    deliberately does NOT make."
    // (migrations/2026_09_22_peer_verification_queue_lease_and_closure.sql)
    // The column and the reclaim shipped together in #841 anyway, and the loop
    // started the next morning at 06:58Z.
    //
    // Dating a stale claim is still correct and is kept. Acting on that date while
    // the releasing step is switched off is what is wrong, so the reclaim is gated
    // on the panel rather than removed.
    const panelOn = peerVerifyPanelEnabled();

    // BACKUP BOUND (belt to the gate's braces). Even with the panel ON, a row whose
    // verdict keeps failing would recycle for ever. A reclaim budget makes the worst
    // case finite instead of unbounded: past the cap the row is closed as
    // 'timeout' — a vocabulary this table already uses — and stops being eligible.
    // Chosen because the gate above depends on one env var being false; if someone
    // enables the panel before the verdict path is proven, this is what holds.
    const reclaimCap = Number(process.env['PEER_VERIFY_RECLAIM_CAP'] ?? 3);

    let expiredRows: PeerVerificationQueueEntry[] | null = null;
    let expiredErr: { message: string } | null = null;

    if (!panelOn) {
      console.log(
        '[PeerVerificationReader] panel DISABLED (PEER_VERIFY_PANEL_ENABLED) — ' +
          'expired-lease reclaim skipped: nothing can post the verdict that would ' +
          'clear the lease, so reclaiming is an unbounded spawn loop (breaker 2.4)'
      );
    } else {
      const res = await db
        .from('peer_verification_queue')
        .select('*')
        .eq('verification_status', 'in_review')
        .is('verifier_agent_id', null)
        .lt('claimed_at', staleBefore)
        .lt('reclaim_count', reclaimCap)
        .limit(10);
      expiredRows = res.data as PeerVerificationQueueEntry[] | null;
      expiredErr = res.error;
    }

    if (expiredErr) {
      // NOT_CHECKED, not "none expired": if this read failed we do not know. Say so
      // and continue with pending only, rather than reporting a clean sweep.
      console.error(
        '[PeerVerificationReader] NOT_CHECKED: expired-lease scan failed:',
        expiredErr.message
      );
    } else if (expiredRows && expiredRows.length > 0) {
      console.log(
        `[PeerVerificationReader] reclaiming ${expiredRows.length} row(s) whose ` +
          `lease expired (> ${leaseTtlMin}m in in_review with no verifier).`
      );
    }

    const pending = [...(pendingRows ?? []), ...(expiredRows ?? [])];

    if (!pending || pending.length === 0) {
      return;
    }

    for (const entry of pending) {
      // 2. Claim the row: set in_review AND stamp the lease.
      //
      // The CAS is on the status we OBSERVED, not a hardcoded 'pending', because a
      // row may also be arriving here with an expired lease. For that case the CAS
      // additionally pins `claimed_at` to the value we read, so a lease another
      // worker has since refreshed is never stolen — its claimed_at moved, the
      // match fails, and we skip. A live claim is therefore unstealable while a
      // dead one is reclaimable, which is the whole point of the column.
      // A RECLAIM spends budget; a first claim does not. Incrementing here rather
      // than in the select keeps the count honest under the CAS below: a claim that
      // loses the race never lands, so it never charges the row.
      const isReclaim = entry.verification_status === 'in_review';
      const claimQuery = db
        .from('peer_verification_queue')
        .update({
          verification_status: 'in_review',
          claimed_at: new Date().toISOString(),
          ...(isReclaim ? { reclaim_count: (entry.reclaim_count ?? 0) + 1 } : {}),
        })
        .eq('id', entry.id)
        .eq('verification_status', entry.verification_status);

      const { data: claimed, error: claimErr } = await (
        entry.verification_status === 'in_review'
          ? claimQuery.eq('claimed_at', entry.claimed_at as string)
          : claimQuery
      )
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
