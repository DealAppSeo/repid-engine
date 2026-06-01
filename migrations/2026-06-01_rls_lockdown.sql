-- ============================================================================
-- S-RLS-LOCKDOWN — enable RLS + service_role-only policy on 241 public tables
-- Author: CC · 2026-06-01 · branch feat/cc-2026-06-01-rls-lockdown
-- DESIGN ONLY — Sean applies in Supabase (D1 TOP-8 first). Co-signed review, no self-merge.
--
-- WHY: 241/545 public tables have RLS DISABLED with FULL anon write grants [sql:2026-06-01]
--      — the #1 pen-test finding. This denies anon/authenticated by default.
-- MODEL: ENABLE RLS + a service_role-FULL policy per table. service_role (BYPASSRLS) and the
--        postgres pooler role (direct-pg :6543, relforcerowsecurity=false) both BYPASS RLS, so
--        every live writer keeps full access; anon/authenticated get NO policy → denied.
-- LIVE-PATH PROOF [sql:2026-06-01]: trinity_tasks, repid_agents, agent_heartbeat,
--        peer_verification_queue, trinity_repid ALREADY have RLS ON and the swarm claims
--        113/30min + HAL/sync writes succeed → this exact pattern is proven safe in prod.
-- All statements idempotent (re-runnable). Each table has a per-table rollback line.
-- VERIFY after apply (run as anon AND service_role): anon SELECT/INSERT denied; service_role OK;
--        swarm claims continue; a HAL score-event write + a stake/proof write still succeed.
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- TIER A — D1 TOP-8 (apply FIRST; highest pen-test leverage)
-- ─────────────────────────────────────────────────────────────────────────

-- service_contracts  — economic contract lifecycle
ALTER TABLE public.service_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.service_contracts;
CREATE POLICY "service_role_all" ON public.service_contracts FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback service_contracts: ALTER TABLE public.service_contracts DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.service_contracts;

-- repid_zkp_proofs  — 41k proofs
ALTER TABLE public.repid_zkp_proofs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_zkp_proofs;
CREATE POLICY "service_role_all" ON public.repid_zkp_proofs FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_zkp_proofs: ALTER TABLE public.repid_zkp_proofs DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_zkp_proofs;

-- human_sbt_registry  — identity SBT
ALTER TABLE public.human_sbt_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.human_sbt_registry;
CREATE POLICY "service_role_all" ON public.human_sbt_registry FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback human_sbt_registry: ALTER TABLE public.human_sbt_registry DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.human_sbt_registry;

-- repid_proof_queue  — 44k proof jobs
ALTER TABLE public.repid_proof_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_proof_queue;
CREATE POLICY "service_role_all" ON public.repid_proof_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_proof_queue: ALTER TABLE public.repid_proof_queue DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_proof_queue;

-- dispute_validation_queue  — dispute integrity
ALTER TABLE public.dispute_validation_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.dispute_validation_queue;
CREATE POLICY "service_role_all" ON public.dispute_validation_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback dispute_validation_queue: ALTER TABLE public.dispute_validation_queue DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.dispute_validation_queue;

-- repid_score_events  — 47k RepID audit log
ALTER TABLE public.repid_score_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_score_events;
CREATE POLICY "service_role_all" ON public.repid_score_events FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_score_events: ALTER TABLE public.repid_score_events DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_score_events;

-- agent_services  — marketplace catalog (trustshell reads via service-role)
ALTER TABLE public.agent_services ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_services;
CREATE POLICY "service_role_all" ON public.agent_services FOR ALL TO service_role USING (true) WITH CHECK (true);
-- FLAG: discovery/catalog surface — if a frontend reads this with the ANON key, uncomment:
--   DROP POLICY IF EXISTS "public_read" ON public.agent_services;
--   CREATE POLICY "public_read" ON public.agent_services FOR SELECT TO anon, authenticated USING (true);
-- rollback agent_services: ALTER TABLE public.agent_services DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_services;

-- defect_4_validation_log  — validation integrity
ALTER TABLE public.defect_4_validation_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.defect_4_validation_log;
CREATE POLICY "service_role_all" ON public.defect_4_validation_log FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback defect_4_validation_log: ALTER TABLE public.defect_4_validation_log DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.defect_4_validation_log;


-- ─────────────────────────────────────────────────────────────────────────
-- TIER B — sensitive (RepID/scores · stakes/financial · keys/identity/SBT · disputes)  (56 tables)
-- ─────────────────────────────────────────────────────────────────────────

-- agent_repid_history
ALTER TABLE public.agent_repid_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_repid_history;
CREATE POLICY "service_role_all" ON public.agent_repid_history FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_repid_history: ALTER TABLE public.agent_repid_history DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_repid_history;

-- confidence_stakes
ALTER TABLE public.confidence_stakes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.confidence_stakes;
CREATE POLICY "service_role_all" ON public.confidence_stakes FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback confidence_stakes: ALTER TABLE public.confidence_stakes DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.confidence_stakes;

-- erc8004_data_packets
ALTER TABLE public.erc8004_data_packets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.erc8004_data_packets;
CREATE POLICY "service_role_all" ON public.erc8004_data_packets FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback erc8004_data_packets: ALTER TABLE public.erc8004_data_packets DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.erc8004_data_packets;

-- erc8004_data_tiers
ALTER TABLE public.erc8004_data_tiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.erc8004_data_tiers;
CREATE POLICY "service_role_all" ON public.erc8004_data_tiers FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback erc8004_data_tiers: ALTER TABLE public.erc8004_data_tiers DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.erc8004_data_tiers;

-- human_sbt_mints
ALTER TABLE public.human_sbt_mints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.human_sbt_mints;
CREATE POLICY "service_role_all" ON public.human_sbt_mints FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback human_sbt_mints: ALTER TABLE public.human_sbt_mints DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.human_sbt_mints;

-- hyperdag_points_ledger
ALTER TABLE public.hyperdag_points_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hyperdag_points_ledger;
CREATE POLICY "service_role_all" ON public.hyperdag_points_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hyperdag_points_ledger: ALTER TABLE public.hyperdag_points_ledger DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hyperdag_points_ledger;

-- hyperdag_receipts
ALTER TABLE public.hyperdag_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hyperdag_receipts;
CREATE POLICY "service_role_all" ON public.hyperdag_receipts FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hyperdag_receipts: ALTER TABLE public.hyperdag_receipts DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hyperdag_receipts;

-- insider_trading_signals
ALTER TABLE public.insider_trading_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.insider_trading_signals;
CREATE POLICY "service_role_all" ON public.insider_trading_signals FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback insider_trading_signals: ALTER TABLE public.insider_trading_signals DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.insider_trading_signals;

-- invite_chains
ALTER TABLE public.invite_chains ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.invite_chains;
CREATE POLICY "service_role_all" ON public.invite_chains FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback invite_chains: ALTER TABLE public.invite_chains DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.invite_chains;

-- linked_bets
ALTER TABLE public.linked_bets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.linked_bets;
CREATE POLICY "service_role_all" ON public.linked_bets FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback linked_bets: ALTER TABLE public.linked_bets DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.linked_bets;

-- merkle_batches
ALTER TABLE public.merkle_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.merkle_batches;
CREATE POLICY "service_role_all" ON public.merkle_batches FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback merkle_batches: ALTER TABLE public.merkle_batches DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.merkle_batches;

-- paper_trade_orders
ALTER TABLE public.paper_trade_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.paper_trade_orders;
CREATE POLICY "service_role_all" ON public.paper_trade_orders FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback paper_trade_orders: ALTER TABLE public.paper_trade_orders DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.paper_trade_orders;

-- paper_trades
ALTER TABLE public.paper_trades ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.paper_trades;
CREATE POLICY "service_role_all" ON public.paper_trades FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback paper_trades: ALTER TABLE public.paper_trades DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.paper_trades;

-- perceived_repid_assessments
ALTER TABLE public.perceived_repid_assessments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.perceived_repid_assessments;
CREATE POLICY "service_role_all" ON public.perceived_repid_assessments FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback perceived_repid_assessments: ALTER TABLE public.perceived_repid_assessments DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.perceived_repid_assessments;

-- permissioned_vaults
ALTER TABLE public.permissioned_vaults ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.permissioned_vaults;
CREATE POLICY "service_role_all" ON public.permissioned_vaults FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback permissioned_vaults: ALTER TABLE public.permissioned_vaults DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.permissioned_vaults;

-- push_subscriptions
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.push_subscriptions;
CREATE POLICY "service_role_all" ON public.push_subscriptions FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback push_subscriptions: ALTER TABLE public.push_subscriptions DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.push_subscriptions;

