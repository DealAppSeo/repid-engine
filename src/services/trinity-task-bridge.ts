import crypto from 'crypto';
import { db } from '../db';
import { runScoreEvent } from '../scoring/pipeline';
import { enqueueVerification } from './peer-verification-writer';
import { classifyPeerVerifyClaim } from './peer-verify-prefilter';

const POLL_INTERVAL_MS = parseInt(process.env.TRINITY_BRIDGE_POLL_MS || '30000', 10);
const ENABLED = () => process.env.TRINITY_BRIDGE_ENABLED !== 'false';

let isRunning = false;
let startTimestamp: string;

export function normalizeAgentName(assigned: string | null | undefined): string {
  if (!assigned) return 'trinity-veritas';
  let name = assigned.trim().toLowerCase();
  if (!name.startsWith('trinity-')) {
    name = `trinity-${name}`;
  }
  return name;
}

// Verdicts that mean an independent verifier UPHELD the claim.
const PASS_VERDICTS = new Set(['pass', 'verified', 'approved', 'confirmed', 'upheld']);

/**
 * repid_verified = true ONLY when an INDEPENDENT verifier checked the task and it
 * PASSED. The peer-verify system guarantees verifier != source, so the presence of
 * a verifier_agent_id + a pass verdict means someone other than the claimant signed
 * off. Self-completion alone is NEVER "verified" — that is the hard rule (an agent
 * may not validate its own work). Exposed for tests.
 */
export function isIndependentlyVerified(task: {
  verifier_agent_id?: string | null;
  verify_count?: number | null;
  final_verdict?: string | null;
  verifier_verdict?: string | null;
}): boolean {
  const hasIndependentVerifier = !!task.verifier_agent_id && (task.verify_count ?? 0) >= 1;
  if (!hasIndependentVerifier) return false;
  const fv = String(task.final_verdict ?? '').toLowerCase();
  const vv = String(task.verifier_verdict ?? '').toLowerCase();
  return PASS_VERDICTS.has(fv) || PASS_VERDICTS.has(vv);
}

function generateDeterministicUuid(taskId: number | string): string {
  const hash = crypto.createHash('sha256').update(String(taskId)).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16), // version 4
    (parseInt(hash.substring(16, 17), 16) & 0x3 | 0x8).toString(16) + hash.substring(17, 20), // variant
    hash.substring(20, 32)
  ].join('-');
}

export async function startTrinityTaskBridge() {
  if (!ENABLED()) {
    console.log('[TrinityTaskBridge] Disabled via env flag, skipping');
    return;
  }
  
  // Start from 10 minutes before the worker booted to catch anything that was done recently
  startTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  console.log(`[TrinityTaskBridge] Starting task bridge worker, polling tasks completed since ${startTimestamp}`);
  
  setInterval(pollCompletedTasks, POLL_INTERVAL_MS);
  // Run once immediately on startup
  pollCompletedTasks();
}

