-- ==========================================================================================
-- DEFECT 1 — HAL PENALTY SUPPRESSION FIRES IN THE WRONG ORDER
-- OUTPUT_PATH: migrations/2026-08-03-hal-penalty-guard-trigger-order.sql
-- ROLLBACK:    migrations/rollback/DOWN_2026-08-03-hal-penalty-guard-trigger-order.sql
--
-- PROMOTION-GATED — NOT APPLIED TO PROD. Written by the migrations lane; DDL on existing
-- objects goes through the single writer with a look first. Do NOT run this against
-- qnnpjhlxljtqyigedwkb until Sean co-signs.
-- ==========================================================================================
--
-- WHAT WAS VERIFIED (read-only queries against qnnpjhlxljtqyigedwkb, 2026-08-03)
-- ------------------------------------------------------------------------------------------
-- [V] repid_score_events carries TWO enabled BEFORE INSERT ... FOR EACH ROW triggers:
--
--       tgname                        timing  events  func
--       trg_apply_repid_score_event   BEFORE  INSERT  apply_repid_score_event
--       trg_hal_penalty_guard         BEFORE  INSERT  trg_hal_penalty_guard
--
--     PostgreSQL fires same-timing row triggers in order of trigger NAME. 'trg_apply...'
--     sorts before 'trg_hal...', so the penalty guard runs SECOND — after the function whose
--     effects it is supposed to prevent. Nothing about that ordering is declared anywhere; it
--     is an accident of the two names.
--
-- [V] trg_hal_penalty_guard(), when it suppresses, mutates exactly three things on NEW:
--       NEW.metadata    += {penalty_suppressed: true, suppressed_reason, original_delta}
--       NEW.repid_after := NEW.repid_before
--       NEW.delta       := 0
--     It does NOT clear NEW.repid_delta_applied, and it cannot touch repid_agents.
--
-- [V] 25,418 live rows are internally self-contradictory in exactly that shape:
--       metadata->>'penalty_suppressed' = 'true'  AND  repid_delta_applied < 0
--       sum(repid_delta_applied) over those rows = -220,389
--     (53,676 rows carry penalty_suppressed=true in total; 25,418 of them still record an
--     applied negative delta. Window 2026-05-29 23:48:49Z .. 2026-08-02 09:15:20Z.)
--
-- WHAT THE ORDERING BUG ACTUALLY COSTS TODAY — narrower than it looks, and worse elsewhere
-- ------------------------------------------------------------------------------------------
-- apply_repid_score_event() opens with:
--       IF NEW.repid_delta_applied IS NOT NULL THEN RETURN NEW; END IF;
--
-- [V] EVERY HAL_SCORE_EVENT row in the table has repid_delta_applied NOT NULL. Grouping the
--     152,084 rows by event_type over the rows where repid_delta_applied IS NULL yields
--     PREDICTION_RESOLVE, GENESIS, CHALLENGE_*, VALIDATOR_*, DORMANCY_DECAY, PEACEMAKER,
--     EPISTEMIC_VIOLATION, VALIDATION_FAILED, AGENT_TEACHING, SERVICE_FULFILLED —
--     and NOT HAL_SCORE_EVENT.
-- [V] agent_repid_history — written ONLY by apply_repid_score_event's UPDATE path — contains
--     ZERO rows with reason = 'HAL_SCORE_EVENT'.
--
--     => apply_repid_score_event has NEVER executed its UPDATE for a HAL_SCORE_EVENT. On
--        every row the guard has ever seen, the trigger it races was already a no-op.
--        So fixing the order changes NOTHING about current traffic (see BLAST RADIUS).
--
-- [inference, labelled] The 25,418 penalties were therefore applied by the APPLICATION writer
--     (src/engine/repid-update.ts, which UPDATEs repid_agents itself and supplies
--     repid_delta_applied on the event row), in a different statement, from a value computed
--     BEFORE the INSERT. A BEFORE INSERT trigger can only mutate the row being inserted, so
--     the guard is structurally incapable of retracting that UPDATE. The suppression is
--     row-cosmetic: it edits the audit record, not the score.
--
--     I did NOT verify that repid_agents.current_repid still carries those -220,389 today, and
--     this migration does not claim it. The 2026-07-23 epoch-1 reset overwrote the 12 core
--     agents to a flat baseline, and there is no per-event agents-table audit for the
--     application path, so the residue is UNKNOWN and is not reconstructed here.
--
-- WHAT THIS MIGRATION DOES — and deliberately does not do
-- ------------------------------------------------------------------------------------------
-- DOES:     make the firing order EXPLICIT instead of alphabetically accidental, by renaming
--           the guard to sort first, and leaves a verification query that ASSERTS the
--           invariant rather than trusting it.
-- DOES NOT: change trg_hal_penalty_guard()'s body, the RepID formula, any HAL threshold, or
--           any ANFIS parameter. It does not touch the application writer — that is another
--           lane's file (src/engine/repid-update.ts) and it is where the live defect lives.
-- DOES NOT: repair the 25,418 historical rows. Rewriting an audit log to remove evidence of a
--           mis-scored penalty is the opposite of an audit log. They stay, and the companion
--           migration 2026-08-03-repid-penalty-suppression-integrity.sql makes them VISIBLE.
--
-- Renaming to a digit-prefixed name (trg_00_) rather than a letter is intentional: it puts the
-- ordering in the identifier where the next reader can see it, instead of leaving the next
-- person to rediscover that 'a' < 'h'.

