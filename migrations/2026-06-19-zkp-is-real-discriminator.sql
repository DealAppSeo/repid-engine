-- STAGED 2026-06-19 XC-S1 — Sean co-sign before prod apply (Tier-3).
-- is_real discriminator + public read-gate for proof surfaces.
-- Idempotent: safe if column already exists (verified prod 2026-06-19 [V]).
--
-- PROD BEFORE (2026-06-19T21:54Z, service/pg direct):
--   SELECT COALESCE(scheme,'(null)') scheme, count(*)::bigint n,
--          count(*) FILTER (WHERE proof_bytes IS NOT NULL AND octet_length(proof_bytes)>0)::bigint with_bytes
--   FROM repid_zkp_proofs GROUP BY 1 ORDER BY n DESC;
--   => sha256-stub: 56823 (with_bytes=0, max_created 2026-06-07)
--   => plonky3_range_check: 21960 (with_bytes=21960, max_created 2026-06-17)
--   SELECT count(*) FILTER (WHERE is_real=true), count(*) FILTER (WHERE is_real IS NOT TRUE), count(*)
--   FROM repid_zkp_proofs;
--   => real_n=21960, stub_n=56823, total=78783
--   Column is_real ALREADY PRESENT — this migration re-backfills + adds read-gate view.

BEGIN;

ALTER TABLE repid_zkp_proofs
  ADD COLUMN IF NOT EXISTS is_real boolean NOT NULL DEFAULT false;

-- Backfill: real = plonky3 scheme with non-empty proof_bytes (matches CC Inv5 pin path)
UPDATE repid_zkp_proofs
   SET is_real = (
         scheme = 'plonky3_range_check'
         AND proof_bytes IS NOT NULL
         AND octet_length(proof_bytes) > 0
       );

-- Label legacy stubs for queryability (idempotent)
UPDATE repid_zkp_proofs
   SET scheme = 'sha256-stub'
 WHERE is_real = false
   AND (scheme IS NULL OR scheme = 'sha256_commitment_poc');

-- Partial index for public read-gate hot path
CREATE INDEX IF NOT EXISTS idx_repid_zkp_proofs_is_real_created
  ON repid_zkp_proofs (created_at DESC)
  WHERE is_real = true;

-- Read-gate view: ONLY real proofs on public surfaces (/verify-proof, /repid/:id/proof, stats)
CREATE OR REPLACE VIEW v_repid_zkp_proofs_public AS
  SELECT id, agent_id, proof_type, tier_proven, scheme, statement, created_at,
         eas_attestation_uid, eas_schema, merkle_root,
         octet_length(proof_bytes) AS proof_bytes_len
    FROM repid_zkp_proofs
   WHERE is_real = true;

COMMENT ON VIEW v_repid_zkp_proofs_public IS
  'Public proof read-gate (XC-S1 2026-06-19): only is_real=true rows. Stubs excluded.';

COMMIT;

-- AFTER-APPLY PROOF (paste raw for Sean):
-- SELECT is_real, scheme, count(*) FROM repid_zkp_proofs GROUP BY 1,2 ORDER BY 1,2;
-- SELECT count(*) FROM v_repid_zkp_proofs_public;  -- expect 21960 (or current real count)
-- SELECT column_name FROM information_schema.columns WHERE table_name='repid_zkp_proofs' AND column_name='is_real';