-- P0.5 RepID RECONCILIATION — cause-aware replay of repid_score_events (+ the missing agent_id index).
-- OUTPUT_PATH: migrations/2026-07-21-repid-reconciliation.sql
-- REPORT: scripts/verify/repid-reconciliation-report.mjs (READ-ONLY; safe to run)
--
-- ==========================================================================================
-- PROMOTION-GATED — NOT APPLIED TO PROD. Gate chain: GA drafts -> XC red-teams ->
-- Sean ratifies -> Claude applies. Do NOT run against qnnpjhlxljtqyigedwkb until Sean
-- co-signs. This file creates a PURE/READ helper + STABLE replay fn + one index. It contains
-- NO writes to current_repid — reconciliation WRITES are a SEPARATE, Sean-gated migration.
-- ==========================================================================================
--
-- WHY THIS EXISTS (verified diagnosis 2026-07-21):
--   * repid_agents.current_repid for the 12 trinity agents is ~1000-2000 (epoch-1 reset baseline).
--   * A NAIVE replay of repid_score_events (1000 + Sum(delta)) yields ABSURD negatives, e.g.
--     trinity-gcm  = -128,435 over 33,418 events;  shofet = -126,344 over 33,987 events.
--     That is a DB-vs-naive-replay gap of +30K..+128K per agent.
--   * ROOT CAUSE: the event log is dominated by DRILL-CHURN — internal HAL veto penalties from
--     the peer-verify flood (the ~33K events/agent MATCH the drained flood). Those penalize
--     agents for INTERNAL cron/drills that are NOT real work. A naive replay ALSO ignores the
--     per-event [10,10000] clamp that the live engine applies (repid-update.ts step 7), so the
--     sum runs unbounded negative. The DB value was a MANUAL reset (papered over, not reconciled).
--   * repid_score_events.agent_id had NO index -> the diagnostic query timed out twice.
--     agent_id is UUID and equals repid_agents.id.
--
-- WHAT THIS DELIVERS (all non-mutating):
--   1. idx_repid_score_events_agent_created  -> fixes the timeout.
--   2. is_repid_drill_churn(event_type, metadata) -> the CAUSE-FILTER POLICY, explicit + editable.
--      *** THIS FUNCTION IS SEAN'S RATIFY DECISION. *** Every rule is commented with WHY so the
--      policy can be tuned before apply. Nothing downstream reads it until the report/apply step.
--   3. replay_score_events(agent_id, baseline, real_work_only) -> cause-aware, per-event-clamped
--      replay that reconstructs a DEFENSIBLE score. real_work_only=true excludes drill-churn.
--
-- SCHEMA-FIRST (CLAUDE-RULE-5): columns/metadata shape derived from the live writer in
--   src/engine/repid-update.ts (insert into repid_score_events): agent_id uuid, event_type text,
--   delta int, created_at timestamptz, metadata jsonb (keys: mode, deltaComputed, stakeProof.txHash,
--   x402Context, ...). Tier trigger trg_sync_tier fires ONLY on UPDATE OF current_repid — this
--   migration never updates current_repid, so the tier trigger is not involved.

-- ------------------------------------------------------------------------------------------
-- 1) INDEX — the timeout fix. Covers the (agent_id, created_at) replay walk + agent rollups.
--    IF NOT EXISTS keeps it idempotent. On prod this should be CREATE INDEX CONCURRENTLY (run
--    OUTSIDE a txn) to avoid locking the write-hot table; the plain form is kept here so the file
--    stays a single reviewable unit — the apply step chooses CONCURRENTLY (see POST-APPLY block).
-- ------------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_repid_score_events_agent_created
  ON repid_score_events (agent_id, created_at);

