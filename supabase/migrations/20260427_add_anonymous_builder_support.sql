-- ============================================================================
-- Reponomics live demo — anonymous-builder support
--
-- Adds three nullable columns to builders so a visitor can use the live
-- demo without a wallet:
--   - earns_repid_rewards   FALSE for token-only signups; TRUE for wallet
--                           or ERC-7231 builders.
--   - auth_method           'wallet' | 'token_only' | 'email'
--                           determines what the builder can do (mint, earn,
--                           govern). Default 'wallet' preserves existing
--                           rows' semantics — they are already wallet-bound.
--   - session_token         opaque random string for token-only auth. NULL
--                           for wallet builders.
--
-- All additive, IF NOT EXISTS guards, no destructive change to existing rows.
-- The partial index on session_token only indexes non-null rows (token-only).
-- ============================================================================

ALTER TABLE builders
  ADD COLUMN IF NOT EXISTS earns_repid_rewards BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auth_method         TEXT    NOT NULL DEFAULT 'wallet',
  ADD COLUMN IF NOT EXISTS session_token       TEXT;

CREATE INDEX IF NOT EXISTS idx_builders_session_token
  ON builders(session_token)
  WHERE session_token IS NOT NULL;
