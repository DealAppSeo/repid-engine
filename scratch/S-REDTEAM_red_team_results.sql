-- S-REDTEAM_red_team_results.sql
-- XC MARATHON SPRINT S-REDTEAM (2026-06-01 PDT)
-- Adversarial testing framework: 200+ challenges, 4+ attack types, RepID micro-transactions.
-- Creates red_team_results (hash-chained via fn_audit_hash_chain like S-AUD1).
-- RLS: service_role full (for redteam runner + analysis). No anon writes.
-- Sean: apply this when capacity; then redteam scripts can INSERT directly.
-- All red team activity is itself auditable and produces real RepID movements.
-- The system gets STRONGER from every attack (ANFIS learns from misses).

CREATE TABLE IF NOT EXISTS red_team_results (
  id BIGSERIAL PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  attack_type TEXT NOT NULL,
  difficulty INTEGER NOT NULL,
  attacker_agent TEXT NOT NULL,
  defender_agent TEXT,
  prompt TEXT NOT NULL,
  response TEXT,
  hal_score NUMERIC(5,4),
  hal_verdict TEXT,
  detected BOOLEAN NOT NULL,
  detection_method TEXT,
  attacker_repid_before NUMERIC,
  attacker_repid_after NUMERIC,
  attacker_repid_delta NUMERIC,
  defender_repid_before NUMERIC,
  defender_repid_after NUMERIC,
  defender_repid_delta NUMERIC,
  bft_votes JSONB,
  latency_ms INTEGER,
  provider_used TEXT,
  false_positive BOOLEAN DEFAULT FALSE,
  previous_entry_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for analysis (Phase 9 learning, Phase 3 defender catch rates, Phase 8 stress)
CREATE INDEX IF NOT EXISTS idx_red_team_attack_type ON red_team_results (attack_type, difficulty);
CREATE INDEX IF NOT EXISTS idx_red_team_detected ON red_team_results (detected, attack_type);
CREATE INDEX IF NOT EXISTS idx_red_team_created ON red_team_results (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_red_team_agents ON red_team_results (attacker_agent, defender_agent);

ALTER TABLE red_team_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY red_team_service ON red_team_results FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Hash chain (identical to hal_production_events / harmonia). Reuses fn_audit_hash_chain from S-AUD1.
-- Requires the column (included above) + fn to exist (scripts/audit/S-AUD1_migration.sql defines it).
DROP TRIGGER IF EXISTS trg_redteam_hash ON red_team_results;
CREATE TRIGGER trg_redteam_hash
BEFORE INSERT ON red_team_results
FOR EACH ROW EXECUTE FUNCTION fn_audit_hash_chain();

COMMENT ON TABLE red_team_results IS 'S-REDTEAM adversarial challenges + outcomes. Every attack strengthens the system via ANFIS + BFT data. Hash-chained.';

-- Optional view for quick Phase 3/9 analysis
CREATE OR REPLACE VIEW red_team_defender_catch_rates AS
SELECT 
  defender_agent,
  attack_type,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE detected) as caught,
  COUNT(*) FILTER (WHERE NOT detected) as missed,
  ROUND(100.0 * COUNT(*) FILTER (WHERE detected) / NULLIF(COUNT(*),0), 1) as catch_rate_pct
FROM red_team_results
WHERE defender_agent IS NOT NULL
GROUP BY defender_agent, attack_type
ORDER BY attack_type, catch_rate_pct DESC;

-- End of S-REDTEAM_red_team_results.sql
-- Apply order: this after S-AUD1 fn exists. Then run redteam runner scripts.