-- S-SEC3: RLS Agent-State Batch (74) + Sensitive OTHER Triage (Roadmap S-SEC3)
-- DESIGN ONLY — extends S-SEC2 Critical-17
-- Based on authoritative RLS_242_DISABLED_TABLES.md (2026-05-30)
-- Sean applies per sub-batch with Cowork co-sign after CC verification.
--
-- Classes for this batch:
-- A. AGENT-STATE core (service_role full + limited owner read where user-linked)
-- B. Sensitive OTHER (paper_trades, governance_votes, hitl_*, *_signals, memory_*) — treat as elevated (CRITICAL-like or strong owner + service_role)

BEGIN;

-- =====================================================
-- CLASS A: AGENT-STATE (74 tables) — service_role primary
-- Most are internal operational. Enable RLS with service_role full access.
-- Add owner policies only for clearly user-owned (e.g. agent_services, agent_directives).
-- Example for representative tables; repeat pattern for the full 74.
-- =====================================================

-- trinity_tasks (core orchestration)
ALTER TABLE trinity_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON trinity_tasks FOR ALL TO service_role USING (true) WITH CHECK (true);
-- Owner/agent read if linked
CREATE POLICY "agent_owner_read" ON trinity_tasks FOR SELECT TO authenticated USING (assigned_to = current_setting('app.current_agent_id', true) OR claimed_by = ...);

-- hal_* family (many: hal_production_events, hal_audit_chain, hal_classifications, hal_runner_results, hal_training_cases, etc.)
-- Group: service_role full (these are evaluation internals)
ALTER TABLE hal_production_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON hal_production_events FOR ALL TO service_role USING (true) WITH CHECK (true);

-- (Repeat identical service_role_full for: hal_anfis_snapshots, hal_antifragility_metrics, hal_audit_chain, hal_classifications, hal_evergreen_tasks, hal_federation_cycles, hal_network_health, hal_runner_results, hal_signals, hal_test_prompts, hal_threshold_sweeps, hal_threshold_updates, hal_training_cases ... and the rest of the 74 as listed in RLS_242_DISABLED_TABLES.md section 2)

-- repid_* family (beyond the critical ones already done in S-SEC2)
-- repid_score_events was moved to S-SEC2 F2 batch. For others:
ALTER TABLE repid_zkp_proofs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON repid_zkp_proofs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- validation_queue, dispute_validation_queue, etc.
ALTER TABLE validation_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON validation_queue FOR ALL TO service_role USING (true) WITH CHECK (true);

-- agent_services, agent_directives (user-facing, add owner)
ALTER TABLE agent_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON agent_services FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "owner" ON agent_services FOR ALL TO authenticated USING (agent_id = current_setting('app.current_agent_id', true)) WITH CHECK (same);

-- (Full list of 74 to be expanded from the authoritative file: agent_a2a_cards, agent_accuracy_matrix, ... zkp_repid_architecture — all get service_role_full base + owner where ownership column exists.)

-- =====================================================
-- CLASS B: Sensitive OTHER triage (from the 144)
-- paper_trades / paper_trade_orders — economic, treat CRITICAL-like
-- governance_votes, governance_proposals — governance integrity
-- hitl_* (hitl_requests, hitl_settings, trinity_hitl_decisions) — human oversight
-- *_signals (insider_trading_signals, prediction_signals, tax_harvest_signals, etc.) — sensitive intel
-- memory_* (memory_cold, memory_glacier, memory_warm) — user/agent memory
-- Others in 144 mostly operational or low-sensitivity (can stay disabled longer or minimal policies).
-- =====================================================

-- paper_trades (high forgery/economic risk — similar to S-SEC2 stakes)
ALTER TABLE paper_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON paper_trades FOR ALL TO service_role USING (true) WITH CHECK (true);
-- Owner read/write
CREATE POLICY "owner" ON paper_trades FOR ALL TO authenticated USING (agent_id = current_setting('app.current_agent_id', true)) WITH CHECK (same);

-- governance_votes / governance_proposals
ALTER TABLE governance_votes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON governance_votes FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_vote" ON governance_votes FOR INSERT TO authenticated WITH CHECK (voter_agent_id = current_setting('app.current_agent_id', true));

-- hitl_* family
ALTER TABLE hitl_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON hitl_requests FOR ALL TO service_role USING (true) WITH CHECK (true);

-- memory_* (user private)
ALTER TABLE memory_warm ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON memory_warm FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "owner" ON memory_warm FOR ALL TO authenticated USING (agent_id = current_setting('app.current_agent_id', true)) WITH CHECK (same);

-- (Triage note: The remaining ~120 in OTHER are lower priority — can be batched later with minimal or no policies, or dropped if temp/scratch. Full list in RLS_242_DISABLED_TABLES.md section 5.)

COMMIT;

-- Notes for applier (same as S-SEC2):
-- Run in small sub-batches (e.g. 15-20 tables).
-- After each sub-batch: run verification queries (anon blocked on sensitive, service_role works).
-- Rollback per table: ALTER TABLE name DISABLE ROW LEVEL SECURITY;
-- Prioritize within this batch: paper_trades, governance_*, hitl_*, memory_* first among the OTHER.