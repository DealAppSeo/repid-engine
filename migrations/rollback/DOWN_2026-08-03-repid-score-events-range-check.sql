-- ==========================================================================================
-- ROLLBACK — DEFECT 2 repid_score_events range checks
-- OUTPUT_PATH: migrations/rollback/DOWN_2026-08-03-repid-score-events-range-check.sql
-- REVERSES:    migrations/2026-08-03-repid-score-events-range-check.sql
-- ==========================================================================================
--
-- Drops both NOT VALID range constraints and the quarantine view. RESTORES THE DEFECT: the audit
-- table can once again record a repid_after that repid_agents.current_repid would reject.
--
-- Touches no rows in either direction. DROP CONSTRAINT takes a brief ACCESS EXCLUSIVE lock on
-- repid_score_events and performs no scan.
--
-- Idempotent via IF EXISTS on all three objects.
--
-- SAFE TO RUN WHILE TRAFFIC IS LIVE, and safer than the forward migration: dropping a constraint
-- can never fail a write that the constraint was previously rejecting. If the forward migration
-- started breaking an economic write path (VALIDATOR_REWARD overshooting 10000 is the observed
-- case), this rollback restores that path within one statement. That asymmetry is the reason the
-- forward migration is safe to attempt at all.

BEGIN;

ALTER TABLE public.repid_score_events
  DROP CONSTRAINT IF EXISTS repid_score_events_repid_after_range;

ALTER TABLE public.repid_score_events
  DROP CONSTRAINT IF EXISTS repid_score_events_repid_before_range;

-- RESTRICT (the default), not CASCADE: if something has come to depend on this view, fail loudly
-- and make a human look rather than silently demolishing the dependent.
DROP VIEW IF EXISTS public.repid_score_events_out_of_range;

COMMIT;

-- VERIFY THE ROLLBACK TOOK (expect 0 rows from each):
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'public.repid_score_events'::regclass
--      AND conname LIKE 'repid_score_events_repid_%_range';
--   SELECT viewname FROM pg_views
--    WHERE schemaname='public' AND viewname='repid_score_events_out_of_range';
--
-- VERIFY NO DATA WAS TOUCHED — the 21,282 out-of-range rows are still there, and the briefed row
-- still disagrees with its agent (expect 21282, and repid_after=10040 vs current_repid=10000):
--   SELECT count(*) FROM repid_score_events
--    WHERE repid_after < 10 OR repid_after > 10000
--       OR repid_before < 10 OR repid_before > 10000;
--   SELECT e.id, e.repid_after, a.current_repid
--     FROM repid_score_events e JOIN repid_agents a ON a.id = e.agent_id WHERE e.id = 157308;
