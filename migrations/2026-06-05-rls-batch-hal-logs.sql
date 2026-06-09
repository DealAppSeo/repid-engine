-- RLS LOCKDOWN BATCH (from AGENT_BACKLOG_BOARD 2026-06-05 XC item 2): next batch after 33.
-- Tables: hal_audit_chain, llm_call_log, tool_call_log, red_team_results, hal_training_cases, etc.
-- Service-role-only (a), additive, no client policies.
-- Rollback per table: DROP POLICY "service_role_all"; ALTER TABLE ... DISABLE ROW LEVEL SECURITY;
-- Sean applies in batches per D-042 etc.
-- Verify post: SELECT tablename, policyname FROM pg_policies WHERE tablename IN ('hal_audit_chain', ...); anon/service queries blocked for these.

-- hal_audit_chain (internal audit, service only)
ALTER TABLE IF EXISTS public.hal_audit_chain ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_audit_chain;
CREATE POLICY "service_role_all" ON public.hal_audit_chain FOR ALL TO service_role USING (true) WITH CHECK (true);

-- llm_call_log (billing/audit, service only)
ALTER TABLE IF EXISTS public.llm_call_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.llm_call_log;
CREATE POLICY "service_role_all" ON public.llm_call_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- tool_call_log (audit, service only)
ALTER TABLE IF EXISTS public.tool_call_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.tool_call_log;
CREATE POLICY "service_role_all" ON public.tool_call_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- red_team_results (pen test, service only)
ALTER TABLE IF EXISTS public.red_team_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.red_team_results;
CREATE POLICY "service_role_all" ON public.red_team_results FOR ALL TO service_role USING (true) WITH CHECK (true);

-- hal_training_cases (if not done)
ALTER TABLE IF EXISTS public.hal_training_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_training_cases;
CREATE POLICY "service_role_all" ON public.hal_training_cases FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Add more as enumerated (e.g. from _temp or types: hal_veto_test_results, etc.)
-- Full 242 will be in subsequent batches.

-- Post apply verify example (Sean):
-- SELECT count(*) FROM pg_policies WHERE tablename = 'hal_audit_chain' AND policyname = 'service_role_all';
-- Expect 1; anon select on these should fail.

-- References: prior RLS-33 migrations, SCHEMA_TRUTH_MAP, D-042, backlog board.