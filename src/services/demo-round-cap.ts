/**
 * The demo round's daily cap, counted in the database (F-13; Strix finding on #1251, 2026-10-07).
 *
 * The first version counted in process memory, so a restart reset it and a second replica kept its
 * own count: a "cap" that held only while one process lived. The count now lives in hal_audit_chain,
 * which every replica shares and no restart clears.
 *
 * Each attempt is appended BEFORE it is counted (source_table 'demo_round_attempts'), then today's
 * attempts are counted. Appends go through the append_hal_audit_chain RPC one row at a time, so two
 * concurrent calls each see the other's row: both may refuse (over-refusal), neither runs past the
 * cap. A refused attempt is recorded too, which only makes the cap stricter.
 *
 * An append or a count that fails is NOT CHECKED, and the caller refuses: a write that could not be
 * counted is not allowed to run uncounted.
 */
import { db } from '../db';
import { emitAuditEvent } from './audit-emit';

export const DEMO_ROUND_ATTEMPT_SOURCE = 'demo_round_attempts';

export type DemoRoundClaim =
  | { ok: true; used: number; cap: number }
  | { ok: false; reason: 'cap_reached'; used: number; cap: number }
  | { ok: false; reason: 'not_checked'; cap: number; error: string };

export async function claimDemoRoundSlot(cap: number, now: Date = new Date()): Promise<DemoRoundClaim> {
  if (cap <= 0) return { ok: false, reason: 'cap_reached', used: 0, cap };
  const day = now.toISOString().slice(0, 10);

  const appended = await emitAuditEvent({
    event_type: 'demo_round_attempt',
    source_table: DEMO_ROUND_ATTEMPT_SOURCE,
    payload: { day },
  });
  if (!appended.ok) {
    return { ok: false, reason: 'not_checked', cap, error: appended.error ?? 'audit append failed' };
  }

  const { count, error } = await db
    .from('hal_audit_chain')
    .select('id', { count: 'exact', head: true })
    .eq('source_table', DEMO_ROUND_ATTEMPT_SOURCE)
    .gte('created_at', `${day}T00:00:00.000Z`);
  if (error || typeof count !== 'number') {
    return { ok: false, reason: 'not_checked', cap, error: error?.message ?? 'count unavailable' };
  }
  // The count includes this attempt's own row.
  if (count > cap) return { ok: false, reason: 'cap_reached', used: count, cap };
  return { ok: true, used: count, cap };
}
