-- ==========================================================================================
-- DEFECT 2 — THE AUDIT TABLE CAN HOLD A SCORE THE AGENTS TABLE WOULD REJECT
-- OUTPUT_PATH: migrations/2026-08-03-repid-score-events-range-check.sql
-- ROLLBACK:    migrations/rollback/DOWN_2026-08-03-repid-score-events-range-check.sql
--
-- PROMOTION-GATED — NOT APPLIED TO PROD. Do NOT run against qnnpjhlxljtqyigedwkb until Sean
-- co-signs. Adds two NOT VALID CHECK constraints. No rows are read, rewritten, or deleted.
-- ==========================================================================================
--
-- WHAT WAS VERIFIED (read-only queries against qnnpjhlxljtqyigedwkb, 2026-08-03)
-- ------------------------------------------------------------------------------------------
-- [V] repid_agents enforces the range, and always has:
--       repid_agents_current_repid_check  CHECK (current_repid >= 10 AND current_repid <= 10000)
--       convalidated = true
--
-- [V] repid_score_events enforces NOTHING about repid_before / repid_after. Its complete CHECK
--     inventory from pg_constraint is three unrelated constraints — certainty_at_claim (0..1),
--     event_type (enum whitelist), veto_class (enum whitelist) — plus the PK and the agent_id
--     FK. There is no range constraint on either score column. The audit table trusts its
--     writer completely.
--
-- [V] The briefed row exists and is exactly as described:
--       id=157308  agent_id=51e8367b-a953-4361-a7b0-bb68e494c1bb  event_type=VALIDATOR_REWARD
--       delta=40   repid_before=10000   repid_after=10040   repid_delta_applied=40
--       created_at=2026-07-25 03:16:17Z
--
-- [V] ...and it is provably WRONG, not merely out of range. That agent's live row is
--       current_repid = 10000, peak_repid = 10000.
--     The ledger records an agent reaching 10040. The agents table says it never left the cap
--     and its own CHECK would have rejected 10040. So the audit trail is off by +40 and nothing
--     anywhere caught it.
--
-- [V] HOW IT GOT COMMITTED — the mechanism, not a guess. apply_repid_score_event() opens with
--       IF NEW.repid_delta_applied IS NOT NULL THEN RETURN NEW; END IF;
--     149,124 of 152,084 rows arrive with repid_delta_applied already populated by the
--     application writer, so the trigger short-circuits and never performs the repid_agents
--     UPDATE whose CHECK would have blocked the value. repid_before / repid_after on those rows
--     are whatever the application computed. Nothing re-derives or bounds them.
--     => 21,281 of the 21,282 out-of-range rows are on that application-supplied path.
--
-- THE VIOLATION IS BIGGER THAN ONE ROW — and this is why the constraint must be NOT VALID
-- ------------------------------------------------------------------------------------------
-- [V] Full scan of all 152,084 rows:
--       repid_after > 10000 ..............     1 row   (id 157308, max 10040)
--       repid_after < 10 ................. 21,281 rows (min 0)
--       repid_before > 10000 .............     0 rows
--       repid_before < 10 ................     1 row   (min 0)
--       TOTAL rows violating [10,10000] .. 21,282
--
--     The briefed defect was the CEILING. The FLOOR is violated 21,281 times as often, and
--     nobody had counted it. A plain validating
--         ALTER TABLE ... ADD CONSTRAINT ... CHECK (repid_after BETWEEN 10 AND 10000);
--     would therefore ABORT with a 23514 on the 21,282 existing rows. This is exactly the
--     assumption a migration must measure rather than inherit.
--
-- [V] The floor hole is CLOSED, the ceiling hole is NOT:
--       last row with repid_after < 10 .......... 2026-05-29 23:48:19Z
--       rows with repid_after < 10 since then ... 0   (and 0 since 2026-06-03, 0 since July)
--       rows with repid_after > 10000 ........... 1, on 2026-07-25 — two months LATER
--     Something fixed the floor at the end of May (the tier floor trigger trg_repid_earned_floor
--     enforces a lower bound on repid_agents; migrations/2026-06-03-restore-9-floor-pinned.sql
--     is in this tree). Nothing has ever enforced a ceiling on the LEDGER, which is why the only
--     post-fix violation is an overshoot.
--
-- SO: NOT VALID is not a cop-out here, it is the correct instrument.
--   * It rejects every FUTURE out-of-range write — including a recurrence of the 2026-07-25
--     ceiling overshoot, which is the only hole still open.
--   * It leaves 21,282 historical rows in place. Rewriting them would destroy the evidence that
--     the engine once emitted them; deleting them would falsify an append-only audit log.
--     Neither is a migration's business. They are quarantined by the companion view below.
--   * It converts a silent bad write into a loud 23514 at the point of the write, which is
--     where a corrupted audit trail is cheap to fix instead of archaeology.
--
-- NOT the RepID formula: [10, 10000] is copied from repid_agents' own long-standing public
-- constraint. This migration adds no scoring logic, no threshold, no ANFIS parameter.

