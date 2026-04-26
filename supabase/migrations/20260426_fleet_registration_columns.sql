-- ============================================================================
-- Fleet registration columns — additive
--
-- The fleet-register-v2.js script (and the GET /api/v1/fleet/status endpoint)
-- need a few columns on agent_kya_registry that don't exist yet. All are
-- nullable and additive — no destructive change to existing rows.
-- ============================================================================

ALTER TABLE agent_kya_registry
  ADD COLUMN IF NOT EXISTS current_token_id      TEXT,
  ADD COLUMN IF NOT EXISTS mint_tx_hash          TEXT,
  ADD COLUMN IF NOT EXISTS metadata_uri          TEXT,
  ADD COLUMN IF NOT EXISTS metadata_inline       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS registration_status   TEXT,            -- 'verified' | 'pending' | 'failed' | 'orphaned' | 'deprecated_duplicate'
  ADD COLUMN IF NOT EXISTS superseded_by         TEXT,            -- token_id of the canonical replacement, when this row is a deprecated_duplicate
  ADD COLUMN IF NOT EXISTS last_chain_check      TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_agent_kya_registry_status
  ON agent_kya_registry(registration_status, agent_name);
