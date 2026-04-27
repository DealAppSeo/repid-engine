-- ============================================================================
-- Reponomics — stake vault
--
-- stake_deposits records every deposit/withdrawal. amount is BIGINT in
-- the asset's smallest unit (USDC = 6 decimals; 1 USDC = 1_000_000).
--
-- stake_authority_snapshots records computed authority at a point in
-- time, used by the demo timeline. The basis JSON breakdown captures
-- the inputs (stake_sqrt, R, W, C, builder_repid) so a snapshot can be
-- replayed and verified client-side.
-- ============================================================================

CREATE TABLE IF NOT EXISTS stake_deposits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  amount          NUMERIC(38,0) NOT NULL,            -- USDC smallest unit; 38 digits handles up to ~1e32 USDC
  token_address   TEXT NOT NULL DEFAULT '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  deposit_tx_hash TEXT,
  status          TEXT NOT NULL DEFAULT 'active',     -- active | withdrawn
  is_simulated    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stake_deposits_builder ON stake_deposits(builder_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS stake_authority_snapshots (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id           UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  computed_authority   NUMERIC(38,0) NOT NULL,
  basis                JSONB NOT NULL,                 -- {stake, stake_sqrt, R, W, C, combinedScore, ...}
  computed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stake_authority_builder ON stake_authority_snapshots(builder_id, computed_at DESC);
