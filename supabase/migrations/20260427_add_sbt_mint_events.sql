-- ============================================================================
-- SBT mint events — append-only log of every SBT mint attempt.
--
-- Used by POST /api/v1/sbt/mint to record an audit row even when the on-chain
-- mint runs in mock mode. Holder lookups (GET /api/v1/sbt/by-holder/:addr)
-- read from this table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sbt_mint_events (
  id                 BIGSERIAL PRIMARY KEY,
  holder_address     TEXT NOT NULL,
  token_id           TEXT,
  tx_hash            TEXT,
  ipfs_uri           TEXT,
  metadata_inline    BOOLEAN NOT NULL DEFAULT TRUE,
  rep_id_commitment  TEXT,
  status             TEXT NOT NULL,                -- pending | minted | failed | mock
  is_mock            BOOLEAN NOT NULL DEFAULT FALSE,
  audit_chain_id     BIGINT,                       -- FK-soft to hal_audit_chain.id
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sbt_mint_events_holder
  ON sbt_mint_events(LOWER(holder_address), created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sbt_mint_events_status
  ON sbt_mint_events(status, created_at DESC);
