-- TRACK A ANFIS/LASSO shadow logs (A2)
-- Additive table for logging BOTH static router decision AND ANFIS decision + outcomes on live traffic.
-- ANFIS in shadow only (does not control routing until A3/A4 measure proves win on cost AND quality per cat).
-- RLS: service_role_all (internal, like other routing/audit tables).
-- Per rules: schema-first, additive, rollback per-table, verify after apply, Sean co-sign for apply.
-- Cite: src/types/database.types.ts (append), src/providers/router.ts (wire shadow log).
-- Report: E:\dev\reports\2026-06-05\XC_ANFIS_LASSO_A0A1A2.md

CREATE TABLE IF NOT EXISTS anfis_routing_logs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt_preview TEXT,           -- truncated for privacy
  category TEXT,
  static_provider TEXT,
  static_tier TEXT,
  static_reason TEXT,
  anfis_provider TEXT,
  anfis_tier TEXT,
  anfis_conf NUMERIC(5,4),
  cost_usdc NUMERIC(12,6),
  latency_ms INTEGER,
  outcome_hal_score NUMERIC(5,4), -- or was_caught etc for quality
  outcome_vetoed BOOLEAN,
  n_providers INTEGER,
  notes JSONB
);

-- RLS service role only (internal sensitive routing decisions, no client read proven)
ALTER TABLE anfis_routing_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON anfis_routing_logs
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ROLLBACK (per table, safe):
-- DROP POLICY IF EXISTS "service_role_all" ON anfis_routing_logs;
-- ALTER TABLE anfis_routing_logs DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS anfis_routing_logs;

-- Post-apply verify (in report or script):
-- SELECT COUNT(*) FROM anfis_routing_logs; -- should grow with shadow calls
-- SELECT * FROM pg_policies WHERE tablename = 'anfis_routing_logs';

-- Sample (for test, after apply):
-- INSERT INTO anfis_routing_logs (prompt_preview, category, static_provider, static_tier, static_reason, anfis_provider, anfis_tier, anfis_conf)
-- VALUES ('test prompt for classify', 'factual', 'groq-llama', '0a', 'priority_healthy', 'cerebras', '0a', 0.82);

COMMENT ON TABLE anfis_routing_logs IS 'Shadow logs for ANFIS vs static router decisions (A2). Ground truth outcomes for A3 measure (cost + HAL quality per cat). T12 feeds. Reversible shadow.';
