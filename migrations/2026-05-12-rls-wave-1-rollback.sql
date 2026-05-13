-- ================================================================
-- CC Sprint 8 — RLS Wave 1 ROLLBACK
-- 2026-05-12
-- ================================================================
-- DO NOT APPLY unless rolling back cc_sprint_8_rls_wave_1_category_a_40tables_2026_05_12.
-- Sean's back-pocket if Wave 1 RLS causes any production smoke regression.
--
-- Disables RLS + drops the service-role-all policy on all 40 Wave 1 tables.
-- Reverses cc_sprint_8_rls_wave_1_category_a_40tables_2026_05_12 cleanly.
--
-- Order matches the original migration. Each block is idempotent
-- (DROP POLICY IF EXISTS + DISABLE).
-- ================================================================

-- ----- Zero-row tables (35) -----
DROP POLICY IF EXISTS "agent_activity_log_service_role_all" ON public.agent_activity_log;
ALTER TABLE public.agent_activity_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_performance_log_service_role_all" ON public.agent_performance_log;
ALTER TABLE public.agent_performance_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anfis_weight_history_service_role_all" ON public.anfis_weight_history;
ALTER TABLE public.anfis_weight_history DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "antigravity_queue_service_role_all" ON public.antigravity_queue;
ALTER TABLE public.antigravity_queue DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "antigravity_stage_log_service_role_all" ON public.antigravity_stage_log;
ALTER TABLE public.antigravity_stage_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ats_sync_log_service_role_all" ON public.ats_sync_log;
ALTER TABLE public.ats_sync_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bubble_migration_events_service_role_all" ON public.bubble_migration_events;
ALTER TABLE public.bubble_migration_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "debug_log_service_role_all" ON public.debug_log;
ALTER TABLE public.debug_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "divergence_metrics_service_role_all" ON public.divergence_metrics;
ALTER TABLE public.divergence_metrics DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "energy_log_service_role_all" ON public.energy_log;
ALTER TABLE public.energy_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hal_ablation_results_service_role_all" ON public.hal_ablation_results;
ALTER TABLE public.hal_ablation_results DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hal_benchmark_results_service_role_all" ON public.hal_benchmark_results;
ALTER TABLE public.hal_benchmark_results DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hal_outbreak_events_service_role_all" ON public.hal_outbreak_events;
ALTER TABLE public.hal_outbreak_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hal_snapshot_registry_service_role_all" ON public.hal_snapshot_registry;
ALTER TABLE public.hal_snapshot_registry DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hal_veto_test_results_service_role_all" ON public.hal_veto_test_results;
ALTER TABLE public.hal_veto_test_results DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hallucination_test_log_service_role_all" ON public.hallucination_test_log;
ALTER TABLE public.hallucination_test_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hitl_hunch_log_service_role_all" ON public.hitl_hunch_log;
ALTER TABLE public.hitl_hunch_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "institution_config_audit_log_service_role_all" ON public.institution_config_audit_log;
ALTER TABLE public.institution_config_audit_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "moderation_queue_service_role_all" ON public.moderation_queue;
ALTER TABLE public.moderation_queue DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "product_metrics_service_role_all" ON public.product_metrics;
ALTER TABLE public.product_metrics DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "productivity_ledger_service_role_all" ON public.productivity_ledger;
ALTER TABLE public.productivity_ledger DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "repid_confession_log_service_role_all" ON public.repid_confession_log;
ALTER TABLE public.repid_confession_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "repid_dual_sig_log_service_role_all" ON public.repid_dual_sig_log;
ALTER TABLE public.repid_dual_sig_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "repid_jubilee_log_service_role_all" ON public.repid_jubilee_log;
ALTER TABLE public.repid_jubilee_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "repid_vesting_events_service_role_all" ON public.repid_vesting_events;
ALTER TABLE public.repid_vesting_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "signal_accuracy_log_service_role_all" ON public.signal_accuracy_log;
ALTER TABLE public.signal_accuracy_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sync_queue_service_role_all" ON public.sync_queue;
ALTER TABLE public.sync_queue DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "system_learning_log_service_role_all" ON public.system_learning_log;
ALTER TABLE public.system_learning_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "token_issuance_log_service_role_all" ON public.token_issuance_log;
ALTER TABLE public.token_issuance_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trinity_mcp_events_service_role_all" ON public.trinity_mcp_events;
ALTER TABLE public.trinity_mcp_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trinity_service_registry_service_role_all" ON public.trinity_service_registry;
ALTER TABLE public.trinity_service_registry DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trinity_system_metrics_service_role_all" ON public.trinity_system_metrics;
ALTER TABLE public.trinity_system_metrics DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trusthealth_veto_log_service_role_all" ON public.trusthealth_veto_log;
ALTER TABLE public.trusthealth_veto_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trustrepid_challenge_ledger_service_role_all" ON public.trustrepid_challenge_ledger;
ALTER TABLE public.trustrepid_challenge_ledger DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "velocity_metrics_service_role_all" ON public.velocity_metrics;
ALTER TABLE public.velocity_metrics DISABLE ROW LEVEL SECURITY;

-- ----- One-row internal logs (5) -----

DROP POLICY IF EXISTS "claude_session_log_service_role_all" ON public.claude_session_log;
ALTER TABLE public.claude_session_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "execution_log_service_role_all" ON public.execution_log;
ALTER TABLE public.execution_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "repid_referendum_log_service_role_all" ON public.repid_referendum_log;
ALTER TABLE public.repid_referendum_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "signal_events_service_role_all" ON public.signal_events;
ALTER TABLE public.signal_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trust_events_service_role_all" ON public.trust_events;
ALTER TABLE public.trust_events DISABLE ROW LEVEL SECURITY;
