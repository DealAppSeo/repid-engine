-- RepID economic-loop dashboard queries — Sean-runnable in Supabase SQL editor.
-- CC1, 2026-05-24. Two groups: (A) live queries against source tables (work today, no new table);
-- (B) snapshot-history queries (need repid_telemetry_snapshots, migration 001).

-- ════════════════════════════ A. LIVE (work now) ════════════════════════════

-- A1. Operational health — active agents by tier
SELECT tier, COUNT(*) AS n
FROM repid_agents WHERE lifecycle_status = 'active'
GROUP BY tier ORDER BY n DESC;

-- A2. Queue depth (pending work)
SELECT
  (SELECT COUNT(*) FROM service_contracts WHERE status = 'pending')   AS pending_contracts,
  (SELECT COUNT(*) FROM service_contracts WHERE status = 'escrowed')  AS escrowed_contracts,
  (SELECT COUNT(*) FROM repid_events
     WHERE event_type = 'service_fulfilled_settled' AND processed_at IS NULL) AS pending_bridge_writes;

-- A3. Economic flow — real contract settlements + on-chain attestations
SELECT
  (SELECT COUNT(*) FROM x402_settlements WHERE is_simulated = false AND idempotency_key IS NOT NULL) AS real_contract_settlements,
  (SELECT COUNT(*) FROM x402_settlements WHERE is_simulated = false AND idempotency_key IS NOT NULL AND tx_hash IS NOT NULL) AS with_tx_hash,
  (SELECT COUNT(*) FROM erc8004_reputation_writes WHERE tx_hash !~* '^0x(mock|abc|0{8})') AS real_onchain_attestations,
  (SELECT MAX(id) FROM erc8004_reputation_writes) AS max_write_id;

-- A4. Settlement velocity (last 7 days, hourly, real only)
SELECT date_trunc('hour', created_at) AS hour, COUNT(*) AS settlements
FROM x402_settlements
WHERE is_simulated = false AND created_at > NOW() - INTERVAL '7 days'
GROUP BY 1 ORDER BY 1 DESC;

-- A5. HAL behavior — veto rate (last 7 days)
SELECT hal_decision, COUNT(*) AS n,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM repid_score_events
WHERE hal_decision IS NOT NULL AND created_at > NOW() - INTERVAL '7 days'
GROUP BY hal_decision;

-- A6. Swarm health (existing view — adapt, don't duplicate)
SELECT * FROM trinity_swarm_health;

-- ─── Audit-trail integrity monitors (invariants — investigate any non-green) ───

-- A7. GAP A monitor — real settlements missing on-chain tx_hash (target: 0 after Gemini H1)
SELECT COUNT(*) AS settlements_missing_tx_hash
FROM x402_settlements
WHERE is_simulated = false AND idempotency_key IS NOT NULL AND tx_hash IS NULL;

-- A8. INVARIANT — simulated→on-chain leaks (MUST be 0)
SELECT COUNT(*) AS sim_to_onchain_leaks
FROM repid_events
WHERE event_type = 'service_fulfilled_settled'
  AND lower(COALESCE(event_data->>'is_simulated','false')) IN ('true','1','yes')
  AND COALESCE(event_data->>'reputation_tx_hash','') !~* '^0x(mock|abc|0{8})'
  AND COALESCE(event_data->>'reputation_tx_hash','') <> '';

-- A9. Duplicate real fire per contract (MUST be empty — double-fulfill signal)
SELECT idempotency_key, COUNT(*)
FROM x402_settlements
WHERE is_simulated = false AND idempotency_key IS NOT NULL
GROUP BY idempotency_key HAVING COUNT(*) > 1;

-- ════════════════════════ B. SNAPSHOT HISTORY (after migration 001) ═══════════

-- B1. Latest snapshot per family
SELECT metric_family, metric_name, metric_value, snapshot_at
FROM repid_telemetry_snapshots t
WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM repid_telemetry_snapshots t2 WHERE t2.metric_family = t.metric_family)
ORDER BY metric_family, metric_name;

-- B2. A single metric over time (e.g. veto_rate trend)
SELECT snapshot_at, metric_value
FROM repid_telemetry_snapshots
WHERE metric_name = 'veto_rate_recent'
ORDER BY snapshot_at DESC LIMIT 50;

