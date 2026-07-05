-- EAS anchor batch audit table (feat/cc-2026-07-04-eas-anchor-worker)
-- ============================================================================
-- Net-new, additive object. Does NOT touch repid_zkp_proofs or any existing
-- table. UNAPPLIED — Sean applies via apply_migration / Supabase SQL editor
-- before enabling the eas-anchor-worker.
--
-- PURPOSE: one durable audit row per EAS anchor batch, so that a merkle-root
-- inclusion proof for any anchored proof is reconstructable after the fact
-- (XC red-team / verify-back). The worker writes the proofs' eas_attestation_uid
-- back onto repid_zkp_proofs (that is the liveness signal system_liveness_v
-- reads); THIS table records the batch → root → tx → uid mapping + the exact
-- id range the batch covered, which the per-proof column does not capture.
--
-- Reconstruct an inclusion proof:
--   1. SELECT proof_id_min, proof_id_max, proof_count, merkle_root, hash_scheme
--        FROM eas_anchor_batches WHERE eas_uid = <uid>;
--   2. re-select the SAME rows the batch covered (is_real, un-anchored-at-batch-time
--      set is captured by the id range + the recorded proof_ids array), rebuild the
--      merkle tree with hash_scheme, and confirm it reproduces merkle_root.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.eas_anchor_batches (
  batch_id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  merkle_root    text        NOT NULL,
  hash_scheme    text        NOT NULL DEFAULT 'keccak256',
  tx_hash        text,                 -- NULL until on-chain send lands (Sean/worker)
  eas_uid        text,                 -- attestation UID from the Attested event
  eas_schema     text,                 -- schema label used for the attestation
  proof_id_min   bigint      NOT NULL, -- min repid_zkp_proofs.id in the batch
  proof_id_max   bigint      NOT NULL, -- max repid_zkp_proofs.id in the batch
  proof_count    integer     NOT NULL, -- rows covered by this batch
  proof_ids      bigint[]    NOT NULL, -- exact ids (order = merkle leaf order)
  status         text        NOT NULL DEFAULT 'anchored'
                 CHECK (status IN ('anchored','deferred','failed')),
  error          text,                 -- populated when status='failed'
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Lookups by uid (verify-back) and by id-range (coverage checks).
CREATE INDEX IF NOT EXISTS idx_eas_anchor_batches_eas_uid
  ON public.eas_anchor_batches (eas_uid);
CREATE INDEX IF NOT EXISTS idx_eas_anchor_batches_id_range
  ON public.eas_anchor_batches (proof_id_min, proof_id_max);
CREATE INDEX IF NOT EXISTS idx_eas_anchor_batches_created_at
  ON public.eas_anchor_batches (created_at DESC);

-- RLS: this project runs 100% RLS-on (STATE_OF_THE_SYSTEM). Enable + restrict to
-- service_role/owner only (the engine writes via service key). No anon/authenticated.
ALTER TABLE public.eas_anchor_batches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.eas_anchor_batches FROM anon, authenticated;
GRANT ALL ON public.eas_anchor_batches TO service_role;

-- (No permissive policy for anon/authenticated is created by design — RLS-on with
--  no policy denies those roles; service_role bypasses RLS.)