BEGIN;

-- ------------------------------------------------------------------------------------------
-- 1) repid_after — the column that holds 10040. NULL-tolerant: the column is nullable, and a
--    NULL says "not recorded", which is honest. Only a recorded-and-impossible value is barred.
--    Idempotent: guarded on conname so a re-run is a no-op.
-- ------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.repid_score_events'::regclass
      AND conname  = 'repid_score_events_repid_after_range'
  ) THEN
    ALTER TABLE public.repid_score_events
      ADD CONSTRAINT repid_score_events_repid_after_range
      CHECK (repid_after IS NULL OR (repid_after >= 10 AND repid_after <= 10000))
      NOT VALID;
    RAISE NOTICE 'added repid_score_events_repid_after_range (NOT VALID — future rows only)';
  ELSE
    RAISE NOTICE 'no-op: repid_score_events_repid_after_range already present';
  END IF;
END $$;

-- ------------------------------------------------------------------------------------------
-- 2) repid_before — same invariant, same reasoning. 1 historical violator.
--    Separate constraint, not one combined CHECK, so that each column can be VALIDATEd
--    independently once its own history is reconciled. A combined constraint would hold both
--    hostage to whichever column is dirtier.
-- ------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.repid_score_events'::regclass
      AND conname  = 'repid_score_events_repid_before_range'
  ) THEN
    ALTER TABLE public.repid_score_events
      ADD CONSTRAINT repid_score_events_repid_before_range
      CHECK (repid_before IS NULL OR (repid_before >= 10 AND repid_before <= 10000))
      NOT VALID;
    RAISE NOTICE 'added repid_score_events_repid_before_range (NOT VALID — future rows only)';
  ELSE
    RAISE NOTICE 'no-op: repid_score_events_repid_before_range already present';
  END IF;
END $$;

-- ------------------------------------------------------------------------------------------
-- 3) Quarantine the history the constraints cannot cover, so "NOT VALID" is documented in the
--    database rather than only in this file. Additive; new name; no anon.
-- ------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.repid_score_events_out_of_range AS
SELECT
  e.id,
  e.agent_id,
  e.event_type,
  e.created_at,
  e.repid_before,
  e.repid_after,
  e.delta,
  e.repid_delta_applied,
  CASE
    WHEN e.repid_after  > 10000 OR e.repid_before  > 10000 THEN 'ABOVE_MAX'
    WHEN e.repid_after  < 10    OR e.repid_before  < 10    THEN 'BELOW_MIN'
  END AS violation,
  CASE WHEN e.repid_delta_applied IS NULL THEN 'trigger-or-unapplied'
       ELSE 'application-writer' END AS written_by
FROM public.repid_score_events e
WHERE e.repid_after  IS NOT NULL AND (e.repid_after  < 10 OR e.repid_after  > 10000)
   OR e.repid_before IS NOT NULL AND (e.repid_before < 10 OR e.repid_before > 10000);

COMMENT ON VIEW public.repid_score_events_out_of_range IS
  'repid_score_events rows whose repid_before/repid_after fall outside the [10,10000] range that '
  'repid_agents.current_repid enforces via repid_agents_current_repid_check. These predate the '
  'NOT VALID constraints repid_score_events_repid_{before,after}_range and are why those '
  'constraints are NOT VALID rather than validated. At 2026-08-03: 21,282 rows — 21,281 '
  'BELOW_MIN (all on or before 2026-05-29, hole since closed) and 1 ABOVE_MAX (id 157308, '
  'repid_after=10040, 2026-07-25 — that agent''s current_repid is 10000, so the ledger is wrong '
  'by +40). NOT repaired on purpose: an append-only audit log is not edited to look correct.';

REVOKE ALL ON public.repid_score_events_out_of_range FROM PUBLIC;
GRANT SELECT ON public.repid_score_events_out_of_range TO service_role;

COMMIT;

