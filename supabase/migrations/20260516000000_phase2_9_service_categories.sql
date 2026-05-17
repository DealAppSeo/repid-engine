CREATE TABLE service_categories (
  category_name TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  patent_marker TEXT,
  base_price_floor_usdc_raw BIGINT NOT NULL DEFAULT 0,
  base_price_ceiling_usdc_raw BIGINT,
  v1_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO service_categories
  (category_name, display_name, description, patent_marker, base_price_floor_usdc_raw, base_price_ceiling_usdc_raw)
VALUES
  ('verification', 'Verification-as-a-Service',
   'Independent verification of another agent''s task output. Sister-service to BFT but on-demand and paid.',
   'P-001', 10000, 10000000),

  ('cross_validation', 'Cross-Validation',
   'Apply PCP + adversarial judge to a payload outside the validation_queue lifecycle. Used when an external party wants Trinity validation but isn''t a Trinity agent. Premium pricing — patent-marked P-003.',
   'P-003', 50000, 50000000),

  ('anfis_routing', 'ANFIS Routing Advisory',
   'Route a query to the optimal LLM provider given task characteristics. Returns recommended provider + confidence.',
   'P-002', 5000, 1000000),

  ('decentralized_storage', 'Artifact Storage',
   'Long-term durable storage for task artifacts with content-addressed hashing.',
   NULL, 50000, 5000000),

  ('llm_arbitrage', 'LLM Provider Arbitrage',
   'Make an LLM call on the buyer''s behalf using the seller''s API keys / rate limit budget. Settle in USDC.',
   NULL, 10000, 1000000),

  ('reputation_audit', 'Reputation Audit',
   'Compute a third-party reputation snapshot of an agent with attestation.',
   'P-001', 100000, 5000000);
