-- A5 (D-062): additive columns so repid_zkp_proofs rows from the REAL Plonky3 prover are
-- independently WASM-verifiable (hyperdag-proof-verifier needs proof_bytes + {repid_score, threshold}),
-- and so real rows are distinguishable from legacy sha256 stubs (scheme).
-- Additive, nullable, reversible. New-events-only — no backfill of the 56k+ legacy POSTCARD rows.
-- `scheme` was already applied to prod via MCP 2026-06-07; included here with IF NOT EXISTS for
-- idempotency + so the migration is self-contained / reproducible on a fresh DB.
-- Populated only when PROOF_DRAIN_RECORD_REAL_FIELDS=true (flag OFF until the Plonky3 pin is
-- deployed + A2/A3 re-verified on the pinned prover).

ALTER TABLE public.repid_zkp_proofs ADD COLUMN IF NOT EXISTS scheme      text;   -- e.g. 'plonky3_range_check' | 'sha256_commitment_poc'
ALTER TABLE public.repid_zkp_proofs ADD COLUMN IF NOT EXISTS proof_bytes text;   -- base64 STARK proof, for client-side WASM verification
ALTER TABLE public.repid_zkp_proofs ADD COLUMN IF NOT EXISTS statement   jsonb;  -- { repid_score, threshold } — the public statement the proof attests

COMMENT ON COLUMN public.repid_zkp_proofs.scheme      IS 'Proving/hash scheme: plonky3_range_check (real BabyBear+Keccak256) | sha256_commitment_poc (legacy stub). NULL on legacy rows. (D-062)';
COMMENT ON COLUMN public.repid_zkp_proofs.proof_bytes IS 'Base64 Plonky3 STARK proof; lets the public surface WASM-verify the stored proof (hyperdag-proof-verifier). NULL on legacy rows. (D-062)';
COMMENT ON COLUMN public.repid_zkp_proofs.statement   IS 'Public statement {repid_score, threshold} the proof attests; required input to WASM verification. NULL on legacy rows. (D-062)';
