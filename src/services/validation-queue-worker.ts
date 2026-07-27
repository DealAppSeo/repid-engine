import { db } from '../db';
import { runPCP } from './pcp-validator';
import { runAdversarialJudge } from './adversarial-judge';
import { applyValidationDeltas } from './validation-repid-delta';
import { HitlReason, HitlResolution, hitlService } from './hitl-service';
import { appendToAuditChain } from './auditChainWriter';
import { shouldParkForHalt } from './emergency-halt';

const POLL_INTERVAL_MS = parseInt(process.env.VALIDATION_WORKER_POLL_MS || '30000', 10);
const BATCH_SIZE = parseInt(process.env.VALIDATION_BATCH_SIZE || '5', 10);
const ENABLED = () => process.env.VALIDATION_WORKER_ENABLED === 'true';
const TIMEOUT_HOURS = parseInt(process.env.VALIDATION_TIMEOUT_HOURS || '4', 10);

export async function startValidationWorker() {
  if (!ENABLED()) {
    console.log('[ValidationWorker] Disabled via env flag, skipping');
    return;
  }
  console.log('[ValidationWorker] Starting poll loop');
  setInterval(processQueue, POLL_INTERVAL_MS);
  setInterval(pollResolvedHitlEntries, POLL_INTERVAL_MS);
  
  // Also start a timeout watcher
  setInterval(checkTimeouts, 60_000);
}

async function processQueue() {
  try {
    // L0 gate 0.4 — global emergency halt. Park before claiming: entries stay
    // 'pending' and are picked up unchanged when the switch is flipped back.
    if (await shouldParkForHalt(db, 'ValidationWorker')) return;

    // Fetch pending entries (atomic claim via UPDATE RETURNING is not directly supported by supabase js without rpc, but we can do a select then update)
    // Actually, Supabase `.update()` doesn't easily act as a row-lock queue out of the box without RPC, but we'll approximate atomic claim:
    const { data: claims, error: claimErr } = await db
      .from('validation_queue')
      .select('id, task_id')
      .eq('status', 'pending')
      .limit(BATCH_SIZE);

    if (claimErr) {
      console.error('[ValidationWorker] Error fetching tasks:', claimErr.message);
      return;
    }

    if (!claims || claims.length === 0) return;

    for (const claim of claims) {
      // Atomic claim approximation.
      // NOTE: do NOT set processed_at here. The validation_queue_processed_check
      // constraint enforces (status IN completed/failed/skipped) == (processed_at
      // IS NOT NULL); a 'processing' row must keep processed_at NULL. processed_at
      // is set only by the terminal (completed/failed) branches below.
      const { data: updated, error: updateErr } = await db
        .from('validation_queue')
        .update({ status: 'processing' })
        .eq('id', claim.id)
        .eq('status', 'pending')
        .select('id');

      if (!updateErr && updated && updated.length > 0) {
        await processSingleTask(claim);
      }
    }
  } catch (err: any) {
    console.error('[ValidationWorker] Queue processing error:', err.message);
  }
}

