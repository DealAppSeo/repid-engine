ALTER TABLE repid_events ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_repid_events_unprocessed ON repid_events (processed_at) WHERE processed_at IS NULL;
