-- ==========================================================================================
-- DEFECT 3 — ONE UNSCOPED F1 OVER SIX INCOMPATIBLE RULERS, LABELLED 'ROBUST'
-- OUTPUT_PATH: migrations/2026-08-03-hal-accuracy-summary-ruler-scoping.sql
-- ROLLBACK:    migrations/rollback/DOWN_2026-08-03-hal-accuracy-summary-ruler-scoping.sql
--
-- PROMOTION-GATED — NOT APPLIED TO PROD. Do NOT run against qnnpjhlxljtqyigedwkb until Sean
-- co-signs. Replaces one view definition and adds one new view. No table, row, or grant is
-- altered. This is the DDL that repid-engine PR #327 flagged as "needs the single-writer"
-- (its out-of-fence follow-up 3); the vocabulary below is #327's, not a second dialect.
-- ==========================================================================================
--
-- THE RULER CONTRACT THIS HONOURS (src/hal/measurement-ruler.ts, merged in PR #327)
-- ------------------------------------------------------------------------------------------
-- A measurement is the sentence
--     F1 = 0.8812 on corpus <id>@sha256:<hash> (N cases) at K families, strictness S
-- or it is not a measurement. The ruler = corpus identity (id + content hash + case count) plus
-- configuration width (familiesConfigured, observed familiesMin/familiesMax, strictness, and the
-- two quorum gates). #327 made that a REFUSAL in TypeScript — recordMeasurement() throws
-- MissingRulerError rather than emitting a bare number. This migration extends the same refusal
-- to SQL, which is where the number was actually being served from.
--
-- WHAT WAS VERIFIED (read-only queries against qnnpjhlxljtqyigedwkb, 2026-08-03)
-- ------------------------------------------------------------------------------------------
-- [V] The live view aggregates ALL of hal_runner_results with no scoping whatsoever. Its only
--     filters are gen_failed = false AND hal_vetoed IS NOT NULL. There is no grouping by run,
--     mode, threshold, corpus, date, or provider width anywhere in the definition.
--
-- [V] What it currently returns — ONE row:
--       tp=178  fp=977  fn=19  tn=221  total_labeled=1395  total_raw=1559
--       precision=0.1541  recall=0.9036  f1_score=0.2633  false_positive_rate=0.8155
--       data_quality='ROBUST'
--
-- [V] data_quality is a SAMPLE-SIZE bucket and nothing more. From the view body: >= 100 labeled
--     rows => 'ROBUST'. It says nothing about whether the 1,395 rows are one population. The
--     word means "big" and reads as "trustworthy".
--
-- [V] The 1,395 labeled rows are SIX different rulers, and one of them is MOCK DATA:
--
--       hal_mode        manifest_dataset_id             threshold   rows  labeled  families  F1
--       -------------   -----------------------------   ---------   ----  -------  --------  ------
--       mock            hal-test-prompts-2026-05-05-v2  1.0136433    633      633  none      0.0000
--       real            hal-test-prompts-2026-05-04     0.25         420      267  none      0.0000
--       fact-check-s2   <NULL>                          0.43         395      395  1..3      0.8812
--       real            hal-test-prompts-2026-05-05-v2  0.25          90       90  none      0.0000
--       mock            hal-test-prompts-2026-05-04     1.0136433     20       10  none      0.0000
--       1               <NULL>                          0.7            1        0  none      NULL
--
--     653 of 1,559 rows are hal_mode = 'mock'. The 1.0136433 threshold on those rows is the
--     Pythagorean comma used as a placeholder — a value no real veto runs at.
--     (Six ruler GROUPS exist; five contribute labeled rows. The sixth, hal_mode='1' @ 0.7, has
--     1 row and 0 labels, so it never reaches the ratio math.)
--
-- [V] THE COST OF NOT SCOPING, stated as a number: the only ruler in the table that is a real
--     cross-LLM fact-check run — fact-check-s2, 395 labeled cases, observed family width 1..3 —
--     scores F1 = 0.8812. Blending it with the mock and legacy runs that score 0.0000 produces
--     the 0.2633 the view publishes. So the unscoped number UNDERSTATES the one real measurement
--     by ~0.62 F1, and stamps the result 'ROBUST'.
--     (0.8812 on 395 cases is verbatim the example citation in src/hal/measurement-ruler.ts.)
--
-- [V] AND THE CONFUSION MATRIX SHOWS EXACTLY WHERE THE DAMAGE COMES FROM. Per-ruler tallies,
--     summed, reproduce the blended view — so the blend is arithmetic, not sampling:
--
--                                        tp    fp   fn    tn
--       fact-check-s2 (the real ruler)  178    29   19   169
--       mock  @ 1.0136433 (633 cases)     0   584    0    49
--       real  @ 0.25      (267 cases)     0   267    0     0
--       real  @ 0.25       (90 cases)     0    90    0     0
--       mock  @ 1.0136433  (10 cases)     0     7    0     3
--       ------------------------------------------------------
--       blended hal_accuracy_summary     178   977   19   221
--
--     EVERY true positive HAL has ever recorded (all 178) comes from the one real ruler. The
--     blend contributes 948 additional false positives and not a single true positive. That is
--     what drives precision from 0.8812-ruler quality down to the published 0.1541, and it is
--     why the fix is scoping rather than re-tuning anything in HAL.
--
-- [V] anon holds SELECT on hal_accuracy_summary. This is not an internal scratch metric — it is
--     reachable by an unauthenticated reader. An overclaim on a surface strangers can hit is
--     product engineering, which is why this is worth a migration rather than a doc note.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------------------------------------------------------------------------
-- 1. hal_accuracy_summary STOPS EMITTING A NUMBER IT CANNOT JUSTIFY. When the underlying rows
--    span more than one ruler — which they do, six ways — the four metric columns go NULL and
--    data_quality becomes 'UNRULED_MIXED_POPULATION'. The counts (tp/fp/fn/tn/total_*) are
--    retained, because they are facts about rows; only the DERIVED RATIOS are withheld, because
--    a ratio across incommensurable populations is not a measurement. This mirrors #327's rule
--    that a zero denominator yields null, not a substituted 1.
--
-- 2. A NEW view, hal_accuracy_by_ruler, emits ONE ROW PER RULER with its own F1 and a citation
--    string in #327's format. That is where 0.8812 becomes quotable — attributed, scoped, and
--    sitting next to its family width.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ------------------------------------------------------------------------------------------
-- * It does NOT invent a corpus content hash. hal_runner_results has manifest_dataset_id and
--   hyperdag_bench_commit but NO content hash column, and hal_snapshot_registry (which has
--   version + snapshot_hash + test_cases_count) has ZERO rows. So corpus identity here is an ID
--   with no receipt, and every row therefore reports ruler_status = 'UNRULED'. That is the
--   honest answer and it is uncomfortable on purpose. Wiring a real hash is a writer-side change
--   (#327 follow-up 4) and is outside this lane's fence.
-- * It does NOT map hal_mode to a strictness where the mapping is a guess. Only 'fact-check-s2'
--   is unambiguously the cross-LLM quorum path (strictness 2). 'real', 'mock' and the literal
--   '1' are reported verbatim with strictness NULL rather than reconstructed.
-- * It does NOT delete, relabel, or exclude the mock rows from the base table. They are marked
--   is_measurement = false and left visible. Hiding them would repeat the original error in the
--   opposite direction.
-- * It changes no HAL threshold, no veto logic, no scoring behaviour. Views only.
--
-- COLUMN COMPATIBILITY: the 13 existing columns keep their names, types, and ORDINAL POSITIONS
-- so this is a true CREATE OR REPLACE — which preserves the existing grants and any dependency —
-- rather than a DROP + CREATE, which would silently drop anon/authenticated/service_role SELECT.
-- New columns are APPENDED, the only shape change CREATE OR REPLACE VIEW permits.

BEGIN;

-- ------------------------------------------------------------------------------------------
-- 1) THE REFUSAL. Same 13 columns, same order, same types; metrics withheld when unruled.
-- ------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.hal_accuracy_summary AS
WITH labeled AS (
  SELECT
    h.id AS hal_id,
    h.hal_vetoed AS predicted_veto,
    (SELECT gt.is_hallucination
       FROM hal_ground_truth_labels gt
      WHERE gt.source_table = 'hal_runner_results' AND gt.source_id = h.id::text
      ORDER BY gt.ground_truth_confidence DESC, gt.created_at DESC
      LIMIT 1) AS actual_hallucination,
    -- The ruler key. Two rows are comparable only if all of these agree.
    h.hal_mode,
    h.hal_threshold,
    h.manifest_dataset_id,
    h.created_at
  FROM hal_runner_results h
  WHERE h.gen_failed = false AND h.hal_vetoed IS NOT NULL
),
classified AS (
  SELECT
    hal_mode, hal_threshold, manifest_dataset_id,
    CASE
      WHEN actual_hallucination IS NULL THEN NULL::text
      WHEN predicted_veto AND actual_hallucination THEN 'TP'
      WHEN predicted_veto AND NOT actual_hallucination THEN 'FP'
      WHEN NOT predicted_veto AND actual_hallucination THEN 'FN'
      WHEN NOT predicted_veto AND NOT actual_hallucination THEN 'TN'
      ELSE NULL::text
    END AS class
  FROM labeled
),
tally AS (
  SELECT
    count(*) FILTER (WHERE class = 'TP') AS tp,
    count(*) FILTER (WHERE class = 'FP') AS fp,
    count(*) FILTER (WHERE class = 'FN') AS fn,
    count(*) FILTER (WHERE class = 'TN') AS tn,
    count(*) FILTER (WHERE class IS NOT NULL) AS total_labeled,
    (SELECT count(*) FROM hal_runner_results WHERE gen_failed = false) AS total_raw,
    -- How many distinct rulers are being blended, counted only over rows that carry a label
    -- (those are the rows the ratios would be computed from).
    count(DISTINCT (coalesce(hal_mode,'<null>'), coalesce(hal_threshold::text,'<null>'),
                    coalesce(manifest_dataset_id,'<null>')))
      FILTER (WHERE class IS NOT NULL) AS distinct_rulers,
    count(*) FILTER (WHERE class IS NOT NULL AND hal_mode = 'mock') AS mock_labeled_rows
  FROM classified
),
verdict AS (
  SELECT *,
    -- A single ruler with no mock contamination is the ONLY case in which a blended ratio is a
    -- measurement. Anything else is refused.
    (total_labeled > 0 AND distinct_rulers = 1 AND mock_labeled_rows = 0) AS is_measurement
  FROM tally
)
SELECT
  CASE WHEN total_labeled = 0 THEN NULL::bigint ELSE tp END AS tp,
  CASE WHEN total_labeled = 0 THEN NULL::bigint ELSE fp END AS fp,
  CASE WHEN total_labeled = 0 THEN NULL::bigint ELSE fn END AS fn,
  CASE WHEN total_labeled = 0 THEN NULL::bigint ELSE tn END AS tn,
  total_labeled,
  total_raw,
  -- The four ratios: emitted ONLY when the population is one ruler. Otherwise NULL — not a
  -- substituted value, not a blended average. See src/hal/measurement-ruler.ts.
  CASE WHEN is_measurement
       THEN round(tp::numeric / NULLIF(tp + fp, 0)::numeric, 4) END AS "precision",
  CASE WHEN is_measurement
       THEN round(tp::numeric / NULLIF(tp + fn, 0)::numeric, 4) END AS recall,
  CASE WHEN is_measurement
       THEN round(2.0 * tp::numeric / NULLIF(2 * tp + fp + fn, 0)::numeric, 4) END AS f1_score,
  CASE WHEN is_measurement
       THEN round(fp::numeric / NULLIF(fp + tn, 0)::numeric, 4) END AS false_positive_rate,
  -- data_quality now reports COMPARABILITY first and sample size second. 'ROBUST' can no longer
  -- be reached by a mixed population, which is the whole defect.
  CASE
    WHEN total_labeled = 0                THEN 'INSUFFICIENT_GROUND_TRUTH'
    WHEN mock_labeled_rows > 0
      AND distinct_rulers > 1             THEN 'UNRULED_MIXED_POPULATION_INCLUDES_MOCK'
    WHEN distinct_rulers > 1              THEN 'UNRULED_MIXED_POPULATION'
    WHEN mock_labeled_rows > 0            THEN 'NOT_A_MEASUREMENT_MOCK_MODE'
    WHEN total_labeled BETWEEN 1 AND 9    THEN 'SPARSE_PRELIMINARY'
    WHEN total_labeled BETWEEN 10 AND 29  THEN 'GROWING_SAMPLE'
    WHEN total_labeled BETWEEN 30 AND 99  THEN 'MINIMUM_VIABLE'
    ELSE 'ROBUST'
  END AS data_quality,
  'hal_runner_results'::text AS source_table,
  now() AS computed_at,
  -- ---- APPENDED COLUMNS (new; CREATE OR REPLACE VIEW permits adding at the end only) ----
  distinct_rulers,
  mock_labeled_rows,
  CASE WHEN is_measurement THEN 'ruled' ELSE 'UNRULED' END AS ruler_status,
  CASE
    WHEN total_labeled = 0 THEN 'no ground truth'
    WHEN NOT is_measurement THEN
      format('REFUSED — %s labeled rows span %s rulers (%s mock). NOT COMPARABLE. Use hal_accuracy_by_ruler.',
             total_labeled, distinct_rulers, mock_labeled_rows)
    ELSE format('F1 = %s on %s labeled cases (single ruler, corpus hash UNKNOWN)',
                round(2.0 * tp::numeric / NULLIF(2 * tp + fp + fn, 0)::numeric, 4), total_labeled)
  END AS citation
FROM verdict;

COMMENT ON VIEW public.hal_accuracy_summary IS
  'HAL confusion counts over hal_runner_results, with the RATIOS WITHHELD unless the underlying '
  'rows are a single comparable ruler. A ruler = (hal_mode, hal_threshold, manifest_dataset_id); '
  'see src/hal/measurement-ruler.ts (PR #327) for the contract. Before 2026-08-03 this view '
  'blended six rulers — including 653 hal_mode=''mock'' rows — into one F1 of 0.2633 labelled '
  'ROBUST, while the single real fact-check-s2 ruler (395 cases) scores 0.8812. precision / '
  'recall / f1_score / false_positive_rate are now NULL whenever data_quality reports UNRULED; '
  'that is a refusal, not missing data. Per-ruler numbers live in hal_accuracy_by_ruler. '
  'NOTE: no corpus CONTENT HASH exists in this schema, so ruler_status is ''UNRULED'' even for a '
  'single-ruler population — corpus identity here is an id with no receipt.';

-- ------------------------------------------------------------------------------------------
-- 2) THE SCOPED VIEW — one row per ruler, each with its own citation.
-- ------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.hal_accuracy_by_ruler AS
WITH labeled AS (
  SELECT
    h.hal_mode,
    h.hal_threshold,
    h.manifest_dataset_id,
    h.hyperdag_bench_commit,
    h.hal_vetoed AS predicted_veto,
    (SELECT gt.is_hallucination
       FROM hal_ground_truth_labels gt
      WHERE gt.source_table = 'hal_runner_results' AND gt.source_id = h.id::text
      ORDER BY gt.ground_truth_confidence DESC, gt.created_at DESC
      LIMIT 1) AS actual_hallucination,
    -- OBSERVED family width. NULL/empty provider arrays mean the width was not recorded, which
    -- #327 verified happens per-case: within one run, cases were judged with 1, 2 and 3
    -- families, and an earlier run recorded an EMPTY provider list on 43 cases.
    nullif(array_length(h.hal_providers_used, 1), 0) AS families_observed,
    h.run_id,
    h.created_at
  FROM hal_runner_results h
  WHERE h.gen_failed = false AND h.hal_vetoed IS NOT NULL
),
per_ruler AS (
  SELECT
    hal_mode,
    hal_threshold,
    manifest_dataset_id,
    count(DISTINCT run_id)                       AS runs,
    count(DISTINCT hyperdag_bench_commit)        AS bench_commits,
    min(created_at)                              AS first_seen,
    max(created_at)                              AS last_seen,
    count(*)                                     AS rows_total,
    count(actual_hallucination)                  AS cases_labeled,
    min(families_observed)                       AS families_min,
    max(families_observed)                       AS families_max,
    -- Denominator is rows_total, NOT cases_labeled: this describes the RUN's instrumentation,
    -- and a row can lack a provider list whether or not it was ever labeled. Named for its
    -- denominator so it is not misread as a share of the labeled cases.
    count(*) FILTER (WHERE families_observed IS NULL) AS rows_missing_family_width,
    count(*) FILTER (WHERE predicted_veto AND actual_hallucination)           AS tp,
    count(*) FILTER (WHERE predicted_veto AND NOT actual_hallucination)       AS fp,
    count(*) FILTER (WHERE NOT predicted_veto AND actual_hallucination)       AS fn,
    count(*) FILTER (WHERE NOT predicted_veto AND NOT actual_hallucination)   AS tn
  FROM labeled
  GROUP BY hal_mode, hal_threshold, manifest_dataset_id
)
SELECT
  hal_mode,
  hal_threshold,
  manifest_dataset_id,
  -- Strictness is asserted ONLY where hal_mode names it unambiguously. NULL means unknown, and
  -- unknown is not reconstructed.
  CASE WHEN hal_mode = 'fact-check-s2' THEN 2 END AS strictness,
  runs, bench_commits, first_seen, last_seen,
  rows_total, cases_labeled,
  families_min, families_max, rows_missing_family_width,
  tp, fp, fn, tn,
  -- A 'mock' run is not a measurement of HAL at any sample size.
  (hal_mode IS DISTINCT FROM 'mock' AND hal_mode IS DISTINCT FROM '1'
     AND cases_labeled > 0) AS is_measurement,
  CASE WHEN hal_mode IN ('mock', '1') OR cases_labeled = 0 THEN NULL
       ELSE round(tp::numeric / NULLIF(tp + fp, 0)::numeric, 4) END AS "precision",
  CASE WHEN hal_mode IN ('mock', '1') OR cases_labeled = 0 THEN NULL
       ELSE round(tp::numeric / NULLIF(tp + fn, 0)::numeric, 4) END AS recall,
  CASE WHEN hal_mode IN ('mock', '1') OR cases_labeled = 0 THEN NULL
       ELSE round(2.0 * tp::numeric / NULLIF(2 * tp + fp + fn, 0)::numeric, 4) END AS f1_score,
  CASE WHEN hal_mode IN ('mock', '1') OR cases_labeled = 0 THEN NULL
       ELSE round(fp::numeric / NULLIF(fp + tn, 0)::numeric, 4) END AS false_positive_rate,
  -- 'ruled' would require corpus identity WITH a content hash. No such column exists in this
  -- schema, so this is 'UNRULED' everywhere today, and the reason is spelled out per row.
  'UNRULED'::text AS ruler_status,
  CASE
    WHEN manifest_dataset_id IS NULL AND hal_mode IS NULL THEN 'no corpus id, no mode recorded'
    WHEN manifest_dataset_id IS NULL THEN 'no corpus id recorded; no content hash exists in schema'
    ELSE 'corpus id present but NO CONTENT HASH exists in schema (hal_snapshot_registry is empty)'
  END AS ruler_gap,
  -- The citation, in the shape src/hal/measurement-ruler.ts defines. UNKNOWN is printed, never
  -- filled in.
  CASE
    WHEN hal_mode IN ('mock', '1') THEN
      format('NOT A MEASUREMENT — hal_mode=%s over %s cases', hal_mode, cases_labeled)
    WHEN cases_labeled = 0 THEN 'NOT A MEASUREMENT — 0 labeled cases'
    ELSE format('F1 = %s on corpus %s@sha256:UNKNOWN (%s cases) at %s families, strictness %s — NOT COMPARABLE (no corpus hash)',
      round(2.0 * tp::numeric / NULLIF(2 * tp + fp + fn, 0)::numeric, 4),
      coalesce(manifest_dataset_id, 'UNKNOWN'),
      cases_labeled,
      CASE WHEN families_min IS NULL THEN 'UNKNOWN'
           WHEN families_min = families_max THEN families_min::text
           ELSE families_min || '..' || families_max END,
      coalesce((CASE WHEN hal_mode = 'fact-check-s2' THEN 2 END)::text, 'UNKNOWN'))
  END AS citation
