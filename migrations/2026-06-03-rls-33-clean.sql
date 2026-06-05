-- R3 RLS-33 clean apply, NO over-grant (testable + revertible)
-- Most of the 33 remain service-role-only (deny-all for anon/auth; already work via service_role bypass).
-- ONLY add policy where real client/authenticated read is proven today (from code paths / UI / agent discovery).
-- Credential tables (agent_api_keys, authorized_signers, repid_credentials, trusttrader_*_credentials, *_sessions etc) left deny-all. NEVER grant anon to them.
-- Each added policy has DROP in rollback.
-- Apply via apply_migration on Sean co-sign. Revert = run the DROP lines.
-- Proven client reads (grep evidence in src/routes + comments):
--   - x402_settlements: agents/UI read own (requestor/provider) settlements.
--   - agent_services: public discovery (trustshell/frontend catalog read; see lockdown comment for public_read).
-- All other 33 (stake_deposits, repid_transactions, payment_log, erc8004_reputation_writes, confidence_stakes, repid_users, verified_users, sponsorship_records, agent_stakes, repid_agent_stakes, x402_recovery_queue, paper_trade_ledger, governance_proposals, hitl_requests, hal_*_audit etc, zkp_routing_config, escalation_log, feature_registry, conductor_state, dbt_registry, gmpd_log, cross_llm_comparisons, ground_truth_facts, hal_training_cases etc): leave as-is (service only or already policied; no client read proven for anon grant).

BEGIN;

-- x402_settlements: owner read for requestor/provider (authenticated agents)
ALTER TABLE IF EXISTS public.x402_settlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.x402_settlements;
CREATE POLICY "service_role_all" ON public.x402_settlements FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "owner_read_own" ON public.x402_settlements;
CREATE POLICY "owner_read_own" ON public.x402_settlements FOR SELECT TO authenticated
  USING (
    (SELECT (auth.jwt() ->> 'app_agent_id')) = requestor_agent_id OR
    (SELECT (auth.jwt() ->> 'app_agent_id')) = provider_agent_id
  );
-- rollback: DROP POLICY IF EXISTS "owner_read_own" ON public.x402_settlements; DROP POLICY IF EXISTS "service_role_all" ON public.x402_settlements; ALTER TABLE public.x402_settlements DISABLE ROW LEVEL SECURITY;

-- agent_services: public read for discovery (as flagged in 2026-06-01 lockdown)
ALTER TABLE IF EXISTS public.agent_services ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_services;
CREATE POLICY "service_role_all" ON public.agent_services FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "public_read" ON public.agent_services;
CREATE POLICY "public_read" ON public.agent_services FOR SELECT TO anon, authenticated USING (true);
-- rollback: DROP POLICY IF EXISTS "public_read" ON public.agent_services; DROP POLICY IF EXISTS "service_role_all" ON public.agent_services; ALTER TABLE public.agent_services DISABLE ROW LEVEL SECURITY;

-- Credential tables (examples; leave deny-all / service only, no client policy added):
-- agent_api_keys, authorized_signers, repid_credentials, trusttrader_pending_credentials, trusttrader_sessions, verified_users etc.
-- (If not yet enabled by lockdown, they get service_role_all only in separate/prior apply; no anon policy here.)

COMMIT;

-- Post apply (Sean): verify with r2-live-gates or 
-- SELECT schemaname, tablename, policyname, roles, cmd FROM pg_policies WHERE tablename IN ('x402_settlements','agent_services') ;
-- Expect owner_read_own + public_read added; no policies on credential tables.
-- To revert one table: run its DROP lines (testable).
-- Gate: only 2 tables gained client policy; credential untouched.
