-- Migration: Agent Registry Hygiene & Soft-Retirement
-- Date: 2026-05-22
-- Author: Sean / Gemini

-- Add lifecycle_status column for soft-retirement
ALTER TABLE repid_agents 
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT 
  DEFAULT 'active' 
  CHECK (lifecycle_status IN ('active', 'deprecated', 'archived', 'test_only'));

ALTER TABLE repid_agents 
  ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ;

ALTER TABLE repid_agents 
  ADD COLUMN IF NOT EXISTS deprecation_reason TEXT;

-- Mark RAVEN as deprecated (replaced by NEXUS per Day-3 canon)
UPDATE repid_agents 
SET 
  lifecycle_status = 'deprecated',
  deprecated_at = NOW(),
  deprecation_reason = 'Replaced by NEXUS in Trinity 12; ARGUS is the Tier-1 BFT validator. Per Day-3 canon 2026-05-21.'
WHERE agent_name = 'RAVEN';

-- Mark all smoke/test/sybil pollution as test_only (excluded from production queries)
UPDATE repid_agents
SET lifecycle_status = 'test_only'
WHERE 
  agent_name LIKE 'smoke%'
  OR agent_name LIKE 'test_integration_%'
  OR agent_name LIKE 'CC%-INT-%'
  OR agent_name LIKE 'HalTester%'
  OR agent_name LIKE 'SYBIL_%'
  OR agent_name LIKE 'trinity-mock-%'
  OR agent_name LIKE 'mock-%'
  OR agent_name LIKE 'trinity-z2 smoke%'
  OR agent_name LIKE '%-smoke%'
  OR agent_name LIKE 'A7SmokeTest'
  OR agent_name LIKE 'OldStyleAgentSmokeA5'
  OR agent_name LIKE 'ProdA7E2E'
  OR agent_name LIKE 'ProdSmokeAgent%'
  OR agent_name LIKE 'ProdSmokeOldStyle%'
  OR agent_name LIKE 'Test_Agent_VDR_%'
  OR agent_name LIKE 'phase-n-external-%'
  OR agent_name LIKE 'MayaCC1Test'
  OR agent_name LIKE 'dry_run_agent'
  OR agent_name LIKE 'my_production_test_agent'
  OR agent_name LIKE 'test-agent-v11';

-- Add index for fast filtering
CREATE INDEX IF NOT EXISTS idx_repid_agents_lifecycle 
  ON repid_agents(lifecycle_status) 
  WHERE lifecycle_status != 'active';
