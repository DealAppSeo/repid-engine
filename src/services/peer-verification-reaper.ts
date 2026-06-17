/**
 * PEER VERIFICATION REAPER — server-side self-heal for stuck in_review rows.
 *
 * WHY (diagnosis 2026-06-17): peer_verification_queue completion depends on the 3 Trinity
 * verifier agents (mel/shofet/gcm) picking up dispatched trinity_tasks and POSTing /respond.
 * When those agents go alive-but-hung (fresh heartbeat, runLoop stalled — happened 2026-06-10),
 * dispatched tasks pile up unpicked and pvq rows sit in 'in_review' forever: there is NO
 * server-side timeout sweep, so 21k+ rows accumulated and the writeback loop lost all input.
 *
 * This reaper bounds that failure: stale 'in_review' rows self-heal instead of stuck-forever.
 *   - RE-QUEUE (default): rows older than REQUEUE_HOURS whose dispatched task never completed
 *     → reset to 'pending' so the reader re-dispatches (recovers automatically once agents revive),
 *     and mark the stale dispatched peer_verify task 'failed' so it can't double-count.
 *   - TIMEOUT (terminal): rows older than DEAD_HOURS → mark 'timeout' (give up; bounded growth).
 *
 * SAFE BY DEFAULT: master flag PEER_VERIFY_REAPER_ENABLED defaults OFF (house style; Sean flips).
 * Generous windows so genuinely-slow-but-real verifiers are never pre-empted. Loud logging.
 * NOTE: the reaper unclogs the queue; it does NOT create verified outcomes — getting *verified*
 * input still needs (a) the un-blind dispatch fix (feat/cc-2026-06-17-validation-loop) and
 * (b) the verifier agents' runLoop alive (Sean: Railway restart/redeploy).
 */
import { pgQuery } from '../db/direct-pg';

const ENABLED = () => (process.env.PEER_VERIFY_REAPER_ENABLED ?? 'false').toLowerCase() === 'true';
const POLL_MS = parseInt(process.env.PEER_VERIFY_REAPER_POLL_MS || '300000', 10); // 5 min
const REQUEUE_HOURS = parseInt(process.env.PEER_VERIFY_REQUEUE_HOURS || '6', 10);
const DEAD_HOURS = parseInt(process.env.PEER_VERIFY_DEAD_HOURS || '72', 10);
const BATCH = parseInt(process.env.PEER_VERIFY_REAPER_BATCH || '200', 10);

let timer: NodeJS.Timeout | null = null;

export async function reapStaleVerifications(): Promise<{ requeued: number; timed_out: number }> {
  // 1. TIMEOUT the truly-dead (older than DEAD_HOURS) — terminal, deterministic, bounds growth.
  const timedOut = await pgQuery<{ id: string }>(
    `UPDATE peer_verification_queue
        SET verification_status = 'timeout', completed_at = now()
      WHERE id IN (
        SELECT id FROM peer_verification_queue
         WHERE verification_status = 'in_review'
           AND created_at < now() - ($1 || ' hours')::interval
         ORDER BY created_at ASC
         LIMIT $2
      )
      RETURNING id`,
    [DEAD_HOURS, BATCH],
    { label: 'peer-verify-reaper-timeout' },
  );

  // 2. RE-QUEUE the recoverable (older than REQUEUE_HOURS, not yet dead) whose dispatched
  //    peer_verify task never completed → reset to 'pending' for re-dispatch.
  const requeued = await pgQuery<{ id: string }>(
    `UPDATE peer_verification_queue
        SET verification_status = 'pending'
      WHERE id IN (
        SELECT pq.id FROM peer_verification_queue pq
         WHERE pq.verification_status = 'in_review'
           AND pq.created_at < now() - ($1 || ' hours')::interval
           AND pq.created_at >= now() - ($2 || ' hours')::interval
         ORDER BY pq.created_at ASC
         LIMIT $3
      )
      RETURNING id`,
    [REQUEUE_HOURS, DEAD_HOURS, BATCH],
    { label: 'peer-verify-reaper-requeue' },
  );

  // 3. Fail the stale dispatched peer_verify tasks for the re-queued rows so they can't double-count.
  if (requeued.length > 0) {
    await pgQuery(
      `UPDATE trinity_tasks
          SET status = 'failed'
        WHERE task_type = 'peer_verify'
          AND status IN ('pending', 'doing')
          AND (metadata->>'peer_verification_queue_id')::bigint = ANY($1::bigint[])`,
      [requeued.map((r) => r.id)],
      { label: 'peer-verify-reaper-fail-stale-tasks' },
    );
  }

  const result = { requeued: requeued.length, timed_out: timedOut.length };
  if (result.requeued > 0 || result.timed_out > 0) {
    console.warn(
      `[PeerVerifyReaper] re-queued ${result.requeued} stale in_review (>${REQUEUE_HOURS}h) for re-dispatch; ` +
      `timed-out ${result.timed_out} dead (>${DEAD_HOURS}h). Self-heal active.`,
    );
  }
  return result;
}

export function startPeerVerificationReaper(): void {
  if (!ENABLED()) {
    console.log('[PeerVerifyReaper] disabled (PEER_VERIFY_REAPER_ENABLED!=true) — skipping');
    return;
  }
  if (timer) clearInterval(timer);
  console.log(`[PeerVerifyReaper] starting (poll ${POLL_MS}ms, requeue>${REQUEUE_HOURS}h, dead>${DEAD_HOURS}h)`);
  timer = setInterval(() => {
    reapStaleVerifications().catch((e) => console.error('[PeerVerifyReaper] reap error:', e?.message ?? e));
  }, POLL_MS);
}

export function stopPeerVerificationReaper(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
