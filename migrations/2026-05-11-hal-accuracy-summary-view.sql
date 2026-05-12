-- ================================================================
-- CC Sprint 4 — hal_accuracy_summary view
-- 2026-05-11
-- ================================================================
-- Resolves V1 gap inventory blocker #10: GMPD's F1=0.86 claim has been
-- unverifiable because `hal_accuracy_summary` did not exist.
--
-- DATA SOURCE DECISION (verified via Supabase MCP 2026-05-11 PM):
--   hal_evaluations    — 0 rows (created 2026-05-09 PR #3, not yet
--                        populated by the dual-write hook)
--   hal_runner_results — 1,360 rows (matches GMPD's "1,360 evaluations
--                        across 26 ground-truth prompts" claim)
-- The view aggregates from `hal_runner_results` because that's where
-- the data lives. Once `hal_evaluations` is populated, a follow-up
-- migration may add a UNION or replace the source.
--
-- CLASSIFICATION (derived from raw booleans, not precomputed ones,
-- to make the math auditable):
--   TP = hal_vetoed AND ground_truth_is_hallucination
--   FP = hal_vetoed AND NOT ground_truth_is_hallucination
--   FN = NOT hal_vetoed AND ground_truth_is_hallucination
--   TN = NOT hal_vetoed AND NOT ground_truth_is_hallucination
--
-- FILTERS:
--   - gen_failed = false (skip rows where the underlying LLM call failed
--     before HAL could evaluate)
--   - both ground_truth_is_hallucination AND hal_vetoed are NOT NULL
--     (rows with missing data don't enter the F1 math)
--
-- The view returns exactly ONE row. If `total = 0`, the metric columns
-- are NULL via NULLIF — this is the "view that returns zeros, not
-- errors" pattern. Callers should handle null gracefully.
-- ================================================================

CREATE OR REPLACE VIEW public.hal_accuracy_summary AS
WITH categorized AS (
  SELECT
    CASE
      WHEN hal_vetoed AND ground_truth_is_hallucination THEN 'TP'
      WHEN hal_vetoed AND NOT ground_truth_is_hallucination THEN 'FP'
      WHEN NOT hal_vetoed AND ground_truth_is_hallucination THEN 'FN'
      WHEN NOT hal_vetoed AND NOT ground_truth_is_hallucination THEN 'TN'
    END AS classification
  FROM public.hal_runner_results
  WHERE gen_failed = false
    AND hal_vetoed IS NOT NULL
    AND ground_truth_is_hallucination IS NOT NULL
),
tallies AS (
  SELECT
    COUNT(*) FILTER (WHERE classification = 'TP') AS tp,
    COUNT(*) FILTER (WHERE classification = 'FP') AS fp,
    COUNT(*) FILTER (WHERE classification = 'FN') AS fn,
    COUNT(*) FILTER (WHERE classification = 'TN') AS tn,
    COUNT(*) AS total
  FROM categorized
)
SELECT
  tp,
  fp,
  fn,
  tn,
  total,
  ROUND(tp::numeric / NULLIF(tp + fp, 0), 4) AS precision,
  ROUND(tp::numeric / NULLIF(tp + fn, 0), 4) AS recall,
  ROUND(2.0 * tp / NULLIF(2 * tp + fp + fn, 0), 4) AS f1_score,
  ROUND(fp::numeric / NULLIF(fp + tn, 0), 4) AS false_positive_rate,
  'hal_runner_results' AS source_table,
  NOW() AS computed_at
FROM tallies;

GRANT SELECT ON public.hal_accuracy_summary TO anon;
GRANT SELECT ON public.hal_accuracy_summary TO authenticated;
GRANT SELECT ON public.hal_accuracy_summary TO service_role;

COMMENT ON VIEW public.hal_accuracy_summary IS
  'F1/precision/recall/FPR aggregated over hal_runner_results (1,360 rows as of 2026-05-11). '
  'Derived from hal_vetoed × ground_truth_is_hallucination booleans. Returns exactly 1 row; '
  'metric columns are NULL if total=0. CC Sprint 4 (resolves V1 gap inventory blocker #10).';

-- Rollback:
--   DROP VIEW IF EXISTS public.hal_accuracy_summary;
