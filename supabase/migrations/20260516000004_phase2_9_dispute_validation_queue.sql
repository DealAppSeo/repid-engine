CREATE TABLE dispute_validation_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES service_contracts(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
  worker_verdict TEXT
    CHECK (worker_verdict IS NULL OR worker_verdict IN (
      'provider_at_fault', 'buyer_at_fault', 'no_fault', 'escalated'
    )),
  validator_agents TEXT[],
  pcp_score NUMERIC,
  judge_verdict TEXT,
  judge_confidence NUMERIC,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX idx_dispute_validation_queue_status ON dispute_validation_queue(status);
CREATE INDEX idx_dispute_validation_queue_contract ON dispute_validation_queue(contract_id);
