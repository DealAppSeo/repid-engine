-- RLS BATCH toward 242 (XC PHASE5 2026-06-05 SPRINT): next internal tables service_role_all.
-- Additive, per-table, owner_read only where public-safe (none here), anon BLOCKED.
-- Tables chosen from SCHEMA_TRUTH_MAP / types: t12_*, repid_zkp_*, agent_artifacts, zkp_routing_config, hal_veto_*, etc.
-- XC applies own (staged). Verify: app loads, pg_policies count up, anon select FAIL.
-- Rollback per table DROP POLICY + DISABLE.
-- Cite: SPRINT_XC:36 (DONE-CHECK count NOT rowsecurity down), prior 2026-06-05-rls-batch-hal-logs.sql, RLS 33/242 batches.
-- Sean co-sign for full apply (D-057).

-- t12_e2e_proofs (internal T12 eval, service only)
ALTER TABLE IF EXISTS public.t12_e2e_proofs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.t12_e2e_proofs;
CREATE POLICY "service_role_all" ON public.t12_e2e_proofs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- repid_zkp_proofs (zkp anchor, service)
ALTER TABLE IF EXISTS public.repid_zkp_proofs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_zkp_proofs;
CREATE POLICY "service_role_all" ON public.repid_zkp_proofs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- agent_artifacts (agent files, service)
ALTER TABLE IF EXISTS public.agent_artifacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_artifacts;
CREATE POLICY "service_role_all" ON public.agent_artifacts FOR ALL TO service_role USING (true) WITH CHECK (true);

-- zkp_routing_config (router config, service)
ALTER TABLE IF EXISTS public.zkp_routing_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.zkp_routing_config;
CREATE POLICY "service_role_all" ON public.zkp_routing_config FOR ALL TO service_role USING (true) WITH CHECK (true);

-- hal_veto_test_results (if exists, internal)
ALTER TABLE IF EXISTS public.hal_veto_test_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_veto_test_results;
CREATE POLICY "service_role_all" ON public.hal_veto_test_results FOR ALL TO service_role USING (true) WITH CHECK (true);

-- hal_score_events (if separate from score pipeline)
ALTER TABLE IF EXISTS public.hal_score_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_score_events;
CREATE POLICY "service_role_all" ON public.hal_score_events FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ROLLBACK (per table):
-- DROP POLICY IF EXISTS "service_role_all" ON public.t12_e2e_proofs; ALTER TABLE public.t12_e2e_proofs DISABLE ROW LEVEL SECURITY;
-- ... repeat for each.

-- Post "apply" (staged): SELECT count(*) FROM pg_tables t WHERE schemaname='public' AND NOT rowsecurity; -- trends down
-- SELECT tablename FROM pg_policies WHERE policyname='service_role_all' AND tablename IN ('t12_e2e_proofs', ...);
-- App load: tsc + node start (no RLS error on service paths).
-- Anon block: psql -U anon ... SELECT * FROM t12_e2e_proofs; -- expect permission denied.

COMMENT ON TABLE public.t12_e2e_proofs IS 'RLS service_role_all added 2026-06-05 XC batch (toward 242).';