-- repid_adversarial_immunity
ALTER TABLE public.repid_adversarial_immunity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_adversarial_immunity;
CREATE POLICY "service_role_all" ON public.repid_adversarial_immunity FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_adversarial_immunity: ALTER TABLE public.repid_adversarial_immunity DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_adversarial_immunity;

-- repid_agent_stakes
ALTER TABLE public.repid_agent_stakes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_agent_stakes;
CREATE POLICY "service_role_all" ON public.repid_agent_stakes FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_agent_stakes: ALTER TABLE public.repid_agent_stakes DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_agent_stakes;

-- repid_badges
ALTER TABLE public.repid_badges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_badges;
CREATE POLICY "service_role_all" ON public.repid_badges FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_badges: ALTER TABLE public.repid_badges DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_badges;

-- repid_bounties
ALTER TABLE public.repid_bounties ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_bounties;
CREATE POLICY "service_role_all" ON public.repid_bounties FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_bounties: ALTER TABLE public.repid_bounties DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_bounties;

-- repid_claims
ALTER TABLE public.repid_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_claims;
CREATE POLICY "service_role_all" ON public.repid_claims FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_claims: ALTER TABLE public.repid_claims DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_claims;

-- repid_credentials
ALTER TABLE public.repid_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_credentials;
CREATE POLICY "service_role_all" ON public.repid_credentials FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_credentials: ALTER TABLE public.repid_credentials DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_credentials;

-- repid_ecosystem_supply
ALTER TABLE public.repid_ecosystem_supply ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_ecosystem_supply;
CREATE POLICY "service_role_all" ON public.repid_ecosystem_supply FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_ecosystem_supply: ALTER TABLE public.repid_ecosystem_supply DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_ecosystem_supply;

-- repid_endorsements
ALTER TABLE public.repid_endorsements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_endorsements;
CREATE POLICY "service_role_all" ON public.repid_endorsements FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_endorsements: ALTER TABLE public.repid_endorsements DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_endorsements;

-- repid_events
ALTER TABLE public.repid_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_events;
CREATE POLICY "service_role_all" ON public.repid_events FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_events: ALTER TABLE public.repid_events DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_events;

-- repid_inflation_alerts
ALTER TABLE public.repid_inflation_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_inflation_alerts;
CREATE POLICY "service_role_all" ON public.repid_inflation_alerts FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_inflation_alerts: ALTER TABLE public.repid_inflation_alerts DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_inflation_alerts;

-- repid_mcp_tools
ALTER TABLE public.repid_mcp_tools ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_mcp_tools;
CREATE POLICY "service_role_all" ON public.repid_mcp_tools FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_mcp_tools: ALTER TABLE public.repid_mcp_tools DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_mcp_tools;

-- repid_mentorship_bonds
ALTER TABLE public.repid_mentorship_bonds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_mentorship_bonds;
CREATE POLICY "service_role_all" ON public.repid_mentorship_bonds FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_mentorship_bonds: ALTER TABLE public.repid_mentorship_bonds DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_mentorship_bonds;

-- repid_merkle_events
ALTER TABLE public.repid_merkle_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_merkle_events;
CREATE POLICY "service_role_all" ON public.repid_merkle_events FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_merkle_events: ALTER TABLE public.repid_merkle_events DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_merkle_events;

-- repid_permissions
ALTER TABLE public.repid_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_permissions;
CREATE POLICY "service_role_all" ON public.repid_permissions FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_permissions: ALTER TABLE public.repid_permissions DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_permissions;

-- repid_scores
ALTER TABLE public.repid_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_scores;
CREATE POLICY "service_role_all" ON public.repid_scores FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_scores: ALTER TABLE public.repid_scores DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_scores;

-- repid_stakes
ALTER TABLE public.repid_stakes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_stakes;
CREATE POLICY "service_role_all" ON public.repid_stakes FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_stakes: ALTER TABLE public.repid_stakes DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_stakes;

-- repid_telemetry_snapshots
ALTER TABLE public.repid_telemetry_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_telemetry_snapshots;
CREATE POLICY "service_role_all" ON public.repid_telemetry_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_telemetry_snapshots: ALTER TABLE public.repid_telemetry_snapshots DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_telemetry_snapshots;

-- repid_trade_attempts
ALTER TABLE public.repid_trade_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_trade_attempts;
CREATE POLICY "service_role_all" ON public.repid_trade_attempts FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_trade_attempts: ALTER TABLE public.repid_trade_attempts DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_trade_attempts;

-- repid_verified_decisions
ALTER TABLE public.repid_verified_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_verified_decisions;
CREATE POLICY "service_role_all" ON public.repid_verified_decisions FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_verified_decisions: ALTER TABLE public.repid_verified_decisions DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_verified_decisions;

-- repid_wisdom_scores
ALTER TABLE public.repid_wisdom_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.repid_wisdom_scores;
CREATE POLICY "service_role_all" ON public.repid_wisdom_scores FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback repid_wisdom_scores: ALTER TABLE public.repid_wisdom_scores DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.repid_wisdom_scores;

-- reputation_attestations
ALTER TABLE public.reputation_attestations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.reputation_attestations;
CREATE POLICY "service_role_all" ON public.reputation_attestations FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback reputation_attestations: ALTER TABLE public.reputation_attestations DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.reputation_attestations;

-- stake_authority_snapshots
ALTER TABLE public.stake_authority_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.stake_authority_snapshots;
CREATE POLICY "service_role_all" ON public.stake_authority_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback stake_authority_snapshots: ALTER TABLE public.stake_authority_snapshots DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.stake_authority_snapshots;

-- stripe_products
ALTER TABLE public.stripe_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.stripe_products;
CREATE POLICY "service_role_all" ON public.stripe_products FOR ALL TO service_role USING (true) WITH CHECK (true);
-- FLAG: discovery/catalog surface — if a frontend reads this with the ANON key, uncomment:
--   DROP POLICY IF EXISTS "public_read" ON public.stripe_products;
--   CREATE POLICY "public_read" ON public.stripe_products FOR SELECT TO anon, authenticated USING (true);
-- rollback stripe_products: ALTER TABLE public.stripe_products DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.stripe_products;

-- task_verification_stakes
ALTER TABLE public.task_verification_stakes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.task_verification_stakes;
CREATE POLICY "service_role_all" ON public.task_verification_stakes FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback task_verification_stakes: ALTER TABLE public.task_verification_stakes DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.task_verification_stakes;

-- tax_harvest_signals
ALTER TABLE public.tax_harvest_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.tax_harvest_signals;
CREATE POLICY "service_role_all" ON public.tax_harvest_signals FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback tax_harvest_signals: ALTER TABLE public.tax_harvest_signals DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.tax_harvest_signals;

-- trinity_dbt_sbt_pipeline
ALTER TABLE public.trinity_dbt_sbt_pipeline ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_dbt_sbt_pipeline;
CREATE POLICY "service_role_all" ON public.trinity_dbt_sbt_pipeline FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_dbt_sbt_pipeline: ALTER TABLE public.trinity_dbt_sbt_pipeline DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_dbt_sbt_pipeline;

-- trustex_custody_chain
ALTER TABLE public.trustex_custody_chain ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustex_custody_chain;
CREATE POLICY "service_role_all" ON public.trustex_custody_chain FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustex_custody_chain: ALTER TABLE public.trustex_custody_chain DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustex_custody_chain;

-- trustex_rep_stakes
ALTER TABLE public.trustex_rep_stakes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustex_rep_stakes;
CREATE POLICY "service_role_all" ON public.trustex_rep_stakes FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustex_rep_stakes: ALTER TABLE public.trustex_rep_stakes DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustex_rep_stakes;

-- trustshell_agent_sbt
ALTER TABLE public.trustshell_agent_sbt ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_agent_sbt;
CREATE POLICY "service_role_all" ON public.trustshell_agent_sbt FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustshell_agent_sbt: ALTER TABLE public.trustshell_agent_sbt DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_agent_sbt;

-- user_agents
ALTER TABLE public.user_agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.user_agents;
CREATE POLICY "service_role_all" ON public.user_agents FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback user_agents: ALTER TABLE public.user_agents DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.user_agents;

-- user_badges
ALTER TABLE public.user_badges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.user_badges;
CREATE POLICY "service_role_all" ON public.user_badges FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback user_badges: ALTER TABLE public.user_badges DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.user_badges;

-- user_journeys
ALTER TABLE public.user_journeys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.user_journeys;
CREATE POLICY "service_role_all" ON public.user_journeys FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback user_journeys: ALTER TABLE public.user_journeys DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.user_journeys;

-- user_memory_tier
ALTER TABLE public.user_memory_tier ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.user_memory_tier;
CREATE POLICY "service_role_all" ON public.user_memory_tier FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback user_memory_tier: ALTER TABLE public.user_memory_tier DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.user_memory_tier;