async function processSingleTask(claim: any) {
  try {
    // Load source task
    const { data: taskData, error: taskErr } = await db
      .from('trinity_tasks')
      .select('*')
      .eq('id', claim.task_id)
      .single();

    if (taskErr || !taskData) {
      throw new Error(`Task ${claim.task_id} not found`);
    }

    // 2. Run PCP & Judge
    const pcpResult = await runPCP(taskData);
    const judgeResult = await runAdversarialJudge(taskData);

    // 3. Compute verdict
    const pcpScore = pcpResult.score;
    const pcpConfidence = pcpResult.confidence;
    const judgeVerdict = judgeResult.verdict;

    let workerVerdict = 'escalated';

    const passThreshold = parseFloat(process.env.PCP_THRESHOLD_PASS || '0.7');
    const failThreshold = parseFloat(process.env.PCP_THRESHOLD_FAIL || '0.3');
    const judgeConfMin = parseFloat(process.env.JUDGE_CONFIDENCE_MIN || '0.5');

    // Escalation checks
    if (pcpConfidence < 0.5) {
      workerVerdict = 'escalated';
    } else if (judgeVerdict === 'ESCALATE' || judgeResult.confidence < judgeConfMin) {
      workerVerdict = 'escalated';
    } else if (pcpScore >= passThreshold && judgeVerdict === 'CHALLENGE') {
      workerVerdict = 'escalated'; // Disagreement
    } else if (pcpScore >= passThreshold && judgeVerdict === 'APPROVE') {
      workerVerdict = 'verified';
    } else if (pcpScore <= failThreshold || judgeVerdict === 'CHALLENGE') {
      workerVerdict = 'challenged';
    } else {
      workerVerdict = 'escalated'; // Fallback
    }

    // 4. Update validation_queue
    if (workerVerdict === 'escalated') {
      const reason: HitlReason =
        pcpConfidence < 0.5 ? 'pcp_low_confidence' :
        judgeVerdict === 'ESCALATE' ? 'judge_escalated' :
        (pcpScore >= passThreshold && judgeVerdict === 'CHALLENGE') ? 'judge_pcp_disagreement' :
        'judge_escalated';

      const { id: hitlRequestId } = await hitlService.createRequest({
        taskId: taskData.id,
        validationQueueId: claim.id,
        reason,
        context: {
          pcpScore,
          pcpConfidence,
          judgeVerdict,
          judgeConfidence: judgeResult.confidence,
          validatorAgents: pcpResult.validators,
          taskSnapshot: { prompt: taskData.prompt, result: taskData.result, claimed_by: taskData.claimed_by, tier: taskData.tier },
          workerVerdictPreHitl: 'escalated',
        },
      });

      // Update validation_queue to reflect pending HITL state (keep status processing)
      await db.from('validation_queue').update({
        status: 'processing',
        worker_verdict: 'escalated',
        pcp_score: pcpScore,
        judge_verdict: judgeVerdict,
        judge_confidence: judgeResult.confidence,
        validator_agents: pcpResult.validators,
        metadata: { ...claim.metadata, hitl_request_id: hitlRequestId },
      }).eq('id', claim.id);

      // Update trinity_tasks status — DO NOT apply RepID deltas yet
      await db.from('trinity_tasks').update({
        status: 'pending_clarification',
      }).eq('id', taskData.id);

    } else {
      await db.from('validation_queue').update({
        status: 'completed',
        processed_at: new Date().toISOString(),
        pcp_score: pcpScore,
        judge_verdict: judgeVerdict,
        judge_confidence: judgeResult.confidence,
        validator_agents: pcpResult.validators,
        worker_verdict: workerVerdict
      }).eq('id', claim.id);

      let taskStatus = workerVerdict === 'verified' ? 'verified' : 'challenged';
      await db.from('trinity_tasks').update({
        status: taskStatus
      }).eq('id', claim.task_id);

      await applyValidationDeltas(claim.id, taskData, workerVerdict, pcpResult.validators, judgeVerdict);

      // Append hal_audit_chain entry. Correct 4-arg p_-prefixed RPC via the
      // shared appendToAuditChain helper (the prior raw 3-arg unprefixed call
      // matched no function and silently no-op'd). Isolated try/catch: an
      // audit-anchor failure must NOT bubble to processSingleTask's outer
      // catch (which would mark this already-completed row 'failed'). Patent
      // surface — fail LOUDLY (stack), never silently.
      try {
        await appendToAuditChain('validation_queue', claim.id, {
          task_id: claim.task_id,
          worker_verdict: workerVerdict,
          pcp_score: pcpScore,
          judge_verdict: judgeVerdict,
          judge_confidence: judgeResult.confidence,
          validator_agents: pcpResult.validators,
          claimer_delta: workerVerdict === 'verified' ? 200 : -500,
          phase_2_6_signature: true,
          provenance: taskData.metadata?._provenance_source || null
        });
      } catch (auditErr: any) {
        console.error(
          `[ValidationWorker] hal_audit_chain append FAILED for validation_queue ${claim.id} ` +
          `(verdict recorded but NOT anchored — patent-surface gap):`,
          auditErr?.stack ?? auditErr
        );
      }
    }

  } catch (err: any) {
    console.error(`[ValidationWorker] Error processing claim ${claim.id}:`, err.message);
    await db.from('validation_queue').update({ status: 'failed', processed_at: new Date().toISOString() }).eq('id', claim.id);
  }
}

