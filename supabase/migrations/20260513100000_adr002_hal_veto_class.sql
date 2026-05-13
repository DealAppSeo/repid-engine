-- Primary production HAL log: repid_score_events
ALTER TABLE repid_score_events
  ADD COLUMN IF NOT EXISTS veto_class TEXT;

ALTER TABLE repid_score_events
  DROP CONSTRAINT IF EXISTS repid_score_events_veto_class_chk;
ALTER TABLE repid_score_events
  ADD CONSTRAINT repid_score_events_veto_class_chk
  CHECK (veto_class IS NULL OR veto_class IN ('FACTUAL_ERROR', 'BFT_CONTRADICTION', 'UNKNOWN'));

CREATE INDEX IF NOT EXISTS idx_repid_score_events_veto_class
  ON repid_score_events(veto_class) WHERE veto_class IS NOT NULL;

-- Secondary benchmark log: hal_runner_results
ALTER TABLE hal_runner_results
  ADD COLUMN IF NOT EXISTS veto_class TEXT;

ALTER TABLE hal_runner_results
  DROP CONSTRAINT IF EXISTS hal_runner_results_veto_class_chk;
ALTER TABLE hal_runner_results
  ADD CONSTRAINT hal_runner_results_veto_class_chk
  CHECK (veto_class IS NULL OR veto_class IN ('FACTUAL_ERROR', 'BFT_CONTRADICTION', 'UNKNOWN'));

CREATE INDEX IF NOT EXISTS idx_hal_runner_results_veto_class
  ON hal_runner_results(veto_class) WHERE veto_class IS NOT NULL;

-- hal_evaluations gets it too (substrate ready for when env-gate flips on)
ALTER TABLE hal_evaluations
  ADD COLUMN IF NOT EXISTS veto_class TEXT;

ALTER TABLE hal_evaluations
  DROP CONSTRAINT IF EXISTS hal_evaluations_veto_class_chk;
ALTER TABLE hal_evaluations
  ADD CONSTRAINT hal_evaluations_veto_class_chk
  CHECK (veto_class IS NULL OR veto_class IN ('FACTUAL_ERROR', 'BFT_CONTRADICTION', 'UNKNOWN'));