-- user_signal_configs
ALTER TABLE public.user_signal_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.user_signal_configs;
CREATE POLICY "service_role_all" ON public.user_signal_configs FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback user_signal_configs: ALTER TABLE public.user_signal_configs DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.user_signal_configs;

-- user_stories
ALTER TABLE public.user_stories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.user_stories;
CREATE POLICY "service_role_all" ON public.user_stories FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback user_stories: ALTER TABLE public.user_stories DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.user_stories;

-- user_streaks
ALTER TABLE public.user_streaks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.user_streaks;
CREATE POLICY "service_role_all" ON public.user_streaks FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback user_streaks: ALTER TABLE public.user_streaks DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.user_streaks;

-- vault_access_log
ALTER TABLE public.vault_access_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.vault_access_log;
CREATE POLICY "service_role_all" ON public.vault_access_log FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback vault_access_log: ALTER TABLE public.vault_access_log DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.vault_access_log;

-- x402_log
ALTER TABLE public.x402_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.x402_log;
CREATE POLICY "service_role_all" ON public.x402_log FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback x402_log: ALTER TABLE public.x402_log DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.x402_log;

-- zkp_circuits
ALTER TABLE public.zkp_circuits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.zkp_circuits;
CREATE POLICY "service_role_all" ON public.zkp_circuits FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback zkp_circuits: ALTER TABLE public.zkp_circuits DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.zkp_circuits;

-- zkp_repid_architecture
ALTER TABLE public.zkp_repid_architecture ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.zkp_repid_architecture;
CREATE POLICY "service_role_all" ON public.zkp_repid_architecture FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback zkp_repid_architecture: ALTER TABLE public.zkp_repid_architecture DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.zkp_repid_architecture;


-- ─────────────────────────────────────────────────────────────────────────
-- TIER C — operational / agent-state / logs (service-role only)  (167 tables)
-- ─────────────────────────────────────────────────────────────────────────

-- accountability_tiers
ALTER TABLE public.accountability_tiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.accountability_tiers;
CREATE POLICY "service_role_all" ON public.accountability_tiers FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback accountability_tiers: ALTER TABLE public.accountability_tiers DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.accountability_tiers;

-- agent_a2a_cards
ALTER TABLE public.agent_a2a_cards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_a2a_cards;
CREATE POLICY "service_role_all" ON public.agent_a2a_cards FOR ALL TO service_role USING (true) WITH CHECK (true);
-- FLAG: discovery/catalog surface — if a frontend reads this with the ANON key, uncomment:
--   DROP POLICY IF EXISTS "public_read" ON public.agent_a2a_cards;
--   CREATE POLICY "public_read" ON public.agent_a2a_cards FOR SELECT TO anon, authenticated USING (true);
-- rollback agent_a2a_cards: ALTER TABLE public.agent_a2a_cards DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_a2a_cards;

-- agent_accuracy_matrix
ALTER TABLE public.agent_accuracy_matrix ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_accuracy_matrix;
CREATE POLICY "service_role_all" ON public.agent_accuracy_matrix FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_accuracy_matrix: ALTER TABLE public.agent_accuracy_matrix DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_accuracy_matrix;

-- agent_artifacts_sprint_0
ALTER TABLE public.agent_artifacts_sprint_0 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_artifacts_sprint_0;
CREATE POLICY "service_role_all" ON public.agent_artifacts_sprint_0 FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_artifacts_sprint_0: ALTER TABLE public.agent_artifacts_sprint_0 DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_artifacts_sprint_0;

-- agent_capability_scores
ALTER TABLE public.agent_capability_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_capability_scores;
CREATE POLICY "service_role_all" ON public.agent_capability_scores FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_capability_scores: ALTER TABLE public.agent_capability_scores DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_capability_scores;

-- agent_character_history
ALTER TABLE public.agent_character_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_character_history;
CREATE POLICY "service_role_all" ON public.agent_character_history FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_character_history: ALTER TABLE public.agent_character_history DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_character_history;

-- agent_custodianship_links
ALTER TABLE public.agent_custodianship_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_custodianship_links;
CREATE POLICY "service_role_all" ON public.agent_custodianship_links FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_custodianship_links: ALTER TABLE public.agent_custodianship_links DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_custodianship_links;

-- agent_directives
ALTER TABLE public.agent_directives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_directives;
CREATE POLICY "service_role_all" ON public.agent_directives FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_directives: ALTER TABLE public.agent_directives DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_directives;

-- agent_evergreen
ALTER TABLE public.agent_evergreen ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_evergreen;
CREATE POLICY "service_role_all" ON public.agent_evergreen FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_evergreen: ALTER TABLE public.agent_evergreen DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_evergreen;

-- agent_mcp_catalog
ALTER TABLE public.agent_mcp_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_mcp_catalog;
CREATE POLICY "service_role_all" ON public.agent_mcp_catalog FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_mcp_catalog: ALTER TABLE public.agent_mcp_catalog DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_mcp_catalog;

-- agent_name_suggestions
ALTER TABLE public.agent_name_suggestions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_name_suggestions;
CREATE POLICY "service_role_all" ON public.agent_name_suggestions FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_name_suggestions: ALTER TABLE public.agent_name_suggestions DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_name_suggestions;

-- agent_outputs
ALTER TABLE public.agent_outputs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_outputs;
CREATE POLICY "service_role_all" ON public.agent_outputs FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_outputs: ALTER TABLE public.agent_outputs DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_outputs;

-- agent_research_queue
ALTER TABLE public.agent_research_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_research_queue;
CREATE POLICY "service_role_all" ON public.agent_research_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_research_queue: ALTER TABLE public.agent_research_queue DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_research_queue;

-- agent_role_contributions
ALTER TABLE public.agent_role_contributions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_role_contributions;
CREATE POLICY "service_role_all" ON public.agent_role_contributions FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_role_contributions: ALTER TABLE public.agent_role_contributions DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_role_contributions;

-- agent_squad_map
ALTER TABLE public.agent_squad_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_squad_map;
CREATE POLICY "service_role_all" ON public.agent_squad_map FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_squad_map: ALTER TABLE public.agent_squad_map DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_squad_map;

-- agent_task_plans
ALTER TABLE public.agent_task_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_task_plans;
CREATE POLICY "service_role_all" ON public.agent_task_plans FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_task_plans: ALTER TABLE public.agent_task_plans DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_task_plans;

-- agent_updates
ALTER TABLE public.agent_updates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_updates;
CREATE POLICY "service_role_all" ON public.agent_updates FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_updates: ALTER TABLE public.agent_updates DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_updates;

-- agent_wake_signals
ALTER TABLE public.agent_wake_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_wake_signals;
CREATE POLICY "service_role_all" ON public.agent_wake_signals FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_wake_signals: ALTER TABLE public.agent_wake_signals DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_wake_signals;

-- agent_wisdom_history
ALTER TABLE public.agent_wisdom_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_wisdom_history;
CREATE POLICY "service_role_all" ON public.agent_wisdom_history FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback agent_wisdom_history: ALTER TABLE public.agent_wisdom_history DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.agent_wisdom_history;

-- ai_dispatch
ALTER TABLE public.ai_dispatch ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.ai_dispatch;
CREATE POLICY "service_role_all" ON public.ai_dispatch FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback ai_dispatch: ALTER TABLE public.ai_dispatch DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.ai_dispatch;

-- aidebate_vote_aggregates
ALTER TABLE public.aidebate_vote_aggregates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.aidebate_vote_aggregates;
CREATE POLICY "service_role_all" ON public.aidebate_vote_aggregates FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback aidebate_vote_aggregates: ALTER TABLE public.aidebate_vote_aggregates DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.aidebate_vote_aggregates;

-- anfis_params
ALTER TABLE public.anfis_params ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.anfis_params;
CREATE POLICY "service_role_all" ON public.anfis_params FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback anfis_params: ALTER TABLE public.anfis_params DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.anfis_params;

-- approved_counterparties
ALTER TABLE public.approved_counterparties ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.approved_counterparties;
CREATE POLICY "service_role_all" ON public.approved_counterparties FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback approved_counterparties: ALTER TABLE public.approved_counterparties DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.approved_counterparties;

-- ats_infrastructure
ALTER TABLE public.ats_infrastructure ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.ats_infrastructure;
CREATE POLICY "service_role_all" ON public.ats_infrastructure FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback ats_infrastructure: ALTER TABLE public.ats_infrastructure DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.ats_infrastructure;

-- autonomous_tasks
ALTER TABLE public.autonomous_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.autonomous_tasks;
CREATE POLICY "service_role_all" ON public.autonomous_tasks FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback autonomous_tasks: ALTER TABLE public.autonomous_tasks DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.autonomous_tasks;

