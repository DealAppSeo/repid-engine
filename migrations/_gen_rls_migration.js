/* S-RLS-LOCKDOWN generator (2026-06-01). Emits an ordered, reviewable RLS migration:
 * D1 TOP-8 first, then sensitive, operational, test/ephemeral. Every table gets ENABLE RLS +
 * a service_role-FULL policy (service-role/postgres bypass RLS → live writers unaffected; the
 * lock is that anon/authenticated get NO policy → denied). Per-table rollback line. NOT applied. */
'use strict';
const fs = require('fs');

// name|approx_rows|testflag  (live [sql:2026-06-01], 241 RLS-disabled public tables)
const RAW = `_temp_ext|-1|T
_temp_rls|-1|T
_temp_sig|-1|T
_temp_triggers|-1|T
accountability_tiers|-1|N
agent_a2a_cards|-1|N
agent_accuracy_matrix|-1|N
agent_artifacts_sprint_0|-1|N
agent_capability_scores|-1|N
agent_character_history|-1|N
agent_custodianship_links|-1|N
agent_directives|-1|N
agent_evergreen|-1|N
agent_mcp_catalog|-1|N
agent_name_suggestions|-1|N
agent_outputs|-1|N
agent_repid_history|-1|N
agent_research_queue|23|N
agent_role_contributions|-1|N
agent_services|-1|N
agent_squad_map|-1|N
agent_task_plans|-1|N
agent_updates|-1|N
agent_wake_signals|-1|N
agent_wisdom_history|-1|N
ai_dispatch|-1|N
aidebate_vote_aggregates|-1|N
anfis_params|-1|N
approved_counterparties|-1|N
ats_infrastructure|-1|N
autonomous_tasks|-1|N
backtest_variance|-1|N
beneficiary_analysis|-1|N
brain_regions|-1|N
compute_bids|-1|N
conductor_state|8|N
confidence_stakes|-1|N
cross_llm_comparisons|237|N
dag_edges|-1|N
dag_nodes|-1|N
daily_exposure_tracker|-1|N
db_routing_decisions|-1|N
db_tier_latency|-1|N
dbt_registry|1|N
defect_4_validation_log|-1|N
demo_sessions|-1|T
dispute_validation_queue|19|N
dual_signature_policy|-1|N
ecosystem_apps|-1|N
erc8004_data_packets|-1|N
erc8004_data_tiers|-1|N
escalation_log|6930|N
execution_logs|-1|N
experiment_registry|-1|N
feature_registry|36|N
gemini_sprint_queue|-1|N
gmpd_log|57|N
governance_proposals|-1|N
governance_votes|-1|N
ground_truth_facts|119|N
hal_anfis_snapshots|0|N
hal_antifragility_metrics|-1|N
hal_audit_chain|12764|N
hal_classifications|39861|N
hal_evergreen_tasks|-1|N
hal_federation_cycles|-1|N
hal_network_health|-1|N
hal_production_events|-1|N
hal_runner_results|1360|N
hal_signals|-1|N
hal_test_prompts|100|T
hal_threshold_sweeps|267|N
hal_threshold_updates|1437|N
hal_training_cases|1455|N
harmonic_cycles|-1|N
historical_wisdom_activations|-1|N
hitl_requests|-1|N
hitl_settings|-1|N
human_intuition_scores|-1|N
human_sbt_mints|-1|N
human_sbt_registry|-1|N
hyperdag_activity_catalog|-1|N
hyperdag_ecosystem_registry|-1|N
hyperdag_governance_weights|-1|N
hyperdag_points_ledger|-1|N
hyperdag_receipts|-1|N
hyperdag_token_config|-1|N
idea_backlog|-1|N
indexer_state|-1|N
influencer_rep_scores|-1|N
insider_trading_signals|-1|N
institution_config|-1|N
institution_risk_config|-1|N
invite_chains|-1|N
jurisdiction_rules|-1|N
lessons_learned|-1|N
linked_bets|52|N
memory_cold|-1|N
memory_glacier|-1|N
memory_warm|-1|N
merkle_batches|-1|N
paper_trade_orders|-1|N
paper_trades|-1|N
peer_lessons|-1|N
perceived_repid_assessments|-1|N
permissioned_vaults|-1|N
personal_truth_facts|-1|N
planted_error_events|-1|N
prediction_consensus|-1|N
prediction_outcomes|-1|N
prediction_postmortems|-1|N
prediction_regimes|-1|N
prediction_signals|-1|N
priority_stack|-1|N
product_bmc|-1|N
product_strategy|-1|N
prompt_library|-1|N
provider_health|-1|N
push_subscriptions|-1|N
repid_adversarial_immunity|-1|N
repid_agent_stakes|-1|N
repid_badges|-1|N
repid_bounties|-1|N
repid_claims|-1|N
repid_credentials|6|N
repid_ecosystem_supply|-1|N
repid_endorsements|-1|N
repid_events|1035|N
repid_inflation_alerts|-1|N
repid_mcp_tools|-1|N
repid_mentorship_bonds|-1|N
repid_merkle_events|-1|N
repid_permissions|-1|N
repid_proof_queue|44282|N
repid_score_events|47097|N
repid_scores|-1|N
repid_stakes|-1|N
repid_telemetry_snapshots|-1|N
repid_trade_attempts|-1|N
repid_verified_decisions|61|N
repid_wisdom_scores|-1|N
repid_zkp_proofs|41046|N
reputation_attestations|-1|N
retrieval_logs|-1|N
schema_change_proposals|-1|N
semantic_cache|-1|N
service_categories|-1|N
service_contracts|112|N
shares|-1|N
signal_library|-1|N
signal_responses|-1|N
social_content_queue|15|N
social_mirror_analyses|-1|N
sprint_queue|45|N
sprint_reports|-1|N
stake_authority_snapshots|-1|N
stewardship_relationships|-1|N
storage_contracts|-1|N
stripe_products|-1|N
substance_gate_events|9290|N
supabase_schema_baseline|3273|N
sync_config|-1|N
system_broadcasts|-1|N
system_metrics_daily|-1|N
system_truth|-1|N
task_verification_stakes|-1|N
tax_harvest_signals|-1|N
team_coordination_log|-1|N
trading_rounds|-1|N
trinity_agent_benchmarks|4985|N
trinity_agent_directives|8|N
trinity_agent_groups|-1|N
trinity_audit_trail_status|-1|N
trinity_collaborations|-1|N
trinity_dbt_sbt_pipeline|-1|N
trinity_deployment_events|114395|N
trinity_deployment_manifest|-1|N
trinity_experiments|-1|N
trinity_filter_configs|-1|N
trinity_fixes|-1|N
trinity_gemini_queue|-1|N
trinity_hallucination_logs|233|N
trinity_hitl_decisions|-1|N
trinity_langgraph_checkpoints|-1|N
trinity_learned_patterns|171|N
trinity_mcp_handoffs|-1|N
trinity_memories|-1|N
trinity_protected_tasks|-1|N
trinity_receipt_bft_results|-1|N
trinity_receipt_validators|-1|N
trinity_shofet_rulings|-1|N
trinity_skills|10|N
trinity_task_templates|-1|N
trinity_tool_usage|-1|N
trinity_whistleblower_reports|-1|N
trinity_wisdom_crystallizations|233|N
trustcre_deal_log|-1|N
trustex_custody_chain|-1|N
trustex_decay_schedule|-1|N
trustex_rep_events|-1|N
trustex_rep_stakes|-1|N
trustex_signal_matches|-1|N
trustex_signals_catalog|-1|N
trustex_user_preferences|-1|N
trustex_yield_outcomes|-1|N
trustrails_agent_verifications|-1|N
trustrails_challenge_events|-1|N
trustrails_challenges|-1|N
trustrails_demo_claims|-1|T
trustrails_demo_sessions|-1|T
trustrails_participants|-1|N
trustshell_agent_sbt|-1|N
trustshell_agents|-1|N
trustshell_decisions|-1|N
trustshell_ecosystem|-1|N
trustshell_sprint_log|-1|N
trustshell_tool_receipts|-1|N
trustshell_trade_decisions|-1|N
trustshell_trade_executions|-1|N
trustshell_trade_signals|-1|N
trusttrader_agent_cards|-1|N
trusttrader_share_cards|-1|N
trusttrader_signal_licenses|-1|N
trusttrader_signals|29523|N
user_agents|-1|N
user_badges|-1|N
user_journeys|-1|N
user_memory_tier|-1|N
user_signal_configs|-1|N
user_stories|-1|N
user_streaks|-1|N
validation_artifacts|2352|N
validation_queue|-1|N
vault_access_log|-1|N
verification_audits|-1|N
virtue_narratives|-1|N
voc_signals|-1|N
vouch_relationships|-1|N
x402_log|-1|N
zkp_circuits|-1|N
zkp_repid_architecture|-1|N`;