-- ==========================================================================================
-- BLAST RADIUS — applying this while traffic is live
-- ==========================================================================================
-- LOCK:  ADD CONSTRAINT ... NOT VALID takes ACCESS EXCLUSIVE on repid_score_events, but does
--        NOT scan the table. It is a catalog write. Milliseconds, independent of the 152,084
--        rows. This is the entire reason to use NOT VALID here rather than a validating ADD,
--        which would seq-scan the table under the same lock AND then abort on row 21,282.
-- BLOCKS: concurrent INSERTs queue behind that momentary lock. A queue blip, not an outage.
-- MAINTENANCE WINDOW: NOT required. Use `SET LOCAL lock_timeout = '3s';` and retry rather than
--        risking a lock-queue pile-up behind a long transaction.
--
-- WHAT BREAKS IF APPLIED WHILE TRAFFIC IS LIVE — the honest answer:
--   Any writer that emits repid_before/repid_after outside [10,10000] starts receiving 23514
--   check_violation and ITS TRANSACTION FAILS. That is the intended behaviour, and it is a real
--   risk, not a theoretical one:
--     [V] the floor is quiet — 0 such rows since 2026-05-29, so the floor side is dormant;
--     [V] the ceiling is NOT — 1 row on 2026-07-25 proves a live path can still overshoot 10000.
--   If that path is a hot economic write (VALIDATOR_REWARD was the event type), it will now fail
--   loudly instead of silently recording a false score. Before applying, decide which you want:
--   a failed reward write, or a wrong audit trail. This lane's recommendation is the former —
--   but it IS a live-behaviour change and it needs Sean's GO, not just a co-sign.
--
--   MITIGATION, if a failed write is unacceptable: apply the two constraints only after the
--   application writer clamps repid_after to [10,10000] before insert. That writer is
--   src/engine/repid-update.ts — outside this lane's fence. See the report handoff.
--
-- IRREVERSIBILITY: none. Rollback drops both constraints and the view. No row is ever touched.
--
-- DO NOT RUN `VALIDATE CONSTRAINT` — it will abort. Recorded here so nobody tries it blind:
--   ALTER TABLE public.repid_score_events VALIDATE CONSTRAINT repid_score_events_repid_after_range;
--     -> ERROR 23514 on the first of 21,282 pre-existing rows.
--   It becomes runnable only after a separately-ratified decision about those rows, and this
--   lane recommends they are never rewritten.
-- ==========================================================================================


-- ==========================================================================================
-- VERIFICATION — proves the defect BEFORE, proves its absence AFTER. Read-only; safe to run.
-- ==========================================================================================
--
-- V1. THE ABSENCE OF THE CONSTRAINT. BEFORE: 0 rows. AFTER: 2 rows, convalidated = false.
--
--   SELECT conname, pg_get_constraintdef(oid) AS def, convalidated
--   FROM pg_constraint
--   WHERE conrelid = 'public.repid_score_events'::regclass
--     AND conname LIKE 'repid_score_events_repid_%_range'
--   ORDER BY conname;
--
-- V2. THE BRIEFED ROW vs THE AGENT IT DESCRIBES. Unchanged by this migration — the point is
--     that the ledger and the agents table disagree. Expect repid_after=10040 next to
--     current_repid=10000:
--
--   SELECT e.id, e.event_type, e.repid_before, e.repid_after, e.repid_delta_applied,
--          a.current_repid AS agent_current_repid, a.peak_repid
--   FROM repid_score_events e JOIN repid_agents a ON a.id = e.agent_id
--   WHERE e.id = 157308;
--
-- V3. THE FULL SCOPE, and the reason for NOT VALID. Expect 21282 / 1 / 21281:
--
--   SELECT count(*) AS out_of_range,
--          count(*) FILTER (WHERE repid_after > 10000 OR repid_before > 10000) AS above_max,
--          count(*) FILTER (WHERE repid_after < 10    OR repid_before < 10)    AS below_min,
--          min(repid_after) AS min_after, max(repid_after) AS max_after
--   FROM repid_score_events
--   WHERE repid_after < 10 OR repid_after > 10000
--      OR repid_before < 10 OR repid_before > 10000;
--
-- V4. THE GUARD IS REAL — is the hole still open? Expect above_max_recent = 1 (2026-07-25),
--     below_min_recent = 0. A non-zero above_max_recent is what this constraint now blocks:
--
--   SELECT count(*) FILTER (WHERE repid_after > 10000) AS above_max_recent,
--          count(*) FILTER (WHERE repid_after < 10)    AS below_min_recent,
--          max(created_at)                              AS latest
--   FROM repid_score_events
--   WHERE created_at > '2026-06-03' AND (repid_after < 10 OR repid_after > 10000);
--
-- V5. AFTER — the quarantine view agrees with the base table (expect the same 21282):
--
--   SELECT violation, written_by, count(*), min(created_at), max(created_at)
--   FROM repid_score_events_out_of_range GROUP BY 1,2 ORDER BY 1,2;
-- ==========================================================================================
