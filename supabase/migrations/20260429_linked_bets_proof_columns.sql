-- ============================================================================
-- linked_bets: add is_simulated and plonky3_proof_bytes columns
--
-- Production code in src/services/linked-bet-resolver.ts writes both fields
-- on every bet insert (post-revert commit 0c71eaea). Live Supabase DB was
-- missing these columns, causing demo Step 3 to fail with PostgREST schema
-- cache error.
--
-- Test environment monkeypatches these columns out via beforeAll in
-- tests/round-numbers-demo.test.ts. Production needs the real schema.
--
-- is_simulated: BOOLEAN NOT NULL DEFAULT FALSE — matches the honesty flag
--   meaning "this bet's proof was simulated (HMAC fallback) rather than a
--   real Plonky3 STARK". Default FALSE because real Plonky3 is the goal
--   state; existing rows pre-migration are tagged FALSE so any post-migration
--   audit can identify them as "before this was tracked".
--
-- plonky3_proof_bytes: TEXT NULLABLE — hex-encoded proof bytes. Nullable
--   because pre-migration rows have no proof to record.
--
-- IF NOT EXISTS guards make the migration idempotent.
-- ============================================================================

ALTER TABLE linked_bets
  ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS plonky3_proof_bytes TEXT;

CREATE INDEX IF NOT EXISTS idx_linked_bets_is_simulated
  ON linked_bets(is_simulated)
  WHERE is_simulated = TRUE;

NOTIFY pgrst, 'reload schema';