export async function checkTimeouts() {
  // L0 gate 0.4 — reaps stuck claims and writes them back. Its own
  // setInterval, so it needs its own gate.
  if (await shouldParkForHalt(db, 'ValidationWorker:checkTimeouts')) return;
  try {
    // Default timeout to 15 minutes if TIMEOUT_HOURS is missing or invalid
    const TIMEOUT_MINUTES = typeof TIMEOUT_HOURS !== 'undefined' ? TIMEOUT_HOURS * 60 : 15;
    const timeoutMs = TIMEOUT_MINUTES * 60 * 1000;
    const cutoffDate = new Date(Date.now() - timeoutMs).toISOString();

    const { data: stuckClaims } = await db
      .from('validation_queue')
      .select('id, task_id, metadata, created_at')
      .eq('status', 'processing')
      .lt('created_at', cutoffDate); // Use created_at since claimed_at is not on the schema and processed_at is NULL

    if (stuckClaims && stuckClaims.length > 0) {
      for (const claim of stuckClaims) {
        const isHitlPending = claim.metadata?.hitl_request_id != null;
        
        if (isHitlPending) {
          const ageMs = Date.now() - new Date(claim.created_at).getTime();
          // HITL-pending past 24 hours alert (N=24h) - configure this elsewhere later
          if (ageMs > 24 * 60 * 60 * 1000) {
            console.warn(`[ValidationWorker] HITL-pending ALERT: task ${claim.task_id} (queue ${claim.id}) pending > 24h.`);
          } else {
            console.info(`[ValidationWorker] HITL-pending: task ${claim.task_id} (queue ${claim.id}) is waiting on HITL.`);
          }
        } else {
          // Genuine stuck row
          const ageMins = Math.round((Date.now() - new Date(claim.created_at).getTime()) / 60000);
          console.error(`[ValidationWorker] Genuine stuck processing row detected: id=${claim.id}, task_id=${claim.task_id}, created_at=${claim.created_at}, age=${ageMins}m. Resetting to pending.`);
          
          await db.from('validation_queue').update({
            status: 'pending',
            processed_at: null,
            metadata: { ...claim.metadata, worker_reset_at: new Date().toISOString() }
          }).eq('id', claim.id);
        }
      }
    }
  } catch (err: any) {
    console.error('[ValidationWorker] Timeout checker error:', err.message);
  }
}

async function pollResolvedHitlEntries(): Promise<void> {
  // L0 gate 0.4 — finalizes HITL-resolved entries (mutates validation_queue
  // and task status). Scheduled by its OWN setInterval; the gate in
  // processQueue does not cover it. Found by making the coverage pin count
  // per LOOP instead of per FILE.
  if (await shouldParkForHalt(db, 'ValidationWorker:pollResolvedHitl')) return;
  const { data: entries, error } = await db.from('validation_queue')
    .select('*')
    .in('status', ['processing', 'completed'])
    .filter('metadata->>hitl_resolved', 'eq', 'true')
    .is('metadata->>hitl_finalized', null)
    .limit(BATCH_SIZE);

  if (error) {
    console.error('[ValidationWorker] pollResolvedHitlEntries select failed:', error);
    return;
  }

  for (const entry of (entries ?? [])) {
    try {
      await finalizeHitlResolvedEntry(entry);
    } catch (e: any) {
      console.error(`[ValidationWorker] finalizeHitlResolvedEntry failed for ${entry.id}:`, e?.message ?? e);
    }
  }
}

