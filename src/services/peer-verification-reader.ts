/**
 * Phase 1b — Un-blind the verifiers (feat/cc-2026-06-17-validation-loop)
 *
 * BEFORE: the task dispatched to verifiers only contained `claim_text` from the
 * peer_verification_queue row. The verifier had NO access to:
 *   - the source agent's actual answer/deliverable
 *   - the original prompt/task that generated the claim
 *   - any artifact the source produced
 *
 * This produced 92.78% dispute/timeout: verifiers literally couldn't judge because
 * they had no evidence — only a short claim snippet with no context.
 *
 * AFTER: before dispatching, we do TWO service-role reads (via pgQuery hot-path,
 * RULE-8 compliant) to fetch:
 *   1. The source agent's completed trinity_task result (prompt + answer + artifact)
 *   2. The matching hal_production_events row for HAL score context (best-effort)
 *
 * The verifier now receives all the evidence needed to issue an evidence-based
 * verdict rather than defaulting to timeout.
 *
 * RLS: the worker already runs as service_role (repid-engine Railway env).
 *      No RLS widening required — service_role bypasses RLS by construction.
 */
import { SupabaseClient } from '@supabase/supabase-js';
import { pgQuery } from '../db/direct-pg';
import { PeerVerificationQueueEntry } from '../types/peer-verification';

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
  return (data as any).agent_name as string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1b: Fetch the source artifact for evidence-based judging
// Returns { prompt, answer, artifact_url, hal_score, hal_decision }
// ─────────────────────────────────────────────────────────────────────────────

interface SourceArtifact {
  prompt: string | null;
  answer: string | null;
  artifact_url: string | null;
  hal_score: number | null;
  hal_decision: string | null;
}

