CREATE TABLE IF NOT EXISTS validation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  validator_agent_id TEXT,
  target_agent_id TEXT,
  request_hash TEXT,
  response_hash TEXT,
  tx_hash TEXT,
  basescan_url TEXT,
  validated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);
