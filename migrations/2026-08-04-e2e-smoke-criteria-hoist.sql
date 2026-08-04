-- 2026-08-04-e2e-smoke-criteria-hoist.sql
--
-- Take the criteria gate to the `claude-loop` producer.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT IS WRONG, EXACTLY
-- ═══════════════════════════════════════════════════════════════════════════════
-- `dispatch_e2e_smoke()` is invoked by cron.job 8 (`e2e_smoke_nightly`, 15 9 * * *,
-- active) and is the producer behind insert_source='claude-loop'. Its INSERT column
-- list does not include `success_criteria`, so every task it has ever created fell
-- to the column DEFAULT:
--
--     success_criteria = 'Pass default checks.'
--
-- That is the vacuous default carried by 93.9% of trinity_tasks (340,958 / 363,015)
-- [V sql 2026-08-04].
--
-- THE POINT IS THAT THE CRITERIA ALREADY EXIST. The author DID write a specific,
-- checkable acceptance bar — it is inside the `description` prose under `CHECKER:`
-- and `PROVENANCE:`:
--
--     "valid ONLY IF every row has a real integer http_status + a verbatim excerpt
--      from the real body; 'I need X'/'here is a plan' = NOT done"
--     "real HTTP only; no synthetic"
--
-- So this is not a missing standard. It is a standard written where no machine can
-- read it. Any verifier, gate, or report-checker reading the structured column sees
-- "Pass default checks." and has nothing to check against — which is how a report
-- that merely LOOKS like completion passes, the shape the nightly-smoke fabrication
-- took (18/18 reports with zero real measurements).
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS CHANGES — AND WHAT IT DELIBERATELY DOES NOT
-- ═══════════════════════════════════════════════════════════════════════════════
-- CHANGES: hoists the criteria that were already in the prose into the structured
-- columns that already exist — `success_criteria`, `expected_output`,
-- `verification_method`. Zero DDL on any table; zero new columns.
--
-- DOES NOT CHANGE: the task's meaning, its description, its schedule, its
-- de-duplication guard, priority, task_type, or `requires_external_artifact` (which
-- this function already set correctly to true — it was never the problem).
--
-- The description keeps its CHECKER text. Deleting it would be the "single source"
-- purist move and it would be wrong here: the agent reads the description, and
-- removing the bar from the place the reader looks in order to satisfy a schema
-- preference trades a real property for a tidy one.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- REVERSIBILITY
-- ═══════════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE on a function with no signature change. The previous definition
-- is preserved verbatim at the bottom of this file; re-running it restores the
-- prior behaviour exactly. No rows are modified — existing tasks keep whatever they
-- have, because rewriting history to match a new standard would destroy the very
-- baseline that lets anyone measure whether this helped.
--
-- VERIFY AFTER APPLYING (next run is 09:15 UTC):
--   SELECT id, created_at, success_criteria, expected_output, verification_method
--   FROM trinity_tasks WHERE insert_source='claude-loop'
--   ORDER BY created_at DESC LIMIT 3;
--   -- expect: success_criteria <> 'Pass default checks.' on the newest row
--
-- To force one immediately without waiting for cron (creates one real task, and
-- returns NULL instead if an E2E smoke is already open):
--   SELECT dispatch_e2e_smoke();

CREATE OR REPLACE FUNCTION public.dispatch_e2e_smoke()
 RETURNS bigint
 LANGUAGE plpgsql
