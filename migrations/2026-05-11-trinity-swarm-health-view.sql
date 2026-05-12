-- ================================================================
-- CC Sprint 6 — trinity_swarm_health view
-- 2026-05-11 evening
-- ================================================================
-- Built so Sean has a single SELECT query he can run after executing
-- Sprint 5's 8-step Railway restart checklist. The view shows ONE row
-- per EXPECTED trinity service (the canonical 12), so an agent that
-- never reports back after restart appears as a red row with NULLs —
-- not as a missing row.
--
-- Status color thresholds:
--   green   = last_seen within 5 minutes (active heartbeat)
--   yellow  = last_seen within 60 minutes (recent but not current)
--   red     = last_seen > 60 minutes ago OR NULL (likely dead)
--
-- Spokesperson cross-join: hardcoded per Sean-confirmed canonical mapping
-- (preflight §5):
--   alpha          → SOPHIA  (UUID f3ef0bf8-...)
--   beta           → VERITAS (UUID a83cc9eb-...)
--   gamma          → SHOFET  (UUID 32e0e809-...)
--   orchestration  → CHESED  (UUID 2c2c24d6-...)
-- This is the SQUAD spokesperson identity, not the worker. The
-- expected_squad column comes from agent_squad_map (worker→squad)
-- which uses lowercase squad names.
--
-- KNOWN INCONSISTENCY (surfaced for Sean, not fixed here per RULE-3):
-- agent_squad_map places trinity-sophia in squad='beta' while the
-- canonical spokesperson mapping has SOPHIA representing alpha. The
-- spokesperson identity (SOPHIA) is a separate concept from the
-- worker (trinity-sophia). The view exposes both faithfully so the
-- discrepancy is visible rather than smoothed over.
-- ================================================================

CREATE OR REPLACE VIEW public.trinity_swarm_health AS
WITH expected_agents AS (
  SELECT unnest(ARRAY[
    'trinity-orch','trinity-w3c','trinity-shofet','trinity-torch',
    'trinity-veritas','trinity-gcm','trinity-chesed','trinity-mel',
    'trinity-apm','trinity-sophia','trinity-nexus','trinity-hdm'
  ]) AS agent_name
),
spokesperson_by_squad(squad, spokesperson_name, spokesperson_uuid) AS (
  VALUES
    ('alpha',         'SOPHIA',  'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271'::uuid),
    ('beta',          'VERITAS', 'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067'::uuid),
    ('gamma',         'SHOFET',  '32e0e809-c1c4-4405-913f-135c8a2d6626'::uuid),
    ('orchestration', 'CHESED',  '2c2c24d6-2fd0-47e6-95d5-7fc9804a19e6'::uuid)
),
heartbeat_latest AS (
  -- trinity_heartbeat is upserted on agent boot; pick latest per agent
  SELECT DISTINCT ON (agent)
    agent, last_seen, status, version,
    config->>'group' AS heartbeat_group_label
  FROM public.trinity_heartbeat
  ORDER BY agent, last_seen DESC
),
last_task_claim AS (
  SELECT claimed_by AS agent_name, max(claimed_at) AS last_claimed_at
  FROM public.trinity_tasks
  WHERE claimed_by IS NOT NULL
  GROUP BY claimed_by
),
last_artifact AS (
  SELECT agent AS agent_name, max(created_at) AS last_artifact_at
  FROM public.trinity_artifacts
  WHERE agent IS NOT NULL
  GROUP BY agent
)
SELECT
  e.agent_name,
  asm.squad AS expected_squad,
  asm.role AS squad_role,
  s.spokesperson_name AS expected_spokesperson,
  s.spokesperson_uuid,
  hb.last_seen AS heartbeat_last_seen,
  CASE
    WHEN hb.last_seen IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (NOW() - hb.last_seen)) / 60.0
  END AS minutes_since_last_seen,
  CASE
    WHEN hb.last_seen IS NULL THEN 'red'
    WHEN hb.last_seen > NOW() - INTERVAL '5 minutes' THEN 'green'
    WHEN hb.last_seen > NOW() - INTERVAL '60 minutes' THEN 'yellow'
    ELSE 'red'
  END AS status_color,
  hb.status AS heartbeat_status,
  hb.version AS heartbeat_version,
  ltc.last_claimed_at AS last_task_claimed_at,
  la.last_artifact_at,
  -- Note: repid_score_events doesn't track which trinity-* worker
  -- contributed; agent_id there refers to RepID-bearing identities
  -- (spokespersons), not workers. So we surface the spokesperson's
  -- last score event as a proxy for "is the squad active?"
  (SELECT max(rse.created_at)
     FROM public.repid_score_events rse
     WHERE rse.agent_id = s.spokesperson_uuid) AS spokesperson_last_score_event_at,
  NOW() AS computed_at
FROM expected_agents e
LEFT JOIN public.agent_squad_map asm ON asm.agent_name = e.agent_name
LEFT JOIN spokesperson_by_squad s ON s.squad = asm.squad
LEFT JOIN heartbeat_latest hb ON hb.agent = e.agent_name
LEFT JOIN last_task_claim ltc ON ltc.agent_name = e.agent_name
LEFT JOIN last_artifact la ON la.agent_name = e.agent_name
ORDER BY
  CASE
    WHEN hb.last_seen IS NULL THEN 2
    WHEN hb.last_seen > NOW() - INTERVAL '5 minutes' THEN 0
    WHEN hb.last_seen > NOW() - INTERVAL '60 minutes' THEN 1
    ELSE 2
  END,
  hb.last_seen DESC NULLS LAST,
  e.agent_name;

GRANT SELECT ON public.trinity_swarm_health TO anon;
GRANT SELECT ON public.trinity_swarm_health TO authenticated;
GRANT SELECT ON public.trinity_swarm_health TO service_role;

COMMENT ON VIEW public.trinity_swarm_health IS
  'One row per expected trinity-* worker (12 canonical). Combines '
  'trinity_heartbeat (boot/recurring heartbeat — note recurring is '
  'currently disabled per ConstitutionalAgentV4.js:153-157), '
  'trinity_tasks.claimed_by, trinity_artifacts, and the spokesperson '
  'mapping (alpha/beta/gamma/orchestration → SOPHIA/VERITAS/SHOFET/CHESED). '
  'Used after Railway restarts to verify the swarm is back online. '
  'CC Sprint 6 (2026-05-11).';

-- Rollback:
--   DROP VIEW IF EXISTS public.trinity_swarm_health;
