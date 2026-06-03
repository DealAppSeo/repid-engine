-- S-ONCHAIN Phase 3: zkp_routing_config table for V1.4 ZKP routing (fast Groth16+Poseidon2 vs heavy Plonky3 STARK)
-- Per ZKP_ROUTING_ARCHITECTURE (sensitivity, frequency, regulatory tag).
-- DDL staged; apply via apply_migration (Sean co-sign for on-chain related if any).
-- Verify no DML until schema applied.

CREATE TABLE IF NOT EXISTS zkp_routing_config (
  id BIGSERIAL PRIMARY KEY,
  proof_type TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT true,
  zkp_system TEXT NOT NULL DEFAULT 'fast_groth16', -- 'fast_groth16' or 'plonky3_stark' or 'hash'
  fast_path TEXT, -- for explicit
  heavy_path TEXT,
  sensitivity NUMERIC(3,2) DEFAULT 0.5,
  frequency TEXT DEFAULT 'normal',
  regulatory_tag TEXT,
  pre_stageable BOOLEAN DEFAULT false,
  max_frequency_per_day INTEGER,
  avg_proof_time_ms INTEGER,
  gas_cost_estimate NUMERIC(10,4),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed initial routing rules (idempotent)
INSERT INTO zkp_routing_config (proof_type, active, zkp_system, sensitivity, frequency, regulatory_tag, pre_stageable, description) VALUES
('POSTCARD', true, 'fast_groth16', 0.3, 'normal', 'identity', true, 'Tier promotion / RepID threshold proofs - fast by default'),
('ENVELOPE', true, 'plonky3_stark', 0.7, 'normal', 'compliance', false, 'Higher sensitivity proofs - prefer heavy for assurance'),
('PACKAGE', true, 'plonky3_stark', 0.9, 'high', 'regulatory', false, 'Full package - heavy path for regulatory'),
('trade_auth', true, 'fast_groth16', 0.4, 'normal', NULL, true, 'Trade auth from router'),
('reputation', true, 'fast_groth16', 0.6, 'normal', 'compliance', false, 'Reputation related')
ON CONFLICT (proof_type) DO UPDATE SET
  active = EXCLUDED.active,
  zkp_system = EXCLUDED.zkp_system,
  sensitivity = EXCLUDED.sensitivity,
  frequency = EXCLUDED.frequency,
  regulatory_tag = EXCLUDED.regulatory_tag,
  pre_stageable = EXCLUDED.pre_stageable,
  description = EXCLUDED.description,
  updated_at = NOW();

-- Note: the router (in mvp-api or proof-router) will query this and log the decision (fast/heavy) per proof request.
-- Add index for hot path
CREATE INDEX IF NOT EXISTS idx_zkp_routing_config_active_type ON zkp_routing_config (active, proof_type);