-- ------------------------------------------------------------------------------------------
-- 2) CAUSE-FILTER POLICY — *** SEAN'S RATIFY DECISION ***
--    Returns TRUE when an event is DRILL-CHURN (internal cron/drill noise) and should be
--    EXCLUDED from a real-work replay. IMMUTABLE + pure on its inputs (no table reads) so it is
--    safe to reason about and cheap to call per row.
--
--    DEFENSIBLE DEFAULT (edit here, then re-run the report, before any apply):
--      EXCLUDE  an event iff  event_type = 'HAL_SCORE_EVENT'  AND it carries NO real-work
--               reference (no task_id / artifact / tx_hash / settlement anywhere in metadata).
--               WHY: the flood is HAL veto penalties fired by internal peer-verify drills with no
--               real task/artifact/on-chain settlement behind them — punishing drills, not work.
--      INCLUDE  everything else. Explicitly INCLUDE (never treat as churn):
--               SERVICE_FULFILLED, VALIDATOR_REWARD, VALIDATOR_PENALTY, CHALLENGE_*,
--               PREDICTION_RESOLVE, GENESIS, STAKE, and ANY event (HAL_SCORE_EVENT included)
--               that DOES carry a real task/artifact/on-chain reference.
--               WHY: these are real earned/lost reputation with a cause behind them; a HAL penalty
--               that IS tied to a real settlement/artifact is legitimate and stays in.
-- ------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_repid_drill_churn(p_event_type text, p_metadata jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_meta jsonb := COALESCE(p_metadata, '{}'::jsonb);
  v_has_real_ref boolean;
BEGIN
  -- --- REAL-WORK REFERENCE TEST ------------------------------------------------------------
  -- An event "has a real reference" if metadata proves a real cause: a task id, an artifact, an
  -- on-chain tx, or an x402 settlement. Checked both as top-level keys (external writers use
  -- snake_case) AND at the known nested paths the engine writer uses (camelCase). Edit this list
  -- to widen/narrow what counts as "real work" — it is the crux of the ratify decision.
  v_has_real_ref :=
       (v_meta ? 'task_id')                               -- external: task reference
    OR (v_meta ? 'taskId')
    OR (v_meta ? 'artifact')                              -- external: artifact reference
    OR (v_meta ? 'artifact_url')
    OR (v_meta ? 'tx_hash')                               -- external: on-chain tx
    OR (v_meta ? 'txHash')
    OR (v_meta ? 'settlement')                            -- external: settlement reference
    OR (v_meta ? 'settlement_id')
    OR ((v_meta -> 'stakeProof' ->> 'txHash') IS NOT NULL)   -- engine writer: verified stake tx
    OR ((v_meta -> 'x402Context') IS NOT NULL              -- engine writer: x402 settlement context
        AND (v_meta -> 'x402Context') <> 'null'::jsonb);

  -- --- RULE 1: HAL drill-churn (the flood) -------------------------------------------------
  -- The dominant noise is HAL veto penalties with NO real reference. Exclude exactly those.
  -- A HAL event WITH a real reference is legitimate and falls through to INCLUDE (return false).
  IF p_event_type = 'HAL_SCORE_EVENT' AND NOT v_has_real_ref THEN
    RETURN true;  -- EXCLUDE: internal drill veto, no work behind it
  END IF;

  -- --- (optional future rules) -------------------------------------------------------------
  -- Add more churn classes here as Sean ratifies them, e.g. a SELF_MONITOR spam class or a
  -- specific metadata.mode marker. Keep every rule commented with WHY. Left minimal on purpose:
  -- the defensible default excludes ONLY unreferenced HAL_SCORE_EVENT churn.

  -- --- DEFAULT: INCLUDE --------------------------------------------------------------------
  RETURN false;  -- INCLUDE: real earned/lost reputation with a cause
END;
$$;

COMMENT ON FUNCTION is_repid_drill_churn(text, jsonb) IS
  'P0.5 CAUSE-FILTER POLICY (Sean-ratify point). TRUE = drill-churn to EXCLUDE from a real-work '
  'replay. Default: exclude HAL_SCORE_EVENT with no task/artifact/tx/settlement reference; include '
  'everything else. Pure/IMMUTABLE. Edit + re-run scripts/verify/repid-reconciliation-report.mjs '
  'before any Sean-gated apply.';

-- ------------------------------------------------------------------------------------------
-- 3) REPLAY — cause-aware, per-event-clamped reconstruction of an agent's score.
--    STABLE (reads repid_score_events; no writes). Walks the agent's events in created_at order
--    and, for each:
--      (i)  if p_real_work_only AND is_repid_drill_churn(...)  -> SKIP, count excluded;
--      (ii) else apply the SAME clamp the live engine applies (repid-update.ts step 7):
--             v := GREATEST(10, LEAST(10000, v + delta));  count applied.
--    Returns the reconciled score + applied/excluded counts. p_real_work_only=false reproduces
--    the naive (all-events, but STILL clamped) replay for side-by-side comparison.
--
--    NOTE ON THE CLAMP: applying [10,10000] PER EVENT (not just at the end) is what makes the
--    number defensible — it mirrors production, where current_repid can never leave [10,10000],
--    so a run of penalties can't drive an agent to -128K and then "owe" a recovery. This alone
--    removes most of the absurd-negative gap even before cause-filtering.
-- ------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION replay_score_events(
  p_agent_id       uuid,
  p_baseline       int  DEFAULT 1000,   -- epoch-1 ESTABLISHED-floor baseline
  p_real_work_only boolean DEFAULT true -- true = exclude drill-churn (cause-aware); false = naive-but-clamped
)
RETURNS TABLE(reconciled_repid int, events_applied int, events_excluded int)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_repid    int := GREATEST(10, LEAST(10000, p_baseline));  -- clamp the baseline itself
  v_applied  int := 0;
  v_excluded int := 0;
  r          record;