-- backtest_variance
ALTER TABLE public.backtest_variance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.backtest_variance;
CREATE POLICY "service_role_all" ON public.backtest_variance FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback backtest_variance: ALTER TABLE public.backtest_variance DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.backtest_variance;

-- beneficiary_analysis
ALTER TABLE public.beneficiary_analysis ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.beneficiary_analysis;
CREATE POLICY "service_role_all" ON public.beneficiary_analysis FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback beneficiary_analysis: ALTER TABLE public.beneficiary_analysis DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.beneficiary_analysis;

-- brain_regions
ALTER TABLE public.brain_regions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.brain_regions;
CREATE POLICY "service_role_all" ON public.brain_regions FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback brain_regions: ALTER TABLE public.brain_regions DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.brain_regions;

-- compute_bids
ALTER TABLE public.compute_bids ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.compute_bids;
CREATE POLICY "service_role_all" ON public.compute_bids FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback compute_bids: ALTER TABLE public.compute_bids DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.compute_bids;

-- conductor_state
ALTER TABLE public.conductor_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.conductor_state;
CREATE POLICY "service_role_all" ON public.conductor_state FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback conductor_state: ALTER TABLE public.conductor_state DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.conductor_state;

-- cross_llm_comparisons
ALTER TABLE public.cross_llm_comparisons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.cross_llm_comparisons;
CREATE POLICY "service_role_all" ON public.cross_llm_comparisons FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback cross_llm_comparisons: ALTER TABLE public.cross_llm_comparisons DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.cross_llm_comparisons;

-- dag_edges
ALTER TABLE public.dag_edges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.dag_edges;
CREATE POLICY "service_role_all" ON public.dag_edges FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback dag_edges: ALTER TABLE public.dag_edges DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.dag_edges;

-- dag_nodes
ALTER TABLE public.dag_nodes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.dag_nodes;
CREATE POLICY "service_role_all" ON public.dag_nodes FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback dag_nodes: ALTER TABLE public.dag_nodes DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.dag_nodes;

-- daily_exposure_tracker
ALTER TABLE public.daily_exposure_tracker ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.daily_exposure_tracker;
CREATE POLICY "service_role_all" ON public.daily_exposure_tracker FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback daily_exposure_tracker: ALTER TABLE public.daily_exposure_tracker DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.daily_exposure_tracker;

-- db_routing_decisions
ALTER TABLE public.db_routing_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.db_routing_decisions;
CREATE POLICY "service_role_all" ON public.db_routing_decisions FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback db_routing_decisions: ALTER TABLE public.db_routing_decisions DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.db_routing_decisions;

-- db_tier_latency
ALTER TABLE public.db_tier_latency ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.db_tier_latency;
CREATE POLICY "service_role_all" ON public.db_tier_latency FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback db_tier_latency: ALTER TABLE public.db_tier_latency DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.db_tier_latency;

-- dbt_registry
ALTER TABLE public.dbt_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.dbt_registry;
CREATE POLICY "service_role_all" ON public.dbt_registry FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback dbt_registry: ALTER TABLE public.dbt_registry DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.dbt_registry;

-- dual_signature_policy
ALTER TABLE public.dual_signature_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.dual_signature_policy;
CREATE POLICY "service_role_all" ON public.dual_signature_policy FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback dual_signature_policy: ALTER TABLE public.dual_signature_policy DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.dual_signature_policy;

-- ecosystem_apps
ALTER TABLE public.ecosystem_apps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.ecosystem_apps;
CREATE POLICY "service_role_all" ON public.ecosystem_apps FOR ALL TO service_role USING (true) WITH CHECK (true);
-- FLAG: discovery/catalog surface — if a frontend reads this with the ANON key, uncomment:
--   DROP POLICY IF EXISTS "public_read" ON public.ecosystem_apps;
--   CREATE POLICY "public_read" ON public.ecosystem_apps FOR SELECT TO anon, authenticated USING (true);
-- rollback ecosystem_apps: ALTER TABLE public.ecosystem_apps DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.ecosystem_apps;

-- escalation_log
ALTER TABLE public.escalation_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.escalation_log;
CREATE POLICY "service_role_all" ON public.escalation_log FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback escalation_log: ALTER TABLE public.escalation_log DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.escalation_log;

-- execution_logs
ALTER TABLE public.execution_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.execution_logs;
CREATE POLICY "service_role_all" ON public.execution_logs FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback execution_logs: ALTER TABLE public.execution_logs DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.execution_logs;

-- experiment_registry
ALTER TABLE public.experiment_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.experiment_registry;
CREATE POLICY "service_role_all" ON public.experiment_registry FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback experiment_registry: ALTER TABLE public.experiment_registry DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.experiment_registry;

-- feature_registry
ALTER TABLE public.feature_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.feature_registry;
CREATE POLICY "service_role_all" ON public.feature_registry FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback feature_registry: ALTER TABLE public.feature_registry DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.feature_registry;

-- gemini_sprint_queue
ALTER TABLE public.gemini_sprint_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.gemini_sprint_queue;
CREATE POLICY "service_role_all" ON public.gemini_sprint_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback gemini_sprint_queue: ALTER TABLE public.gemini_sprint_queue DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.gemini_sprint_queue;

-- gmpd_log
ALTER TABLE public.gmpd_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.gmpd_log;
CREATE POLICY "service_role_all" ON public.gmpd_log FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback gmpd_log: ALTER TABLE public.gmpd_log DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.gmpd_log;

-- governance_proposals
ALTER TABLE public.governance_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.governance_proposals;
CREATE POLICY "service_role_all" ON public.governance_proposals FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback governance_proposals: ALTER TABLE public.governance_proposals DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.governance_proposals;

-- governance_votes
ALTER TABLE public.governance_votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.governance_votes;
CREATE POLICY "service_role_all" ON public.governance_votes FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback governance_votes: ALTER TABLE public.governance_votes DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.governance_votes;

-- ground_truth_facts
ALTER TABLE public.ground_truth_facts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.ground_truth_facts;
CREATE POLICY "service_role_all" ON public.ground_truth_facts FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback ground_truth_facts: ALTER TABLE public.ground_truth_facts DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.ground_truth_facts;

-- hal_anfis_snapshots
ALTER TABLE public.hal_anfis_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_anfis_snapshots;
CREATE POLICY "service_role_all" ON public.hal_anfis_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_anfis_snapshots: ALTER TABLE public.hal_anfis_snapshots DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_anfis_snapshots;

-- hal_antifragility_metrics
ALTER TABLE public.hal_antifragility_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_antifragility_metrics;
CREATE POLICY "service_role_all" ON public.hal_antifragility_metrics FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_antifragility_metrics: ALTER TABLE public.hal_antifragility_metrics DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_antifragility_metrics;

-- hal_audit_chain
ALTER TABLE public.hal_audit_chain ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_audit_chain;
CREATE POLICY "service_role_all" ON public.hal_audit_chain FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_audit_chain: ALTER TABLE public.hal_audit_chain DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_audit_chain;

-- hal_classifications
ALTER TABLE public.hal_classifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_classifications;
CREATE POLICY "service_role_all" ON public.hal_classifications FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_classifications: ALTER TABLE public.hal_classifications DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_classifications;

-- hal_evergreen_tasks
ALTER TABLE public.hal_evergreen_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_evergreen_tasks;
CREATE POLICY "service_role_all" ON public.hal_evergreen_tasks FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_evergreen_tasks: ALTER TABLE public.hal_evergreen_tasks DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_evergreen_tasks;

-- hal_federation_cycles
ALTER TABLE public.hal_federation_cycles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_federation_cycles;
CREATE POLICY "service_role_all" ON public.hal_federation_cycles FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_federation_cycles: ALTER TABLE public.hal_federation_cycles DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_federation_cycles;

-- hal_network_health
ALTER TABLE public.hal_network_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_network_health;
CREATE POLICY "service_role_all" ON public.hal_network_health FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_network_health: ALTER TABLE public.hal_network_health DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_network_health;

-- hal_production_events
ALTER TABLE public.hal_production_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_production_events;
CREATE POLICY "service_role_all" ON public.hal_production_events FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_production_events: ALTER TABLE public.hal_production_events DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_production_events;

-- hal_runner_results
ALTER TABLE public.hal_runner_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_runner_results;
CREATE POLICY "service_role_all" ON public.hal_runner_results FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_runner_results: ALTER TABLE public.hal_runner_results DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_runner_results;

-- hal_signals
ALTER TABLE public.hal_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_signals;
CREATE POLICY "service_role_all" ON public.hal_signals FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_signals: ALTER TABLE public.hal_signals DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_signals;

