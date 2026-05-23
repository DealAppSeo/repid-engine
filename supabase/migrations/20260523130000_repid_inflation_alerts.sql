-- RepID Inflation Patch C — statistical outlier detection alerts.
-- Additive, internal-only table. Nightly detector writes Z-score outliers here for human review.
-- Safe to apply (nothing references it yet; no behavior change to scoring/tier).
CREATE TABLE IF NOT EXISTS repid_inflation_alerts (
  id BIGSERIAL PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES repid_agents(id),
  detection_window TEXT NOT NULL,                       -- 'daily' | 'weekly' | 'monthly'
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  repid_delta NUMERIC NOT NULL,                         -- agent's net RepID change in window
  population_mean NUMERIC NOT NULL,
  population_stddev NUMERIC NOT NULL,
  z_score NUMERIC NOT NULL,
  threshold NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',        -- pending_review | reviewed_ok | reviewed_action | false_positive
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  UNIQUE (agent_id, detection_window, window_start)     -- idempotent re-runs per window
);

CREATE INDEX IF NOT EXISTS idx_repid_inflation_status ON repid_inflation_alerts(status);
CREATE INDEX IF NOT EXISTS idx_repid_inflation_zscore ON repid_inflation_alerts(z_score DESC);
CREATE INDEX IF NOT EXISTS idx_repid_inflation_agent ON repid_inflation_alerts(agent_id, window_start DESC);

COMMENT ON TABLE repid_inflation_alerts IS
  'RepID Inflation Patch C: statistical outlier detection on RepID growth rate. Flags agents with Z-score > threshold for human review. Advisory only — no automatic score/tier action.';