AS $function$
DECLARE v_id bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM trinity_tasks
             WHERE title LIKE '[E2E-SMOKE%' AND status IN ('pending','doing','claimed','in_review')) THEN
    RETURN NULL; -- an open E2E smoke already exists; skip (no pile-up)
  END IF;
  INSERT INTO trinity_tasks (
    title, description, task_type, status, insert_source, agent_assigned, priority,
    requires_external_artifact, success_criteria, expected_output, verification_method, created_at
  )
  VALUES (
    '[E2E-SMOKE nightly] Live value-loop smoke — evidence required',
    'GOAL: table, one row per endpoint: {endpoint, http_status(int), verbatim_excerpt(<=200 chars), verdict: live|error|stale}. INPUTS (given, do NOT ask): BASE=https://repid-engine-production.up.railway.app ; GET BASE/health (expect deployed_commit), BASE/api/v1/repid/leaderboard, BASE/api/v1/marketplace/browse, BASE/api/v1/stats. SCOPE: read-only GETs + one artifact to trinity_artifacts. CHECKER: valid ONLY IF every row has a real integer http_status + a verbatim excerpt from the real body; "I need X"/"here is a plan" = NOT done (set pending, stop). PROVENANCE: real HTTP only; no synthetic. STOP: success=all rows real; failure=HTTP impossible after 2 tries → report; max 6 iters. MONEY: $0.',
    'review', 'pending', 'claude-loop', NULL, 70, true,
    -- success_criteria: the CHECKER/PROVENANCE clauses from the description, hoisted
    -- into the column a machine actually reads. Reproduced rather than paraphrased —
    -- a criterion that drifts from the one the agent was shown is worse than none.
    'Every one of the 4 endpoint rows carries a REAL integer http_status and a verbatim excerpt copied from the real response body. Obtained by real HTTP only — no synthetic, reconstructed, or remembered values. A plan, a request for access ("I need X"), or a description of what would have been found does NOT satisfy this and must be reported as NOT done. Reporting "could not reach endpoint X after 2 tries" IS a valid, correct outcome; an invented status code is not.',
    -- expected_output: 56 of 363,015 rows have ever set this. The shape was already
    -- stated in the GOAL clause; stating it here makes it checkable.
    'A 4-row table, one row per endpoint, each row: {endpoint, http_status (integer), verbatim_excerpt (<=200 chars, copied from the real body), verdict: live|error|stale}. Plus one artifact written to trinity_artifacts.',
    -- verification_method: ZERO rows in the entire table have ever set this column.
    -- Naming the check makes the task auditable by something other than a human
    -- reading prose.
    'Cross-check each reported http_status and verbatim_excerpt against an independent GET of the same endpoint. Any row whose excerpt does not appear in the live response body fails the task.',
    now()
  ) RETURNING id INTO v_id;
  RETURN v_id;
END$function$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — the exact prior definition, captured from pg_get_functiondef
-- before this change. Run this block to restore.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- CREATE OR REPLACE FUNCTION public.dispatch_e2e_smoke()
--  RETURNS bigint
--  LANGUAGE plpgsql
-- AS $function$
-- DECLARE v_id bigint;
-- BEGIN
--   IF EXISTS (SELECT 1 FROM trinity_tasks
--              WHERE title LIKE '[E2E-SMOKE%' AND status IN ('pending','doing','claimed','in_review')) THEN
--     RETURN NULL; -- an open E2E smoke already exists; skip (no pile-up)
--   END IF;
--   INSERT INTO trinity_tasks (title, description, task_type, status, insert_source, agent_assigned, priority, requires_external_artifact, created_at)
--   VALUES (
--     '[E2E-SMOKE nightly] Live value-loop smoke — evidence required',
--     'GOAL: table, one row per endpoint: {endpoint, http_status(int), verbatim_excerpt(<=200 chars), verdict: live|error|stale}. INPUTS (given, do NOT ask): BASE=https://repid-engine-production.up.railway.app ; GET BASE/health (expect deployed_commit), BASE/api/v1/repid/leaderboard, BASE/api/v1/marketplace/browse, BASE/api/v1/stats. SCOPE: read-only GETs + one artifact to trinity_artifacts. CHECKER: valid ONLY IF every row has a real integer http_status + a verbatim excerpt from the real body; "I need X"/"here is a plan" = NOT done (set pending, stop). PROVENANCE: real HTTP only; no synthetic. STOP: success=all rows real; failure=HTTP impossible after 2 tries → report; max 6 iters. MONEY: $0.',
--     'review', 'pending', 'claude-loop', NULL, 70, true, now()
--   ) RETURNING id INTO v_id;
--   RETURN v_id;
-- END$function$;
