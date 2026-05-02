-- HAL Phase 1.5 Extension — Pythagorean Comma BFT veto + 3-provider support
-- Author: HAL/HAEE
-- Date: 2026-05-03
-- Sprint: CC1 cross-LLM verification layer extension
-- Applied to qnnpjhlxljtqyigedwkb on 2026-05-03 via Supabase MCP.
--
-- Adds:
--   - provider_responses jsonb — canonical N-provider record (replaces denormalized provider_1/2 cols)
--   - comma_veto boolean — Pythagorean Comma BFT veto fired (P-003)
--   - comma_gap numeric — max(beliefs) - min(beliefs); small + high avg = veto signature
--   - comma_severity text — 'none' | 'minor' | 'major' | 'critical' (only critical triggers veto)
--   - provider_count int — convenience field for filtering (1, 2, or 3)
--
-- Existing columns provider_1, provider_2, model_1, model_2, answer_1_preview,
-- answer_2_preview kept for backward compatibility — code writes to both during
-- transition. Plan to drop in a follow-up sprint after dashboards are migrated.
--
-- Backfills the existing 237 rows from columnar → jsonb provider_responses.

-- 1. Add new columns
ALTER TABLE cross_llm_comparisons
  ADD COLUMN IF NOT EXISTS provider_responses jsonb,
  ADD COLUMN IF NOT EXISTS comma_veto boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS comma_gap numeric(7,4),
  ADD COLUMN IF NOT EXISTS comma_severity text,
  ADD COLUMN IF NOT EXISTS provider_count integer;

-- 2. Constraint on comma_severity values
ALTER TABLE cross_llm_comparisons
  DROP CONSTRAINT IF EXISTS cross_llm_comparisons_comma_severity_check;
ALTER TABLE cross_llm_comparisons
  ADD CONSTRAINT cross_llm_comparisons_comma_severity_check
  CHECK (comma_severity IS NULL OR comma_severity IN ('none','minor','major','critical'));

-- 3. Backfill existing rows from columnar → jsonb (idempotent via WHERE clause)
UPDATE cross_llm_comparisons
SET provider_responses = jsonb_build_array(
  jsonb_build_object(
    'provider', provider_1,
    'model', model_1,
    'answer_preview', answer_1_preview
  ),
  jsonb_build_object(
    'provider', provider_2,
    'model', model_2,
    'answer_preview', answer_2_preview
  )
),
provider_count = 2
WHERE provider_responses IS NULL;

-- 4. Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_cross_llm_comma_severity
  ON cross_llm_comparisons(comma_severity) WHERE comma_severity IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cross_llm_comma_veto
  ON cross_llm_comparisons(comma_veto) WHERE comma_veto = true;

-- 5. Drop NOT NULL on provider_1/provider_2 — future rows can be 1- or 3-provider
ALTER TABLE cross_llm_comparisons ALTER COLUMN provider_1 DROP NOT NULL;
ALTER TABLE cross_llm_comparisons ALTER COLUMN provider_2 DROP NOT NULL;

COMMENT ON COLUMN cross_llm_comparisons.provider_responses IS
  'Canonical N-provider response array. Each element: {provider, model, answer_preview, latency_ms?, error?}';
COMMENT ON COLUMN cross_llm_comparisons.comma_veto IS
  'Pythagorean Comma BFT veto fired (P-003). True only when comma_gap < 0.05 AND avgBelief > 0.85 AND >= 3 providers responded.';
COMMENT ON COLUMN cross_llm_comparisons.comma_gap IS
  'max(per-provider beliefs) - min(per-provider beliefs). Per-provider belief = mean(pairwise sim with others). Small gap + high avg = coordinated bias signature.';
COMMENT ON COLUMN cross_llm_comparisons.comma_severity IS
  'Tiered Comma divergence: none / minor / major / critical. Only critical triggers comma_veto. Major and minor logged for HAEE-Evolution to learn from.';

-- 6. New repid_config keys for 6-DOF thresholds (initial values copied from 5-DOF live values).
INSERT INTO repid_config (key, value, conductor_tunable, requires_vote, auto_tunable, description, last_updated, updated_by)
VALUES
  ('hal_veto_threshold_6dof', '0.43', false, false, true,
   'HAL veto threshold (HITL gate) when 6-DOF combiner active (cross-LLM agreement available). Initial = 5-DOF live value; CC2 will re-tune for 6-DOF distribution.',
   NOW(), 'cc1_phase_1_5_extension'),
  ('hal_block_threshold_6dof', '0.55', false, false, true,
   'HAL block threshold (constitutional block) when 6-DOF combiner active. Initial = 5-DOF live value; CC2 will re-tune for 6-DOF distribution.',
   NOW(), 'cc1_phase_1_5_extension')
ON CONFLICT (key) DO NOTHING;
