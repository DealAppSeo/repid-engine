-- V1 Launch-Security RLS Wave v1 (remaining critical money/audit) — STAGED 2026-06-19 XC-S2
-- LOCAL ONLY. PROD apply qnnpjhlxljtqyigedwkb ONLY on explicit Sean instruction + raw before/after.
-- Pattern: service_role FOR ALL; preserve intended public SELECT only where already documented.
--
-- FRESH RAW BEFORE (service/pg direct, 2026-06-19T21:54Z [V]):
--   service_contracts: 114
--   x402_payment_gates: 2
--   x402_settlements: 242
--   staking_deposits: 0
--   staking_withdrawals: 0
--   repid_score_events: 102172
--   trinity_task_audit_log: 1000
--   tool_call_log: 84100
-- RLS status before:
--   x402_settlements: relrowsecurity=true, policy_n=0  <-- GAP (no policies)
--   staking_*: relrowsecurity=true, policy_n=2 (verify tightness on apply)
--   others: relrowsecurity=true, policy_n=1-2

BEGIN;

-- service_contracts (money)
ALTER TABLE IF EXISTS public.service_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_contracts_service_role_all" ON public.service_contracts;
CREATE POLICY "service_contracts_service_role_all" ON public.service_contracts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- x402 surfaces
ALTER TABLE IF EXISTS public.x402_payment_gates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "x402_payment_gates_service_role_all" ON public.x402_payment_gates;
CREATE POLICY "x402_payment_gates_service_role_all" ON public.x402_payment_gates
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE IF EXISTS public.x402_settlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "x402_settlements_service_role_all" ON public.x402_settlements;
CREATE POLICY "x402_settlements_service_role_all" ON public.x402_settlements
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- staking (money)
ALTER TABLE IF EXISTS public.staking_deposits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staking_deposits_service_role_all" ON public.staking_deposits;
CREATE POLICY "staking_deposits_service_role_all" ON public.staking_deposits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE IF EXISTS public.staking_withdrawals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staking_withdrawals_service_role_all" ON public.staking_withdrawals;
CREATE POLICY "staking_withdrawals_service_role_all" ON public.staking_withdrawals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- repid score ledger (audit/money-adjacent)
ALTER TABLE IF EXISTS public.repid_score_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "repid_score_events_service_role_all" ON public.repid_score_events;
CREATE POLICY "repid_score_events_service_role_all" ON public.repid_score_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- audit logs
ALTER TABLE IF EXISTS public.trinity_task_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trinity_task_audit_log_service_role_all" ON public.trinity_task_audit_log;
CREATE POLICY "trinity_task_audit_log_service_role_all" ON public.trinity_task_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE IF EXISTS public.tool_call_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tool_call_log_service_role_all" ON public.tool_call_log;
CREATE POLICY "tool_call_log_service_role_all" ON public.tool_call_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.x402_settlements IS 'V1 RLS wave v1 2026-06-19 — service_role only (was RLS-on, zero policies).';

COMMIT;

-- AFTER-APPLY PROOF (Sean paste raw):
-- SELECT c.relname, c.relrowsecurity, (SELECT count(*)::int FROM pg_policies p WHERE p.tablename=c.relname) policy_n
--   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--  WHERE n.nspname='public' AND c.relname IN ('service_contracts','x402_payment_gates','x402_settlements',
--        'staking_deposits','staking_withdrawals','repid_score_events','trinity_task_audit_log','tool_call_log')
--  ORDER BY 1;
-- SELECT tablename, policyname, roles FROM pg_policies WHERE tablename IN (...);
-- SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
--  WHERE table_name IN (...) AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE','DELETE');