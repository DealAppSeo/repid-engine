CREATE TABLE reputation_attestations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_contract_id UUID NOT NULL REFERENCES service_contracts(id),
  subject_agent_id UUID NOT NULL REFERENCES repid_agents(id),
  attester_agent_id UUID NOT NULL REFERENCES repid_agents(id),

  -- Snapshot at attestation time
  current_repid_snapshot INTEGER NOT NULL,
  tier_snapshot TEXT NOT NULL,
  validation_count_snapshot INTEGER NOT NULL,
  validations_correct_snapshot INTEGER NOT NULL,
  vdr_count_snapshot INTEGER NOT NULL,
  wisdom_score_snapshot NUMERIC,
  character_score_snapshot INTEGER,

  -- Cryptographic attestation
  attestation_payload JSONB NOT NULL,  -- canonical signed payload
  signature TEXT NOT NULL,             -- EIP-712 or equivalent
  signing_address TEXT NOT NULL,
  zkp_proof_id UUID,                   -- nullable — links to ZKP record if generated

  -- Audit
  patent_marker TEXT NOT NULL DEFAULT 'P-001',  -- SBFA reduction-to-practice
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_reputation_attestations_subject ON reputation_attestations(subject_agent_id);
CREATE INDEX idx_reputation_attestations_attester ON reputation_attestations(attester_agent_id);
CREATE INDEX idx_reputation_attestations_active
  ON reputation_attestations(subject_agent_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_reputation_attestations_signature ON reputation_attestations(signature);
