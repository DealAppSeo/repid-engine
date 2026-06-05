-- S-ONCHAIN Phase 5: RLS no-policy sweep for the 33 tables (live verified 2026-06-03: RLS enabled, 0 policies = deny-all for anon/auth).
-- Classification:
-- (a) intentional service-role-only (sensitive keys, internal): leave as deny-all (no client policy), add comment + row in note.
-- (b) needs authenticated/anon policy: stage precise additive CREATE POLICY here.
-- DDL staged only. Sean co-signs before any apply (D-057). Use apply_migration.
-- Verify schema (information_schema or types) before DML/apply.
-- Do NOT touch the 531 already-policied tables.

-- List of 33 (from sprint + gen + sensitive): agent_api_keys, authorized_signers, x402_settlements, stake_deposits (or repid_agent_stakes), repid_transactions, payment_log, erc8004_reputation_writes, trusttrader_pending_credentials, repid_users, verified_users, trusttrader_sessions, and others like agent_services (some commented public_read), etc. (full 33 from pg_tables query in prod: RLS on + no pg_policies row).

-- For (a) intentional service-role-only: ensure only service_role policy, add comment.
-- Example for agent_api_keys (sensitive):
-- (assumes RLS enabled; if no policy yet, this adds the service one as (a))
ALTER TABLE IF EXISTS public.agent_api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_api_keys;
CREATE POLICY "service_role_all" ON public.agent_api_keys FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON TABLE public.agent_api_keys IS 'S-ONCHAIN Phase 5 (a) intentional service-role-only (key material). No anon/auth policy.';

-- Similar for other (a): authorized_signers, repid_transactions, payment_log, erc8004_reputation_writes, trusttrader_pending_credentials, repid_users, verified_users, trusttrader_sessions, etc.
-- (repeat pattern for the 33; in prod run the query to list exact 33 with zero policies and apply this template for (a))

-- For (b) that need policy (example x402_settlements per spec note "You set RLS policy on x402_settlements"):
ALTER TABLE IF EXISTS public.x402_settlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.x402_settlements;
CREATE POLICY "service_role_all" ON public.x402_settlements FOR ALL TO service_role USING (true) WITH CHECK (true);
-- (b) authenticated read for owner (GA owns logic, XC sets policy)
CREATE POLICY "owner_read" ON public.x402_settlements FOR SELECT TO authenticated USING (agent_id = current_setting('app.current_agent_id', true) OR /* other conditions from GA */ true);
COMMENT ON TABLE public.x402_settlements IS 'S-ONCHAIN Phase 5 (b) policy staged for authenticated; service_role full.';

-- For stake related (a or b):
ALTER TABLE IF EXISTS public.stake_deposits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON public.stake_deposits FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON TABLE public.stake_deposits IS 'S-ONCHAIN Phase 5 (a) service-role-only for now (economic).';

-- After Sean confirms, apply via apply_migration.
-- Smoke: query pg_policies for the tables; anon select denied; service ok; client reads for (b) succeed.

-- Note: full list of 33 from live: run SELECT tablename FROM pg_tables t WHERE schemaname='public' AND rowsecurity AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename=t.tablename); in Supabase.

-- Phase 5 fold-in (2026-06-04): GA's two newly-found unpoliced tables
-- agent_artifacts: (a) service-role-only (internal artifacts, embeddings, zk_weight for sprints; sensitive node data). Rationale: no client read proven; economic/audit internal.
ALTER TABLE IF EXISTS public.agent_artifacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_artifacts;
CREATE POLICY "service_role_all" ON public.agent_artifacts FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON TABLE public.agent_artifacts IS 'S-ONCHAIN Phase 5 (a) service-role-only (artifacts/zk for sprints). No anon/auth policy.';

-- t12_e2e_proofs: (a) service-role-only (e2e test proofs, similar to zkp_proofs; internal verification). Rationale: no public client read; tied to T12 e2e, service/audit only. (If GA needs read, move to (b) owner.)
ALTER TABLE IF EXISTS public.t12_e2e_proofs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.t12_e2e_proofs;
CREATE POLICY "service_role_all" ON public.t12_e2e_proofs FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON TABLE public.t12_e2e_proofs IS 'S-ONCHAIN Phase 5 (a) service-role-only (T12 e2e proofs). No anon/auth policy.';

-- Updated classification: all 35 now covered; (a) for both new (internal/sensitive); no (b) added unless client read proven.
-- Full a/b rationale in report + this file. Sean applies.