async function pollCompletedTasks() {
  if (isRunning) return;
  isRunning = true;

  try {
    // Query recently completed done, shadow_reject, or verified tasks that are not yet repid_verified
    const { data: tasks, error: fetchErr } = await db
      .from('trinity_tasks')
      .select('id, agent_assigned, claimed_by, agent_name, completed_by, status, result, belief, uncertainty, certainty, title, description, task_type, metadata, completed_at, updated_at, verifier_agent_id, verifier_verdict, final_verdict, verify_count, verification_required, needs_peer')
      .in('status', ['done', 'shadow_reject', 'verified'])
      // Dedup on the bridge's OWN marker (metadata.repid_bridged), NOT repid_verified.
      // repid_verified is now reserved to mean, honestly, "an INDEPENDENT peer verifier
      // checked this and it passed" — self-completion is never "verified". (runScoreEvent
      // is idempotent per idempotency_key, so a missed dedup can never double-score.)
      .or('metadata->>repid_bridged.is.null,metadata->>repid_bridged.neq.true')
      .or(`completed_at.gt.${startTimestamp},updated_at.gt.${startTimestamp}`)
      .order('completed_at', { ascending: true })
      .limit(10);

    if (fetchErr) {
      console.error('[TrinityTaskBridge] Error fetching completed tasks:', fetchErr.message);
      isRunning = false;
      return;
    }

    if (!tasks || tasks.length === 0) {
      isRunning = false;
      return;
    }

    console.log(`[TrinityTaskBridge] Found ${tasks.length} pending completed/decision tasks to bridge`);

    for (const task of tasks) {
      try {
        const answer = task.result?.trim() || '';
        if (!answer || answer.toLowerCase() === 'hello' || answer.startsWith('[SOFT-SKIP]')) {
          console.log(`[TrinityTaskBridge] Skipping hello/empty/soft-skip result for task ${task.id}`);
          await markTaskBridged(task);
          continue;
        }

        // Safely parse metadata if it is a string
        let metadataObj: any = {};
        if (task.metadata) {
          if (typeof task.metadata === 'string') {
            try {
              metadataObj = JSON.parse(task.metadata);
            } catch (e) {
              metadataObj = {};
            }
          } else if (typeof task.metadata === 'object') {
            metadataObj = task.metadata;
          }
        }

        // Check if this task has already been scored (e.g. by substance-gate EPISTEMIC_VIOLATION)
        const gateEventId = metadataObj.substance_gate_event_id;
        if (gateEventId) {
          const { data: existingGateEvent, error: gateErr } = await db
            .from('repid_score_events')
            .select('id')
            .eq('idempotency_key', gateEventId)
            .maybeSingle();
          if (gateErr) {
            console.error(`[TrinityTaskBridge] Error checking existing score event for task ${task.id}:`, gateErr.message);
          } else if (existingGateEvent) {
            console.log(`[TrinityTaskBridge] Task ${task.id} already scored via gate event ${gateEventId}, marking bridged`);
            await markTaskBridged(task);
            continue;
          }
        }

        const rawAgent = 
          task.agent_assigned || 
          task.claimed_by || 
          task.agent_name || 
          task.completed_by || 
          metadataObj.processedBy;
        const agentName = normalizeAgentName(rawAgent);

        const { data: agentInfo, error: agentErr } = await db
          .from('repid_agents')
          .select('id')
          .eq('agent_name', agentName)
          .maybeSingle();

        if (agentErr || !agentInfo) {
          console.warn(`[TrinityTaskBridge] Agent '${agentName}' not found in repid_agents for task ${task.id}, skipping`);
          await markTaskBridged(task);
          continue;
        }

        // Map certainty from certainty, belief, uncertainty, or metadata
        let certainty = 0.85;
        if (task.certainty != null && !isNaN(parseFloat(task.certainty))) {
          certainty = parseFloat(task.certainty);
        } else if (task.belief != null && !isNaN(parseFloat(task.belief))) {
          certainty = parseFloat(task.belief);
        } else if (task.uncertainty != null && !isNaN(parseFloat(task.uncertainty))) {
          certainty = 1 - parseFloat(task.uncertainty);
        } else if (metadataObj.certainty != null && !isNaN(parseFloat(metadataObj.certainty))) {
          certainty = parseFloat(metadataObj.certainty);
        }
        certainty = Math.max(0, Math.min(1, certainty));
        if (isNaN(certainty)) {
          certainty = 0.85;
        }

        console.log(`[TrinityTaskBridge] Bridging task ${task.id} (status: ${task.status}, agent: ${agentName}, certainty: ${certainty})`);

        // Run score event
        const scoreResult = await runScoreEvent({
          agent_id: agentInfo.id,
          prompt: task.description || task.title || 'Swarm Task',
          answer: answer,
          task_domain: task.task_type || 'general',
          certainty: certainty,
          idempotency_key: `trinity_task_bridge_${task.id}`,
          llm_call_id: generateDeterministicUuid(task.id),
          provider_used: metadataObj.provider_used || metadataObj.provider || null,
        });

        console.log(`[TrinityTaskBridge] Score event successfully created: id=${scoreResult.score_event_id}, hal_score=${scoreResult.hal_score}, delta=${scoreResult.repid_delta_applied}`);

        // Wire: a task flagged verification_required / needs_peer must go to an INDEPENDENT
        // verifier (the bilateral loop), not rest on HAL alone. Enqueue a peer-verification so
        // peer-verification-reader assigns a verifier != source. Skip non-verifiable claims
        // (drill/status) and skip if already independently verified. (Before this, those flags
        // were cosmetic — tasks self-completed with no peer, per the 2026-07-24 dogfood.)
        const wantsPeer = task.verification_required === true || task.needs_peer === true;
        if (wantsPeer && !isIndependentlyVerified(task) && classifyPeerVerifyClaim(answer, certainty).verifiable) {
          const enq = await enqueueVerification(db, {
            source_response_id: generateDeterministicUuid(task.id),
            source_agent_id: agentInfo.id,
            certainty_at_claim: certainty,
            claim_text: answer,
          });
          if (enq) console.log(`[TrinityTaskBridge] Task ${task.id} → peer-verification queued (${enq.id}) for independent check`);
        }

        await markTaskBridged(task);

      } catch (err: any) {
        console.error(`[TrinityTaskBridge] Failed to bridge task ${task.id}:`, err.message);
      }
    }

  } catch (err: any) {
    console.error('[TrinityTaskBridge] Unexpected error in polling loop:', err.message);
  } finally {
    isRunning = false;
  }
}

async function markTaskBridged(task: any) {
  let currentMetadata = {};
  if (task.metadata) {
    if (typeof task.metadata === 'string') {
      try {
        currentMetadata = JSON.parse(task.metadata);
      } catch (e) {
        currentMetadata = {};
      }
    } else if (typeof task.metadata === 'object') {
      currentMetadata = task.metadata;
    }
  }
  // HARD RULE: an agent may not validate its own work. repid_verified reflects
  // INDEPENDENT peer verification only; being scored/bridged is tracked separately
  // via metadata.repid_bridged (the dedup marker).
  const verified = isIndependentlyVerified(task);
  const updatedMetadata = {
    ...currentMetadata,
    repid_bridged: 'true',
    repid_bridged_at: new Date().toISOString(),
    independently_verified: verified,
  };

  const { error: updateErr } = await db
    .from('trinity_tasks')
    .update({
      metadata: updatedMetadata,
      repid_verified: verified, // true ONLY when an independent verifier passed it
    })
    .eq('id', task.id);

  if (updateErr) {
    console.error(`[TrinityTaskBridge] Failed to mark task ${task.id} as bridged in DB:`, updateErr.message);
  } else {
    console.log(`[TrinityTaskBridge] Marked task ${task.id} as bridged`);
  }
}
