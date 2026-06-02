-- S-SECURE_harmonia_apply.sql
-- Project Harmonia schema (from S-HARMONIA-1, hardened for apply)
-- DESIGN-ONLY in XC worktree. Sean / Cowork applies via Supabase SQL editor or migration.
-- All experiments on FREE quotas only. Testnet anchoring only.
-- Hash-chained using prior S-AUD1 patterns (previous_entry_hash + optional trigger).
-- RLS + service_role only (anon blocked by default like other research tables).

-- PRE-FLIGHT (run first)
-- SELECT table_name FROM information_schema.tables 
-- WHERE table_schema = 'public' 
-- AND table_name IN ('harmonia_experiments', 'harmonia_budget');
-- Expect 0 rows.

-- ============================================================
-- harmonia_experiments (with RLS + hash chain support)
-- ============================================================
CREATE TABLE IF NOT EXISTS harmonia_experiments (
  id BIGSERIAL PRIMARY KEY,
  experiment_id UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  hypothesis_text TEXT NOT NULL,
  hypothesis_hash TEXT NOT NULL,
  chord_name TEXT NOT NULL,
  note_1 TEXT NOT NULL,
  note_2 TEXT NOT NULL,
  note_3 TEXT NOT NULL,
  circle_positions JSONB NOT NULL,
  circle_distance_12 INTEGER NOT NULL,
  circle_distance_13 INTEGER NOT NULL,
  circle_distance_23 INTEGER NOT NULL,
  consonance_class TEXT NOT NULL CHECK (consonance_class IN ('major_triad','minor_triad','diminished','augmented','random_control')),
  task_domain TEXT NOT NULL,
  task_description TEXT NOT NULL,
  baseline_scores JSONB NOT NULL,
  chord_score NUMERIC(8,4),
  random_control_score NUMERIC(8,4),
  emergent_capability TEXT,
  compute_cost_usd NUMERIC(10,6) DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  latency_ms INTEGER,
  model_providers JSONB,
  hal_score NUMERIC(6,4),
  hal_signals JSONB,
  agent_name TEXT,
  agent_repid_at_run INTEGER,
  onchain_anchor_tx TEXT,
  hypothesis_confirmed BOOLEAN,
  reproduction_count INTEGER DEFAULT 0,
  previous_entry_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_harmonia_experiments_confirmed ON harmonia_experiments (hypothesis_confirmed, reproduction_count) WHERE hypothesis_confirmed = true;
CREATE INDEX IF NOT EXISTS idx_harmonia_experiments_chord ON harmonia_experiments (chord_name, consonance_class);
CREATE INDEX IF NOT EXISTS idx_harmonia_experiments_created ON harmonia_experiments (created_at DESC);

-- RLS (service_role full; anon blocked like other research tables)
ALTER TABLE harmonia_experiments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON harmonia_experiments FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Optional: hash-chain trigger stub (reuse/adapt fn_audit_hash_chain or append_hal_audit_chain pattern if desired)
-- For now, application-side or simple BEFORE INSERT trigger can populate previous_entry_hash.

COMMENT ON TABLE harmonia_experiments IS 'Harmonia research experiments (side project, free quotas only). Hash-chained + RLS.';

-- ============================================================
-- harmonia_budget (free quota tracker)
-- ============================================================
CREATE TABLE IF NOT EXISTS harmonia_budget (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  daily_quota_tokens INTEGER NOT NULL,
  used_today INTEGER DEFAULT 0,
  quota_reset_hour INTEGER DEFAULT 0,
  last_reset_at TIMESTAMPTZ,
  is_free BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (provider, model)
);

-- RLS
ALTER TABLE harmonia_budget ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON harmonia_budget FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Seed free tiers (idempotent)
INSERT INTO harmonia_budget (provider, model, daily_quota_tokens, quota_reset_hour, is_free) VALUES
  ('groq', 'llama-3.1-8b-instant', 6000, 0, true),
  ('cerebras', 'llama3.1-8b', 10000, 0, true),
  ('google', 'gemini-2.0-flash', 1500000, 0, true),
  ('ollama', 'llama3.1:8b', 999999999, 0, true),
  ('together', 'llama-3.1-8b', 50000, 0, true),
  ('ollama', 'phi3:mini', 999999999, 0, true),
  ('ollama', 'gemma2:9b', 999999999, 0, true)
ON CONFLICT (provider, model) DO NOTHING;

COMMENT ON TABLE harmonia_budget IS 'Free-tier daily quota tracker for Harmonia (never paid keys).';

-- ============================================================
-- Notes for apply
-- - Run in Supabase SQL editor as service_role or postgres.
-- - After apply: verify with the pre-flight SELECT (0 rows before, 2 after).
-- - Budget updates + experiment insert should be transactional in app code.
-- - previous_entry_hash population: app-side (read last row) or add simple trigger mirroring S-AUD1.
-- - Isolated tables: no FKs to production (research side project).
-- - After apply, update living docs / SCHEMA_TRUTH_MAP.

-- End of S-SECURE_harmonia_apply.sql (design-only, ready for co-sign/apply)