-- Phase 2.10 — ANFIS Routing Service Handler companion RPC.
-- Positive-outcome set per Phase 2.9.3 Q0.4 + Strategy Claude Decision 4:
-- distinct decision_outcome values observed = approved, APPROVED, clean,
-- PENDING, profit, rejected, submitted, test, vetoed.
--   positive: approved/APPROVED/clean/profit  -> 1.0
--   negative: rejected/vetoed                 -> 0.0
--   neutral/transient: submitted/PENDING/test -> NULL (AVG ignores → no skew)

CREATE OR REPLACE FUNCTION anfis_provider_performance_lookup(
  p_domain TEXT,
  p_window_days INTEGER
)
RETURNS TABLE (
  provider TEXT,
  hit_rate NUMERIC,
  avg_latency_ms NUMERIC,
  avg_cost_usdc NUMERIC,
  sample_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    rse.llm_provider::text AS provider,
    AVG(CASE
      WHEN rse.decision_outcome IN ('approved','APPROVED','clean','profit') THEN 1.0
      WHEN rse.decision_outcome IN ('rejected','vetoed') THEN 0.0
      ELSE NULL
    END) AS hit_rate,
    AVG(COALESCE((rse.metadata->>'latency_ms')::numeric, 0)) AS avg_latency_ms,
    AVG(COALESCE(rse.economic_impact_usdc, 0)) AS avg_cost_usdc,
    COUNT(*) AS sample_count
  FROM repid_score_events rse
  WHERE rse.llm_provider IS NOT NULL
    AND rse.task_domain = p_domain
    AND rse.created_at > NOW() - (p_window_days || ' days')::INTERVAL
  GROUP BY rse.llm_provider
  HAVING COUNT(*) >= 5
  ORDER BY hit_rate DESC NULLS LAST;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION anfis_provider_performance_lookup IS
  'Phase 2.10 — ANFIS Routing Service Handler companion. Historical LLM '
  'provider performance per domain. Positive decision_outcome set: '
  'approved/APPROVED/clean/profit; negative: rejected/vetoed; neutral NULL.';
