-- ==========================================================================================
-- ROLLBACK — DEFECT 1 trigger order
-- OUTPUT_PATH: migrations/rollback/DOWN_2026-08-03-hal-penalty-guard-trigger-order.sql
-- REVERSES:    migrations/2026-08-03-hal-penalty-guard-trigger-order.sql
-- ==========================================================================================
--
-- Restores the trigger to its original name, which RESTORES THE DEFECT: the HAL penalty guard
-- goes back to firing AFTER trg_apply_repid_score_event. That is the point of a rollback — it
-- returns the system to the state that was measured, not to a state nobody has seen.
--
-- Touches no rows. Same brief ACCESS EXCLUSIVE catalog lock as the forward migration.
-- Idempotent: no-op if the rename was never applied.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'repid_score_events'
          AND t.tgname  = 'trg_00_hal_penalty_guard'
          AND NOT t.tgisinternal
     )
     AND NOT EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'repid_score_events'
          AND t.tgname  = 'trg_hal_penalty_guard'
          AND NOT t.tgisinternal
     )
  THEN
    ALTER TRIGGER trg_00_hal_penalty_guard ON public.repid_score_events
      RENAME TO trg_hal_penalty_guard;
    RAISE WARNING 'ROLLED BACK to trg_hal_penalty_guard — the guard now fires AFTER apply_repid_score_event again (defect restored, intentionally)';
  ELSE
    RAISE NOTICE 'no-op: guard already named trg_hal_penalty_guard, or absent';
  END IF;
END $$;

COMMIT;

-- VERIFY THE ROLLBACK TOOK (expect 'trg_apply_repid_score_event' as fires_nth = 1):
--   SELECT row_number() OVER (ORDER BY t.tgname) AS fires_nth, t.tgname
--   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--   WHERE c.relname='repid_score_events' AND NOT t.tgisinternal AND t.tgenabled <> 'D'
--     AND (t.tgtype & 2)=2 AND (t.tgtype & 4)=4 AND (t.tgtype & 1)=1
--   ORDER BY t.tgname;
