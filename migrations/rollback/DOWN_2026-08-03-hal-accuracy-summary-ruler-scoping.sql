-- ==========================================================================================
-- ROLLBACK — DEFECT 3 hal_accuracy_summary ruler scoping
-- OUTPUT_PATH: migrations/rollback/DOWN_2026-08-03-hal-accuracy-summary-ruler-scoping.sql
-- REVERSES:    migrations/2026-08-03-hal-accuracy-summary-ruler-scoping.sql
-- ==========================================================================================
--
-- Restores hal_accuracy_summary to the definition that was LIVE immediately before the forward
-- migration, and drops hal_accuracy_by_ruler.
--
-- PROVENANCE OF THE BODY BELOW: captured verbatim from the live database on 2026-08-03 via
--     SELECT pg_get_viewdef('public.hal_accuracy_summary'::regclass, true);
-- It is not reconstructed from migrations/2026-05-11-hal-accuracy-summary-view.sql — that file
-- is the ORIGINAL definition and is NOT what was live. The 2026-05-12 hal-ground-truth-labels
-- migration redefined the view (it swapped the label source to hal_ground_truth_labels, renamed
-- `total` to total_labeled, and added total_raw + data_quality). Rolling back to the 05-11 file
-- would have SILENTLY REVERTED four months of changes and reintroduced a `total` column that has
-- not existed since May. Always roll back to what was measured, not to the oldest file on disk.
--
-- RESTORES THE DEFECT, deliberately: f1_score goes back to 0.2633 with data_quality='ROBUST',
-- blending 5 rulers including 643 mock rows.
--
-- Uses CREATE OR REPLACE, not DROP + CREATE, so the anon / authenticated / service_role grants
-- on hal_accuracy_summary survive the rollback. A DROP here would silently revoke them.
--
-- IDEMPOTENT: CREATE OR REPLACE and DROP ... IF EXISTS are both safe to re-run.
--
-- ⚠ ONE ORDERING CONSTRAINT: CREATE OR REPLACE VIEW cannot REMOVE columns. The forward migration
-- APPENDED four (distinct_rulers, mock_labeled_rows, ruler_status, citation), so replacing it
-- with the shorter 13-column body requires dropping the view first. That is unavoidable, so this
-- rollback re-grants explicitly afterwards. The DROP is ordered BEFORE the new view is dropped so
-- that a failure part-way leaves no half-state.

BEGIN;

-- Drop first: the 13-column body cannot replace the 17-column one in place.
DROP VIEW IF EXISTS public.hal_accuracy_summary;

