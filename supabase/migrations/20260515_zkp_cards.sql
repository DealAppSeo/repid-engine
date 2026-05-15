CREATE TABLE zkp_cards (
  card_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  agent_repid NUMERIC NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('task_completion','substance_gate_fire','constitutional_refusal')),
  task_id BIGINT REFERENCES trinity_tasks(id),
  task_title TEXT,
  zkp_proof_hash TEXT,
  on_chain_tx_hash TEXT,
  verification_url TEXT NOT NULL,
  card_created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX zkp_cards_agent_idx ON zkp_cards(agent_name);
CREATE INDEX zkp_cards_event_type_idx ON zkp_cards(event_type);
CREATE INDEX zkp_cards_created_idx ON zkp_cards(card_created_at DESC);
