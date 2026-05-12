-- ================================================================
-- CC Sprint 7 — hal_ground_truth_labels + hal_accuracy_summary refresh
-- 2026-05-12
-- ================================================================
-- Sprint 4 finding: hal_accuracy_summary returns F1=0 / FPR=95.44% because
-- every benchmark_source in hal_runner_results has ground_truth_is_hallucination=false.
-- The COLUMN exists; the DATA is uniformly "good answer." Without a positive
-- class in ground truth, F1 is structurally uncomputable.
--
-- This migration adds:
--   1. hal_ground_truth_labels — a SUPPLEMENTARY truth source. Append-only.
--      Each row labels a specific hal_runner_results / hal_evaluations /
--      hal_classifications row with the truth-of-the-matter, who said it,
--      and confidence. Multiple labelers per source row are allowed
--      (UNIQUE on source_table + source_id + labeled_by).
--   2. hal_accuracy_summary view UPDATED to JOIN on this table (when
--      labels exist) and report F1/precision/recall over the labeled
--      subset. data_quality flag returns INSUFFICIENT_GROUND_TRUTH
--      until ≥30 labels exist.
--
-- The original hal_runner_results.ground_truth_is_hallucination column is
-- preserved (read-only from this view). The new labels table OVERRIDES /
-- AUGMENTS it for accuracy-summary purposes — letting Sean (or a future
-- labeling sprint) introduce positive-class examples without touching the
-- raw ingestion data.
--
-- The data_quality threshold of 30 is intentionally conservative: with
-- fewer than 30 binary labels, F1 noise is too high for the metric to be
-- meaningful. When ≥30 labels exist, the view reports actual numbers.
-- ================================================================

CREATE TABLE IF NOT EXISTS public.hal_ground_truth_labels (
  id BIGSERIAL PRIMARY KEY,
  source_table TEXT NOT NULL CHECK (source_table IN ('hal_runner_results','hal_evaluations','hal_classifications')),
  source_id TEXT NOT NULL,                         -- TEXT to accept BIGINT (hal_runner_results) or UUID (hal_evaluations) ids
  is_hallucination BOOLEAN NOT NULL,
  ground_truth_confidence NUMERIC NOT NULL CHECK (ground_truth_confidence BETWEEN 0 AND 1),
  labeled_by TEXT NOT NULL,                        -- e.g. 'sean', 'auditor-agent', 'community-vote'
  rationale TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_table, source_id, labeled_by)
);

CREATE INDEX IF NOT EXISTS idx_hal_gt_source
  ON public.hal_ground_truth_labels (source_table, source_id);

ALTER TABLE public.hal_ground_truth_labels ENABLE ROW LEVEL SECURITY;

CREATE POLICY hal_gt_service_role ON public.hal_ground_truth_labels
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.hal_ground_truth_labels IS
  'Append-only ground-truth labels for HAL evaluations. Each row labels a hal_runner_results / hal_evaluations / hal_classifications row with the truth-of-the-matter. Multiple labelers per source row allowed. Used by hal_accuracy_summary view to compute F1/precision/recall over labeled subset. CC Sprint 7 (2026-05-12) — addresses Sprint 4 finding that F1 was structurally uncomputable from raw data.';

-- ================================================================
-- Refresh hal_accuracy_summary view
-- Old behavior (Sprint 4): aggregates over hal_runner_results raw cols.
-- New behavior (Sprint 7): JOINs to hal_ground_truth_labels for the
-- ACTUAL ground truth. Falls back to data_quality='INSUFFICIENT_GROUND_TRUTH'
-- if fewer than 30 labels exist (the metric is too noisy below that
-- threshold to publish).
-- The hal_runner_results.ground_truth_is_hallucination column is
-- intentionally NOT used here — it's all-false, would degenerate the
-- metric back to Sprint 4's F1=0 finding. Sean's labeling effort is the
-- canonical truth source going forward.
-- ================================================================

CREATE OR REPLACE VIEW public.hal_accuracy_summary AS
WITH labeled AS (
  SELECT
    h.id AS hal_id,
    h.hal_vetoed AS predicted_veto,
    -- For multi-labeler aggregation: take majority vote weighted by confidence
    -- For v1: take the first label per source row (UNIQUE constraint means
    -- one label per (source, labeler) pair; multiple labelers would need
    -- a tiebreak — deferred to Sprint 8+ when we have multiple labelers)
    (SELECT gt.is_hallucination
       FROM public.hal_ground_truth_labels gt
       WHERE gt.source_table = 'hal_runner_results' AND gt.source_id = h.id::text
       ORDER BY gt.ground_truth_confidence DESC, gt.created_at DESC
       LIMIT 1) AS actual_hallucination,
    h.created_at
  FROM public.hal_runner_results h
  WHERE h.gen_failed = false
    AND h.hal_vetoed IS NOT NULL
),
classified AS (
  SELECT
    CASE
      WHEN actual_hallucination IS NULL THEN NULL
      WHEN predicted_veto AND actual_hallucination THEN 'TP'
      WHEN predicted_veto AND NOT actual_hallucination THEN 'FP'
      WHEN NOT predicted_veto AND actual_hallucination THEN 'FN'
      WHEN NOT predicted_veto AND NOT actual_hallucination THEN 'TN'
    END AS class
  FROM labeled
),
tally AS (
  SELECT
    COUNT(*) FILTER (WHERE class = 'TP') AS tp,
    COUNT(*) FILTER (WHERE class = 'FP') AS fp,
    COUNT(*) FILTER (WHERE class = 'FN') AS fn,
    COUNT(*) FILTER (WHERE class = 'TN') AS tn,
    COUNT(*) FILTER (WHERE class IS NOT NULL) AS total_labeled,
    (SELECT COUNT(*) FROM public.hal_runner_results WHERE gen_failed = false) AS total_raw
  FROM classified
)
SELECT
  tp, fp, fn, tn, total_labeled, total_raw,
  ROUND(tp::numeric / NULLIF(tp + fp, 0), 4) AS precision,
  ROUND(tp::numeric / NULLIF(tp + fn, 0), 4) AS recall,
  ROUND(2.0 * tp / NULLIF(2 * tp + fp + fn, 0), 4) AS f1_score,
  ROUND(fp::numeric / NULLIF(fp + tn, 0), 4) AS false_positive_rate,
  CASE
    WHEN total_labeled = 0 THEN 'NO_GROUND_TRUTH_LABELS'
    WHEN total_labeled < 30 THEN 'INSUFFICIENT_GROUND_TRUTH'
    ELSE 'OK'
  END AS data_quality,
  'hal_runner_results' AS source_table,
  NOW() AS computed_at
FROM tally;

GRANT SELECT ON public.hal_accuracy_summary TO anon;
GRANT SELECT ON public.hal_accuracy_summary TO authenticated;
GRANT SELECT ON public.hal_accuracy_summary TO service_role;

COMMENT ON VIEW public.hal_accuracy_summary IS
  'F1/precision/recall/FPR over hal_runner_results, joined to hal_ground_truth_labels for actual truth. Returns ONE row. data_quality flag = NO_GROUND_TRUTH_LABELS / INSUFFICIENT_GROUND_TRUTH (<30 labels) / OK. CC Sprint 7 (2026-05-12) — replaces Sprint 4 view that read raw .ground_truth_is_hallucination (all false → degenerate F1=0).';

-- Rollback:
--   -- Restore the Sprint 4 view definition (see migrations/2026-05-11-hal-accuracy-summary-view.sql)
--   DROP TABLE IF EXISTS public.hal_ground_truth_labels;
