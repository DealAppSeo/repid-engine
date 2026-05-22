-- 2026-05-22 — repid_events parallel-verdict columns (HAL || x402)
-- Sean applies via Supabase. Verified against live schema 2026-05-22:
--   repid_events.id = bigint, processed_at = timestamptz, hal_classifications.id = bigint.
-- Adds the two verdict columns + an audit link + a combine timestamp so the
-- FeedbackLoopWorker can require BOTH verdicts before an on-chain write
-- (either dissent vetoes; gas only on x402='settled' AND hal='pass').
-- Idempotent (IF NOT EXISTS) so re-apply is safe.

ALTER TABLE repid_events
  ADD COLUMN IF NOT EXISTS verdict_x402 TEXT
    CHECK (verdict_x402 IN ('settled','rejected','error','pending') OR verdict_x402 IS NULL),
  ADD COLUMN IF NOT EXISTS verdict_hal TEXT
    CHECK (verdict_hal IN ('pass','fail','error','pending') OR verdict_hal IS NULL),
  ADD COLUMN IF NOT EXISTS hal_classification_id BIGINT REFERENCES hal_classifications(id),
  ADD COLUMN IF NOT EXISTS verdict_combined_at TIMESTAMPTZ;

-- Partial index: the FeedbackLoopWorker only ever scans unprocessed rows.
CREATE INDEX IF NOT EXISTS idx_repid_events_verdicts
  ON repid_events (verdict_x402, verdict_hal)
  WHERE processed_at IS NULL;

-- Column purposes:
--   verdict_x402          : x402-server.ts writes settled|rejected|error on settlement attempt
--   verdict_hal           : HAL judgment worker writes pass|fail|error (derived from HAL signals)
--   hal_classification_id : link to the hal_classifications row that produced the judgment (audit)
--   verdict_combined_at   : set once both verdicts are present (the FeedbackLoopWorker gate)

-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_repid_events_verdicts;
--   ALTER TABLE repid_events
--     DROP COLUMN IF EXISTS verdict_x402,
--     DROP COLUMN IF EXISTS verdict_hal,
--     DROP COLUMN IF EXISTS hal_classification_id,
--     DROP COLUMN IF EXISTS verdict_combined_at;