BEGIN
  FOR r IN
    SELECT delta, event_type, metadata
      FROM repid_score_events
     WHERE agent_id = p_agent_id
     ORDER BY created_at ASC, id ASC   -- deterministic within same-timestamp ties
  LOOP
    IF p_real_work_only AND is_repid_drill_churn(r.event_type, r.metadata) THEN
      v_excluded := v_excluded + 1;
      CONTINUE;                                   -- (i) skip drill-churn
    END IF;
    -- (ii) apply the per-event production clamp
    v_repid := GREATEST(10, LEAST(10000, v_repid + COALESCE(r.delta, 0)));
    v_applied := v_applied + 1;
  END LOOP;

  reconciled_repid := v_repid;
  events_applied   := v_applied;
  events_excluded  := v_excluded;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION replay_score_events(uuid, int, boolean) IS
  'P0.5 cause-aware RepID replay (READ-ONLY, STABLE). Walks an agent''s repid_score_events in '
  'created_at order applying the per-event [10,10000] clamp; real_work_only=true excludes '
  'is_repid_drill_churn events. Returns (reconciled_repid, events_applied, events_excluded). '
  'NO write to current_repid — reconciliation writes are a separate Sean-gated migration.';

-- ==========================================================================================
-- ROLLBACK (safe; drops only the objects this file adds):
--   DROP FUNCTION IF EXISTS replay_score_events(uuid, int, boolean);
--   DROP FUNCTION IF EXISTS is_repid_drill_churn(text, jsonb);
--   DROP INDEX IF EXISTS idx_repid_score_events_agent_created;
--
-- POST-APPLY VERIFY (run only after a Sean-gated apply; READ-ONLY, no writes):
--   -- index exists:
--   SELECT indexname FROM pg_indexes WHERE tablename='repid_score_events' AND indexname='idx_repid_score_events_agent_created';
--   -- functions exist:
--   SELECT proname FROM pg_proc WHERE proname IN ('is_repid_drill_churn','replay_score_events');
--   -- spot-check one agent (replace :id with a trinity agent's repid_agents.id):
--   SELECT a.agent_name, a.current_repid AS db_current,
--          (replay_score_events(a.id, 1000, true )).reconciled_repid AS reconciled_real_work,
--          (replay_score_events(a.id, 1000, false)).reconciled_repid AS reconciled_naive_clamped,
--          (replay_score_events(a.id, 1000, true )).events_excluded  AS excluded
--     FROM repid_agents a
--    WHERE a.agent_name = 'trinity-gcm';
--
-- APPLY NOTE (Sean-gated): create the index CONCURRENTLY on prod to avoid locking the write-hot
-- table, i.e. run this instead of the plain CREATE INDEX above, OUTSIDE a transaction:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_repid_score_events_agent_created
--     ON repid_score_events (agent_id, created_at);
-- ==========================================================================================
