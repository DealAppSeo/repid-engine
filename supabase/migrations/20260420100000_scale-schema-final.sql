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
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_proof_queue_status
ON repid_proof_queue(status, created_at);

CREATE TABLE IF NOT EXISTS repid_dual_sig_log (
  id BIGSERIAL PRIMARY KEY,
  change_type TEXT NOT NULL,
  parameter_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  proposed_at TIMESTAMPTZ DEFAULT NOW(),
  ceo_approved_at TIMESTAMPTZ,
  cto_approved_at TIMESTAMPTZ,
  ceo_agent_id UUID REFERENCES repid_agents(id),
  cto_agent_id UUID REFERENCES repid_agents(id),
  status TEXT DEFAULT 'pending',
  proof_hash TEXT,
  executed_at TIMESTAMPTZ
);

ALTER TABLE repid_agents
ADD COLUMN IF NOT EXISTS webhook_url TEXT,
ADD COLUMN IF NOT EXISTS webhook_secret TEXT,
ADD COLUMN IF NOT EXISTS webhook_events TEXT[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS api_rate_limit INTEGER DEFAULT 100,
ADD COLUMN IF NOT EXISTS sla_uptime_pct NUMERIC DEFAULT 99.9,
ADD COLUMN IF NOT EXISTS enterprise_tier TEXT DEFAULT 'standard',
ADD COLUMN IF NOT EXISTS compliance_mode TEXT DEFAULT 'standard',
ADD COLUMN IF NOT EXISTS dedicated_hal_instance BOOLEAN DEFAULT FALSE;

DROP VIEW IF EXISTS repid_standings;
DROP VIEW IF EXISTS repid_config_view;

ALTER TABLE repid_config ALTER COLUMN value TYPE text USING value::text;

CREATE OR REPLACE VIEW repid_config_view AS
 SELECT key,
    value,
    min_value,
    max_value,
        CASE
            WHEN conductor_tunable THEN 'Conductor can change'::text
            WHEN requires_vote THEN 'Needs 3-agent vote'::text
            WHEN auto_tunable THEN 'System auto-adjusts'::text
            ELSE 'Fixed'::text
        END AS change_method,
    description
   FROM repid_config
  ORDER BY key;

CREATE OR REPLACE VIEW repid_standings AS
 SELECT agent_name,
    repid_score,
    tier,
    challenges_today,
    ((( SELECT repid_config.value
           FROM repid_config
          WHERE (repid_config.key = 'free_challenges_per_day'::text)))::integer - challenges_today) AS free_left,
    total_challenges_made,
    total_challenges_correct,
        CASE
            WHEN (total_challenges_made > 0) THEN round(((100.0 * (total_challenges_correct)::numeric) / (total_challenges_made)::numeric), 1)
            ELSE NULL::numeric
        END AS accuracy_pct,
    total_times_challenged,
    total_times_vindicated,
    conductor_sessions,
    last_activity
   FROM agent_repid
  ORDER BY repid_score DESC;

INSERT INTO repid_config (key, value, description, requires_vote)
VALUES
('hal_veto_threshold', '0.25',
  'General agent HAL veto threshold', false),
('bft_veto_threshold', '0.0195',
  'TrustTrader BFT veto (Pythagorean Comma)', false),
('hal_block_threshold', '0.48',
  'Constitutional block — always vetoed', false),
('enterprise_api_key', gen_random_uuid()::text,
  'Enterprise bypass key for rate limits', false),
('max_agents_standard', '10000',
  'Max agents on standard tier', true),
('proof_batching_enabled', 'true',
  'Async Plonky3 proof batching', true),
('tgn_confidence_threshold', '0.6',
  'Min TGN confidence before using embeddings', true),
('tgn_bootstrap_events', '50',
  'Events needed before full TGN activation', false),
('wisdom_bootstrap_label', 'true',
  'Show bootstrapping mode label in API', false)
ON CONFLICT (key) DO NOTHING;
