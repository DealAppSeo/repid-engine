-- C-1 RepID active gate SHADOW LOG. DRAFT — apply is Tier-2 (XC). The gate writes here in shadow
-- mode (REPID_ACTIVE_GATE_MODE=shadow, the default); enforcement (enforce) is held on GA-D evidence.
-- Until applied, logGateShadow() falls back to trinity_agent_logs (event_type='repid_gate_shadow').
CREATE TABLE IF NOT EXISTS repid_gate_shadow_log (
  id                   bigserial PRIMARY KEY,
  agent_id             text NOT NULL,
  mode                 text NOT NULL DEFAULT 'shadow',
  tier                 text,
  repid                integer,
  claim_limit          integer,
  reward_scale         real,
  quarantine_candidate boolean,
  would_allow_claim    boolean,
  context              jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_repid_gate_shadow_agent ON repid_gate_shadow_log (agent_id, created_at DESC);
