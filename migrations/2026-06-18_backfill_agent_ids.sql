-- XC Sprint 2026-06-18 — metadata backfill ONLY (identity ≠ runtime).
-- Sets agent_id = agent_name for 10 Trinity agents with NULL agent_id.
-- Does NOT start Railway services or poll loops.
-- Tier safety: trg_sync_tier fires ONLY on UPDATE OF current_repid (verified pg_trigger).

-- ROLLBACK (Sean, if needed):
-- UPDATE repid_agents SET agent_id = NULL
-- WHERE agent_name IN (
--   'trinity-torch','trinity-nexus','trinity-hdm','trinity-gcm','trinity-apm',
--   'trinity-w3c','trinity-chesed','trinity-shofet','trinity-veritas','trinity-orch'
-- ) AND agent_id = agent_name;

BEGIN;

UPDATE repid_agents
   SET agent_id = agent_name
 WHERE agent_name IN (
   'trinity-torch',
   'trinity-nexus',
   'trinity-hdm',
   'trinity-gcm',
   'trinity-apm',
   'trinity-w3c',
   'trinity-chesed',
   'trinity-shofet',
   'trinity-veritas',
   'trinity-orch'
 )
   AND agent_id IS NULL;

-- Verify (read-only sanity — do not fail migration if counts differ in drift env)
DO $$
DECLARE
  v_set int;
  v_expected int := 10;
BEGIN
  GET DIAGNOSTICS v_set = ROW_COUNT;
  RAISE NOTICE 'agent_id backfill: % rows updated (expected %)', v_set, v_expected;
END $$;

COMMIT;