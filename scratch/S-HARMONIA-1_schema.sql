-- S-HARMONIA-1_schema.sql
-- Project Harmonia: Circle of Fifths algorithm synergy research
-- Design-only. Sean applies later when free quota capacity exists.
-- Hash-chained for integrity (same previous_entry_hash pattern as S-AUD1/hal_audit_chain).
-- All experiments run exclusively on free tiers (groq, cerebras, gemini, ollama, together free credits).
-- Testnet anchoring only. Never spend real funds on research.

-- ============================================================
-- TABLE: harmonia_experiments
-- One row per full experiment (chord + baselines + control + HAL eval)
-- ============================================================

CREATE TABLE IF NOT EXISTS harmonia_experiments (
  id BIGSERIAL PRIMARY KEY,
  experiment_id UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,

  -- Hypothesis
  hypothesis_text TEXT NOT NULL,
  hypothesis_hash TEXT NOT NULL,  -- SHA-256 of hypothesis_text, computed client-side before run

  -- Circle of Fifths chord definition
  chord_name TEXT NOT NULL,                       -- e.g. "D#_Major", "A_minor", "dissonant_3"
  note_1 TEXT NOT NULL,
  note_2 TEXT NOT NULL,
  note_3 TEXT NOT NULL,
  circle_positions JSONB NOT NULL,                -- e.g. {"note_1": 9, "note_2": 8, "note_3": 3}
  circle_distance_12 INTEGER NOT NULL,
  circle_distance_13 INTEGER NOT NULL,
  circle_distance_23 INTEGER NOT NULL,

  -- Classification
  consonance_class TEXT NOT NULL CHECK (consonance_class IN (
    'major_triad', 'minor_triad', 'diminished', 'augmented', 'random_control'
  )),

  -- Task under test
  task_domain TEXT NOT NULL,                      -- "meta_routing", "hal_improvement", "consensus", "agent_coordination", etc.
  task_description TEXT NOT NULL,

  -- Results
  baseline_scores JSONB NOT NULL,                 -- { "algo1": {accuracy:.., latency_ms:.., tokens:.., cost_usd:..}, ... }
  chord_score NUMERIC(8,4),
  random_control_score NUMERIC(8,4),
  emergent_capability TEXT,                       -- free-text description of any surprising new behavior

  -- Cost & provenance
  compute_cost_usd NUMERIC(10,6) DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  latency_ms INTEGER,
  model_providers JSONB,                          -- { "baseline1": "groq:llama-3.1-8b", "chord": "cerebras:llama3.1-8b", ... }
  hal_score NUMERIC(6,4),
  hal_signals JSONB,
  agent_name TEXT,
  agent_repid_at_run INTEGER,

  -- On-chain & audit
  onchain_anchor_tx TEXT,                         -- testnet tx hash (batch daily via W3C agent)
  hypothesis_confirmed BOOLEAN,
  reproduction_count INTEGER DEFAULT 0,

  -- Hash chain (S-AUD1 pattern)
  previous_entry_hash TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookup of confirmed chords and reproduction tracking
CREATE INDEX IF NOT EXISTS idx_harmonia_experiments_confirmed
  ON harmonia_experiments (hypothesis_confirmed, reproduction_count)
  WHERE hypothesis_confirmed = true;

CREATE INDEX IF NOT EXISTS idx_harmonia_experiments_chord
  ON harmonia_experiments (chord_name, consonance_class);

CREATE INDEX IF NOT EXISTS idx_harmonia_experiments_created
  ON harmonia_experiments (created_at DESC);

-- ============================================================
-- TABLE: harmonia_budget
-- Tracks free daily quotas across providers. Updated after every experiment.
-- ============================================================

CREATE TABLE IF NOT EXISTS harmonia_budget (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  daily_quota_tokens INTEGER NOT NULL,
  used_today INTEGER DEFAULT 0,
  quota_reset_hour INTEGER DEFAULT 0,   -- UTC hour when quota resets (e.g. 0 = midnight UTC)
  last_reset_at TIMESTAMPTZ,
  is_free BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (provider, model)
);

-- Seed known free tiers (as of June 2026)
INSERT INTO harmonia_budget (provider, model, daily_quota_tokens, quota_reset_hour, is_free) VALUES
  ('groq', 'llama-3.1-8b-instant', 6000, 0, true),           -- ~6000 requests/day free tier
  ('cerebras', 'llama3.1-8b', 10000, 0, true),               -- generous free tier
  ('google', 'gemini-2.0-flash', 1500000, 0, true),          -- AI Studio free quota (tokens)
  ('ollama', 'llama3.1:8b', 999999999, 0, true),             -- local, "unlimited" (compute-bound only)
  ('together', 'llama-3.1-8b', 50000, 0, true)               -- new account free credits (rotating)
ON CONFLICT (provider, model) DO NOTHING;

-- Additional useful free/local models (extend as new free tiers appear)
INSERT INTO harmonia_budget (provider, model, daily_quota_tokens, quota_reset_hour, is_free) VALUES
  ('ollama', 'phi3:mini', 999999999, 0, true),
  ('ollama', 'gemma2:9b', 999999999, 0, true)
ON CONFLICT (provider, model) DO NOTHING;

-- ============================================================
-- NOTES FOR APPLICATION / SEAN
-- ============================================================
-- 1. previous_entry_hash follows the same pattern as hal_audit_chain:
--    - Before INSERT, read the current max id's current_entry_hash (or previous_entry_hash)
--    - Compute new hash over (previous + canonical_json_of_this_row)
--    - Store previous_entry_hash on the new row
-- 2. Use a simple PL/pgSQL function or application-side logic (mirrors append_hal_audit_chain).
-- 3. Budget check MUST happen inside the same transaction as the experiment INSERT + UPDATE.
-- 4. All runs must be tagged with agent_name + agent_repid_at_run for provenance.
-- 5. onchain_anchor_tx is populated later by a daily batch cron (testnet only).
-- 6. This schema is intentionally isolated from production tables (no FKs).

COMMENT ON TABLE harmonia_experiments IS 'Project Harmonia research experiments. Side project. Free quotas only. Hash-chained.';
COMMENT ON TABLE harmonia_budget IS 'Free-tier daily quota tracker for Harmonia experiments. Never use paid keys.';

-- End of S-HARMONIA-1_schema.sql (design-only)