BEGIN;

-- ------------------------------------------------------------------------------------------
-- 1) Rename the guard so it sorts BEFORE trg_apply_repid_score_event.
--    Idempotent: no-op if already renamed, no-op if the old name is absent.
--    ALTER TRIGGER ... RENAME is catalog-only — it rewrites no rows and reads no data.
-- ------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'repid_score_events'
          AND t.tgname  = 'trg_hal_penalty_guard'
          AND NOT t.tgisinternal
     )
     AND NOT EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'repid_score_events'
          AND t.tgname  = 'trg_00_hal_penalty_guard'
          AND NOT t.tgisinternal
     )
  THEN
    ALTER TRIGGER trg_hal_penalty_guard ON public.repid_score_events
      RENAME TO trg_00_hal_penalty_guard;
    RAISE NOTICE 'renamed trg_hal_penalty_guard -> trg_00_hal_penalty_guard (now fires first)';
  ELSE
    RAISE NOTICE 'no-op: guard already named trg_00_hal_penalty_guard, or absent';
  END IF;
END $$;

-- ------------------------------------------------------------------------------------------
-- 2) FAIL LOUD if the invariant did not actually hold after the rename.
--    This is the whole point: the previous state was "correct by coincidence". If some future
--    trigger sorts ahead of the guard, this migration's own assertion is the tripwire.
-- ------------------------------------------------------------------------------------------
DO $$
DECLARE v_first text;
BEGIN
  SELECT t.tgname INTO v_first
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relname = 'repid_score_events'
    AND NOT t.tgisinternal
    AND t.tgenabled <> 'D'      -- ignore disabled triggers; they never fire
    AND (t.tgtype & 2) = 2      -- BEFORE
    AND (t.tgtype & 4) = 4      -- INSERT
    AND (t.tgtype & 1) = 1      -- FOR EACH ROW
  ORDER BY t.tgname
  LIMIT 1;

  IF v_first IS DISTINCT FROM 'trg_00_hal_penalty_guard' THEN
    RAISE EXCEPTION
      'INVARIANT VIOLATED: first enabled BEFORE INSERT ROW trigger on repid_score_events is %, expected trg_00_hal_penalty_guard. The HAL penalty guard must run before apply_repid_score_event.',
      coalesce(v_first, '<none>');
  END IF;
  RAISE NOTICE 'invariant OK: % fires first', v_first;
END $$;

COMMENT ON TRIGGER trg_00_hal_penalty_guard ON public.repid_score_events IS
  'HAL penalty suppression. The 00_ prefix is LOAD-BEARING: PostgreSQL fires same-timing row '
  'triggers in name order, and this guard must run before trg_apply_repid_score_event so that '
  'apply sees the already-zeroed delta. Do not rename without re-reading '
  'migrations/2026-08-03-hal-penalty-guard-trigger-order.sql. NOTE: this guard only mutates the '
  'row being inserted; it cannot retract a repid_agents UPDATE made by the application writer.';

