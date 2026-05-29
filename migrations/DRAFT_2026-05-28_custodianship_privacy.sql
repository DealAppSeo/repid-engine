-- ============================================================================
-- DRAFT — DO NOT APPLY. Gated on XC Phase 3 ABI + Sean review [rule:1,2].
-- ============================================================================
-- Sprint 2026-05-28 Phase 2 — privacy migration for agent_custodianship_links.
--
-- PROBLEM (verified [sql:2026-05-28]): agent_custodianship_links keys on
-- plaintext `human_address` (NOT NULL) — this leaks the human identity. The
-- table is dormant (0 rows), so there is NOTHING to back-fill: the migration is
-- additive + a deprecation, no data motion required.
--
-- FIX (per XC_HUMAN_OWNERSHIP_ZKP_DESIGN.md): the authority root becomes a ZK
-- ownership proof + nullifier, not the address. The human is represented only
-- by a Semaphore-style commitment (human_sbt_mints.commitment_hash) and a
-- per-agent scoped nullifier = Poseidon2(identity_nullifier, agentId).
--
-- The new columns mirror XC's OwnershipProofPubSignals public-input ordering so
-- a custodianship link is a verifiable record of an accepted on-chain proof.
--
-- Why two-phase (this draft = phase A only):
--   A. add nullable ZK columns + make human_address nullable (this file).
--   B. (later, separate migration, after the verifier is live) DROP human_address.
--   Splitting avoids a hard breakage if any out-of-repo writer still sets it.
-- ============================================================================

BEGIN;

-- 1. Identity commitment (replaces plaintext human_address as the human ref).
--    References human_sbt_mints.commitment_hash (the Semaphore identity_commitment).
ALTER TABLE agent_custodianship_links
  ADD COLUMN IF NOT EXISTS commitment_ref text;

-- 2. Per-agent scoped nullifier — on-chain anti-double-ownership signal.
--    UNIQUE per (agent, nullifier): the same nullifier cannot bind an agent twice.
ALTER TABLE agent_custodianship_links
  ADD COLUMN IF NOT EXISTS nullifier text;

-- 3. Ownership-proof public inputs (XC OwnershipProofPubSignals indices 0,3,5,6).
--    agentId → existing agent_dbt_id; capabilitiesHash → existing capabilities_hash.
ALTER TABLE agent_custodianship_links
  ADD COLUMN IF NOT EXISTS humans_root text;          -- index 0
ALTER TABLE agent_custodianship_links
  ADD COLUMN IF NOT EXISTS min_authority bigint;      -- index 3
ALTER TABLE agent_custodianship_links
  ADD COLUMN IF NOT EXISTS policy_version integer;    -- index 5
ALTER TABLE agent_custodianship_links
  ADD COLUMN IF NOT EXISTS proof_block_number bigint; -- index 6

-- 4. Pointer to the Groth16 proof (bytes / receipt id / EAS uid).
ALTER TABLE agent_custodianship_links
  ADD COLUMN IF NOT EXISTS ownership_proof_ref text;

-- 5. is_simulated marker (no real proofs yet; sim-only this sprint).
ALTER TABLE agent_custodianship_links
  ADD COLUMN IF NOT EXISTS is_simulated boolean NOT NULL DEFAULT true;

-- 6. Deprecate the plaintext leak — make nullable now; DROP in phase B.
ALTER TABLE agent_custodianship_links
  ALTER COLUMN human_address DROP NOT NULL;

-- 7. Anti-double-ownership uniqueness (per XC: same nullifier+agent invalid).
CREATE UNIQUE INDEX IF NOT EXISTS uq_custodianship_nullifier_agent
  ON agent_custodianship_links (agent_dbt_id, nullifier)
  WHERE nullifier IS NOT NULL;

COMMENT ON COLUMN agent_custodianship_links.human_address IS
  'DEPRECATED 2026-05-28 (privacy leak). Replaced by commitment_ref + nullifier. DROP in phase B once the ownership verifier is live.';
COMMENT ON COLUMN agent_custodianship_links.commitment_ref IS
  'Semaphore identity_commitment = Poseidon2(identity_nullifier, identity_trapdoor); FK-by-value to human_sbt_mints.commitment_hash.';
COMMENT ON COLUMN agent_custodianship_links.nullifier IS
  'Per-agent scoped nullifier = Poseidon2(identity_nullifier, agent). On-chain anti-double-ownership signal.';

COMMIT;

-- ============================================================================
-- PHASE B (FUTURE, separate migration — listed here for review only):
--   ALTER TABLE agent_custodianship_links DROP COLUMN human_address;
--   ALTER TABLE agent_custodianship_links ALTER COLUMN commitment_ref SET NOT NULL;
--   ALTER TABLE agent_custodianship_links ALTER COLUMN nullifier SET NOT NULL;
-- Apply only after: (1) verifier deployed, (2) no out-of-repo writer sets
-- human_address, (3) Sean sign-off.
-- ============================================================================
