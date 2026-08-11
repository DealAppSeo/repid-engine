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
import { currentCoverage, withCoverage } from '../services/detector-coverage';

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

/**
 * THE ZERO-DELTA TRAP.
 *
 * `applier: 'trigger'` used to be a guaranteed `23502` for any zero-delta event.
 * Verified live 2026-08-03 against `pg_proc` and by probe, not from a report:
 *
 *     v_delta := COALESCE(NEW.repid_delta_calculated, NEW.delta, 0);
 *     IF v_delta = 0 THEN RETURN NEW; END IF;   -- ← returns BEFORE stamping
 *
 * and `repid_before` / `repid_after` are both `integer NOT NULL` with **no
 * default** (`information_schema.columns`). So the trigger hands back a row with
 * NULL in a NOT NULL column and the insert dies:
 *
 *     null value in column "repid_before" ... violates not-null constraint
 *
 * Zero-delta is not an edge case here. 79,842 of 152,084 rows (52.5%) of
 * `repid_score_events` are zero-delta, the most recent from today, and 54,392 of
 * those carry `repid_delta_applied = 0` with `repid_before = repid_after`. The
 * purpose gate's entire evidence that it works is zero-delta rows — a
 * non-deliverable HAL veto is *supposed* to apply 0 instead of −10. So the helper
 * SUPPLIES the numbers rather than refusing zero-delta: refusing would reject the
 * largest class of audit event in the ledger, and because most call sites
 * `await insertScoreEvent(...)` without reading `ok`, a refusal would make the
 * event silently disappear — the one outcome worse than the crash.
 *
 * Note the precedence: the trigger tests `COALESCE(repid_delta_calculated, delta)`,
 * so `delta: 5` with `repid_delta_calculated: 0` is ALSO a zero-delta event and
 * also died. Probed: both shapes returned 23502.
 */
export function effectiveTriggerDelta(e: ScoreEventInsert): number {
  const calc = (e.extra ?? {})['repid_delta_calculated'];
  if (calc !== undefined && calc !== null) return Math.round(Number(calc));
  return Math.round(e.delta);
}

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
    // EVERY score event records what was watching when it was written.
    //
    // Measured 2026-08-11: 99.86% of negative reputation events (68,321 of 68,417) come from
    // a single detector, and task #56 has 3 of ~6 HAL providers down. A detector outage and
    // a genuine improvement in behaviour have the IDENTICAL signature — fewer negatives — so
    // without this stamp nobody reading the history can tell which one happened.
    //
    // Stamped here rather than at each call site on purpose: this is the one chokepoint every
    // guarded write passes through, and a per-caller list of "remember to add coverage" is the
    // hand-maintained enumeration that has failed three times in this repo already.
    //
    // Unknown coverage writes UNKNOWN, never nothing — see detector-coverage.ts for why an
    // absent ruler must not read as the good ruler.
    metadata: withCoverage(e.metadata, currentCoverage()),
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
  //
  // ...EXCEPT when the effective delta is 0, where the trigger returns early and
  // stamps nothing. Then we must supply the snapshot ourselves or hit 23502.
  if (e.applier === 'trigger' && effectiveTriggerDelta(e) === 0) {
    const extra = e.extra ?? {};
    const givenBefore = extra['repid_before'];
    const givenAfter = extra['repid_after'];
    const hasBefore = givenBefore !== undefined && givenBefore !== null;
    const hasAfter = givenAfter !== undefined && givenAfter !== null;

    if (hasBefore && hasAfter) {
      // Respect a caller-supplied snapshot, but never write a row that contradicts
      // itself: a zero-delta event whose before/after differ does not add up, and
      // the same reasoning as `reconciles()` applies — a ledger that does not add
      // up is worse than a gap, because it looks like data.
      if (Number(givenAfter) - Number(givenBefore) !== 0) {
        return {
          ok: false,
          applier: 'trigger',
          error:
            `zero-delta score event does not reconcile: repid_after(${String(givenAfter)}) - ` +
            `repid_before(${String(givenBefore)}) is not 0. The effective delta is 0, so ` +
            `nothing was applied; if something else moved the score it must be recorded ` +
            `as its own event with applier: 'caller'.`,
        };
      }
    } else {
      // Read the current score for the snapshot. This is a NON-MUTATING read: the
      // row we then write carries repid_delta_applied = 0, so the trigger stands
      // down at its FIRST guard and `repid_agents` is never UPDATEd.
      //
      // Honest limit: another event can move the score between this read and the
      // insert. That can only make the recorded snapshot stale by a few points —
      // it can never move a score or mis-state what THIS event applied, because
      // this event applies exactly 0. The race is cosmetic, not economic. Closing
      // it properly means letting the trigger stamp zero-delta rows itself, which
      // is a migration, not an application change.
      const { data: agent, error: readErr } = await db
        .from('repid_agents')
        .select('current_repid')
        .eq('id', e.agent_id)
        .single();

      if (readErr || !agent) {
        // Say why, rather than firing a doomed insert and reporting 23502 as if the
        // schema were at fault.
        return {
          ok: false,
          applier: 'trigger',
          error:
            `zero-delta score event needs a repid_before snapshot (repid_before is NOT NULL ` +
            `and the trigger does not stamp it when the delta is 0), but reading ` +
            `repid_agents.current_repid for agent ${e.agent_id} failed: ` +
            `${readErr?.message ?? 'agent not found'}`,
        };
      }

      const current = Math.round(Number((agent as any).current_repid ?? 0));
      row.repid_before = current;
      row.repid_after = current;
    }

    // Non-NULL repid_delta_applied makes the trigger return at its first guard, so
    // the outcome no longer depends on the zero-check at all. It also states the
    // truth: exactly 0 was applied.
    row.repid_delta_applied = 0;
  }

  const { data, error } = await db
    .from('repid_score_events')
    .insert(row)
    .select('id')
    .single();

  if (error) return { ok: false, applier: e.applier, error: error.message };
  return { ok: true, applier: e.applier, id: String((data as any)?.id ?? '') };
}