const TOP8 = ['service_contracts','repid_zkp_proofs','human_sbt_registry','repid_proof_queue',
  'dispute_validation_queue','repid_score_events','agent_services','defect_4_validation_log'];

// Discovery/catalog tables a frontend MIGHT read with the anon key — flag for an optional
// public-read policy (default stays deny; trustshell /market reads via service-role per CC1 memo).
const PUBLIC_READ_FLAG = new Set(['agent_services','service_categories','trustex_signals_catalog',
  'agent_a2a_cards','trusttrader_agent_cards','trusttrader_signals','trusttrader_share_cards',
  'hyperdag_ecosystem_registry','ecosystem_apps','stripe_products','signal_library','trustshell_ecosystem']);

const SENSITIVE = /(repid|sbt|stake|vault|x402|erc8004|credential|permissioned|paper_trade|linked_bets|confidence_stakes|hyperdag_points|hyperdag_receipts|push_subscriptions|custody|escrow|reputation_attestations|insider_trading|tax_harvest|stripe|invite_chains|^user_|merkle|zkp|dispute|defect)/i;

const rows = RAW.split('\n').map(l => { const [name, r, t] = l.split('|'); return { name, rows: Number(r), test: t === 'T' }; });
const byName = Object.fromEntries(rows.map(r => [r.name, r]));