-- B3. GAP-A remediation trend (settlements_missing_tx_hash should trend to 0)
SELECT snapshot_at, metric_value->>'value' AS missing_tx_hash
FROM repid_telemetry_snapshots
WHERE metric_name = 'settlements_missing_tx_hash'
ORDER BY snapshot_at DESC LIMIT 50;

-- ════════════════════ C. SETTLEMENTS TIMELINE (Phase 3, 2026-05-25) ════════════════════
-- Settlements + score_events + on-chain attestations bucketed hourly over the last 7 days.
-- Sean-runnable; also feeds a future dashboard trend chart.
SELECT
  date_trunc('hour', t.hour) AS hour,
  COALESCE(s.settlements, 0)        AS settlements,
  COALESCE(s.real_settlements, 0)   AS real_settlements,
  COALESCE(e.score_events, 0)       AS score_events,
  COALESCE(e.vetoed, 0)             AS hal_vetoed,
  COALESCE(a.attestations, 0)       AS onchain_attestations
FROM generate_series(date_trunc('hour', NOW() - INTERVAL '7 days'), date_trunc('hour', NOW()), INTERVAL '1 hour') AS t(hour)
LEFT JOIN (
  SELECT date_trunc('hour', created_at) h,
         COUNT(*) settlements,
         COUNT(*) FILTER (WHERE is_simulated = false) real_settlements
  FROM x402_settlements WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY 1
) s ON s.h = t.hour
LEFT JOIN (
  SELECT date_trunc('hour', created_at) h,
         COUNT(*) score_events,
         COUNT(*) FILTER (WHERE hal_decision = 'vetoed') vetoed
  FROM repid_score_events WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY 1
) e ON e.h = t.hour
LEFT JOIN (
  SELECT date_trunc('hour', created_at) h, COUNT(*) attestations
  FROM erc8004_reputation_writes WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY 1
) a ON a.h = t.hour
ORDER BY hour DESC;

-- C2. Compact daily-rollup history (from health-summary-24h.ts)
SELECT snapshot_at, metric_value
FROM repid_telemetry_snapshots
WHERE metric_family = 'health_24h' ORDER BY snapshot_at DESC LIMIT 30;

-- ════════════════════ D. PRODUCTIVITY STACK (Phase 4.3, 2026-05-26) ════════════════════
-- Mirrors GET /api/v1/observability/productivity-stack for Sean's manual inspection.

-- D1. SLM tier — decisions + cost saved (24h)
SELECT COUNT(*) AS slm_decisions,
       ROUND(COALESCE(SUM((outcome->'savings'->>'saved_usd')::numeric), 0), 6) AS slm_cost_saved_usd,
       ROUND(COALESCE(SUM((outcome->'savings'->>'slm_cost_usd')::numeric), 0), 6) AS slm_actual_cost_usd
FROM trinity_tool_usage
WHERE tool_name = 'slm_route' AND created_at > NOW() - INTERVAL '24 hours';

-- D2. Firecrawl usage + cost by agent (24h)
SELECT agent_id, COUNT(*) AS calls,
       ROUND(COALESCE(SUM(COALESCE((outcome->>'cost_usd')::numeric, (outcome->>'cost')::numeric, 0)), 0), 6) AS cost_usd
FROM trinity_tool_usage
WHERE tool_name ILIKE '%firecrawl%' AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY agent_id ORDER BY cost_usd DESC;

-- D3. ANFIS routing distribution (24h): SLM vs cheap-LLM vs expensive-LLM
SELECT
  COUNT(*) FILTER (WHERE lower(llm_provider) IN ('groq','cerebras') AND lower(coalesce(llm_model,'')) LIKE '%8b%') AS slm,
  COUNT(*) FILTER (WHERE lower(llm_provider) IN ('anthropic','openai')) AS expensive_llm,
  COUNT(*) AS total_with_provider
FROM repid_score_events
WHERE llm_provider IS NOT NULL AND created_at > NOW() - INTERVAL '24 hours';

-- D4. Per-agent productivity: tasks completed (24h)
SELECT COALESCE(completed_by, agent_name, 'unknown') AS agent, COUNT(*) AS tasks_completed
FROM trinity_tasks WHERE completed_at > NOW() - INTERVAL '24 hours'
GROUP BY 1 ORDER BY tasks_completed DESC;
