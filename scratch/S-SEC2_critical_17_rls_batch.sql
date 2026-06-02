-- S-SEC2: RLS Critical-17 Batch (Roadmap S-SEC2)
-- DESIGN ONLY — Sean applies with Cowork co-sign after CC verification
-- Date: 2026-05-30
-- Tables: 16 CRITICAL (from RLS_242_DISABLED_TABLES.md) + repid_score_events
-- Policy: service_role only (broad access for backend). No anon, no authenticated by default.
-- Rationale: These tables are the primary F2 forgery surface (stakes, credentials, SBTs, x402 activity, RepID event log).

BEGIN;

-- 1. confidence_stakes
ALTER TABLE confidence_stakes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON confidence_stakes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 2. erc8004_data_packets
ALTER TABLE erc8004_data_packets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON erc8004_data_packets
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 3. erc8004_data_tiers
ALTER TABLE erc8004_data_tiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON erc8004_data_tiers
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 4. human_sbt_mints
ALTER TABLE human_sbt_mints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON human_sbt_mints
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 5. human_sbt_registry
ALTER TABLE human_sbt_registry ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON human_sbt_registry
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 6. permissioned_vaults
ALTER TABLE permissioned_vaults ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON permissioned_vaults
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 7. repid_agent_stakes
ALTER TABLE repid_agent_stakes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON repid_agent_stakes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 8. repid_credentials
ALTER TABLE repid_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON repid_credentials
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 9. repid_stakes
ALTER TABLE repid_stakes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON repid_stakes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 10. stake_authority_snapshots
ALTER TABLE stake_authority_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON stake_authority_snapshots
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 11. task_verification_stakes
ALTER TABLE task_verification_stakes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON task_verification_stakes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 12. trinity_dbt_sbt_pipeline
ALTER TABLE trinity_dbt_sbt_pipeline ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON trinity_dbt_sbt_pipeline
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 13. trustex_rep_stakes
ALTER TABLE trustex_rep_stakes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON trustex_rep_stakes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 14. trustshell_agent_sbt
ALTER TABLE trustshell_agent_sbt ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON trustshell_agent_sbt
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 15. vault_access_log
ALTER TABLE vault_access_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON vault_access_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 16. x402_log
ALTER TABLE x402_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON x402_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 17. repid_score_events (F2 high-value RepID history)
ALTER TABLE repid_score_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON repid_score_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;

-- Notes for applier:
-- - Run in a transaction where possible.
-- - After apply, immediately run the verification queries below as anon, authenticated, and service_role.
-- - If any legitimate service breaks, the rollback is: ALTER TABLE <name> DISABLE ROW LEVEL SECURITY; for the affected table(s).