FROM per_ruler
ORDER BY cases_labeled DESC;

COMMENT ON VIEW public.hal_accuracy_by_ruler IS
  'HAL accuracy, ONE ROW PER RULER, where a ruler = (hal_mode, hal_threshold, '
  'manifest_dataset_id) plus the OBSERVED family width. Replaces the practice of quoting one '
  'blended F1: see hal_accuracy_summary, which now refuses. is_measurement = false for '
  'hal_mode=''mock'' at any sample size. ruler_status is ''UNRULED'' on every row because this '
  'schema records no corpus CONTENT hash — manifest_dataset_id is a promise without a receipt, '
  'and hal_snapshot_registry (which has version + snapshot_hash + test_cases_count) has 0 rows. '
  'At 2026-08-03: 6 ruler groups, 5 of them carrying the 1,395 labeled cases. The only real '
  'cross-LLM ruler is fact-check-s2 @ 0.43 — 395 cases, families 1..3, F1 0.8812 — and it '
  'supplies ALL 178 of the true positives; the other rulers add 948 false positives and zero '
  'true positives. Contract: src/hal/measurement-ruler.ts (PR #327).';

-- Match the existing exposure of hal_accuracy_summary so a caller reading one can read the
-- other. NOTE: hal_accuracy_summary is anon-readable today; this migration does not widen or
-- narrow that, it mirrors it. See the report for the separate grant-hygiene finding.
GRANT SELECT ON public.hal_accuracy_by_ruler TO anon;
GRANT SELECT ON public.hal_accuracy_by_ruler TO authenticated;
GRANT SELECT ON public.hal_accuracy_by_ruler TO service_role;

