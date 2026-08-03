-- ==========================================================================================
-- ROLLBACK — DEFECT 1 companion, suppression audit view
-- OUTPUT_PATH: migrations/rollback/DOWN_2026-08-03-repid-penalty-suppression-audit-view.sql
-- REVERSES:    migrations/2026-08-03-repid-penalty-suppression-audit-view.sql
-- ==========================================================================================
--
-- Drops the view. No data is affected — the 25,418 INCOHERENT rows live in
-- repid_score_events and are untouched by both the forward migration and this rollback;
-- dropping the view only removes the lens, not the evidence.
--
-- Idempotent via IF EXISTS. RESTRICT (the default) rather than CASCADE, deliberately: if
-- something has come to depend on this view, the rollback should FAIL LOUDLY and make a human
-- look, not silently demolish the dependent.

BEGIN;

DROP VIEW IF EXISTS public.repid_penalty_suppression_audit;

COMMIT;

-- VERIFY THE ROLLBACK TOOK (expect 0 rows):
--   SELECT viewname FROM pg_views
--   WHERE schemaname = 'public' AND viewname = 'repid_penalty_suppression_audit';
--
-- VERIFY NO EVIDENCE WAS LOST (expect 25418 / -220389, same as before the forward migration):
--   SELECT count(*), sum(repid_delta_applied) FROM repid_score_events
--   WHERE metadata->>'penalty_suppressed' = 'true' AND coalesce(repid_delta_applied,0) <> 0;
