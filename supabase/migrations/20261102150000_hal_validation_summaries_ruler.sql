-- HAL VALIDATION SUMMARIES — carry the MEASUREMENT RULER with each stored F1 (SHADOW).
--
-- ╔══════════════════════════════════════════════════════════════════════════════════╗
-- ║  NOT APPLIED TO PROD (owner-gated). FILE ONLY — do not run.                         ║
-- ║  Additive and safe: one nullable column. Existing rows get ruler = NULL, which      ║
-- ║  MEANS UNATTRIBUTED. Nothing live changes until the owner applies this AND sets      ║
-- ║  HAL_PERSIST_RULER (default OFF). With the flag OFF the write path never names        ║
-- ║  `ruler`, so this column stays absent-of-data and nothing reads it.                  ║
-- ╚══════════════════════════════════════════════════════════════════════════════════╝
--
-- WHY. `hal_validation_summaries` stores `f1_score` next to exactly one descriptor of how the run
-- was configured: `harness_version`. That is not enough to tell two runs apart: on 2026-07-04 two
-- runs over the SAME 1000 case ids were recorded as F1 0.344 and F1 0.798, both stamped
-- `harness_version = '1.0.0'`. The configuration — which corpus, how many families, what strictness,
-- what quorum gating — was the difference, and it was never written down. src/hal/measurement-ruler.ts
-- builds that ruler and refuses a number without it in memory; this column is where the ruler lands
-- when a summary is saved, so a SAVED number keeps the ruler it was taken with.
--
-- SHAPE. The serialized MeasurementRuler (src/hal/measurement-ruler.ts serializeRuler):
--   { "corpus": { "corpusId": "...", "contentHash": "sha256:<64 hex>", "caseCount": <int> },
--     "width":  { "familiesConfigured": <int>, "familiesMin": <int>, "familiesMax": <int>,
--                 "strictness": 1 | 2, "decisionRequiresQuorum": <bool>, "penaltyRequiresQuorum": <bool> },
--     "engineCommit": "<sha>"   -- optional
--   }
--
-- NO CHECK CONSTRAINT, on purpose. A CHECK that required `ruler` to be non-null would reject every
-- historical row (they predate the ruler and cannot be back-attributed — see measurement-ruler.ts
-- "HISTORICAL NUMBERS"). "No new UNRULED summary" is enforced in the WRITE PATH instead
-- (src/services/hal-validation-runner.ts buildSummaryRow throws UnruledSummaryError when
-- HAL_PERSIST_RULER is on and a summary carries no usable ruler), which can distinguish a new run
-- from a historical row; a column CHECK cannot.

alter table public.hal_validation_summaries
  add column if not exists ruler jsonb;

comment on column public.hal_validation_summaries.ruler is
  'Serialized MeasurementRuler (src/hal/measurement-ruler.ts): the corpus {corpusId, contentHash, caseCount}, configuration width {familiesConfigured, familiesMin, familiesMax, strictness, decisionRequiresQuorum, penaltyRequiresQuorum}, and optional engineCommit the f1_score was taken with. NULL MEANS UNATTRIBUTED: a stored number whose ruler was never recorded (every row before HAL_PERSIST_RULER). An UNATTRIBUTED number is rendered visibly un-sourced and is never quoted as comparable or trendable.';

-- ── ROLLBACK (DOWN) — run this to undo, if the column is ever applied ───────────────────
-- Nothing live depends on it while HAL_PERSIST_RULER is off.
-- alter table public.hal_validation_summaries drop column if exists ruler;
