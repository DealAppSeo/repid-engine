import { pgQuery } from '../db/direct-pg';
import { db } from '../db';
import { shouldParkForHalt } from './emergency-halt';

// V1.6 — HITL expiry sweeper (CC2 2026-05-27).
// Periodically flips trinity_hitl_requests rows from 'pending' → 'expired' when
// their expires_at lapses. Complements the V1.6 callback handler: if Sean never
// taps a button, the sweeper closes the loop instead of leaving rows pending forever.
//
// Acts ONLY on rows with expires_at IS NOT NULL — so pre-migration pending rows
// (1,978 of them at V1.6 build time) keep expires_at=NULL and are unaffected.
// New HITL rows pick up the 24h default from the migration.
//
// Default OFF — start() exits early unless HITL_EXPIRY_SWEEPER_ENABLED === 'true'.

const POLL_INTERVAL_MS = parseInt(process.env.HITL_EXPIRY_POLL_MS || '60000', 10);
const BATCH_LIMIT = parseInt(process.env.HITL_EXPIRY_BATCH_LIMIT || '100', 10);
const ENABLED = (): boolean => process.env.HITL_EXPIRY_SWEEPER_ENABLED === 'true';

let isRunning = false;

export async function startHitlExpirySweeper(): Promise<void> {
  if (!ENABLED()) {
    console.log('[HitlExpirySweeper] disabled (HITL_EXPIRY_SWEEPER_ENABLED != "true") — skipping start');
    return;
  }
  console.log(`[HitlExpirySweeper] start · poll=${POLL_INTERVAL_MS}ms · batch=${BATCH_LIMIT}`);
  setInterval(pollOnce, POLL_INTERVAL_MS);
  pollOnce();
}

export async function pollOnce(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    // L0 gate 0.4 — GLOBAL EMERGENCY HALT. This sweep runs an UPDATE that
    // resolves HITL requests. Inside the try so the isRunning flag is still
    // released by the finally when the fleet is parked.
    if (await shouldParkForHalt(db, 'HitlExpirySweeper')) return;
    // Atomic flip: lock + mark in one statement; FOR UPDATE SKIP LOCKED is multi-instance safe.
    const expired = await pgQuery<{ id: string }>(
      `UPDATE trinity_hitl_requests
         SET status = 'expired',
             resolved_at = now(),
             resolved_by = 'system:expiry-sweeper'
       WHERE id IN (
         SELECT id FROM trinity_hitl_requests
         WHERE status = 'pending'
           AND expires_at IS NOT NULL
           AND expires_at < now()
         ORDER BY expires_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id::text AS id`,
      [BATCH_LIMIT],
      { label: 'hitl-expiry-sweep' },
    );
    if (expired.length > 0) {
      console.log(`[HitlExpirySweeper] expired ${expired.length} request(s)`);
    }
  } catch (e: any) {
    console.error('[HitlExpirySweeper] poll error:', e?.message ?? e);
  } finally {
    isRunning = false;
  }
}