-- hal_threshold_sweeps
ALTER TABLE public.hal_threshold_sweeps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_threshold_sweeps;
CREATE POLICY "service_role_all" ON public.hal_threshold_sweeps FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_threshold_sweeps: ALTER TABLE public.hal_threshold_sweeps DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_threshold_sweeps;

-- hal_threshold_updates
ALTER TABLE public.hal_threshold_updates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_threshold_updates;
CREATE POLICY "service_role_all" ON public.hal_threshold_updates FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_threshold_updates: ALTER TABLE public.hal_threshold_updates DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_threshold_updates;

-- hal_training_cases
ALTER TABLE public.hal_training_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_training_cases;
CREATE POLICY "service_role_all" ON public.hal_training_cases FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_training_cases: ALTER TABLE public.hal_training_cases DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_training_cases;

-- harmonic_cycles
ALTER TABLE public.harmonic_cycles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.harmonic_cycles;
CREATE POLICY "service_role_all" ON public.harmonic_cycles FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback harmonic_cycles: ALTER TABLE public.harmonic_cycles DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.harmonic_cycles;

-- historical_wisdom_activations
ALTER TABLE public.historical_wisdom_activations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.historical_wisdom_activations;
CREATE POLICY "service_role_all" ON public.historical_wisdom_activations FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback historical_wisdom_activations: ALTER TABLE public.historical_wisdom_activations DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.historical_wisdom_activations;

-- hitl_requests
ALTER TABLE public.hitl_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hitl_requests;
CREATE POLICY "service_role_all" ON public.hitl_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hitl_requests: ALTER TABLE public.hitl_requests DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hitl_requests;

-- hitl_settings
ALTER TABLE public.hitl_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hitl_settings;
CREATE POLICY "service_role_all" ON public.hitl_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hitl_settings: ALTER TABLE public.hitl_settings DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hitl_settings;

-- human_intuition_scores
ALTER TABLE public.human_intuition_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.human_intuition_scores;
CREATE POLICY "service_role_all" ON public.human_intuition_scores FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback human_intuition_scores: ALTER TABLE public.human_intuition_scores DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.human_intuition_scores;

-- hyperdag_activity_catalog
ALTER TABLE public.hyperdag_activity_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hyperdag_activity_catalog;
CREATE POLICY "service_role_all" ON public.hyperdag_activity_catalog FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hyperdag_activity_catalog: ALTER TABLE public.hyperdag_activity_catalog DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hyperdag_activity_catalog;

-- hyperdag_ecosystem_registry
ALTER TABLE public.hyperdag_ecosystem_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hyperdag_ecosystem_registry;
CREATE POLICY "service_role_all" ON public.hyperdag_ecosystem_registry FOR ALL TO service_role USING (true) WITH CHECK (true);
-- FLAG: discovery/catalog surface — if a frontend reads this with the ANON key, uncomment:
--   DROP POLICY IF EXISTS "public_read" ON public.hyperdag_ecosystem_registry;
--   CREATE POLICY "public_read" ON public.hyperdag_ecosystem_registry FOR SELECT TO anon, authenticated USING (true);
-- rollback hyperdag_ecosystem_registry: ALTER TABLE public.hyperdag_ecosystem_registry DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hyperdag_ecosystem_registry;

-- hyperdag_governance_weights
ALTER TABLE public.hyperdag_governance_weights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hyperdag_governance_weights;
CREATE POLICY "service_role_all" ON public.hyperdag_governance_weights FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hyperdag_governance_weights: ALTER TABLE public.hyperdag_governance_weights DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hyperdag_governance_weights;

-- hyperdag_token_config
ALTER TABLE public.hyperdag_token_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hyperdag_token_config;
CREATE POLICY "service_role_all" ON public.hyperdag_token_config FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hyperdag_token_config: ALTER TABLE public.hyperdag_token_config DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hyperdag_token_config;

-- idea_backlog
ALTER TABLE public.idea_backlog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.idea_backlog;
CREATE POLICY "service_role_all" ON public.idea_backlog FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback idea_backlog: ALTER TABLE public.idea_backlog DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.idea_backlog;

-- indexer_state
ALTER TABLE public.indexer_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.indexer_state;
CREATE POLICY "service_role_all" ON public.indexer_state FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback indexer_state: ALTER TABLE public.indexer_state DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.indexer_state;

-- influencer_rep_scores
ALTER TABLE public.influencer_rep_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.influencer_rep_scores;
CREATE POLICY "service_role_all" ON public.influencer_rep_scores FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback influencer_rep_scores: ALTER TABLE public.influencer_rep_scores DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.influencer_rep_scores;

-- institution_config
ALTER TABLE public.institution_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.institution_config;
CREATE POLICY "service_role_all" ON public.institution_config FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback institution_config: ALTER TABLE public.institution_config DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.institution_config;

-- institution_risk_config
ALTER TABLE public.institution_risk_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.institution_risk_config;
CREATE POLICY "service_role_all" ON public.institution_risk_config FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback institution_risk_config: ALTER TABLE public.institution_risk_config DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.institution_risk_config;

-- jurisdiction_rules
ALTER TABLE public.jurisdiction_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.jurisdiction_rules;
CREATE POLICY "service_role_all" ON public.jurisdiction_rules FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback jurisdiction_rules: ALTER TABLE public.jurisdiction_rules DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.jurisdiction_rules;

-- lessons_learned
ALTER TABLE public.lessons_learned ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.lessons_learned;
CREATE POLICY "service_role_all" ON public.lessons_learned FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback lessons_learned: ALTER TABLE public.lessons_learned DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.lessons_learned;

-- memory_cold
ALTER TABLE public.memory_cold ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.memory_cold;
CREATE POLICY "service_role_all" ON public.memory_cold FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback memory_cold: ALTER TABLE public.memory_cold DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.memory_cold;

-- memory_glacier
ALTER TABLE public.memory_glacier ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.memory_glacier;
CREATE POLICY "service_role_all" ON public.memory_glacier FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback memory_glacier: ALTER TABLE public.memory_glacier DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.memory_glacier;

-- memory_warm
ALTER TABLE public.memory_warm ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.memory_warm;
CREATE POLICY "service_role_all" ON public.memory_warm FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback memory_warm: ALTER TABLE public.memory_warm DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.memory_warm;

-- peer_lessons
ALTER TABLE public.peer_lessons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.peer_lessons;
CREATE POLICY "service_role_all" ON public.peer_lessons FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback peer_lessons: ALTER TABLE public.peer_lessons DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.peer_lessons;

-- personal_truth_facts
ALTER TABLE public.personal_truth_facts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.personal_truth_facts;
CREATE POLICY "service_role_all" ON public.personal_truth_facts FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback personal_truth_facts: ALTER TABLE public.personal_truth_facts DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.personal_truth_facts;

-- prediction_consensus
ALTER TABLE public.prediction_consensus ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.prediction_consensus;
CREATE POLICY "service_role_all" ON public.prediction_consensus FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback prediction_consensus: ALTER TABLE public.prediction_consensus DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.prediction_consensus;

-- prediction_outcomes
ALTER TABLE public.prediction_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.prediction_outcomes;
CREATE POLICY "service_role_all" ON public.prediction_outcomes FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback prediction_outcomes: ALTER TABLE public.prediction_outcomes DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.prediction_outcomes;

-- prediction_postmortems
ALTER TABLE public.prediction_postmortems ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.prediction_postmortems;
CREATE POLICY "service_role_all" ON public.prediction_postmortems FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback prediction_postmortems: ALTER TABLE public.prediction_postmortems DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.prediction_postmortems;

-- prediction_regimes
ALTER TABLE public.prediction_regimes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.prediction_regimes;
CREATE POLICY "service_role_all" ON public.prediction_regimes FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback prediction_regimes: ALTER TABLE public.prediction_regimes DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.prediction_regimes;

-- prediction_signals
ALTER TABLE public.prediction_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.prediction_signals;
CREATE POLICY "service_role_all" ON public.prediction_signals FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback prediction_signals: ALTER TABLE public.prediction_signals DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.prediction_signals;

-- priority_stack
ALTER TABLE public.priority_stack ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.priority_stack;
CREATE POLICY "service_role_all" ON public.priority_stack FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback priority_stack: ALTER TABLE public.priority_stack DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.priority_stack;

-- product_bmc
ALTER TABLE public.product_bmc ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.product_bmc;
CREATE POLICY "service_role_all" ON public.product_bmc FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback product_bmc: ALTER TABLE public.product_bmc DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.product_bmc;

-- product_strategy
ALTER TABLE public.product_strategy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.product_strategy;
CREATE POLICY "service_role_all" ON public.product_strategy FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback product_strategy: ALTER TABLE public.product_strategy DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.product_strategy;

