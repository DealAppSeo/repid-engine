import { db } from '../db';
import { runPCP } from './pcp-validator';
import { runAdversarialJudge } from './adversarial-judge';
import { applyValidationDeltas } from './validation-repid-delta';

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
  
  // Also start a timeout watcher
  setInterval(checkTimeouts, 60_000);
}

async function processQueue() {
  try {
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
      // Atomic claim approximation
      const { data: updated, error: updateErr } = await db
        .from('validation_queue')
        .update({ status: 'processing', processed_at: new Date().toISOString() })
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
    const statusMap: Record<string, string> = {
      'verified': 'completed',
      'challenged': 'completed',
      'escalated': 'escalated'
    };

    const finalStatus = statusMap[workerVerdict] || 'escalated';

    await db.from('validation_queue').update({
      status: finalStatus,
      pcp_score: pcpScore,
      judge_verdict: judgeVerdict,
      judge_confidence: judgeResult.confidence,
      validator_agents: pcpResult.validators,
      worker_verdict: workerVerdict
    }).eq('id', claim.id);

    // 5. Update trinity_tasks
    let taskStatus = 'pending_clarification';
    if (workerVerdict === 'verified') taskStatus = 'verified';
    if (workerVerdict === 'challenged') taskStatus = 'challenged';

    await db.from('trinity_tasks').update({
      status: taskStatus
    }).eq('id', claim.task_id);

    // Apply RepID Deltas
    if (workerVerdict !== 'escalated') {
      await applyValidationDeltas(claim.id, taskData, workerVerdict, pcpResult.validators, judgeVerdict);
    }

    // 6. Append hal_audit_chain entry
    await db.rpc('append_hal_audit_chain', {
      source_table: 'validation_queue',
      source_id: claim.id,
      event_payload: {
        task_id: claim.task_id,
        worker_verdict: workerVerdict,
        pcp_score: pcpScore,
        judge_verdict: judgeVerdict,
        judge_confidence: judgeResult.confidence,
        validator_agents: pcpResult.validators,
        claimer_delta: workerVerdict === 'verified' ? 200 : -500, // simplified, real delta logged in pipeline
        phase_2_6_signature: true,
        provenance: taskData.metadata?._provenance_source || null
      }
    });

  } catch (err: any) {
    console.error(`[ValidationWorker] Error processing claim ${claim.id}:`, err.message);
    await db.from('validation_queue').update({ status: 'failed' }).eq('id', claim.id);
  }
}

async function checkTimeouts() {
  try {
    const timeoutMs = TIMEOUT_HOURS * 60 * 60 * 1000;
    const cutoffDate = new Date(Date.now() - timeoutMs).toISOString();

    const { data: oldClaims } = await db
      .from('validation_queue')
      .select('id, task_id')
      .eq('status', 'processing')
      .lt('processed_at', cutoffDate);

    if (oldClaims && oldClaims.length > 0) {
      for (const claim of oldClaims) {
        await db.from('validation_queue').update({ status: 'escalated', worker_verdict: 'escalated' }).eq('id', claim.id);
        await db.from('trinity_tasks').update({ status: 'pending_clarification' }).eq('id', claim.task_id);
      }
    }
  } catch (err: any) {
    console.error('[ValidationWorker] Timeout checker error:', err.message);
  }
}
