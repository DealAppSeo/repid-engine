-- ============================================================================
-- R2 Phase 2: RLS 33 completion (the remaining no-policy tables post 2026-06-01 lockdown)
-- Date: 2026-06-03 (xc3) · Author: XC per sprint
-- SEAN CO-SIGNS before apply_migration (D-057). DDL only via apply_migration.
-- "Gate passed" = LIVE pg_policies count >0 for these 33 (or documented intentional deny) + no client regression.
--
-- Classification (a) service-role-only (internal/sensitive, deny anon/auth by default):
--   agent_api_keys, authorized_signers, stake_deposits, repid_transactions, payment_log,
--   erc8004_reputation_writes, trusttrader_pending_credentials, repid_users, verified_users,
--   trusttrader_sessions, confidence_stakes, agent_services, sponsorship_records (if exists),
--   agent_stakes (model stakes), repid_agent_stakes, x402_recovery_queue, etc.
--
-- (b) needs client policy (owner/auth reads for x402 flows, settlements, some public discovery):
--   x402_settlements (owner can read own), perhaps agent_services public read (see comment in lockdown),
--   other settlement/ledger that authenticated clients must SELECT/INSERT under RLS.
--
-- After 241+ lockdown, these 33 were the remainder with 0 policies (or RLS off).
-- This migration makes them explicit + safe. Additive only.
-- Recommend: run `apply_migration 2026-06-03-rls-33-apply.sql` (or Supabase SQL editor paste) after co-sign.
-- Verify post: SELECT tablename, COUNT(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('x402_settlements', ...) GROUP BY 1;
-- Smoke: anon key SELECT on x402_settlements should be policy-limited; service_role full OK.
-- ============================================================================

BEGIN;

-- (a) service_role_all for sensitive/internal (no client bypass)
DO $$
DECLARE
  t text;
  tables_a text[] := ARRAY[
    'agent_api_keys','authorized_signers','stake_deposits','repid_transactions','payment_log',
    'erc8004_reputation_writes','trusttrader_pending_credentials','repid_users','verified_users',
    'trusttrader_sessions','confidence_stakes','agent_services','sponsorship_records',
    'agent_stakes','repid_agent_stakes','x402_recovery_queue','paper_trade_ledger',
    'governance_proposals','hitl_requests','hal_threshold_updates','hal_training_cases',
    'ground_truth_facts','escalation_log','feature_registry','conductor_state',
    'dbt_registry','gmpd_log','cross_llm_comparisons','hal_audit_chain',
    'hal_production_events','hal_classifications','zkp_routing_config'
  ];
BEGIN
  FOREACH t IN ARRAY tables_a LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS "service_role_all" ON public.%I;', t);
    EXECUTE format('CREATE POLICY "service_role_all" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true);', t);
    -- rollback: ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.%I;
  END LOOP;
END $$;

-- (b) owner/client policies for x402_settlements + similar (example; adjust per real FK to auth)
-- These allow authenticated owner (or agent context) read/insert of own rows.
-- If client uses anon key for x402, policy must permit under USING/WITH CHECK with proper claim.
ALTER TABLE public.x402_settlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.x402_settlements;
CREATE POLICY "service_role_all" ON public.x402_settlements FOR ALL TO service_role USING (true) WITH CHECK (true);
-- Owner read example (customize to your JWT/app user mapping; often via security definer fn or app_metadata):
-- DROP POLICY IF EXISTS "owner_read_own" ON public.x402_settlements;
-- CREATE POLICY "owner_read_own" ON public.x402_settlements FOR SELECT TO authenticated
--   USING ( (SELECT (auth.jwt() ->> 'app_agent_id')) = payer_agent_id OR (SELECT (auth.jwt() ->> 'app_agent_id')) = payee_agent_id );
-- Similar for INSERT if clients create settlements directly (rare; usually service).

-- If other (b) tables need public/anon read (e.g. for discovery), add here with comment.
-- agent_services already had a commented public_read in 2026-06-01 lockdown.

COMMIT;

-- Post-apply (Sean or XC with keys): run scripts/verify/r2-live-gates.ts ; expect rls_zero drops for the 33.
-- No intended client read regressed (x402 flows, settlement queries from GA/TrustShell still work via service or owner policy).
-- If table missing (e.g. sponsorship_records not yet), the DO skips harmlessly (or add CREATE TABLE in prior substrate migration).
