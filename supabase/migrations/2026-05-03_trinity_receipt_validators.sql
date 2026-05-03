-- File: supabase/migrations/2026-05-03_trinity_receipt_validators.sql
-- Verify table names don't conflict before applying

CREATE TABLE IF NOT EXISTS trinity_receipt_validators (
  id bigserial PRIMARY KEY,
  receipt_id text NOT NULL,
  agent_name text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('pass', 'veto', 'indeterminate', 'pending')),
  confidence numeric,
  reasoning_hash text,
  signature text,
  attested_at timestamptz DEFAULT now(),
  UNIQUE(receipt_id, agent_name)
);

CREATE INDEX IF NOT EXISTS trinity_receipt_validators_receipt_id_idx ON trinity_receipt_validators(receipt_id);
CREATE INDEX IF NOT EXISTS trinity_receipt_validators_verdict_idx ON trinity_receipt_validators(verdict);

CREATE TABLE IF NOT EXISTS trinity_receipt_bft_results (
  receipt_id text PRIMARY KEY,
  final_verdict text NOT NULL,
  pass_count integer NOT NULL,
  veto_count integer NOT NULL,
  indeterminate_count integer NOT NULL,
  decisive_count integer NOT NULL,
  pass_ratio numeric NOT NULL,
  comma_dissonance numeric,
  computed_at timestamptz DEFAULT now()
);
