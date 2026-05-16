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
  let vqId: number | string = 0;
  let taskId: number | string = 0;
  try {
    const { data: task, error: taskErr } = await db.from('trinity_tasks').insert({
      title: 'HITL Test Task',
      description: 'Test description',
      status: 'pending'
    }).select('id').single();
    if (taskErr) throw new Error(`Task insert failed: ${taskErr.message}`);
    taskId = task.id;

    const { data: vq, error: vqErr } = await db.from('validation_queue').insert({
      task_id: task.id,
      status: 'processing',
      worker_verdict: 'escalated',
      fast_path_passed: true
    }).select('id').single();
    if (vqErr) throw new Error(`VQ insert failed: ${vqErr.message}`);
    vqId = vq.id;

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

  console.log('\n3. Verifying loop closure (waiting for pollResolvedHitlEntries)...');
  const POLL_TIMEOUT_MS = 120_000;  // 2 minutes — give the worker generous slack
  const POLL_INTERVAL_MS = 5_000;   // poll DB every 5s
  const startedAt = Date.now();

  let loopClosed = false;
  let finalVqState: any = null;
  let finalTaskState: any = null;
  let repidEventCount = 0;
  let auditChainCount = 0;

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const [vqResult, ttResult, repidResult, auditResult] = await Promise.all([
      db.from('validation_queue').select('*').eq('id', vqId).single(),
      db.from('trinity_tasks').select('status').eq('id', taskId).single(),
      db.from('repid_score_events').select('id', { count: 'exact', head: true })
        // Note: Using metadata->>task_id instead of event_payload->>task_id as discovered in audit
        .filter('metadata->>task_id', 'eq', taskId.toString()),
      db.from('hal_audit_chain').select('id', { count: 'exact', head: true })
        .eq('source_table', 'validation_queue')
        .eq('source_id', vqId),
    ]);
    
    finalVqState = vqResult.data;
    finalTaskState = ttResult.data;
    repidEventCount = repidResult.count ?? 0;
    auditChainCount = auditResult.count ?? 0;
    
    const deltaApplied = finalVqState?.metadata?.hitl_delta_applied === true;
    const vqTerminal = ['completed', 'failed'].includes(finalVqState?.status);
    const processedAtSet = finalVqState?.processed_at !== null;
    
    if (deltaApplied && vqTerminal && processedAtSet) {
      loopClosed = true;
      break;
    }
    
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (loopClosed) {
    console.log(`  ✅ LOOP CLOSED after ${elapsedSec}s`);
    console.log(`     validation_queue.status = ${finalVqState.status}`);
    console.log(`     validation_queue.processed_at = ${finalVqState.processed_at}`);
    console.log(`     validation_queue.metadata.hitl_delta_applied = ${finalVqState.metadata?.hitl_delta_applied}`);
    console.log(`     trinity_tasks.status = ${finalTaskState?.status}`);
    console.log(`     repid_score_events rows for task = ${repidEventCount}`);
    console.log(`     hal_audit_chain rows for vq_id = ${auditChainCount}`);
    
    if (repidEventCount === 0) {
      console.warn(`  ⚠️  Loop closed but no repid_score_events written — investigate pipeline.applyValidationEvent`);
    }
    if (auditChainCount === 0) {
      console.warn(`  ⚠️  Loop closed but no hal_audit_chain entries — investigate append_hal_audit_chain call`);
    }
  } else {
    console.error(`  ❌ LOOP DID NOT CLOSE within ${elapsedSec}s`);
    console.error(`     Final state:`);
    console.error(`       validation_queue.status = ${finalVqState?.status}`);
    console.error(`       validation_queue.processed_at = ${finalVqState?.processed_at}`);
    console.error(`       validation_queue.metadata = ${JSON.stringify(finalVqState?.metadata)}`);
    console.error(`       trinity_tasks.status = ${finalTaskState?.status}`);
    console.error(`       repid_score_events count = ${repidEventCount}`);
    console.error(`       hal_audit_chain count = ${auditChainCount}`);
    console.error(`\n     This means the polling loop in validation-queue-worker.ts is not closing HITL-resolved entries.`);
    console.error(`     Likely causes: predicate mismatch, exception swallowed, or worker not running.`);
    process.exit(1);  // FAIL the smoke test
  }

  console.log('\nSmoke test complete.');
  process.exit(0);
}

run();
