-- Migration: dual_band_schema_migration (2026-06-10)
-- 1. Ensure columns exist and have the desired default (additive, IF NOT EXISTS)
ALTER TABLE repid_agents ADD COLUMN IF NOT EXISTS wisdom_score DECIMAL(5, 2) DEFAULT 50.0;
ALTER TABLE repid_agents ADD COLUMN IF NOT EXISTS character_score DECIMAL(5, 2) DEFAULT 50.0;

-- Set defaults for columns in case they already existed with other defaults
ALTER TABLE repid_agents ALTER COLUMN wisdom_score SET DEFAULT 50.0;
ALTER TABLE repid_agents ALTER COLUMN character_score SET DEFAULT 50.0;

-- 2. Drop the old event type constraint and recreate it to include DORMANCY_DECAY and SALE_DROP
ALTER TABLE repid_score_events DROP CONSTRAINT IF EXISTS repid_score_events_event_type_check;

ALTER TABLE repid_score_events ADD CONSTRAINT repid_score_events_event_type_check
CHECK (event_type = ANY (ARRAY[
  'CHALLENGE_WIN', 'CHALLENGE_LOSS', 'CHALLENGE_DRAW', 'EPISTEMIC_VIOLATION',
  'CONSTITUTIONAL_VIOLATION', 'PREDICTION_RESOLVE', 'STAKE', 'GENESIS', 'REFERRAL',
  'PEACEMAKER', 'SELF_MONITOR', 'DECAY', 'DORMANCY_DECAY', 'SALE_DROP', 'MIRROR_TEST_MODE7', 'CONSTITUTIONAL_PASS',
  'CODE_CONTRIBUTION', 'WORKFLOW_CONTRIBUTION', 'TOOL_PIONEER', 'AGENT_TEACHING',
  'AUDIT_CONTRIBUTION', 'CONSTITUTIONAL_AUDIT', 'MCP_TOOL_CALL',
  'LATENCY_OPPORTUNITY_LEARNING', 'BOUNTY_CLAIM', 'BOUNTY_COMPLETE', 'BOUNTY_VERIFY',
  'HAL_SCORE_EVENT', 'PAPER_TRADE_OUTCOME',
  'VALIDATION_PASSED', 'VALIDATION_FAILED', 'VALIDATOR_REWARD', 'VALIDATOR_PENALTY',
  'SERVICE_FULFILLED', 'SERVICE_SATISFIED'
]));

-- 3. Seed default values for active agents that are unseeded (either NULL or 1.0)
UPDATE repid_agents 
SET wisdom_score = 50.0, character_score = 50.0 
WHERE lifecycle_status = 'active' AND (wisdom_score IS NULL OR wisdom_score = 1.0);
