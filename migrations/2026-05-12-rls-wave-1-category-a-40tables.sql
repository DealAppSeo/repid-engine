-- ================================================================
-- CC Sprint 8 — RLS Wave 1: Category A backend-only tables (40)
-- 2026-05-12
-- ================================================================
-- Selection criteria (all 40 satisfy ALL):
--   1. In Category A from Sprint 7 inventory (RLS_HARDENING_INVENTORY_2026-05-12.md)
--   2. Zero references in repid-engine/src/ (verified via grep)
--   3. Not in production-smoke.ts touched-table set
--   4. Either zero rows (35 tables — extremely safe) or one-row internal log (5 tables)
--   5. Name pattern matches audit / log / queue / metrics / internal config
--
-- Defensively EXCLUDED from this wave despite matching Category A:
--   - conductor_state (trinity ConstitutionalAgentV4 might use)
--   - semantic_cache (Graph RAG cache target)
--   - indexer_state (receipt-indexer service state)
--   - dbt_registry (has wallet_address, deferred to careful review)
--   - _temp_* tables (should be DROPped, not RLS'd — separate cleanup)
--   - trinity_artifacts / trinity_heartbeat (touched by Sprint 6 view + future swarm wake)
--   - All Category B/C tables (need anon-read or hot-write policies — separate sprints)
--
-- Policy template per table:
--   ALTER TABLE public.<name> ENABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS "<name>_service_role_all" ON public.<name>;
--   CREATE POLICY "<name>_service_role_all" ON public.<name>
--     FOR ALL TO service_role USING (true) WITH CHECK (true);
--
-- service_role bypasses RLS by default in Postgres, so the explicit
-- policy is belt-and-suspenders. Anon and authenticated roles are
-- denied implicitly (no policy → no access).
--
-- Rollback: see migrations/2026-05-12-rls-wave-1-rollback.sql (prepared,
-- NOT applied — Sean's back-pocket).
-- ================================================================

-- ----- Zero-row tables (35) -----

ALTER TABLE public.agent_activity_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_activity_log_service_role_all" ON public.agent_activity_log;
CREATE POLICY "agent_activity_log_service_role_all" ON public.agent_activity_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.agent_performance_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_performance_log_service_role_all" ON public.agent_performance_log;
CREATE POLICY "agent_performance_log_service_role_all" ON public.agent_performance_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.anfis_weight_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anfis_weight_history_service_role_all" ON public.anfis_weight_history;
CREATE POLICY "anfis_weight_history_service_role_all" ON public.anfis_weight_history FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.antigravity_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "antigravity_queue_service_role_all" ON public.antigravity_queue;
CREATE POLICY "antigravity_queue_service_role_all" ON public.antigravity_queue FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.antigravity_stage_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "antigravity_stage_log_service_role_all" ON public.antigravity_stage_log;
CREATE POLICY "antigravity_stage_log_service_role_all" ON public.antigravity_stage_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.ats_sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ats_sync_log_service_role_all" ON public.ats_sync_log;
CREATE POLICY "ats_sync_log_service_role_all" ON public.ats_sync_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.bubble_migration_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bubble_migration_events_service_role_all" ON public.bubble_migration_events;
CREATE POLICY "bubble_migration_events_service_role_all" ON public.bubble_migration_events FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.debug_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "debug_log_service_role_all" ON public.debug_log;
CREATE POLICY "debug_log_service_role_all" ON public.debug_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.divergence_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "divergence_metrics_service_role_all" ON public.divergence_metrics;
CREATE POLICY "divergence_metrics_service_role_all" ON public.divergence_metrics FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.energy_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "energy_log_service_role_all" ON public.energy_log;
CREATE POLICY "energy_log_service_role_all" ON public.energy_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.hal_ablation_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hal_ablation_results_service_role_all" ON public.hal_ablation_results;
CREATE POLICY "hal_ablation_results_service_role_all" ON public.hal_ablation_results FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.hal_benchmark_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hal_benchmark_results_service_role_all" ON public.hal_benchmark_results;
CREATE POLICY "hal_benchmark_results_service_role_all" ON public.hal_benchmark_results FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.hal_outbreak_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hal_outbreak_events_service_role_all" ON public.hal_outbreak_events;
CREATE POLICY "hal_outbreak_events_service_role_all" ON public.hal_outbreak_events FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.hal_snapshot_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hal_snapshot_registry_service_role_all" ON public.hal_snapshot_registry;
CREATE POLICY "hal_snapshot_registry_service_role_all" ON public.hal_snapshot_registry FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.hal_veto_test_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hal_veto_test_results_service_role_all" ON public.hal_veto_test_results;
CREATE POLICY "hal_veto_test_results_service_role_all" ON public.hal_veto_test_results FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.hallucination_test_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hallucination_test_log_service_role_all" ON public.hallucination_test_log;
CREATE POLICY "hallucination_test_log_service_role_all" ON public.hallucination_test_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.hitl_hunch_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hitl_hunch_log_service_role_all" ON public.hitl_hunch_log;
CREATE POLICY "hitl_hunch_log_service_role_all" ON public.hitl_hunch_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.institution_config_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "institution_config_audit_log_service_role_all" ON public.institution_config_audit_log;
CREATE POLICY "institution_config_audit_log_service_role_all" ON public.institution_config_audit_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.moderation_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "moderation_queue_service_role_all" ON public.moderation_queue;
CREATE POLICY "moderation_queue_service_role_all" ON public.moderation_queue FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.product_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "product_metrics_service_role_all" ON public.product_metrics;
CREATE POLICY "product_metrics_service_role_all" ON public.product_metrics FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.productivity_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "productivity_ledger_service_role_all" ON public.productivity_ledger;
CREATE POLICY "productivity_ledger_service_role_all" ON public.productivity_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.repid_confession_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "repid_confession_log_service_role_all" ON public.repid_confession_log;
CREATE POLICY "repid_confession_log_service_role_all" ON public.repid_confession_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.repid_dual_sig_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "repid_dual_sig_log_service_role_all" ON public.repid_dual_sig_log;
CREATE POLICY "repid_dual_sig_log_service_role_all" ON public.repid_dual_sig_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.repid_jubilee_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "repid_jubilee_log_service_role_all" ON public.repid_jubilee_log;
CREATE POLICY "repid_jubilee_log_service_role_all" ON public.repid_jubilee_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.repid_vesting_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "repid_vesting_events_service_role_all" ON public.repid_vesting_events;
CREATE POLICY "repid_vesting_events_service_role_all" ON public.repid_vesting_events FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.signal_accuracy_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "signal_accuracy_log_service_role_all" ON public.signal_accuracy_log;
CREATE POLICY "signal_accuracy_log_service_role_all" ON public.signal_accuracy_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.sync_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sync_queue_service_role_all" ON public.sync_queue;
CREATE POLICY "sync_queue_service_role_all" ON public.sync_queue FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.system_learning_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "system_learning_log_service_role_all" ON public.system_learning_log;
CREATE POLICY "system_learning_log_service_role_all" ON public.system_learning_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.token_issuance_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "token_issuance_log_service_role_all" ON public.token_issuance_log;
CREATE POLICY "token_issuance_log_service_role_all" ON public.token_issuance_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.trinity_mcp_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trinity_mcp_events_service_role_all" ON public.trinity_mcp_events;
CREATE POLICY "trinity_mcp_events_service_role_all" ON public.trinity_mcp_events FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.trinity_service_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trinity_service_registry_service_role_all" ON public.trinity_service_registry;
CREATE POLICY "trinity_service_registry_service_role_all" ON public.trinity_service_registry FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.trinity_system_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trinity_system_metrics_service_role_all" ON public.trinity_system_metrics;
CREATE POLICY "trinity_system_metrics_service_role_all" ON public.trinity_system_metrics FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.trusthealth_veto_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trusthealth_veto_log_service_role_all" ON public.trusthealth_veto_log;
CREATE POLICY "trusthealth_veto_log_service_role_all" ON public.trusthealth_veto_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.trustrepid_challenge_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trustrepid_challenge_ledger_service_role_all" ON public.trustrepid_challenge_ledger;
CREATE POLICY "trustrepid_challenge_ledger_service_role_all" ON public.trustrepid_challenge_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.velocity_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "velocity_metrics_service_role_all" ON public.velocity_metrics;
CREATE POLICY "velocity_metrics_service_role_all" ON public.velocity_metrics FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ----- One-row internal logs (5) -----

ALTER TABLE public.claude_session_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "claude_session_log_service_role_all" ON public.claude_session_log;
CREATE POLICY "claude_session_log_service_role_all" ON public.claude_session_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.execution_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "execution_log_service_role_all" ON public.execution_log;
CREATE POLICY "execution_log_service_role_all" ON public.execution_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.repid_referendum_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "repid_referendum_log_service_role_all" ON public.repid_referendum_log;
CREATE POLICY "repid_referendum_log_service_role_all" ON public.repid_referendum_log FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.signal_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "signal_events_service_role_all" ON public.signal_events;
CREATE POLICY "signal_events_service_role_all" ON public.signal_events FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.trust_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trust_events_service_role_all" ON public.trust_events;
CREATE POLICY "trust_events_service_role_all" ON public.trust_events FOR ALL TO service_role USING (true) WITH CHECK (true);
