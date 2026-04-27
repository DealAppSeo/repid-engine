-- ============================================================================
-- Reponomics — builder registry
--
-- Builders (humans) own one or more agents. Each builder has a stake
-- deposit (separate table), a current_repid (mean of owned agents'
-- repid minus ghost cohort penalty), and a ghost_cohort_count tracking
-- agents that have been inactive for >7 days.
--
-- Authority is computed from (stake, agent R/W/C, builder R) per the
-- quadratic formula in stake-vault.ts.
-- ============================================================================

CREATE TABLE IF NOT EXISTS builders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address             TEXT NOT NULL UNIQUE,                 -- wallet address
  erc7231_token_id    TEXT,                                  -- nullable, set when ERC-7231 SBT minted
  current_repid       INTEGER NOT NULL DEFAULT 0,
  ghost_cohort_count  INTEGER NOT NULL DEFAULT 0,
  last_active_at      TIMESTAMPTZ,
  display_name        TEXT,                                  -- demo: "Builder W", "Builder M"
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_builders_address ON builders(LOWER(address));
CREATE INDEX IF NOT EXISTS idx_builders_active ON builders(last_active_at DESC);

-- Add agent → builder linkage + activity tracker on repid_agents.
-- All additive, nullable; existing rows untouched.
ALTER TABLE repid_agents
  ADD COLUMN IF NOT EXISTS character_score      INTEGER DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS last_active_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS builder_id           UUID,
  ADD COLUMN IF NOT EXISTS wisdom_history_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS character_history_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_repid_agents_builder ON repid_agents(builder_id);
