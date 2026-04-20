ALTER TABLE repid_agents
ADD COLUMN IF NOT EXISTS enterprise_tier TEXT DEFAULT 'standard',
ADD COLUMN IF NOT EXISTS api_rate_limit INTEGER DEFAULT 100,
ADD COLUMN IF NOT EXISTS dedicated_hal_instance BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS sla_uptime_pct NUMERIC DEFAULT 99.9,
ADD COLUMN IF NOT EXISTS compliance_mode TEXT DEFAULT 'standard',
ADD COLUMN IF NOT EXISTS webhook_url TEXT,
ADD COLUMN IF NOT EXISTS webhook_secret TEXT,
ADD COLUMN IF NOT EXISTS webhook_events TEXT[] DEFAULT '{}';

INSERT INTO repid_config (key, value)
VALUES 
    ('enterprise_api_key', gen_random_uuid()),
    ('max_agents_standard', 10000),
    ('max_agents_enterprise', -1),
    ('hal_batch_size', 100),
    ('proof_batching_enabled', 1)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS repid_proof_queue (
    id BIGSERIAL PRIMARY KEY,
    job_id TEXT UNIQUE NOT NULL,
    agent_id UUID REFERENCES repid_agents(id),
    event_id BIGINT REFERENCES repid_score_events(id),
    status TEXT DEFAULT 'pending',
    proof_hash TEXT,
    proof_size_bytes INTEGER,
    zkp_service_url TEXT,
    attempts INTEGER DEFAULT 0,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
