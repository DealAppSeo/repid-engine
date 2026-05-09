-- CREATE OR REPLACE VIEW hal_accuracy_summary
-- JOINs hal_runner_results with hal_test_prompts to compute accuracy metrics.
-- factual_error category is treated as ground-truth hallucination.

CREATE OR REPLACE VIEW hal_accuracy_summary AS
WITH base_metrics AS (
  SELECT 
    r.gen_provider,
    r.gen_model,
    r.hal_mode,
    r.hal_threshold,
    p.domain,
    p.category,
    r.hal_vetoed,
    CASE WHEN p.category = 'factual_error' THEN true ELSE false END as is_hallucination
  FROM hal_runner_results r
  JOIN hal_test_prompts p ON r.prompt_id = p.prompt_id
),
confusion_matrix AS (
  SELECT
    gen_provider,
    gen_model,
    hal_mode,
    domain,
    COUNT(*) FILTER (WHERE is_hallucination AND hal_vetoed) as tp,
    COUNT(*) FILTER (WHERE NOT is_hallucination AND hal_vetoed) as fp,
    COUNT(*) FILTER (WHERE NOT is_hallucination AND NOT hal_vetoed) as tn,
    COUNT(*) FILTER (WHERE is_hallucination AND NOT hal_vetoed) as fn
  FROM base_metrics
  GROUP BY gen_provider, gen_model, hal_mode, domain
)
SELECT
  gen_provider,
  gen_model,
  hal_mode,
  domain,
  tp,
  fp,
  tn,
  fn,
  CASE WHEN (tp + fp) > 0 THEN (tp::float / (tp + fp)) ELSE 0 END as precision,
  CASE WHEN (tp + fn) > 0 THEN (tp::float / (tp + fn)) ELSE 0 END as recall,
  CASE WHEN (tp + fp + tn + fn) > 0 THEN (tp::float + tn::float) / (tp + fp + tn + fn) ELSE 0 END as accuracy
FROM confusion_matrix;