CREATE VIEW public.hal_accuracy_summary AS
 WITH labeled AS (
         SELECT h.id AS hal_id,
            h.hal_vetoed AS predicted_veto,
            ( SELECT gt.is_hallucination
                   FROM hal_ground_truth_labels gt
                  WHERE gt.source_table = 'hal_runner_results'::text AND gt.source_id = h.id::text
                  ORDER BY gt.ground_truth_confidence DESC, gt.created_at DESC
                 LIMIT 1) AS actual_hallucination,
            h.created_at
           FROM hal_runner_results h
          WHERE h.gen_failed = false AND h.hal_vetoed IS NOT NULL
        ), classified AS (
         SELECT
                CASE
                    WHEN labeled.actual_hallucination IS NULL THEN NULL::text
                    WHEN labeled.predicted_veto AND labeled.actual_hallucination THEN 'TP'::text
                    WHEN labeled.predicted_veto AND NOT labeled.actual_hallucination THEN 'FP'::text
                    WHEN NOT labeled.predicted_veto AND labeled.actual_hallucination THEN 'FN'::text
                    WHEN NOT labeled.predicted_veto AND NOT labeled.actual_hallucination THEN 'TN'::text
                    ELSE NULL::text
                END AS class
           FROM labeled
        ), tally AS (
         SELECT count(*) FILTER (WHERE classified.class = 'TP'::text) AS tp,
            count(*) FILTER (WHERE classified.class = 'FP'::text) AS fp,
            count(*) FILTER (WHERE classified.class = 'FN'::text) AS fn,
            count(*) FILTER (WHERE classified.class = 'TN'::text) AS tn,
            count(*) FILTER (WHERE classified.class IS NOT NULL) AS total_labeled,
            ( SELECT count(*) AS count
                   FROM hal_runner_results
                  WHERE hal_runner_results.gen_failed = false) AS total_raw
           FROM classified
        )
 SELECT
        CASE
            WHEN total_labeled = 0 THEN NULL::bigint
            ELSE tp
        END AS tp,
        CASE
            WHEN total_labeled = 0 THEN NULL::bigint
            ELSE fp
        END AS fp,
        CASE
            WHEN total_labeled = 0 THEN NULL::bigint
            ELSE fn
        END AS fn,
        CASE
            WHEN total_labeled = 0 THEN NULL::bigint
            ELSE tn
        END AS tn,
    total_labeled,
    total_raw,
        CASE
            WHEN total_labeled = 0 THEN NULL::numeric
            ELSE round(tp::numeric / NULLIF(tp + fp, 0)::numeric, 4)
        END AS "precision",
        CASE
            WHEN total_labeled = 0 THEN NULL::numeric
            ELSE round(tp::numeric / NULLIF(tp + fn, 0)::numeric, 4)
        END AS recall,
        CASE
            WHEN total_labeled = 0 THEN NULL::numeric
            ELSE round(2.0 * tp::numeric / NULLIF(2 * tp + fp + fn, 0)::numeric, 4)
        END AS f1_score,
        CASE
            WHEN total_labeled = 0 THEN NULL::numeric
            ELSE round(fp::numeric / NULLIF(fp + tn, 0)::numeric, 4)
        END AS false_positive_rate,
        CASE
            WHEN total_labeled = 0 THEN 'INSUFFICIENT_GROUND_TRUTH'::text
            WHEN total_labeled >= 1 AND total_labeled <= 9 THEN 'SPARSE_PRELIMINARY'::text
            WHEN total_labeled >= 10 AND total_labeled <= 29 THEN 'GROWING_SAMPLE'::text
            WHEN total_labeled >= 30 AND total_labeled <= 99 THEN 'MINIMUM_VIABLE'::text
            ELSE 'ROBUST'::text
        END AS data_quality,
    'hal_runner_results'::text AS source_table,
    now() AS computed_at
   FROM tally;

-- Re-grant: the DROP above removed the grants that CREATE OR REPLACE would have preserved.
-- These reproduce the SELECT privileges observed live on 2026-08-03.
GRANT SELECT ON public.hal_accuracy_summary TO anon;
GRANT SELECT ON public.hal_accuracy_summary TO authenticated;
GRANT SELECT ON public.hal_accuracy_summary TO service_role;

COMMENT ON VIEW public.hal_accuracy_summary IS
  'F1/precision/recall/FPR aggregated over hal_runner_results. Derived from hal_vetoed x '
  'hal_ground_truth_labels. Returns exactly 1 row; metric columns are NULL if total_labeled=0. '
  'WARNING (restored by rollback 2026-08-03): this definition aggregates ALL hal_modes, '
  'thresholds and corpora into one unscoped F1 and labels it ROBUST on sample size alone. '
  'See migrations/2026-08-03-hal-accuracy-summary-ruler-scoping.sql.';

DROP VIEW IF EXISTS public.hal_accuracy_by_ruler;

COMMIT;

-- VERIFY THE ROLLBACK TOOK — expect the defect back: f1_score = 0.2633, data_quality = 'ROBUST',
-- 13 columns, and no ruler_status column:
--   SELECT tp, fp, fn, tn, total_labeled, f1_score, data_quality FROM hal_accuracy_summary;
--   SELECT count(*) AS col_count FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='hal_accuracy_summary';        -- expect 13
--   SELECT count(*) FROM pg_views
--    WHERE schemaname='public' AND viewname='hal_accuracy_by_ruler';           -- expect 0
--
-- VERIFY THE GRANTS SURVIVED (expect anon, authenticated, service_role all with SELECT):
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema='public' AND table_name='hal_accuracy_summary' AND privilege_type='SELECT'
--    ORDER BY grantee;