COMMIT;

-- ==========================================================================================
-- BLAST RADIUS — applying this while traffic is live
-- ==========================================================================================
-- LOCK:  CREATE OR REPLACE VIEW takes ACCESS EXCLUSIVE on the view only, for the duration of a
--        catalog update. It does not lock or scan hal_runner_results. Milliseconds.
-- MAINTENANCE WINDOW: NOT required. Neither view is on a write path; nothing INSERTs through
--        them.
--
-- WHAT BREAKS — the honest answer, and there IS something:
--   Any consumer that reads f1_score / precision / recall / false_positive_rate from
--   hal_accuracy_summary starts receiving NULL, because the live population is unruled. A
--   consumer that renders the number without a null check will show a blank or throw.
--   [V] Enumerated consumers — grep for 'hal_accuracy_summary' across the repo (excluding
--       node_modules) returns exactly 6 files:
--         tests/hal-accuracy-summary.test.ts       — smoke test; already tolerates NULL metrics
--                                                    ("Null when insufficient ground truth")
--         scripts/preflight-cc-sprint-6.ts         — preflight check, not a served surface
--         scripts/seed-ground-truth-26-prompts.ts  — seeding script
--         src/types/database.types.ts              — generated types (STALE; regenerate)
--         migrations/2026-05-11-hal-accuracy-summary-view.sql   — original definition
--         migrations/2026-05-12-hal-ground-truth-labels.sql     — the redefinition now live
--       NO route under src/routes/ selects this view, so no public API response changes shape.
--   [V] SEPARATE PRE-EXISTING BREAK, not caused by this migration: that smoke test selects
--       'tp, fp, fn, tn, total', and the LIVE view has no 'total' column — it has total_labeled
--       and total_raw. The 2026-05-12 redefinition renamed it and the test was never updated.
--       This migration keeps total_labeled/total_raw (it does NOT resurrect 'total'), so that
--       test stays broken in exactly the way it already was. Fixing it is a tests/ change
--       outside this lane's fence — see the report.
--
--   The intended consequence: a dashboard that used to show '0.26 ROBUST' now shows nothing plus
--   'UNRULED_MIXED_POPULATION_INCLUDES_MOCK'. That is the correct reading of the data, and it is
--   strictly better than a confident wrong number on an anon-readable surface.
--
-- IRREVERSIBILITY: none. The rollback restores the previous definition VERBATIM (captured from
-- pg_get_viewdef before this change) and drops the new view. Grants survive both directions
-- because neither uses DROP + CREATE on the existing view.
-- ==========================================================================================