-- prompt_library
ALTER TABLE public.prompt_library ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.prompt_library;
CREATE POLICY "service_role_all" ON public.prompt_library FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback prompt_library: ALTER TABLE public.prompt_library DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.prompt_library;

-- provider_health
ALTER TABLE public.provider_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.provider_health;
CREATE POLICY "service_role_all" ON public.provider_health FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback provider_health: ALTER TABLE public.provider_health DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.provider_health;

-- retrieval_logs
ALTER TABLE public.retrieval_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.retrieval_logs;
CREATE POLICY "service_role_all" ON public.retrieval_logs FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback retrieval_logs: ALTER TABLE public.retrieval_logs DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.retrieval_logs;

-- schema_change_proposals
ALTER TABLE public.schema_change_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.schema_change_proposals;
CREATE POLICY "service_role_all" ON public.schema_change_proposals FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback schema_change_proposals: ALTER TABLE public.schema_change_proposals DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.schema_change_proposals;

-- semantic_cache
ALTER TABLE public.semantic_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.semantic_cache;
CREATE POLICY "service_role_all" ON public.semantic_cache FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback semantic_cache: ALTER TABLE public.semantic_cache DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.semantic_cache;

-- service_categories
ALTER TABLE public.service_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.service_categories;
CREATE POLICY "service_role_all" ON public.service_categories FOR ALL TO service_role USING (true) WITH CHECK (true);
-- FLAG: discovery/catalog surface — if a frontend reads this with the ANON key, uncomment:
--   DROP POLICY IF EXISTS "public_read" ON public.service_categories;
--   CREATE POLICY "public_read" ON public.service_categories FOR SELECT TO anon, authenticated USING (true);
-- rollback service_categories: ALTER TABLE public.service_categories DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.service_categories;

-- shares
ALTER TABLE public.shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.shares;
CREATE POLICY "service_role_all" ON public.shares FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback shares: ALTER TABLE public.shares DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.shares;

-- signal_library
ALTER TABLE public.signal_library ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.signal_library;
CREATE POLICY "service_role_all" ON public.signal_library FOR ALL TO service_role USING (true) WITH CHECK (true);
-- FLAG: discovery/catalog surface — if a frontend reads this with the ANON key, uncomment:
--   DROP POLICY IF EXISTS "public_read" ON public.signal_library;
--   CREATE POLICY "public_read" ON public.signal_library FOR SELECT TO anon, authenticated USING (true);
-- rollback signal_library: ALTER TABLE public.signal_library DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.signal_library;

-- signal_responses
ALTER TABLE public.signal_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.signal_responses;
CREATE POLICY "service_role_all" ON public.signal_responses FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback signal_responses: ALTER TABLE public.signal_responses DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.signal_responses;

-- social_content_queue
ALTER TABLE public.social_content_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.social_content_queue;
CREATE POLICY "service_role_all" ON public.social_content_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback social_content_queue: ALTER TABLE public.social_content_queue DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.social_content_queue;

-- social_mirror_analyses
ALTER TABLE public.social_mirror_analyses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.social_mirror_analyses;
CREATE POLICY "service_role_all" ON public.social_mirror_analyses FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback social_mirror_analyses: ALTER TABLE public.social_mirror_analyses DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.social_mirror_analyses;

-- sprint_queue
ALTER TABLE public.sprint_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.sprint_queue;
CREATE POLICY "service_role_all" ON public.sprint_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback sprint_queue: ALTER TABLE public.sprint_queue DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.sprint_queue;

-- sprint_reports
ALTER TABLE public.sprint_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.sprint_reports;
CREATE POLICY "service_role_all" ON public.sprint_reports FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback sprint_reports: ALTER TABLE public.sprint_reports DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.sprint_reports;

-- stewardship_relationships
ALTER TABLE public.stewardship_relationships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.stewardship_relationships;
CREATE POLICY "service_role_all" ON public.stewardship_relationships FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback stewardship_relationships: ALTER TABLE public.stewardship_relationships DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.stewardship_relationships;

-- storage_contracts
ALTER TABLE public.storage_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.storage_contracts;
CREATE POLICY "service_role_all" ON public.storage_contracts FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback storage_contracts: ALTER TABLE public.storage_contracts DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.storage_contracts;

-- substance_gate_events
ALTER TABLE public.substance_gate_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.substance_gate_events;
CREATE POLICY "service_role_all" ON public.substance_gate_events FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback substance_gate_events: ALTER TABLE public.substance_gate_events DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.substance_gate_events;

-- sync_config
ALTER TABLE public.sync_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.sync_config;
CREATE POLICY "service_role_all" ON public.sync_config FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback sync_config: ALTER TABLE public.sync_config DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.sync_config;

-- system_broadcasts
ALTER TABLE public.system_broadcasts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.system_broadcasts;
CREATE POLICY "service_role_all" ON public.system_broadcasts FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback system_broadcasts: ALTER TABLE public.system_broadcasts DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.system_broadcasts;

-- system_metrics_daily
ALTER TABLE public.system_metrics_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.system_metrics_daily;
CREATE POLICY "service_role_all" ON public.system_metrics_daily FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback system_metrics_daily: ALTER TABLE public.system_metrics_daily DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.system_metrics_daily;

-- system_truth
ALTER TABLE public.system_truth ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.system_truth;
CREATE POLICY "service_role_all" ON public.system_truth FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback system_truth: ALTER TABLE public.system_truth DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.system_truth;

-- team_coordination_log
ALTER TABLE public.team_coordination_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.team_coordination_log;
CREATE POLICY "service_role_all" ON public.team_coordination_log FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback team_coordination_log: ALTER TABLE public.team_coordination_log DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.team_coordination_log;

-- trading_rounds
ALTER TABLE public.trading_rounds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trading_rounds;
CREATE POLICY "service_role_all" ON public.trading_rounds FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trading_rounds: ALTER TABLE public.trading_rounds DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trading_rounds;

-- trinity_agent_benchmarks
ALTER TABLE public.trinity_agent_benchmarks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_agent_benchmarks;
CREATE POLICY "service_role_all" ON public.trinity_agent_benchmarks FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_agent_benchmarks: ALTER TABLE public.trinity_agent_benchmarks DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_agent_benchmarks;

-- trinity_agent_directives
ALTER TABLE public.trinity_agent_directives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_agent_directives;
CREATE POLICY "service_role_all" ON public.trinity_agent_directives FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_agent_directives: ALTER TABLE public.trinity_agent_directives DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_agent_directives;

-- trinity_agent_groups
ALTER TABLE public.trinity_agent_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_agent_groups;
CREATE POLICY "service_role_all" ON public.trinity_agent_groups FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_agent_groups: ALTER TABLE public.trinity_agent_groups DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_agent_groups;

-- trinity_audit_trail_status
ALTER TABLE public.trinity_audit_trail_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_audit_trail_status;
CREATE POLICY "service_role_all" ON public.trinity_audit_trail_status FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_audit_trail_status: ALTER TABLE public.trinity_audit_trail_status DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_audit_trail_status;

-- trinity_collaborations
ALTER TABLE public.trinity_collaborations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_collaborations;
CREATE POLICY "service_role_all" ON public.trinity_collaborations FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_collaborations: ALTER TABLE public.trinity_collaborations DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_collaborations;

-- trinity_deployment_events
ALTER TABLE public.trinity_deployment_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_deployment_events;
CREATE POLICY "service_role_all" ON public.trinity_deployment_events FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_deployment_events: ALTER TABLE public.trinity_deployment_events DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_deployment_events;

-- trinity_deployment_manifest
ALTER TABLE public.trinity_deployment_manifest ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_deployment_manifest;
CREATE POLICY "service_role_all" ON public.trinity_deployment_manifest FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_deployment_manifest: ALTER TABLE public.trinity_deployment_manifest DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_deployment_manifest;

-- trinity_experiments
ALTER TABLE public.trinity_experiments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_experiments;
CREATE POLICY "service_role_all" ON public.trinity_experiments FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_experiments: ALTER TABLE public.trinity_experiments DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_experiments;

-- trinity_filter_configs
ALTER TABLE public.trinity_filter_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_filter_configs;
CREATE POLICY "service_role_all" ON public.trinity_filter_configs FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_filter_configs: ALTER TABLE public.trinity_filter_configs DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_filter_configs;

-- trinity_fixes
ALTER TABLE public.trinity_fixes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_fixes;
CREATE POLICY "service_role_all" ON public.trinity_fixes FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_fixes: ALTER TABLE public.trinity_fixes DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_fixes;

-- trinity_gemini_queue
ALTER TABLE public.trinity_gemini_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_gemini_queue;
CREATE POLICY "service_role_all" ON public.trinity_gemini_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_gemini_queue: ALTER TABLE public.trinity_gemini_queue DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_gemini_queue;

