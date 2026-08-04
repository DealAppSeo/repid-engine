-- ==========================================================================================
-- DEFECT 1, COMPANION — MAKE THE 25,418 SELF-CONTRADICTORY ROWS VISIBLE
-- OUTPUT_PATH: migrations/2026-08-03-repid-penalty-suppression-audit-view.sql
-- ROLLBACK:    migrations/rollback/DOWN_2026-08-03-repid-penalty-suppression-audit-view.sql
--
-- PROMOTION-GATED — NOT APPLIED TO PROD. Do NOT run against qnnpjhlxljtqyigedwkb until Sean
-- co-signs. Purely ADDITIVE: creates one new view. Touches no existing object, no rows.
-- ==========================================================================================
--
-- WHY A VIEW AND NOT A CHECK CONSTRAINT — the decision, and the reason it went this way
-- ------------------------------------------------------------------------------------------
-- The natural fix for "rows may not claim a suppressed penalty while recording an applied
-- negative delta" is a CHECK constraint:
--
--     ALTER TABLE repid_score_events ADD CONSTRAINT repid_score_events_suppression_coherent
--       CHECK (metadata->>'penalty_suppressed' IS DISTINCT FROM 'true'
--              OR coalesce(repid_delta_applied, 0) = 0) NOT VALID;
--
-- That constraint is DELIBERATELY NOT SHIPPED HERE, and shipping it would have been a mistake.
-- Verified reasoning:
--
--   [V] All 152,084 rows with event_type = 'HAL_SCORE_EVENT' arrive with repid_delta_applied
--       already NOT NULL — supplied by the application writer, not by the trigger.
--   [V] trg_hal_penalty_guard() sets NEW.delta := 0 but never clears NEW.repid_delta_applied.
--
--   => The contradictory shape is produced on EVERY suppressed HAL insert, by the current
--      production writer. A NOT VALID CHECK constrains new rows only — which is precisely the
--      rows the live writer is still producing. Adding it would turn every suppressed HAL
--      penalty write into a 23514 check_violation and take HAL scoring writes down.
--
-- The constraint becomes correct the moment the application writer stops emitting the shape,
-- and not one commit before. That writer is src/engine/repid-update.ts — another lane's file,
-- outside this lane's fence. See the report for the handoff.
--
-- So this migration does the part that is safe and useful today: it makes the defect COUNTABLE
-- instead of buried in a jsonb key, so the writer fix has a before/after number to prove itself
-- against. Fail-loud beats fail-silent; where failing loud would mean failing the write, being
-- loudly OBSERVABLE is the honest interim.
--
-- WHAT THE ROWS LOOK LIKE (read-only, qnnpjhlxljtqyigedwkb, 2026-08-03)
-- ------------------------------------------------------------------------------------------
--   penalty_suppressed = true, total ........................ 53,676
--     ... of which still record an applied negative delta ... 25,418
--     ... sum of those applied deltas ....................... -220,389
--   window ................................. 2026-05-29 23:48:49Z .. 2026-08-02 09:15:20Z
--
-- NOTE ON WHAT THIS VIEW DOES NOT CLAIM: it reports what the LEDGER records, not what
-- repid_agents currently holds. Whether those -220,389 survive in current_repid today is
-- UNKNOWN — the 2026-07-23 epoch-1 reset flattened the 12 core agents and there is no
-- per-event agents-table audit for the application write path. The view is named for the
-- ledger claim it measures, and its comment says so, so nobody quotes it as a live balance.

BEGIN;

CREATE OR REPLACE VIEW public.repid_penalty_suppression_audit AS
SELECT
  e.id,
  e.agent_id,
  e.event_type,
  e.created_at,
  e.delta                                    AS delta_recorded,
  (e.metadata->>'original_delta')::int        AS delta_before_suppression,
  e.repid_delta_applied,
  e.repid_before,
  e.repid_after,
  e.metadata->>'suppressed_reason'            AS suppressed_reason,
  -- The classification. 'INCOHERENT' is the defect shape: the row simultaneously says the
  -- penalty was suppressed (delta 0, repid_after = repid_before) and that a negative delta was
  -- applied. 'COHERENT' rows are suppressions that really did net to zero.
  CASE
    WHEN coalesce(e.repid_delta_applied, 0) <> 0 THEN 'INCOHERENT'
    ELSE 'COHERENT'
  END                                         AS suppression_coherence,
  -- Which writer produced the row. The trigger only sets repid_delta_applied when it ran its
  -- UPDATE path; a value present at INSERT time means the application supplied it.
  CASE
    WHEN e.repid_delta_applied IS NULL THEN 'trigger-or-unapplied'
    ELSE 'application-writer'
  END                                         AS applied_by
