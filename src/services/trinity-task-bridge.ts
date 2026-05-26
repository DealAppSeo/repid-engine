import { db } from '../db';
import { runScoreEvent } from '../scoring/pipeline';

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
    // Query recently completed done tasks that are not yet verified
    const { data: tasks, error: fetchErr } = await db
      .from('trinity_tasks')
      .select('id, agent_assigned, status, result, belief, uncertainty, title, description, task_type, metadata, completed_at, updated_at')
      .eq('status', 'done')
      .eq('repid_verified', false)
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

    console.log(`[TrinityTaskBridge] Found ${tasks.length} pending done tasks to bridge`);

    for (const task of tasks) {
      try {
        const answer = task.result?.trim() || '';
        if (!answer || answer.toLowerCase() === 'hello') {
          console.log(`[TrinityTaskBridge] Skipping hello/empty result for task ${task.id}`);
          await markTaskBridged(task);
          continue;
        }

        const agentName = normalizeAgentName(task.agent_assigned);
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

        // Map certainty from belief or uncertainty
        let certainty = 0.85;
        if (task.belief != null) {
          certainty = parseFloat(task.belief);
        } else if (task.uncertainty != null) {
          certainty = 1 - parseFloat(task.uncertainty);
        }
        certainty = Math.max(0, Math.min(1, certainty));

        console.log(`[TrinityTaskBridge] Bridging task ${task.id} (agent: ${agentName}, certainty: ${certainty})`);

        // Run score event
        const scoreResult = await runScoreEvent({
          agent_id: agentInfo.id,
          prompt: task.description || task.title || 'Swarm Task',
          answer: answer,
          task_domain: task.task_type || 'general',
          certainty: certainty,
          idempotency_key: `trinity_task_bridge_${task.id}`,
        });

        console.log(`[TrinityTaskBridge] Score event successfully created: id=${scoreResult.score_event_id}, hal_score=${scoreResult.hal_score}, delta=${scoreResult.repid_delta_applied}`);

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
  const currentMetadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const updatedMetadata = {
    ...currentMetadata,
    repid_bridged: 'true',
    repid_bridged_at: new Date().toISOString()
  };

  const { error: updateErr } = await db
    .from('trinity_tasks')
    .update({
      metadata: updatedMetadata,
      repid_verified: true
    })
    .eq('id', task.id);

  if (updateErr) {
    console.error(`[TrinityTaskBridge] Failed to mark task ${task.id} as bridged in DB:`, updateErr.message);
  } else {
    console.log(`[TrinityTaskBridge] Marked task ${task.id} as bridged`);
  }
}