-- trinity_hallucination_logs
ALTER TABLE public.trinity_hallucination_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_hallucination_logs;
CREATE POLICY "service_role_all" ON public.trinity_hallucination_logs FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_hallucination_logs: ALTER TABLE public.trinity_hallucination_logs DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_hallucination_logs;

-- trinity_hitl_decisions
ALTER TABLE public.trinity_hitl_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_hitl_decisions;
CREATE POLICY "service_role_all" ON public.trinity_hitl_decisions FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_hitl_decisions: ALTER TABLE public.trinity_hitl_decisions DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_hitl_decisions;

-- trinity_langgraph_checkpoints
ALTER TABLE public.trinity_langgraph_checkpoints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_langgraph_checkpoints;
CREATE POLICY "service_role_all" ON public.trinity_langgraph_checkpoints FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_langgraph_checkpoints: ALTER TABLE public.trinity_langgraph_checkpoints DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_langgraph_checkpoints;

-- trinity_learned_patterns
ALTER TABLE public.trinity_learned_patterns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_learned_patterns;
CREATE POLICY "service_role_all" ON public.trinity_learned_patterns FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_learned_patterns: ALTER TABLE public.trinity_learned_patterns DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_learned_patterns;

-- trinity_mcp_handoffs
ALTER TABLE public.trinity_mcp_handoffs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_mcp_handoffs;
CREATE POLICY "service_role_all" ON public.trinity_mcp_handoffs FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_mcp_handoffs: ALTER TABLE public.trinity_mcp_handoffs DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_mcp_handoffs;

-- trinity_memories
ALTER TABLE public.trinity_memories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_memories;
CREATE POLICY "service_role_all" ON public.trinity_memories FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_memories: ALTER TABLE public.trinity_memories DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_memories;

-- trinity_protected_tasks
ALTER TABLE public.trinity_protected_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_protected_tasks;
CREATE POLICY "service_role_all" ON public.trinity_protected_tasks FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_protected_tasks: ALTER TABLE public.trinity_protected_tasks DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_protected_tasks;

-- trinity_receipt_bft_results
ALTER TABLE public.trinity_receipt_bft_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_receipt_bft_results;
CREATE POLICY "service_role_all" ON public.trinity_receipt_bft_results FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_receipt_bft_results: ALTER TABLE public.trinity_receipt_bft_results DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_receipt_bft_results;

-- trinity_receipt_validators
ALTER TABLE public.trinity_receipt_validators ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_receipt_validators;
CREATE POLICY "service_role_all" ON public.trinity_receipt_validators FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_receipt_validators: ALTER TABLE public.trinity_receipt_validators DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_receipt_validators;

-- trinity_shofet_rulings
ALTER TABLE public.trinity_shofet_rulings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_shofet_rulings;
CREATE POLICY "service_role_all" ON public.trinity_shofet_rulings FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_shofet_rulings: ALTER TABLE public.trinity_shofet_rulings DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_shofet_rulings;

-- trinity_skills
ALTER TABLE public.trinity_skills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_skills;
CREATE POLICY "service_role_all" ON public.trinity_skills FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_skills: ALTER TABLE public.trinity_skills DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_skills;

-- trinity_task_templates
ALTER TABLE public.trinity_task_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_task_templates;
CREATE POLICY "service_role_all" ON public.trinity_task_templates FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_task_templates: ALTER TABLE public.trinity_task_templates DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_task_templates;

-- trinity_tool_usage
ALTER TABLE public.trinity_tool_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_tool_usage;
CREATE POLICY "service_role_all" ON public.trinity_tool_usage FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_tool_usage: ALTER TABLE public.trinity_tool_usage DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_tool_usage;

-- trinity_whistleblower_reports
ALTER TABLE public.trinity_whistleblower_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_whistleblower_reports;
CREATE POLICY "service_role_all" ON public.trinity_whistleblower_reports FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_whistleblower_reports: ALTER TABLE public.trinity_whistleblower_reports DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_whistleblower_reports;

-- trinity_wisdom_crystallizations
ALTER TABLE public.trinity_wisdom_crystallizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trinity_wisdom_crystallizations;
CREATE POLICY "service_role_all" ON public.trinity_wisdom_crystallizations FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trinity_wisdom_crystallizations: ALTER TABLE public.trinity_wisdom_crystallizations DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trinity_wisdom_crystallizations;

-- trustcre_deal_log
ALTER TABLE public.trustcre_deal_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustcre_deal_log;
CREATE POLICY "service_role_all" ON public.trustcre_deal_log FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustcre_deal_log: ALTER TABLE public.trustcre_deal_log DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustcre_deal_log;

-- trustex_decay_schedule
ALTER TABLE public.trustex_decay_schedule ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustex_decay_schedule;
CREATE POLICY "service_role_all" ON public.trustex_decay_schedule FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustex_decay_schedule: ALTER TABLE public.trustex_decay_schedule DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustex_decay_schedule;

-- trustex_rep_events
ALTER TABLE public.trustex_rep_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustex_rep_events;
CREATE POLICY "service_role_all" ON public.trustex_rep_events FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustex_rep_events: ALTER TABLE public.trustex_rep_events DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustex_rep_events;

-- trustex_signal_matches
ALTER TABLE public.trustex_signal_matches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustex_signal_matches;
CREATE POLICY "service_role_all" ON public.trustex_signal_matches FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustex_signal_matches: ALTER TABLE public.trustex_signal_matches DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustex_signal_matches;

-- trustex_signals_catalog
ALTER TABLE public.trustex_signals_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustex_signals_catalog;
CREATE POLICY "service_role_all" ON public.trustex_signals_catalog FOR ALL TO service_role USING (true) WITH CHECK (true);
-- FLAG: discovery/catalog surface — if a frontend reads this with the ANON key, uncomment:
--   DROP POLICY IF EXISTS "public_read" ON public.trustex_signals_catalog;
--   CREATE POLICY "public_read" ON public.trustex_signals_catalog FOR SELECT TO anon, authenticated USING (true);
-- rollback trustex_signals_catalog: ALTER TABLE public.trustex_signals_catalog DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustex_signals_catalog;

-- trustex_user_preferences
ALTER TABLE public.trustex_user_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustex_user_preferences;
CREATE POLICY "service_role_all" ON public.trustex_user_preferences FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustex_user_preferences: ALTER TABLE public.trustex_user_preferences DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustex_user_preferences;

-- trustex_yield_outcomes
ALTER TABLE public.trustex_yield_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustex_yield_outcomes;
CREATE POLICY "service_role_all" ON public.trustex_yield_outcomes FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustex_yield_outcomes: ALTER TABLE public.trustex_yield_outcomes DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustex_yield_outcomes;

-- trustrails_agent_verifications
ALTER TABLE public.trustrails_agent_verifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustrails_agent_verifications;
CREATE POLICY "service_role_all" ON public.trustrails_agent_verifications FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustrails_agent_verifications: ALTER TABLE public.trustrails_agent_verifications DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustrails_agent_verifications;

-- trustrails_challenge_events
ALTER TABLE public.trustrails_challenge_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustrails_challenge_events;
CREATE POLICY "service_role_all" ON public.trustrails_challenge_events FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustrails_challenge_events: ALTER TABLE public.trustrails_challenge_events DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustrails_challenge_events;

-- trustrails_challenges
ALTER TABLE public.trustrails_challenges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustrails_challenges;
CREATE POLICY "service_role_all" ON public.trustrails_challenges FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustrails_challenges: ALTER TABLE public.trustrails_challenges DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustrails_challenges;

-- trustrails_participants
ALTER TABLE public.trustrails_participants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustrails_participants;
CREATE POLICY "service_role_all" ON public.trustrails_participants FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustrails_participants: ALTER TABLE public.trustrails_participants DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustrails_participants;

-- trustshell_agents
ALTER TABLE public.trustshell_agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_agents;
CREATE POLICY "service_role_all" ON public.trustshell_agents FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustshell_agents: ALTER TABLE public.trustshell_agents DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_agents;

-- trustshell_decisions
ALTER TABLE public.trustshell_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_decisions;
CREATE POLICY "service_role_all" ON public.trustshell_decisions FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustshell_decisions: ALTER TABLE public.trustshell_decisions DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_decisions;

