-- XC Sprint 2026-06-18 — public per-vertical leaderboard view (Trinity 12, mocks excluded).
-- ROLLBACK: DROP VIEW IF EXISTS public.v_repid_leaderboard_by_vertical;

CREATE OR REPLACE VIEW public.v_repid_leaderboard_by_vertical AS
WITH public_agents AS (
  SELECT
    ra.agent_name,
    ra.current_repid,
    ra.tier,
    ra.domain_accuracy
  FROM repid_agents ra
  WHERE ra.agent_name = ANY (ARRAY[
    'trinity-mel','trinity-sophia','trinity-torch','trinity-nexus','trinity-hdm','trinity-gcm',
    'trinity-apm','trinity-w3c','trinity-chesed','trinity-shofet','trinity-veritas','trinity-orch'
  ]::text[])
    AND COALESCE(ra.agent_id, '') NOT LIKE 'trinity-agent-mock-%'
),
overall_rank AS (
  SELECT
    'overall'::text AS vertical,
    pa.agent_name,
    pa.current_repid,
    pa.tier,
    NULL::numeric AS domain_pct,
    ROW_NUMBER() OVER (ORDER BY pa.current_repid DESC, pa.agent_name) AS rank
  FROM public_agents pa
),
domain_rank AS (
  SELECT
    d.vertical,
    pa.agent_name,
    pa.current_repid,
    pa.tier,
    d.domain_pct,
    ROW_NUMBER() OVER (
      PARTITION BY d.vertical
      ORDER BY d.domain_pct DESC NULLS LAST, pa.current_repid DESC, pa.agent_name
    ) AS rank
  FROM public_agents pa
  CROSS JOIN LATERAL (
    SELECT
      kv.key AS vertical,
      (kv.value ->> 'pct')::numeric AS domain_pct
    FROM jsonb_each(pa.domain_accuracy) AS kv(key, value)
    WHERE jsonb_typeof(pa.domain_accuracy) = 'object'
      AND pa.domain_accuracy <> '{}'::jsonb
      AND (kv.value ->> 'pct') IS NOT NULL
  ) d
)
SELECT vertical, agent_name, current_repid, tier, domain_pct, rank FROM overall_rank
UNION ALL
SELECT vertical, agent_name, current_repid, tier, domain_pct, rank FROM domain_rank;

COMMENT ON VIEW public.v_repid_leaderboard_by_vertical IS
  'Trinity 12 overall + per-vertical ranks from domain_accuracy; excludes trinity-agent-mock-%';

-- Public read (TrustShell /stats surfaces)
GRANT SELECT ON public.v_repid_leaderboard_by_vertical TO anon, authenticated;