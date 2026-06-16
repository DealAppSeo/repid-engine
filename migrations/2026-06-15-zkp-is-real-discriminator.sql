-- STAGED — Sean co-sign before applying.
-- is_real discriminator: only scheme NOT NULL AND proof_bytes present = a real Plonky3 proof.
-- Public 'proven' surfaces MUST filter is_real=true.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + UPDATE is safe to run twice.
-- DO NOT apply without Sean co-sign + prior worktree freeze.
--
-- Context: repid_zkp_proofs has ~56,824 rows as of 2026-06-09.
-- Only 1 confirmed real Plonky3 proof (scheme='plonky3_range_check', proof_bytes non-empty).
-- All other rows are sha256 stubs: scheme IS NULL or scheme='sha256_commitment_poc'.
-- This column provides a clean truth-in-data discriminator so public surfaces
-- (/repid/:agentId/proof, /verify-proof, EAS anchor eligibility) can filter
-- without relying on callers to remember the scheme/proof_bytes compound check.

BEGIN;

-- Step 1: add the column (idempotent)
ALTER TABLE repid_zkp_proofs
  ADD COLUMN IF NOT EXISTS is_real boolean NOT NULL DEFAULT false;

-- Step 2: backfill — real = scheme set AND proof_bytes non-empty
UPDATE repid_zkp_proofs
   SET is_real = (
         scheme IS NOT NULL
         AND octet_length(proof_bytes) > 0
       );

-- Step 3: label stubs so they are queryable by stub type
-- Sets scheme='sha256-stub' for rows that have no scheme at all (the oldest stubs
-- that predate the A5 scheme field; distinguishes them from sha256_commitment_poc).
-- Opt-in only — do NOT run this step if you prefer to keep scheme NULL as the signal.
UPDATE repid_zkp_proofs
   SET scheme = 'sha256-stub'
 WHERE is_real = false
   AND scheme IS NULL;

COMMIT;

-- Verify (run after applying):
-- SELECT is_real, scheme, count(*) FROM repid_zkp_proofs GROUP BY 1,2 ORDER BY 1,2;
-- Expected: is_real=true => 1 row (the one real plonky3 proof); is_real=false => ~56,823 stubs.