-- ==========================================================================================
-- VERIFICATION — proves the defect BEFORE, proves its absence AFTER. Read-only; safe to run.
-- ==========================================================================================
--
-- V1. THE DEFECT, BEFORE. Expect f1_score = 0.2633 with data_quality = 'ROBUST' — one number,
--     no scoping, asserted as robust:
--
--   SELECT tp, fp, fn, tn, total_labeled, f1_score, false_positive_rate, data_quality
--   FROM hal_accuracy_summary;
--
-- V2. THE PROOF THAT 0.2633 IS A BLEND OF INCOMPATIBLE POPULATIONS. Run this BEFORE applying;
--     it needs none of this migration. Expect 6 groups, 633+20 of them hal_mode='mock' at
--     threshold 1.0136433, and fact-check-s2 alone at F1 0.8812:
--
--   WITH labeled AS (
--     SELECT h.hal_mode, h.hal_threshold, h.manifest_dataset_id, h.hal_vetoed,
--            (SELECT gt.is_hallucination FROM hal_ground_truth_labels gt
--              WHERE gt.source_table='hal_runner_results' AND gt.source_id=h.id::text
--              ORDER BY gt.ground_truth_confidence DESC, gt.created_at DESC LIMIT 1) AS actual,
--            array_length(h.hal_providers_used,1) AS fam
--     FROM hal_runner_results h WHERE h.gen_failed=false AND h.hal_vetoed IS NOT NULL)
--   SELECT hal_mode, manifest_dataset_id, hal_threshold, count(*) AS rows,
--          count(actual) AS labeled, min(fam) AS fam_min, max(fam) AS fam_max,
--          round(2.0*count(*) FILTER (WHERE hal_vetoed AND actual)::numeric
--                / nullif(2*count(*) FILTER (WHERE hal_vetoed AND actual)
--                         + count(*) FILTER (WHERE hal_vetoed AND actual=false)
--                         + count(*) FILTER (WHERE hal_vetoed=false AND actual),0),4) AS f1
--   FROM labeled GROUP BY 1,2,3 ORDER BY rows DESC;
--
-- V3. AFTER — the refusal is in force. Expect f1_score IS NULL, ruler_status = 'UNRULED',
--     data_quality = 'UNRULED_MIXED_POPULATION_INCLUDES_MOCK', distinct_rulers = 5 (the sixth
--     group has 0 labeled rows and so never enters the ratio math), mock_labeled_rows = 643,
--     and the counts still present (tp=178 fp=977 fn=19 tn=221).
--     VERIFIED read-only on 2026-08-03 by running this view's SELECT body as a plain query
--     against qnnpjhlxljtqyigedwkb — exact output:
--       tp=178 fp=977 fn=19 tn=221 total_labeled=1395 total_raw=1559 f1_score=NULL
--       data_quality='UNRULED_MIXED_POPULATION_INCLUDES_MOCK' distinct_rulers=5
--       mock_labeled_rows=643 ruler_status='UNRULED'
--       citation='REFUSED — 1395 labeled rows span 5 rulers (643 mock). NOT COMPARABLE. Use hal_accuracy_by_ruler.'
--
--   SELECT tp, fp, fn, tn, total_labeled, f1_score, data_quality, distinct_rulers,
--          mock_labeled_rows, ruler_status, citation
--   FROM hal_accuracy_summary;
--
-- V4. AFTER — the real number is now quotable, attributed, next to its width. VERIFIED
--     read-only on 2026-08-03 by running this view's SELECT body as a plain query; expect 6 rows,
--     the fact-check-s2 one reading exactly:
--       hal_mode=fact-check-s2 threshold=0.43 manifest=NULL strictness=2 runs=4
--       cases_labeled=395 families 1..3 rows_missing_family_width=59
--       tp=178 fp=29 fn=19 tn=169 is_measurement=true f1_score=0.8812
--       citation='F1 = 0.8812 on corpus UNKNOWN@sha256:UNKNOWN (395 cases) at 1..3 families, strictness 2 — NOT COMPARABLE (no corpus hash)'
--     ...both mock rows at is_measurement=false, f1_score NULL; and the two legacy 'real' rulers
--     at f1_score 0.0000 (tp=0, every labeled case a false positive) — those ARE measurements,
--     of a configuration that vetoed everything, which is why they are not hidden.
--
--   SELECT hal_mode, hal_threshold, manifest_dataset_id, strictness, cases_labeled,
--          families_min, families_max, rows_missing_family_width,
--          is_measurement, f1_score, ruler_status, citation
--   FROM hal_accuracy_by_ruler;
--
-- V5. AFTER — the counts did not move. The refusal withheld ratios, it did not drop rows.
--     Expect equal values on both sides:
--
--   SELECT s.total_labeled AS summary_labeled,
--          (SELECT sum(cases_labeled) FROM hal_accuracy_by_ruler) AS by_ruler_labeled,
--          s.tp + s.fp + s.fn + s.tn AS summary_classified,
--          (SELECT sum(tp+fp+fn+tn) FROM hal_accuracy_by_ruler) AS by_ruler_classified
--   FROM hal_accuracy_summary s;
-- ==========================================================================================
