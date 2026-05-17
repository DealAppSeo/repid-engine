CREATE TABLE service_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES agent_services(id),
  buyer_agent_id UUID NOT NULL REFERENCES repid_agents(id),
  provider_agent_id UUID NOT NULL REFERENCES repid_agents(id),
  agreed_price_usdc_raw BIGINT NOT NULL CHECK (agreed_price_usdc_raw > 0),

  payload JSONB NOT NULL,
  result JSONB,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'escrowed',
      'fulfilled',
      'satisfied',
      'settled',
      'disputed',
      'resolved',
      'expired',
      'cancelled'
    )),

  x402_payment_id UUID REFERENCES x402_settlements(id),

  buyer_satisfaction_score NUMERIC CHECK (buyer_satisfaction_score IS NULL OR (buyer_satisfaction_score >= 0 AND buyer_satisfaction_score <= 1)),

  dispute_panel_validation_queue_id UUID REFERENCES validation_queue(id),
  dispute_verdict TEXT
    CHECK (dispute_verdict IS NULL OR dispute_verdict IN ('provider_at_fault', 'buyer_at_fault', 'no_fault')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  escrowed_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ,
  satisfied_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  disputed_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_service_contracts_buyer ON service_contracts(buyer_agent_id);
CREATE INDEX idx_service_contracts_provider ON service_contracts(provider_agent_id);
CREATE INDEX idx_service_contracts_status ON service_contracts(status);
CREATE INDEX idx_service_contracts_expires ON service_contracts(expires_at)
  WHERE status IN ('pending', 'escrowed');
CREATE INDEX idx_service_contracts_provider_pending
  ON service_contracts(provider_agent_id, status)
  WHERE status = 'escrowed';

CREATE OR REPLACE FUNCTION enforce_service_contract_status_transition()
RETURNS TRIGGER AS $$
DECLARE
  valid_transition BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('pending', 'cancelled') THEN
      RAISE EXCEPTION 'service_contracts INSERT must be status=pending or cancelled, got %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;

  valid_transition := CASE OLD.status
    WHEN 'pending'    THEN NEW.status IN ('pending', 'escrowed', 'expired', 'cancelled')
    WHEN 'escrowed'   THEN NEW.status IN ('escrowed', 'fulfilled', 'disputed', 'expired')
    WHEN 'fulfilled'  THEN NEW.status IN ('fulfilled', 'satisfied', 'disputed')
    WHEN 'satisfied'  THEN NEW.status IN ('satisfied', 'settled')
    WHEN 'settled'    THEN FALSE
    WHEN 'disputed'   THEN NEW.status IN ('disputed', 'resolved')
    WHEN 'resolved'   THEN FALSE
    WHEN 'expired'    THEN FALSE
    WHEN 'cancelled'  THEN FALSE
    ELSE FALSE
  END;

  IF NOT valid_transition THEN
    RAISE EXCEPTION 'Invalid service_contracts status transition: % → %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_service_contracts_status_transition
  BEFORE INSERT OR UPDATE ON service_contracts
  FOR EACH ROW EXECUTE FUNCTION enforce_service_contract_status_transition();