-- trustshell_ecosystem
ALTER TABLE public.trustshell_ecosystem ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_ecosystem;
CREATE POLICY "service_role_all" ON public.trustshell_ecosystem FOR ALL TO service_role USING (true) WITH CHECK (true);
-- FLAG: discovery/catalog surface — if a frontend reads this with the ANON key, uncomment:
--   DROP POLICY IF EXISTS "public_read" ON public.trustshell_ecosystem;
--   CREATE POLICY "public_read" ON public.trustshell_ecosystem FOR SELECT TO anon, authenticated USING (true);
-- rollback trustshell_ecosystem: ALTER TABLE public.trustshell_ecosystem DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_ecosystem;

-- trustshell_sprint_log
ALTER TABLE public.trustshell_sprint_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_sprint_log;
CREATE POLICY "service_role_all" ON public.trustshell_sprint_log FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustshell_sprint_log: ALTER TABLE public.trustshell_sprint_log DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_sprint_log;

-- trustshell_tool_receipts
ALTER TABLE public.trustshell_tool_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_tool_receipts;
CREATE POLICY "service_role_all" ON public.trustshell_tool_receipts FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustshell_tool_receipts: ALTER TABLE public.trustshell_tool_receipts DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_tool_receipts;

-- trustshell_trade_decisions
ALTER TABLE public.trustshell_trade_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_trade_decisions;
CREATE POLICY "service_role_all" ON public.trustshell_trade_decisions FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustshell_trade_decisions: ALTER TABLE public.trustshell_trade_decisions DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_trade_decisions;

-- trustshell_trade_executions
ALTER TABLE public.trustshell_trade_executions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_trade_executions;
CREATE POLICY "service_role_all" ON public.trustshell_trade_executions FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustshell_trade_executions: ALTER TABLE public.trustshell_trade_executions DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_trade_executions;

-- trustshell_trade_signals
ALTER TABLE public.trustshell_trade_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_trade_signals;
CREATE POLICY "service_role_all" ON public.trustshell_trade_signals FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustshell_trade_signals: ALTER TABLE public.trustshell_trade_signals DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustshell_trade_signals;

-- trusttrader_agent_cards
ALTER TABLE public.trusttrader_agent_cards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trusttrader_agent_cards;
CREATE POLICY "service_role_all" ON public.trusttrader_agent_cards FOR ALL TO service_role USING (true) WITH CHECK (true);
-- FLAG: discovery/catalog surface — if a frontend reads this with the ANON key, uncomment:
--   DROP POLICY IF EXISTS "public_read" ON public.trusttrader_agent_cards;
--   CREATE POLICY "public_read" ON public.trusttrader_agent_cards FOR SELECT TO anon, authenticated USING (true);
-- rollback trusttrader_agent_cards: ALTER TABLE public.trusttrader_agent_cards DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trusttrader_agent_cards;

-- trusttrader_share_cards
ALTER TABLE public.trusttrader_share_cards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trusttrader_share_cards;
CREATE POLICY "service_role_all" ON public.trusttrader_share_cards FOR ALL TO service_role USING (true) WITH CHECK (true);
-- FLAG: discovery/catalog surface — if a frontend reads this with the ANON key, uncomment:
--   DROP POLICY IF EXISTS "public_read" ON public.trusttrader_share_cards;
--   CREATE POLICY "public_read" ON public.trusttrader_share_cards FOR SELECT TO anon, authenticated USING (true);
-- rollback trusttrader_share_cards: ALTER TABLE public.trusttrader_share_cards DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trusttrader_share_cards;

-- trusttrader_signal_licenses
ALTER TABLE public.trusttrader_signal_licenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trusttrader_signal_licenses;
CREATE POLICY "service_role_all" ON public.trusttrader_signal_licenses FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trusttrader_signal_licenses: ALTER TABLE public.trusttrader_signal_licenses DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trusttrader_signal_licenses;

-- trusttrader_signals
ALTER TABLE public.trusttrader_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trusttrader_signals;
CREATE POLICY "service_role_all" ON public.trusttrader_signals FOR ALL TO service_role USING (true) WITH CHECK (true);
-- FLAG: discovery/catalog surface — if a frontend reads this with the ANON key, uncomment:
--   DROP POLICY IF EXISTS "public_read" ON public.trusttrader_signals;
--   CREATE POLICY "public_read" ON public.trusttrader_signals FOR SELECT TO anon, authenticated USING (true);
-- rollback trusttrader_signals: ALTER TABLE public.trusttrader_signals DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trusttrader_signals;

-- validation_artifacts
ALTER TABLE public.validation_artifacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.validation_artifacts;
CREATE POLICY "service_role_all" ON public.validation_artifacts FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback validation_artifacts: ALTER TABLE public.validation_artifacts DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.validation_artifacts;

-- validation_queue
ALTER TABLE public.validation_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.validation_queue;
CREATE POLICY "service_role_all" ON public.validation_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback validation_queue: ALTER TABLE public.validation_queue DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.validation_queue;

-- verification_audits
ALTER TABLE public.verification_audits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.verification_audits;
CREATE POLICY "service_role_all" ON public.verification_audits FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback verification_audits: ALTER TABLE public.verification_audits DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.verification_audits;

-- virtue_narratives
ALTER TABLE public.virtue_narratives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.virtue_narratives;
CREATE POLICY "service_role_all" ON public.virtue_narratives FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback virtue_narratives: ALTER TABLE public.virtue_narratives DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.virtue_narratives;

-- voc_signals
ALTER TABLE public.voc_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.voc_signals;
CREATE POLICY "service_role_all" ON public.voc_signals FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback voc_signals: ALTER TABLE public.voc_signals DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.voc_signals;

-- vouch_relationships
ALTER TABLE public.vouch_relationships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.vouch_relationships;
CREATE POLICY "service_role_all" ON public.vouch_relationships FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback vouch_relationships: ALTER TABLE public.vouch_relationships DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.vouch_relationships;


-- ─────────────────────────────────────────────────────────────────────────
-- TIER D — test / ephemeral / schema-dump (lock anyway; deny anon)  (10 tables)
-- ─────────────────────────────────────────────────────────────────────────

-- _temp_ext
ALTER TABLE public._temp_ext ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public._temp_ext;
CREATE POLICY "service_role_all" ON public._temp_ext FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback _temp_ext: ALTER TABLE public._temp_ext DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public._temp_ext;

-- _temp_rls
ALTER TABLE public._temp_rls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public._temp_rls;
CREATE POLICY "service_role_all" ON public._temp_rls FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback _temp_rls: ALTER TABLE public._temp_rls DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public._temp_rls;

-- _temp_sig
ALTER TABLE public._temp_sig ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public._temp_sig;
CREATE POLICY "service_role_all" ON public._temp_sig FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback _temp_sig: ALTER TABLE public._temp_sig DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public._temp_sig;

-- _temp_triggers
ALTER TABLE public._temp_triggers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public._temp_triggers;
CREATE POLICY "service_role_all" ON public._temp_triggers FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback _temp_triggers: ALTER TABLE public._temp_triggers DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public._temp_triggers;

-- demo_sessions
ALTER TABLE public.demo_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.demo_sessions;
CREATE POLICY "service_role_all" ON public.demo_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback demo_sessions: ALTER TABLE public.demo_sessions DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.demo_sessions;

-- hal_test_prompts
ALTER TABLE public.hal_test_prompts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hal_test_prompts;
CREATE POLICY "service_role_all" ON public.hal_test_prompts FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback hal_test_prompts: ALTER TABLE public.hal_test_prompts DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.hal_test_prompts;

-- planted_error_events
ALTER TABLE public.planted_error_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.planted_error_events;
CREATE POLICY "service_role_all" ON public.planted_error_events FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback planted_error_events: ALTER TABLE public.planted_error_events DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.planted_error_events;

-- supabase_schema_baseline
ALTER TABLE public.supabase_schema_baseline ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.supabase_schema_baseline;
CREATE POLICY "service_role_all" ON public.supabase_schema_baseline FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback supabase_schema_baseline: ALTER TABLE public.supabase_schema_baseline DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.supabase_schema_baseline;

-- trustrails_demo_claims
ALTER TABLE public.trustrails_demo_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustrails_demo_claims;
CREATE POLICY "service_role_all" ON public.trustrails_demo_claims FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustrails_demo_claims: ALTER TABLE public.trustrails_demo_claims DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustrails_demo_claims;

-- trustrails_demo_sessions
ALTER TABLE public.trustrails_demo_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.trustrails_demo_sessions;
CREATE POLICY "service_role_all" ON public.trustrails_demo_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);
-- rollback trustrails_demo_sessions: ALTER TABLE public.trustrails_demo_sessions DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON public.trustrails_demo_sessions;


COMMIT;

-- ── FULL ROLLBACK (if needed) ────────────────────────────────────────────
-- Disable RLS + drop the policy on every table touched above. Reverse order is fine.
-- (Per-table rollback lines are inline above for selective rollback.)
