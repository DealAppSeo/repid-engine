CREATE TABLE IF NOT EXISTS x402_settlement_failures (
  id BIGSERIAL PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  agent_id UUID REFERENCES repid_agents(id),
  payment_payload_b64 TEXT NOT NULL,
  payment_requirements JSONB NOT NULL,
  facilitator_response JSONB,
  attempt_count INT NOT NULL DEFAULT 1,
  last_attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_x402_settlement_failures_unresolved ON x402_settlement_failures (resolved_at) WHERE resolved_at IS NULL;
ALTER TABLE x402_settlement_failures ENABLE ROW LEVEL SECURITY;

-- Service role policy
DROP POLICY IF EXISTS x402_settlement_failures_service_role ON x402_settlement_failures;
CREATE POLICY x402_settlement_failures_service_role ON x402_settlement_failures FOR ALL TO service_role USING (true) WITH CHECK (true);
