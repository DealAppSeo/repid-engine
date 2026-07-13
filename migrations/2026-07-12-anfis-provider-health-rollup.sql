-- 2026-07-12 — ANFIS routing re-tune feed (task 21).
--
-- Net-new, additive SQL function. Does NOT touch existing tables/triggers.
-- Server-side GROUP BY over llm_call_log so the re-tune (src/services/anfis-retune.ts)
-- never pages tens of thousands of rows through supabase-js.
--
-- Repoints the ANFIS routing-adaptation loop off the DEAD execution_log feed (frozen
-- 2026-03-04; its sync_routing_weight trigger is orphaned) and off the DEGENERATE
-- anfis_provider_performance_lookup() (repid_score_events.decision_outcome/latency are
-- unpopulated for provider calls) onto the LIVE, healthy llm_call_log feed (fresh to
-- now, ~20 providers, real status + latency_ms).
--
-- NOT applied to prod by this PR (no prod merge). Apply via the normal migration path
-- when the ANFIS_RETUNE loop is promoted.

CREATE OR REPLACE FUNCTION public.anfis_provider_health_rollup(p_hours integer)
RETURNS TABLE(
  provider text,
  success bigint,
  failed bigint,
  rate_limited bigint,
  samples bigint,
  avg_latency_ms numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    l.provider::text AS provider,
    COUNT(*) FILTER (WHERE l.status = 'success')                       AS success,
    COUNT(*) FILTER (WHERE l.status = 'failed')                        AS failed,
    COUNT(*) FILTER (WHERE l.status = 'rate_limited')                  AS rate_limited,
    COUNT(*)                                                           AS samples,
    -- latency averaged over successful calls only (a failed/timed-out call's latency
    -- is not representative of the provider's serving speed).
    COALESCE(AVG(l.latency_ms) FILTER (WHERE l.status = 'success'), 0) AS avg_latency_ms
  FROM public.llm_call_log l
  WHERE l.provider IS NOT NULL
    AND l.created_at > NOW() - (p_hours || ' hours')::INTERVAL
  GROUP BY l.provider
  HAVING COUNT(*) > 0
  ORDER BY samples DESC;
$$;

COMMENT ON FUNCTION public.anfis_provider_health_rollup(integer) IS
  'ANFIS routing re-tune feed (task 21, 2026-07-12): per-provider success/failed/rate_limited/avg_latency rollup of llm_call_log over the last p_hours. Consumed by src/services/anfis-retune.ts.';
