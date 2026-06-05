-- Phase 3: zkp_routing_config staged (Sean co-sign via apply_migration)
-- Reconciled 1:1 with ZKP_ROUTING_ARCHITECTURE.md and ZKP_TIERING_DECISION (from sprint):
-- postcard = signatures/EAS (fast path, high-freq low-stakes like RepID/identity)
-- envelope = Groth16 (on-chain leaf, for on-chain verification)
-- package = zkVM/Plonky3-engine (off-chain, wrapped to Groth16) -- ROADMAP, not raw-Plonky3-on-chain.
-- Wire /zkp/route (in proof-router.ts + mvp-api.ts) already logs the fast/heavy split per proof (console + decision).
-- Schema-first: see src/types/database.types.ts for zkp_routing_config (or previous migration).

-- (Include the CREATE TABLE from 2026-06-03-zkp-routing-config.sql for completeness if needed)
-- Seed reconciled:

INSERT INTO zkp_routing_config (proof_type, active, zkp_system, sensitivity, frequency, regulatory_tag, pre_stageable, description) VALUES
('POSTCARD', true, 'fast_groth16', 0.3, 'normal', 'identity', true, 'Tier promotion / RepID threshold / signatures / EAS -- fast (postcard = signatures/EAS per doc)'),
('ENVELOPE', true, 'fast_groth16', 0.6, 'normal', 'compliance', true, 'Envelope proofs -- Groth16 on-chain leaf (per tiering decision; on-chain verification)'),
('PACKAGE', true, 'plonky3_stark', 0.9, 'high', 'regulatory', false, 'Full package -- zkVM/Plonky3-engine off-chain wrapped to Groth16 (ROADMAP, not raw on-chain per doc)'),
('trade_auth', true, 'fast_groth16', 0.4, 'normal', NULL, true, 'Trade auth from router (fast)'),
('reputation', true, 'fast_groth16', 0.6, 'normal', 'compliance', false, 'Reputation related (fast)')
ON CONFLICT (proof_type) DO UPDATE SET
  zkp_system = EXCLUDED.zkp_system,
  sensitivity = EXCLUDED.sensitivity,
  frequency = EXCLUDED.frequency,
  regulatory_tag = EXCLUDED.regulatory_tag,
  pre_stageable = EXCLUDED.pre_stageable,
  description = EXCLUDED.description,
  updated_at = NOW();

-- Config <-> doc map (1:1) per public ZKP_ROUTING_ARCHITECTURE.md (E:\dev\living-docs\ZKP_ROUTING_ARCHITECTURE.md) AND ZKP_TIERING_DECISION (per sprint):
-- POSTCARD <-> Fast Groth16+Poseidon2 (high-freq low-stakes: RepID thresholds, agent identity, peer verification signatures, task attestations per doc "What Goes Where" table rows 1-4 + "Fast Path" section); signatures/EAS per sprint mapping.
-- ENVELOPE <-> Groth16 (on-chain leaf for on-chain verification/compliance) per sprint ZKP_TIERING_DECISION (doc implies on-chain for certain envelopes; "The Router" classify + security model).
-- PACKAGE <-> zkVM/Plonky3-engine (off-chain, wrapped to Groth16 for Merkle anchor; pre-staging for regulatory like HIPAA/SOX per doc rows 7+ + "Heavy Path" + "Pre-staging" sections) -- ROADMAP, not raw-Plonky3-on-chain per sprint.
-- See full doc: E:\dev\living-docs\ZKP_ROUTING_ARCHITECTURE.md sections "Two ZKP Systems, One Router", "What Goes Where" table, "The Router" (sensitivity/freq/reg tag classify + pre-staging), "Pre-staging: Making Heavy Proofs Feel Instant", "Security Model (Fast vs Heavy)", "Integration With Existing Stack".
-- ZKP_TIERING_DECISION explicit from sprint: postcard = signatures/EAS · envelope = Groth16 (on-chain leaf) · package = zkVM/Plonky3-engine (off-chain, wrapped to Groth16) — ROADMAP, not raw-Plonky3-on-chain.
-- Matches doc "Right Tool for the Right Job" + router logic in proof-router.ts (sens >0.7 or reg or high freq -> heavy).

-- Logging wired: proof-router.ts:46 console.log(`[ZKP Router] ${proofType} -> ${route_to} ...`); mvp-api /zkp/route returns the decision per proof request (already logs fast/heavy split).
-- Add DB log if table exists (e.g. zkp_routing_log).

-- Apply via Sean co-sign. Verify schema first (types or information_schema.columns for zkp_routing_config).