async function fetchSourceArtifact(
  sourceAgentId: string,
  sourceResponseId: string | null,
): Promise<SourceArtifact> {
  const empty: SourceArtifact = {
    prompt: null,
    answer: null,
    artifact_url: null,
    hal_score: null,
    hal_decision: null,
  };

  // ── 1. Try trinity_tasks (most likely home for the source response) ────────
  // We join on the metadata field that stores source_response_id, OR look up
  // the most recent completed task from this source agent.
  try {
    const rows = await pgQuery<{
      title: string | null;
      description: string | null;
      result: string | null;
      artifact_url: string | null;
    }>(
      `SELECT title, description, result, artifact_url
       FROM trinity_tasks
       WHERE agent_assigned = (
         SELECT agent_name FROM repid_agents WHERE id = $1 LIMIT 1
       )
         AND status = 'completed'
         AND ($2::text IS NULL OR metadata->>'source_response_id' = $2::text
              OR metadata->>'peer_verification_queue_source' = $2::text)
       ORDER BY completed_at DESC
       LIMIT 1`,
      [sourceAgentId, sourceResponseId],
      { label: 'pv-reader-source-artifact-task', retries: 1 },
    );

    if (rows.length > 0) {
      const row = rows[0]!;
      const answer = row.result ?? null;
      const prompt = [row.title, row.description].filter(Boolean).join('\n\n') || null;
      // ── 2. Enrich with HAL score from hal_production_events (best-effort) ──
      let hal_score: number | null = null;
      let hal_decision: string | null = null;
      if (sourceResponseId) {
        try {
          const halRows = await pgQuery<{ score: number | null; decision: string | null }>(
            `SELECT score, decision
             FROM hal_production_events
             WHERE agent_id = $1
               AND ($2::text IS NULL OR response_id::text = $2::text
                    OR metadata->>'source_response_id' = $2::text)
             ORDER BY created_at DESC
             LIMIT 1`,
            [sourceAgentId, sourceResponseId],
            { label: 'pv-reader-hal-enrich', retries: 1 },
          );
          if (halRows.length > 0) {
            hal_score = halRows[0]!.score ?? null;
            hal_decision = halRows[0]!.decision ?? null;
          }
        } catch (halErr: any) {
          // Best-effort — hal_production_events may have different schema; ignore
          console.debug('[PeerVerificationReader] HAL enrich skipped:', halErr.message);
        }
      }
      return { prompt, answer, artifact_url: row.artifact_url ?? null, hal_score, hal_decision };
    }
  } catch (err: any) {
    console.warn('[PeerVerificationReader] source artifact fetch (trinity_tasks) failed:', err.message);
  }

  // ── 3. Fallback: try hal_production_events directly by agent + response id ─
  if (sourceResponseId) {
    try {
      const halRows = await pgQuery<{
        prompt_text: string | null;
        response_text: string | null;
        score: number | null;
        decision: string | null;
      }>(
        `SELECT prompt_text, response_text, score, decision
         FROM hal_production_events
         WHERE agent_id = $1
           AND (response_id::text = $2::text OR metadata->>'source_response_id' = $2::text)
         ORDER BY created_at DESC
         LIMIT 1`,
        [sourceAgentId, sourceResponseId],
        { label: 'pv-reader-source-artifact-hal', retries: 1 },
      );
      if (halRows.length > 0) {
        const row = halRows[0]!;
        return {
          prompt: row.prompt_text ?? null,
          answer: row.response_text ?? null,
          artifact_url: null,
          hal_score: row.score ?? null,
          hal_decision: row.decision ?? null,
        };
      }
    } catch (err: any) {
      console.debug('[PeerVerificationReader] source artifact fetch (hal_production_events) failed:', err.message);
    }
  }

  return empty;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build evidence-rich task description for the verifier
// ─────────────────────────────────────────────────────────────────────────────

function buildVerifierDescription(
  queueEntry: PeerVerificationQueueEntry,
  sourceAgentName: string,
  artifact: SourceArtifact,
  pvqId: string | number,
): string {
  const lines: string[] = [
    `[PEER_VERIFY TASK] You are reviewing a response produced by agent ${sourceAgentName}.`,
    ``,
    `CLAIM UNDER REVIEW (queue entry ${pvqId}):`,
    `  certainty_at_claim: ${queueEntry.certainty_at_claim}`,
    `  threshold_used: ${queueEntry.threshold_used ?? 0.85}`,
    `  claim_text: "${queueEntry.claim_text ?? '(none provided)'}"`,
  ];

  if (artifact.prompt) {
    lines.push(``, `ORIGINAL PROMPT / TASK:`);
    lines.push(artifact.prompt.slice(0, 800));
  }

  if (artifact.answer) {
    lines.push(``, `SOURCE AGENT ANSWER / DELIVERABLE:`);
    lines.push(artifact.answer.slice(0, 1200));
  } else {
    lines.push(``, `⚠ NO SOURCE ARTIFACT RETRIEVED — verify on claim_text only. Default 'disputed' if insufficient evidence.`);
  }

  if (artifact.artifact_url) {
    lines.push(``, `ARTIFACT URL: ${artifact.artifact_url}`);
  }

  if (artifact.hal_score !== null) {
    lines.push(``, `HAL SCORE: ${artifact.hal_score.toFixed(3)} | HAL DECISION: ${artifact.hal_decision ?? 'unknown'}`);
  }

  lines.push(
    ``,
    `VERDICT INSTRUCTIONS:`,
    `  - "verified": the source agent's answer is factually correct and complete`,
    `  - "disputed": you found errors, hallucinations, or insufficient evidence`,
    `  - "timeout": you cannot judge (use ONLY if artifact is missing AND claim is unverifiable)`,
    ``,
    `Submit your verdict: POST /api/v1/peer-verification/respond`,
    `  { queue_id: ${pvqId}, verifier_agent_id: <your_id>, verifier_response_id: <uuid>, verdict: "verified|disputed|timeout", signature: <hmac> }`,
  );

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main polling loop
// ─────────────────────────────────────────────────────────────────────────────

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

      // 3. Phase 1b: Fetch source artifact for evidence-based judging
      const sourceArtifact = await fetchSourceArtifact(
        queueEntry.source_agent_id,
        queueEntry.source_response_id,
      );

      if (sourceArtifact.answer) {
        console.log(
          `[PeerVerificationReader] queue ${queueEntry.id}: fetched source artifact ` +
          `(answer_len=${sourceArtifact.answer.length} hal=${sourceArtifact.hal_score ?? 'n/a'})`,
        );
      } else {
        console.warn(
          `[PeerVerificationReader] queue ${queueEntry.id}: no source artifact found — ` +
          `verifier will judge on claim_text only (fallback path)`,
        );
      }

      // 4. UUID-based verifier selection (excluding the source agent)
      const { data: verifierAgents } = await db
        .from('repid_agents')
        .select('id, agent_name')
        .in('agent_name', VERIFIER_POOL);

      const eligibleVerifiers = (verifierAgents as any[] | null)
        ?.filter((agent) => agent.id !== queueEntry.source_agent_id)
        .map((agent) => agent.agent_name) || [];

      if (eligibleVerifiers.length === 0) {
        // Fallback if the pool somehow is empty (e.g. source is the only verifier)
        eligibleVerifiers.push(VERIFIER_POOL[0] ?? 'trinity-mel');
      }

      // Stateless deterministic round-robin based on queue ID
      const chosenVerifier = eligibleVerifiers[Number(queueEntry.id) % eligibleVerifiers.length];

      // 5. Dispatch task to trinity_tasks — with full evidence in description
      const evidenceDescription = buildVerifierDescription(
        queueEntry,
        sourceAgentName,
        sourceArtifact,
        queueEntry.id,
      );

      const { data: task, error: taskErr } = await db
        .from('trinity_tasks')
        .insert({
          title: `[PEER_VERIFY] Verify response from ${sourceAgentName}`,
          description: evidenceDescription,
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
            // Phase 1b: carry evidence fetch result for downstream audit
            evidence_fetched: {
              has_answer: !!sourceArtifact.answer,
              has_prompt: !!sourceArtifact.prompt,
              has_artifact_url: !!sourceArtifact.artifact_url,
              hal_score: sourceArtifact.hal_score,
              hal_decision: sourceArtifact.hal_decision,
            },
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
        `[PeerVerificationReader] Dispatched queue entry ${queueEntry.id} to verifier ${chosenVerifier} ` +
        `(Task ID: ${(task as any).id}, evidence_fetched=${!!sourceArtifact.answer})`,
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
  console.log('[PeerVerificationReader] Starting polling loop (Phase 1b: evidence-aware)');
  readerInterval = setInterval(() => processPeerVerificationQueue(db), POLL_INTERVAL_MS);
}

export function stopPeerVerificationReader(): void {
  if (readerInterval) {
    clearInterval(readerInterval);
    readerInterval = null;
    console.log('[PeerVerificationReader] Polling loop stopped');
  }
}
