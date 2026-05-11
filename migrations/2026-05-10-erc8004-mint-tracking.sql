-- ============================================================
-- ERC-8004 mint tracking columns
-- Sprint: feat/erc8004-minting-flow-2026-05-10 (CC1)
-- Target contract: IdentityRegistry at 0x8004A818BFB912233c491871b3d84c89A494BD9e
--   on Base Sepolia (chainId 84532). Multi-chain vanity address.
-- ============================================================
-- Pre-state verified 2026-05-10 against project qnnpjhlxljtqyigedwkb:
--   Existing on repid_agents (text):
--     - conservator_address
--     - erc8004_address
--     - erc8004_token_id
--   New columns added by this migration:
--     - mint_tx_hash      (text)
--     - mint_block_number (bigint)
--     - minted_at         (timestamptz)
--     - mint_chain_id     (integer)
-- ============================================================
BEGIN;

ALTER TABLE repid_agents
  ADD COLUMN IF NOT EXISTS mint_tx_hash      TEXT,
  ADD COLUMN IF NOT EXISTS mint_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS minted_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mint_chain_id     INTEGER;

-- Index for "is this agent minted" lookups
CREATE INDEX IF NOT EXISTS idx_repid_agents_minted_at
  ON repid_agents(minted_at)
  WHERE minted_at IS NOT NULL;

-- Index for chain-scoped lookups
CREATE INDEX IF NOT EXISTS idx_repid_agents_mint_chain
  ON repid_agents(mint_chain_id, erc8004_token_id)
  WHERE erc8004_token_id IS NOT NULL;

-- ------------------------------------------------------------
-- APM BACKFILL: DELIBERATELY OMITTED
-- ------------------------------------------------------------
-- The sprint draft proposed backfilling APM's mint_chain_id=84532
-- on the assumption that APM's erc8004_address is the deployed
-- contract address. Audit (2026-05-10) found that APM's stored
-- erc8004_address (0xceD17F65E03e7b3a77D5321A2d3715840317199C) is
-- actually APM's AGENT WALLET (per SPRINT-CC-REPONOMICS-DEMO.md
-- line 68: APM_AGENT_WALLET=0xceD17F65...), not the IdentityRegistry
-- contract. Backfilling mint_chain_id without first verifying that
-- token #1585 actually exists on the canonical IdentityRegistry
-- (0x8004A818BFB912233c491871b3d84c89A494BD9e) could cement
-- incorrect provenance. Sean should verify on-chain first via:
--   GET /api/v1/agents/{APM_UUID}/onchain   (after this branch lands)
-- and only backfill APM if drift=false.

COMMIT;

-- ROLLBACK (manual, comment-uncomment to use):
-- BEGIN;
-- DROP INDEX IF EXISTS idx_repid_agents_mint_chain;
-- DROP INDEX IF EXISTS idx_repid_agents_minted_at;
-- ALTER TABLE repid_agents
--   DROP COLUMN IF EXISTS mint_tx_hash,
--   DROP COLUMN IF EXISTS mint_block_number,
--   DROP COLUMN IF EXISTS minted_at,
--   DROP COLUMN IF EXISTS mint_chain_id;
-- COMMIT;