FROM public.repid_score_events e
WHERE e.metadata->>'penalty_suppressed' = 'true';

COMMENT ON VIEW public.repid_penalty_suppression_audit IS
  'Every repid_score_events row claiming penalty_suppressed=true, classified COHERENT vs '
  'INCOHERENT. INCOHERENT = the row claims the HAL penalty was suppressed (delta 0, '
  'repid_after = repid_before) while repid_delta_applied still records a negative delta — '
  'trg_hal_penalty_guard zeroes delta but never clears repid_delta_applied, and it cannot '
  'retract the repid_agents UPDATE made separately by the application writer. '
  'THIS REPORTS THE LEDGER''S CLAIM, NOT A LIVE BALANCE: whether repid_agents.current_repid '
  'still carries these deltas is unknown and is NOT reconstructed here. '
  'Added 2026-08-03; expected INCOHERENT count at that date = 25,418 (sum -220,389).';

-- Least privilege. This is an internal integrity surface, not a public metric: no anon.
-- (Contrast hal_accuracy_summary, which is readable by anon — see the report.)
REVOKE ALL ON public.repid_penalty_suppression_audit FROM PUBLIC;
GRANT SELECT ON public.repid_penalty_suppression_audit TO service_role;

COMMIT;

-- ==========================================================================================
-- BLAST RADIUS — applying this while traffic is live
-- ==========================================================================================
-- LOCK:  additive only — CREATE OR REPLACE VIEW on a NEW name. No existing object is altered, no
--        rows are read at apply time, and no lock is taken on repid_score_events beyond the
--        momentary ACCESS SHARE needed to resolve the dependency.
-- MAINTENANCE WINDOW: NOT required. Nothing breaks if this is applied mid-traffic: no writer
--        touches this view, no existing view or constraint changes, and no consumer exists yet
--        (the name is new as of this migration).
--
-- Cost note, not a correctness note: the view has no WHERE-clause index support —
-- metadata->>'penalty_suppressed' is unindexed, so SELECTing it seq-scans 152,084 rows. That is
-- fine for an operator query and it is NOT wired into any hot path. Do not put it in one
-- without adding a partial index first.
--
-- IRREVERSIBILITY: none. Rollback drops the view.
-- ==========================================================================================


-- ==========================================================================================
-- VERIFICATION — proves the defect. Read-only; safe to run.
-- ==========================================================================================
--
-- V1. BEFORE (no view yet) — the defect, straight from the base table. Expect 25418 / -220389:
--
--   SELECT count(*) AS incoherent_rows, sum(repid_delta_applied) AS repid_recorded_as_applied
--   FROM repid_score_events
--   WHERE metadata->>'penalty_suppressed' = 'true'
--     AND coalesce(repid_delta_applied, 0) <> 0;
--
-- V2. AFTER — the same fact through the view, now countable by class. Expect
--     INCOHERENT 25418 and COHERENT 28258 (53,676 total):
--
--   SELECT suppression_coherence, applied_by, count(*), sum(repid_delta_applied)
--   FROM repid_penalty_suppression_audit
--   GROUP BY 1, 2 ORDER BY 1, 2;
--
-- V3. THE REGRESSION TRIPWIRE for the writer fix — is the defect STILL BEING PRODUCED?
--     Today this returns a non-zero count. After src/engine/repid-update.ts stops emitting the
--     shape it must return 0, and that is the moment the CHECK constraint above becomes safe
--     to add:
--
--   SELECT count(*) AS incoherent_in_last_24h
--   FROM repid_penalty_suppression_audit
--   WHERE suppression_coherence = 'INCOHERENT' AND created_at > now() - interval '24 hours';
-- ==========================================================================================
