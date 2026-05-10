-- Migration: Create hal_evaluations unified table
-- Date: 2026-05-09
-- Author: CC1

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.hal_evaluations (
  -- Identity
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),

  -- Mode taxonomy (REQUIRED, no default)
  -- 'production' = real SDK user / agent traffic
  -- 'calibration' = research sweep results (hyperdag-bench's domain)
  -- 'backtest' = replays of past data against new threshold candidates
  -- 'shadow' = candidate configs evaluated alongside production
  -- 'a_b' = split-traffic experiments
  mode text NOT NULL,

  -- Experiment / sweep identity (NULL for production single-shot)
  experiment_id text,
  corpus_version text,

  -- Threshold + model versioning
  threshold_set_version text,
  hal_mode text,  -- existing language: 'strictness-1', etc.

  -- Provenance (commit SHAs at write-time)
  hyperdag_bench_commit text,
  repid_engine_commit text,
  manifest_dataset_id text,

  -- The prompt / input
  prompt_id text,
  prompt_source text,  -- 'production_traffic' | 'truthfulqa' | 'hal_test_prompts' | 'live_user_query'
  prompt_text_hash text,  -- sha256 of normalized prompt text; NEVER store full prompt without consent

  -- Caller identity
  agent_id text,
  api_key_hash text,  -- sha256 of api key, for production traffic; NULL for calibration

  -- Generation provider context (when known)
  gen_provider text,
  gen_model text,
  gen_latency_ms integer,

  -- HAL signals + decision
  hal_signals jsonb,  -- the 5 base + 3 optional, full object
  certainty_used numeric,
  hal_score numeric,
  comma_gap numeric,
  hal_vetoed boolean,
  decision text,  -- 'APPROVE' | 'HITL' | 'BLOCK' | 'VETO'

  -- Ground truth (when known)
  ground_truth_label text,  -- e.g., 'is_hallucination=true' | 'is_hallucination=false' | NULL
  was_caught boolean,
  false_positive boolean,

  -- Outcome / reward
  repid_delta numeric,
  cost_usd numeric,

  -- Cross-eval traceability
  parent_evaluation_id uuid REFERENCES public.hal_evaluations(id),

  -- Notes (free text, optional)
  notes text
);

-- Mode whitelist (CHECK constraint to enforce taxonomy)
ALTER TABLE public.hal_evaluations
  DROP CONSTRAINT IF EXISTS hal_evaluations_mode_check;
ALTER TABLE public.hal_evaluations
  ADD CONSTRAINT hal_evaluations_mode_check
  CHECK (mode IN ('production', 'calibration', 'backtest', 'shadow', 'a_b'));

-- Decision whitelist
ALTER TABLE public.hal_evaluations
  DROP CONSTRAINT IF EXISTS hal_evaluations_decision_check;
ALTER TABLE public.hal_evaluations
  ADD CONSTRAINT hal_evaluations_decision_check
  CHECK (decision IS NULL
         OR decision IN ('APPROVE', 'HITL', 'BLOCK', 'VETO'));

-- Indexes for the most common query patterns
CREATE INDEX IF NOT EXISTS idx_hal_evaluations_mode_ts
  ON public.hal_evaluations (mode, ts DESC);

CREATE INDEX IF NOT EXISTS idx_hal_evaluations_experiment_id
  ON public.hal_evaluations (experiment_id, ts DESC)
  WHERE experiment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hal_evaluations_prompt_text_hash
  ON public.hal_evaluations (prompt_text_hash)
  WHERE prompt_text_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hal_evaluations_agent_id_ts
  ON public.hal_evaluations (agent_id, ts DESC)
  WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hal_evaluations_threshold_version
  ON public.hal_evaluations (threshold_set_version, ts DESC)
  WHERE threshold_set_version IS NOT NULL;

-- RLS: enable, then policies
ALTER TABLE public.hal_evaluations ENABLE ROW LEVEL SECURITY;

-- Service role can read/write everything
DROP POLICY IF EXISTS hal_evaluations_service_role_all ON public.hal_evaluations;
CREATE POLICY hal_evaluations_service_role_all
  ON public.hal_evaluations
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Verification
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name = 'hal_evaluations'
ORDER BY ordinal_position;
