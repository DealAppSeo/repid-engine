-- S-REP3: RepID Explainability "Why did my RepID change?" read-only view
-- DESIGN / PROPOSAL ONLY
-- Cowork co-sign REQUIRED before executing CREATE VIEW or function in any environment.
--
-- Goal: For any agent + time window, return an ordered, human/LLM-auditable
--       timeline of exactly what moved their current_repid, with full context.
--
-- Usage (after creation):
--   SELECT * FROM repid_explainability
--   WHERE agent_id = '...' 
--     AND created_at BETWEEN '2026-05-01' AND '2026-05-30'
--   ORDER BY created_at;

-- Recommended: a view + a small helper function for convenience.
-- The view is safe for authenticated agents to query their own history
-- (add RLS later if exposing via PostgREST).

CREATE OR REPLACE VIEW repid_explainability AS
SELECT
    rse.id,
    rse.created_at,
    rse.agent_id,
    ra.agent_name,

    -- The delta and before/after that actually changed the balance
    rse.delta,
    rse.repid_before,
    rse.repid_after,

    -- Why it happened
    rse.event_type                    AS reason,
    rse.hal_score,
    rse.hal_decision,
    rse.veto_class,
    rse.hallucination_caught,

    -- Was this penalty suppressed by the D-050 HAL guard?
    (rse.delta = 0 AND rse.hal_decision IN ('flagged','vetoed')) AS suppressed_by_hal_guard,

    -- Full HAL context for deep audit / Trust Card
    rse.metadata -> 'hal_signals'     AS hal_signals,

    -- Resulting state after this event (best-effort from current snapshot + this delta)
    ra.tier                           AS tier_after_event,

    -- For authority impact, join to current stake/wisdom/character if needed in application layer
    -- or materialize a snapshot at event time in a future iteration.

    rse.idempotency_key,
    rse.llm_provider,
    rse.task_domain

FROM repid_score_events rse
JOIN repid_agents       ra  ON ra.id = rse.agent_id
ORDER BY rse.created_at, rse.id;

-- Optional: a parameterized helper function (more future-proof for PostgREST)
CREATE OR REPLACE FUNCTION get_repid_explainability(
    p_agent_id uuid,
    p_from timestamptz DEFAULT now() - interval '30 days',
    p_to   timestamptz DEFAULT now()
)
RETURNS SETOF repid_explainability
LANGUAGE sql STABLE AS $$
    SELECT * FROM repid_explainability
    WHERE agent_id = p_agent_id
      AND created_at BETWEEN p_from AND p_to;
$$;

COMMENT ON VIEW  repid_explainability IS 
  'S-REP3 — Read-only "why did my RepID change?" timeline. One row per repid_score_event with full HAL + suppression context.';

COMMENT ON FUNCTION get_repid_explainability(uuid, timestamptz, timestamptz) IS
  'S-REP3 convenience wrapper. Use this from application code or (after RLS + co-sign) via PostgREST.';

-- Security note for when this is exposed:
--   - RLS should later restrict to the owning agent (or their authorized viewers).
--   - Until then, treat as internal / authenticated-only.
--   - Never grant to anon.

-- Rollback (if created):
--   DROP VIEW IF EXISTS repid_explainability;
--   DROP FUNCTION IF EXISTS get_repid_explainability(uuid, timestamptz, timestamptz);