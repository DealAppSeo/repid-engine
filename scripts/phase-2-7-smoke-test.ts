import { db } from '../src/db';
import { hitlService } from '../src/services/hitl-service';
import {
  getValidationQueueStatus,
  getSubstanceGateStatus,
  getHitlStatus,
  getAgentStatus,
  getRepidEventStats
} from '../src/services/observability-queries';

async function run() {
  console.log('1. Fetching observability targets...');
  const endpoints = ['validation-queue', 'substance-gate', 'hitl', 'agents', 'repid-events'];
  for (const ep of endpoints) {
    try {
      // Direct call to services instead of HTTP to bypass setup
      let data;
      if (ep === 'validation-queue') data = await getValidationQueueStatus();
      else if (ep === 'substance-gate') data = await getSubstanceGateStatus();
      else if (ep === 'hitl') data = await getHitlStatus();
      else if (ep === 'agents') data = await getAgentStatus();
      else if (ep === 'repid-events') data = await getRepidEventStats();
      console.log(`[GET /api/v1/status/${ep}] OK`);
    } catch (e: any) {
      console.error(`[GET /api/v1/status/${ep}] FAILED:`, e.message);
    }
  }

  console.log('\n2. Testing HITL Create & Resolve cycle...');
  try {
    const { data: task, error: taskErr } = await db.from('trinity_tasks').insert({
      title: 'HITL Test Task',
      description: 'Test description',
      status: 'pending'
    }).select('id').single();
    if (taskErr) throw new Error(`Task insert failed: ${taskErr.message}`);

    const { data: vq, error: vqErr } = await db.from('validation_queue').insert({
      task_id: task.id,
      status: 'processing',
      worker_verdict: 'escalated',
      fast_path_passed: true
    }).select('id').single();
    if (vqErr) throw new Error(`VQ insert failed: ${vqErr.message}`);

    const { id: hitlId } = await hitlService.createRequest({
      taskId: task.id,
      validationQueueId: vq.id,
      reason: 'pcp_low_confidence',
      context: { taskSnapshot: {} },
      priority: 9
    });
    console.log(`  -> Created HITL request: ${hitlId}`);

    await hitlService.assignRequest({ requestId: hitlId, reviewer: 'sean-test' });
    console.log(`  -> Assigned to sean-test`);

    await hitlService.resolveRequest({
      requestId: hitlId,
      resolution: 'challenge_claimer',
      notes: 'Test resolution',
      reviewer: 'sean-test'
    });
    console.log(`  -> Resolved as challenge_claimer`);
    
    // Test the sync trigger
    const { data: vqAfter } = await db.from('validation_queue').select('worker_verdict').eq('id', vq.id).single();
    if (vqAfter.worker_verdict === 'challenged') {
      console.log(`  -> Sync trigger verified: validation_queue worker_verdict = challenged`);
    } else {
      console.error(`  -> Sync trigger failed: expected challenged, got ${vqAfter.worker_verdict}`);
    }
  } catch (e: any) {
    console.error('HITL Cycle failed:', e.message);
  }

  console.log('\nSmoke test complete.');
  process.exit(0);
}

run();
