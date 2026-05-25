-- Phase 1 — V1 Launch Readiness Schema Gaps

-- 1. GAP B: repid_event_id on erc8004_reputation_writes
ALTER TABLE erc8004_reputation_writes
  ADD COLUMN IF NOT EXISTS repid_event_id BIGINT REFERENCES repid_events(id);

CREATE INDEX IF NOT EXISTS idx_erc8004_writes_event ON erc8004_reputation_writes(repid_event_id);

-- 2. GAP C part 2: contract_id on repid_score_events
ALTER TABLE repid_score_events
  ADD COLUMN IF NOT EXISTS contract_id UUID;

CREATE INDEX IF NOT EXISTS idx_score_events_contract ON repid_score_events(contract_id);

-- Backfill contract_id from existing metadata JSONB
UPDATE repid_score_events
SET contract_id = (metadata->>'contract_id')::UUID
WHERE contract_id IS NULL
  AND metadata->>'contract_id' IS NOT NULL;
