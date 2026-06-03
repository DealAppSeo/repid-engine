import { hitlService } from './hitl-service';
import { db } from '../db';
import { HitlResolution } from './hitl-service';

const POLL_INTERVAL_MS = parseInt(process.env.HITL_EXPIRATION_POLL_MS || '300000', 10);
const ENABLED = () => process.env.HITL_EXPIRATION_ENABLED !== 'false';
const TIMEOUT_VERDICT = (process.env.HITL_TIMEOUT_VERDICT || 'challenged') as HitlResolution;

export async function startHitlExpirationJob() {
  if (!ENABLED()) {
    console.log('[HitlExpirationJob] Disabled via env flag, skipping');
    return;
  }
  console.log('[HitlExpirationJob] Starting loop');
  const interval = setInterval(runExpirationSweep, POLL_INTERVAL_MS);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }
}

async function runExpirationSweep() {
  try {
    const { expired, expiredIds } = await hitlService.expireStaleRequests();
    if (expired === 0) return;

    console.log(`[HitlExpirationJob] Expired ${expired} requests`);

    for (const requestId of expiredIds) {
      try {
        const request = await hitlService.getRequest(requestId);
        if (!request) continue;

        if (request.validationQueueId) {
          // Update validation queue to sync resolution (which simulates hitting the resolve endpoint)
          await hitlService.resolveRequest({
            requestId,
            resolution: TIMEOUT_VERDICT,
            notes: 'Auto-expired due to timeout',
            reviewer: 'system'
          });
        } else {
          // If no validation queue ID, we just close the task
          await db.from('trinity_tasks').update({ status: 'done' }).eq('id', request.taskId);
          
          await db.rpc('append_hal_audit_chain', {
            source_table: 'hitl_requests',
            source_id: requestId,
            event_payload: { resolution: TIMEOUT_VERDICT, event: 'timeout_expiration', task_id: request.taskId }
          });
        }
      } catch (err: any) {
        console.error(`[HitlExpirationJob] Error processing expired request ${requestId}:`, err.message);
      }
    }
  } catch (err: any) {
    console.error('[HitlExpirationJob] Sweep error:', err.message);
  }
}
