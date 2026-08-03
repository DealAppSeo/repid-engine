/**
 * score-event-guard.ts — the flag that lets a writer opt in to the structural guard.
 *
 * WHY A FLAG AND NOT A STRAIGHT MIGRATION.
 *
 * `trg_apply_repid_score_event` is a live BEFORE INSERT trigger on
 * `repid_score_events` and it is the DEFAULT APPLIER of every delta. Verified
 * against prod 2026-08-03 (`pg_get_functiondef`), the guard is one line:
 *
 *     IF NEW.repid_delta_applied IS NOT NULL THEN RETURN NEW; END IF;
 *     v_delta := COALESCE(NEW.repid_delta_calculated, NEW.delta, 0);
 *     IF v_delta = 0 THEN RETURN NEW; END IF;
 *     SELECT current_repid INTO v_before FROM repid_agents WHERE id = NEW.agent_id FOR UPDATE;
 *     UPDATE repid_agents SET current_repid = COALESCE(v_before,0) + v_delta ...
 *     NEW.repid_before := v_before; NEW.repid_after := v_after;
 *
 * Note what #316's writer map did not: the trigger re-reads `current_repid` at
 * insert time. So a writer that updates `current_repid` itself and *then* inserts
 * the event does not "agree by arithmetic" — the trigger adds the delta a SECOND
 * time on top of the already-updated value, and then OVERWRITES the caller's
 * repid_before/repid_after with its own pair. Measured on prod inside a
 * rolled-back transaction:
 *
 *     read before          = 699
 *     caller wrote         = 706      (699 + 7)
 *     FINAL current_repid  = 713      (single-apply would be 706)   <-- +7 drift
 *     row as stored: repid_before=706 repid_after=713 repid_delta_applied=7
 *
 * The row RECONCILES (713 - 706 == 7) while the score moved twice, which is why
 * #316's reconciliation invariant cannot detect this class of bug. Only setting
 * `repid_delta_applied` stops it.
 *
 * Flipping that on changes live RepID arithmetic, so it is not this lane's call:
 * `SCORE_EVENT_GUARD_MODE` defaults to `off`, and the `off` branch at every call
 * site is the byte-identical legacy insert. Enforce is finished, tested and inert
 * until Sean flips it.
 *
 * WHY THE LEGACY BRANCH STAYS. `tests/score-event-writer-ratchet.test.ts` asserts
 * its allow-list has no STALE entries — a file that stops doing a raw insert must
 * be removed from the list. Deleting the legacy branch here would therefore have
 * to edit that test, which this lane does not own. So the guarded path lands
 * alongside the raw one and the allow-list is untouched; deleting the legacy
 * branches and shrinking the allow-list is the follow-up migration commit.
 */

export type ScoreEventGuardMode = 'off' | 'enforce';

/**
 * Resolved guard mode. Default `off` — never infer enforce from a typo'd value,
 * because the failure mode of guessing wrong is double-counted reputation.
 */
export function scoreEventGuardMode(): ScoreEventGuardMode {
  return (process.env.SCORE_EVENT_GUARD_MODE || '').trim().toLowerCase() === 'enforce'
    ? 'enforce'
    : 'off';
}

/** True when writers should route through `insertScoreEvent()` and set the guard. */
export function scoreEventGuardEnforced(): boolean {
  return scoreEventGuardMode() === 'enforce';
}