COMMIT;

-- ==========================================================================================
-- BLAST RADIUS — applying this while traffic is live
-- ==========================================================================================
-- LOCK:            ALTER TRIGGER ... RENAME takes a brief ACCESS EXCLUSIVE lock on
--                  repid_score_events. It is catalog-only: no table rewrite, no row reads, no
--                  index build. Expect single-digit milliseconds.
-- BLOCKS:          for the duration of that lock, concurrent INSERTs into repid_score_events
--                  wait. Because the lock is taken at COMMIT-time scale, not scan-time scale,
--                  this is a queue blip, NOT an outage.
-- MAINTENANCE WINDOW: NOT required. The one caveat that would demand one is lock-queue
--                  pile-up behind a long-running transaction already holding a conflicting
--                  lock on repid_score_events; guard against that by running it with a short
--                  `SET LOCAL lock_timeout = '3s';` and retrying, rather than by taking the
--                  system down.
--
-- BEHAVIOUR CHANGE — the honest accounting:
--   * On rows where repid_delta_applied is supplied by the writer (149,124 of 152,084 rows,
--     and 100% of HAL_SCORE_EVENT rows): NO CHANGE. apply_repid_score_event short-circuits
--     regardless of order, so both orderings produce an identical row.
--   * On rows where repid_delta_applied IS NULL (2,960 rows, none of them HAL_SCORE_EVENT):
--     the guard only fires at all for event_type = 'HAL_SCORE_EVENT' with delta < 0, and no
--     such row has ever taken that path. So: NO CHANGE to any traffic observed to date.
--   * The change takes effect ONLY if a future writer inserts a HAL_SCORE_EVENT with a
--     negative delta and leaves repid_delta_applied NULL. From that moment the penalty is
--     correctly NOT applied to repid_agents, instead of being applied and then cosmetically
--     erased from the row. That is the guard's intended semantics.
--
--   => This rename is a latent-defect fix, not a live-behaviour flip. It is safe to apply
--      before the application writer is fixed, and it does not on its own fix the 25,418-row
--      defect, because that defect is in the application writer.
--
-- IRREVERSIBILITY: none. The rollback is a rename back. No data is touched either way.
-- ==========================================================================================


-- ==========================================================================================
-- VERIFICATION — proves the defect BEFORE, proves its absence AFTER. Read-only; safe to run.
-- ==========================================================================================
--
-- V1. FIRING ORDER. BEFORE: trg_apply_repid_score_event is row 1 and the guard is row 2.
--     AFTER: trg_00_hal_penalty_guard is row 1.
--
--   SELECT row_number() OVER (ORDER BY t.tgname) AS fires_nth, t.tgname, p.proname
--   FROM pg_trigger t
--   JOIN pg_class c ON c.oid = t.tgrelid
--   JOIN pg_proc  p ON p.oid = t.tgfoid
--   WHERE c.relname = 'repid_score_events'
--     AND NOT t.tgisinternal AND t.tgenabled <> 'D'
--     AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 1) = 1
--   ORDER BY t.tgname;
--
-- V2. THE ONE-LINE PASS/FAIL. BEFORE: 'DEFECT'. AFTER: 'OK'.
--
--   SELECT CASE WHEN (
--            SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--            WHERE c.relname='repid_score_events' AND NOT t.tgisinternal AND t.tgenabled <> 'D'
--              AND (t.tgtype & 2)=2 AND (t.tgtype & 4)=4 AND (t.tgtype & 1)=1
--            ORDER BY t.tgname LIMIT 1
--          ) = 'trg_00_hal_penalty_guard'
--          THEN 'OK — guard fires before apply'
--          ELSE 'DEFECT — guard fires after apply' END AS verdict;
--
-- V3. THE HISTORICAL DAMAGE THIS MIGRATION DOES **NOT** REPAIR. Unchanged by design:
--     expect 25418 / -220389 both before and after.
--
--   SELECT count(*) AS self_contradictory_rows,
--          sum(repid_delta_applied) AS repid_recorded_as_applied
--   FROM repid_score_events
--   WHERE metadata->>'penalty_suppressed' = 'true'
--     AND coalesce(repid_delta_applied, 0) <> 0;
-- ==========================================================================================
