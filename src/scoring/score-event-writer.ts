/**
 * score-event-writer.ts — the only place a score event should be inserted.
 *
 * THE INVISIBLE CONTRACT THIS MAKES VISIBLE. `trg_apply_repid_score_event` is a
 * live BEFORE INSERT trigger on `repid_score_events`, and it is the DEFAULT
 * APPLIER of every delta:
 *
 *     IF NEW.repid_delta_applied IS NOT NULL THEN RETURN NEW; END IF;
 *     UPDATE repid_agents SET current_repid = v_before + v_delta ...
 *
 * That single IF is the entire double-count guard. It is per-writer, it is not
 * enforced anywhere in the application, and nothing at a call site hints that it
 * exists. Audited 2026-08-03: **3 of 11 writers hold it.** Seven both let the
 * trigger apply AND write `current_repid` themselves.
 *
 * There is no live double-count today only because those seven happen to compute
 * the same absolute value the trigger computed relatively — coincidence of
 * arithmetic, not a mechanism. One concurrent event between the two writes and the
 * absolute write silently wins, making `repid_after` on the audit row a lie. That
 * is the exact failure the RepID-sync D-054 co-sign was WITHHELD over
 * (DECISIONS.md:249).
 *
 * THE FIX IS TO MAKE THE CHOICE EXPLICIT, NOT TO PICK A DEFAULT. Callers must say
 * who applies:
 *
 *   applier: 'trigger'  — the DB applies the delta and stamps repid_before/after.
 *                         The caller must NOT touch current_repid. Simplest, and
 *                         correct for anything that just records an outcome.
 *   applier: 'caller'   — the caller already computed and wrote the score. We set
 *                         repid_delta_applied so the trigger stands down.
 *
 * A default would recreate the bug: the whole problem is that omitting a field
 * silently changes who applies. So `applier` is required, and 'caller' additionally
 * requires the before/after/applied numbers — you cannot claim to have applied a
 * delta without saying what it did.
 */

import { db } from '../db';

export type Applier = 'trigger' | 'caller';

export interface ScoreEventBase {
  agent_id: string;
  event_type: string;
  delta: number;
  metadata?: Record<string, unknown> | null;
  idempotency_key?: string | null;
  /** Any additional columns the caller legitimately owns. */
  extra?: Record<string, unknown>;
}

export interface TriggerAppliedEvent extends ScoreEventBase {
  applier: 'trigger';
}

export interface CallerAppliedEvent extends ScoreEventBase {
  applier: 'caller';
  repid_before: number;
  repid_after: number;
  /** What was actually applied to the score. MUST equal repid_after - repid_before. */
  repid_delta_applied: number;
  repid_delta_calculated?: number;
}

export type ScoreEventInsert = TriggerAppliedEvent | CallerAppliedEvent;

export interface WriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** Who ended up applying the delta. Recorded so a caller can assert it. */
  applier: Applier;
}

/**
 * The reconciliation invariant.
 *
 * `repid_after - repid_before` must equal `repid_delta_applied`, or the audit row
 * and `agent_repid_history` disagree about what happened. This caught a real defect
 * in the decay work (#315): decay was folded into the score but not into the
 * applied delta, so an enforce-mode row would have shown delta −9 beside a
 * 34-point drop.
 */
export function reconciles(e: CallerAppliedEvent): boolean {
  return e.repid_after - e.repid_before === e.repid_delta_applied;
}

export async function insertScoreEvent(e: ScoreEventInsert): Promise<WriteResult> {
  const row: Record<string, unknown> = {
    agent_id: e.agent_id,
    event_type: e.event_type,
    delta: Math.round(e.delta),
    metadata: e.metadata ?? {},
    ...(e.idempotency_key ? { idempotency_key: e.idempotency_key } : {}),
    ...(e.extra ?? {}),
  };

  if (e.applier === 'caller') {
    if (!reconciles(e)) {
      // Refuse rather than write a row whose own numbers disagree. A ledger that
      // does not add up is worse than a missing entry, because it looks like data.
      return {
        ok: false,
        applier: 'caller',
        error:
          `score event does not reconcile: repid_after(${e.repid_after}) - ` +
          `repid_before(${e.repid_before}) = ${e.repid_after - e.repid_before}, ` +
          `but repid_delta_applied is ${e.repid_delta_applied}. ` +
          `If something other than the delta moved the score (e.g. decay), it must be ` +
          `included in repid_delta_applied or recorded as its own event.`,
      };
    }
    row.repid_before = e.repid_before;
    row.repid_after = e.repid_after;
    row.repid_delta_applied = e.repid_delta_applied;
    if (e.repid_delta_calculated !== undefined) {
      row.repid_delta_calculated = e.repid_delta_calculated;
    }
  }
  // applier === 'trigger': repid_delta_applied is deliberately ABSENT so
  // trg_apply_repid_score_event applies the delta and stamps before/after itself.

  const { data, error } = await db
    .from('repid_score_events')
    .insert(row)
    .select('id')
    .single();

  if (error) return { ok: false, applier: e.applier, error: error.message };
  return { ok: true, applier: e.applier, id: String((data as any)?.id ?? '') };
}