async function finalizeHitlResolvedEntry(entry: any): Promise<void> {
  const { data: task, error: taskErr } = await db.from('trinity_tasks')
    .select('*')
    .eq('id', entry.task_id)
    .single();

  if (taskErr || !task) {
    throw new Error(`Task ${entry.task_id} not found for validation_queue ${entry.id}: ${taskErr?.message ?? 'no row'}`);
  }

  const resolution = entry.metadata?.hitl_resolution as
    | 'approve_claimer' | 'challenge_claimer' | 'rework_required' | 'no_action';

  await applyValidationDeltas(
    entry.id,
    task,
    mapResolutionToOutcome(resolution),
    entry.validator_agents ?? [],
    entry.judge_verdict ?? null
  );

  await writeHitlResolutionAuditEntry(entry, task, resolution);
  await updateTaskStatusFromResolution(task, resolution);

  await db.from('validation_queue').update({
    status: 'completed',
    processed_at: new Date().toISOString(),
    metadata: {
      ...entry.metadata,
      hitl_delta_applied: true,
      hitl_delta_applied_at: entry.metadata?.hitl_delta_applied_at || new Date().toISOString(),
      hitl_finalized: true,
      hitl_finalized_at: new Date().toISOString(),
    },
  }).eq('id', entry.id);

  console.log(`[ValidationWorker] Finalized HITL-resolved entry ${entry.id} (task ${task.id}, resolution=${resolution})`);
}

function mapResolutionToOutcome(resolution: string): string {
  switch (resolution) {
    case 'approve_claimer':   return 'verified';
    case 'challenge_claimer': return 'challenged';
    case 'rework_required':   return 'rework_required';
    case 'no_action':         return 'no_action';
    default: throw new Error(`Unknown HITL resolution: ${resolution}`);
  }
}

async function writeHitlResolutionAuditEntry(
  entry: any,
  task: any,
  resolution: string
): Promise<void> {
  const payload = {
    event_type: 'HITL_RESOLUTION_APPLIED',
    validation_queue_id: entry.id,
    task_id: task.id,
    claimed_by: task.claimed_by,
    resolution,
    worker_verdict: entry.worker_verdict,
    pcp_score: entry.pcp_score,
    judge_verdict: entry.judge_verdict,
    judge_confidence: entry.judge_confidence,
    validator_agents: entry.validator_agents,
    hitl_request_id: entry.metadata?.hitl_request_id,
    hitl_resolver: entry.metadata?.hitl_resolver,
    hitl_resolved_at: entry.metadata?.hitl_resolved_at,
  };

  const canonical = JSON.stringify(payload, Object.keys(payload).sort());

  const { error } = await db.rpc('append_hal_audit_chain', {
    p_source_table: 'validation_queue',
    p_source_id: entry.id,
    p_event_payload: payload,
    p_canonical_json_text: canonical,
  });

  if (error) {
    throw new Error(`append_hal_audit_chain failed: ${error.message}`);
  }
}

async function updateTaskStatusFromResolution(task: any, resolution: string): Promise<void> {
  let newStatus: string;
  let claimedByUpdate: string | null | undefined = undefined;

  switch (resolution) {
    case 'approve_claimer':   newStatus = 'verified'; break;
    case 'challenge_claimer': newStatus = 'failed'; break;
    case 'rework_required':
      newStatus = 'pending';
      claimedByUpdate = null;
      break;
    case 'no_action':         newStatus = 'done'; break;
    default: throw new Error(`Unknown HITL resolution for task status update: ${resolution}`);
  }

  const update: any = { status: newStatus };
  if (claimedByUpdate !== undefined) {
    update.claimed_by = claimedByUpdate;
  }

  const { error } = await db.from('trinity_tasks')
    .update(update)
    .eq('id', task.id)
    .in('status', ['doing', 'in_progress', 'pending_clarification', 'pending_validation', 'done']);

  if (error) {
    throw new Error(`trinity_tasks status update failed for task ${task.id}: ${error.message}`);
  }
}
