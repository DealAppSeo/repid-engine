-- Parallel, hash-chained audit table for HAL events.
-- Lives alongside hal_production_events; this migration does NOT modify
-- hal_production_events or add any triggers. Application-side writers that
-- populate current_entry_hash / previous_entry_hash will land in a later
-- change once approved.

CREATE TABLE IF NOT EXISTS hal_audit_chain (
  id BIGSERIAL PRIMARY KEY,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_payload JSONB NOT NULL,
  previous_entry_hash TEXT,
  current_entry_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hal_audit_chain_created_at
  ON hal_audit_chain(created_at);

CREATE INDEX IF NOT EXISTS idx_hal_audit_chain_source
  ON hal_audit_chain(source_table, source_id);