function tierOf(r) {
  if (TOP8.includes(r.name)) return 'A';
  if (r.test || r.name.startsWith('_temp') || r.name === 'supabase_schema_baseline' || r.name === 'planted_error_events') return 'D';
  if (SENSITIVE.test(r.name)) return 'B';
  return 'C';
}

function policyBlock(name, note) {
  const t = `public.${name}`;
  const flag = PUBLIC_READ_FLAG.has(name)
    ? `-- FLAG: discovery/catalog surface — if a frontend reads this with the ANON key, uncomment:\n--   DROP POLICY IF EXISTS "public_read" ON ${t};\n--   CREATE POLICY "public_read" ON ${t} FOR SELECT TO anon, authenticated USING (true);\n`
    : '';
  return `-- ${name}${note ? '  — ' + note : ''}\n` +
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;\n` +
    `DROP POLICY IF EXISTS "service_role_all" ON ${t};\n` +
    `CREATE POLICY "service_role_all" ON ${t} FOR ALL TO service_role USING (true) WITH CHECK (true);\n` +
    flag +
    `-- rollback ${name}: ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "service_role_all" ON ${t};\n`;
}

let out = '';
out += `-- ============================================================================\n`;
out += `-- S-RLS-LOCKDOWN — enable RLS + service_role-only policy on 241 public tables\n`;
out += `-- Author: CC · 2026-06-01 · branch feat/cc-2026-06-01-rls-lockdown\n`;
out += `-- DESIGN ONLY — Sean applies in Supabase (D1 TOP-8 first). Co-signed review, no self-merge.\n`;
out += `--\n`;
out += `-- WHY: 241/545 public tables have RLS DISABLED with FULL anon write grants [sql:2026-06-01]\n`;
out += `--      — the #1 pen-test finding. This denies anon/authenticated by default.\n`;
out += `-- MODEL: ENABLE RLS + a service_role-FULL policy per table. service_role (BYPASSRLS) and the\n`;
out += `--        postgres pooler role (direct-pg :6543, relforcerowsecurity=false) both BYPASS RLS, so\n`;
out += `--        every live writer keeps full access; anon/authenticated get NO policy → denied.\n`;
out += `-- LIVE-PATH PROOF [sql:2026-06-01]: trinity_tasks, repid_agents, agent_heartbeat,\n`;
out += `--        peer_verification_queue, trinity_repid ALREADY have RLS ON and the swarm claims\n`;
out += `--        113/30min + HAL/sync writes succeed → this exact pattern is proven safe in prod.\n`;
out += `-- All statements idempotent (re-runnable). Each table has a per-table rollback line.\n`;
out += `-- VERIFY after apply (run as anon AND service_role): anon SELECT/INSERT denied; service_role OK;\n`;
out += `--        swarm claims continue; a HAL score-event write + a stake/proof write still succeed.\n`;
out += `-- ============================================================================\n\nBEGIN;\n\n`;

// Section A — D1 TOP-8 (in canon order)
out += `-- ─────────────────────────────────────────────────────────────────────────\n-- TIER A — D1 TOP-8 (apply FIRST; highest pen-test leverage)\n-- ─────────────────────────────────────────────────────────────────────────\n\n`;
const a8notes = {
  service_contracts:'economic contract lifecycle', repid_zkp_proofs:'41k proofs', human_sbt_registry:'identity SBT',
  repid_proof_queue:'44k proof jobs', dispute_validation_queue:'dispute integrity', repid_score_events:'47k RepID audit log',
  agent_services:'marketplace catalog (trustshell reads via service-role)', defect_4_validation_log:'validation integrity' };
for (const n of TOP8) out += policyBlock(n, a8notes[n]) + '\n';

const tiers = { B: [], C: [], D: [] };
for (const r of rows) { if (TOP8.includes(r.name)) continue; tiers[tierOf(r)].push(r.name); }
for (const k of ['B','C','D']) tiers[k].sort();

const titles = {
  B: 'TIER B — sensitive (RepID/scores · stakes/financial · keys/identity/SBT · disputes)',
  C: 'TIER C — operational / agent-state / logs (service-role only)',
  D: 'TIER D — test / ephemeral / schema-dump (lock anyway; deny anon)' };
for (const k of ['B','C','D']) {
  out += `\n-- ─────────────────────────────────────────────────────────────────────────\n-- ${titles[k]}  (${tiers[k].length} tables)\n-- ─────────────────────────────────────────────────────────────────────────\n\n`;
  for (const n of tiers[k]) out += policyBlock(n) + '\n';
}

out += `\nCOMMIT;\n\n`;
out += `-- ── FULL ROLLBACK (if needed) ────────────────────────────────────────────\n`;
out += `-- Disable RLS + drop the policy on every table touched above. Reverse order is fine.\n`;
out += `-- (Per-table rollback lines are inline above for selective rollback.)\n`;

fs.writeFileSync(__dirname + '/2026-06-01_rls_lockdown.sql', out);
console.log(`TIER A (TOP-8): ${TOP8.length}`);
console.log(`TIER B sensitive: ${tiers.B.length}`);
console.log(`TIER C operational: ${tiers.C.length}`);
console.log(`TIER D test/ephemeral: ${tiers.D.length}`);
console.log(`TOTAL: ${TOP8.length + tiers.B.length + tiers.C.length + tiers.D.length}`);
console.log(`public-read flagged: ${[...PUBLIC_READ_FLAG].filter(n => byName[n]).length}`);
