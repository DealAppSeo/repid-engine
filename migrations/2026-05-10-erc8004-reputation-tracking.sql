-- ============================================================
-- ERC-8004 ReputationRegistry write tracking
-- Sprint: feat/erc8004-spec-compliance-2026-05-10 (CC1 Wave 6)
-- ============================================================
-- Pre-state verified 2026-05-10 evening:
--   None of the 5 target columns exist on repid_agents.
--   No table named erc8004_reputation_writes exists.
-- ============================================================
BEGIN;

-- Track the last reputation feedback write per agent.
ALTER TABLE repid_agents
  ADD COLUMN IF NOT EXISTS last_reputation_tx_hash      TEXT,
  ADD COLUMN IF NOT EXISTS last_reputation_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS last_reputation_repid        INTEGER,
  ADD COLUMN IF NOT EXISTS last_reputation_written_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reputation_write_count       INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS repid_agents_last_reputation_written_at_idx
  ON repid_agents(last_reputation_written_at DESC NULLS LAST);

-- Append-only audit log of every reputation feedback write.
CREATE TABLE IF NOT EXISTS erc8004_reputation_writes (
  id                BIGSERIAL PRIMARY KEY,
  agent_id          UUID NOT NULL REFERENCES repid_agents(id) ON DELETE CASCADE,
  agent_token_id    TEXT NOT NULL,
  repid_value       INTEGER NOT NULL,
  tier              TEXT NOT NULL,
  tx_hash           TEXT NOT NULL UNIQUE,
  block_number      BIGINT NOT NULL,
  gas_used          NUMERIC,
  chain_id          INTEGER NOT NULL DEFAULT 84532,
  contract_address  TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS erc8004_reputation_writes_agent_id_idx
  ON erc8004_reputation_writes(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS erc8004_reputation_writes_chain_token_idx
  ON erc8004_reputation_writes(chain_id, agent_token_id);

ALTER TABLE erc8004_reputation_writes ENABLE ROW LEVEL SECURITY;
-- Service role bypasses by default (used by backend); no other policies
-- needed for v1. Reads can be added later when an authenticated end-user
-- surface lands.

COMMIT;

-- ROLLBACK (manual, comment-uncomment to use):
-- BEGIN;
-- DROP INDEX IF EXISTS erc8004_reputation_writes_chain_token_idx;
-- DROP INDEX IF EXISTS erc8004_reputation_writes_agent_id_idx;
-- DROP TABLE IF EXISTS erc8004_reputation_writes;
-- DROP INDEX IF EXISTS repid_agents_last_reputation_written_at_idx;
-- ALTER TABLE repid_agents
--   DROP COLUMN IF EXISTS reputation_write_count,
--   DROP COLUMN IF EXISTS last_reputation_written_at,
--   DROP COLUMN IF EXISTS last_reputation_repid,
--   DROP COLUMN IF EXISTS last_reputation_block_number,
--   DROP COLUMN IF EXISTS last_reputation_tx_hash;
-- COMMIT;
