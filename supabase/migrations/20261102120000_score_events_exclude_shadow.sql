-- SCORE-EVENT VIEWS AND FUNCTIONS EXCLUDE SHADOW ROWS
--
-- ╔══════════════════════════════════════════════════════════════════════════════════╗
-- ║  NOT APPLIED TO PROD (Sean-gated, HIGH: prod DDL). FILE ONLY.                       ║
-- ║  Paste the whole file into the Supabase SQL editor; it runs in one transaction.     ║
-- ╚══════════════════════════════════════════════════════════════════════════════════╝
--
-- WHAT. Adds `is_shadow = false` at every read of public.repid_score_events in 16 views and
-- 11 functions. Nothing else in any definition changes: each statement is the prod definition read
-- on 2026-11-02 (pg_get_viewdef / pg_get_functiondef, project qnnpjhlxljtqyigedwkb) plus the
-- predicate. Column names, order and types are unchanged, so CREATE OR REPLACE is allowed and the
-- dependent views (v_canon and v_mvp_readiness read v_canon_state) need nothing.
--
-- WHY. repid_score_events.is_shadow (boolean NOT NULL DEFAULT false) marks rows that must never
-- count as canonical activity. #1487 filtered the TypeScript readers; these DB readers were still
-- counting them. Today that is 114 shadow SERVICE_SATISFIED rows (delta 15..30, policy
-- shadow-satisfaction-weighted-v1). Once TRINITY_BRIDGE_KNOWN_ANSWER_MODE=shadow is set, shadow
-- HAL_SCORE_EVENT rows will be written at volume.
--
-- WHAT THIS MOVES (read the PR before pasting).
--   * sync_active_agent_count() (cron active_agent_count_sync_hourly, :50) writes
--     repid_config.active_agent_count, which get_scaled_reward() reads: shadow-only scorers stop
--     counting toward the reward multiplier. That is a reward input, i.e. MAJOR.
--   * compute_self_certainty() and anfis_provider_performance_lookup() (provider routing) stop
--     seeing shadow rows. Neither sees any today (shadow rows carry no hal_score or llm_provider).
--   * Detector views (v_score_emit_backfill_truth, v_cascade_chokepoint_truth,
--     v_settlement_tail_truth) stop treating a shadow SERVICE_SATISFIED row as proof the canonical
--     emitter fired.
--   * Hourly snapshots (repid_capture_baseline, repid_capture_models,
--     ecosystem_capture_loop_health) change ruler from this hour on: compare before/after with care.
--
-- LEFT AS THEY ARE (they read repid_score_events, and are right to see shadow rows or already
-- filter): v_settlement_shadow_divergence, v_mvp_readiness, v_repid_service_fulfilled_reward_baseline,
-- v_value_loop_staleness_monitor, v_llm_call_attribution_recovery,
-- v_repid_proof_queue_disposition_truth, apply_repid_penalty, backfill_score_event_counterparty,
-- check_hal_penalty_guard, emit_settlement_shadow_event, update_agent_repid. Reasons in the PR.
--
-- KEPT AS IS BY CREATE OR REPLACE: owner (postgres), grants, comments, SECURITY DEFINER,
-- volatility, SET search_path / statement_timeout (all restated by pg_get_functiondef).
-- NOT kept unless restated: a view's WITH (...) options. CREATE OR REPLACE VIEW replaces the whole
-- list, so every view below restates its security_invoker option exactly as stored. The four views
-- with no WITH clause have no options today.
--
-- HOW TO VERIFY (run separately, after this file). Expect 27 rows, shadow_predicate = true on all,
-- and options exactly: security_invoker=on for v_active_agent_count_truth,
-- v_reward_clamp_armed_truth, v_score_emit_backfill_truth; security_invoker=true for the other 9
-- v_* views except v_cascade_baseline_2026_05_18; NULL for llm_trust_leaderboard,
-- system_liveness_v, trinity_swarm_health, v_cascade_baseline_2026_05_18; for functions, the
-- options column shows prosecdef: true only for ecosystem_capture_loop_health and
-- sync_active_agent_count.
--
--   SELECT c.relname AS object, 'view' AS kind,
--          pg_get_viewdef(c.oid) ~ 'is_shadow = false' AS shadow_predicate,
--          array_to_string(c.reloptions, ',') AS options
--     FROM pg_class c
--    WHERE c.relnamespace = 'public'::regnamespace
--      AND c.relname IN ('llm_trust_leaderboard','system_liveness_v','trinity_swarm_health',
--        'v_active_agent_count_truth','v_agent_earned_observations','v_canon_state',
--        'v_cascade_baseline_2026_05_18','v_cascade_chokepoint_truth','v_economy_cascade_stall_truth',
--        'v_repid_service_loop_wash_truth','v_reward_clamp_armed_truth','v_reward_floor_inflation_truth',
--        'v_score_emit_backfill_truth','v_settlement_tail_truth','v_throughput_daily','v_throughput_now')
--   UNION ALL
--   SELECT p.proname, 'function', p.prosrc ~ 'is_shadow = false', p.prosecdef::text
--     FROM pg_proc p
--    WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('anfis_provider_performance_lookup','compute_self_certainty',
--        'daily_system_health_check','ecosystem_capture_loop_health','fn_agent_performance',
--        'fn_system_health_summary','graph_rag_backfill_competence_candidates',
--        'graph_rag_backfill_counterparty_candidates','repid_capture_baseline','repid_capture_models',
--        'sync_active_agent_count')
--   ORDER BY 1;
--
-- ROLLBACK. Paste 20261102120000_score_events_exclude_shadow.rollback.sql (same folder): the 27
-- definitions as they were, verbatim, options restated. Then the query above shows
-- shadow_predicate = false for all 27.

BEGIN;
SET LOCAL search_path TO public;

CREATE OR REPLACE VIEW public.llm_trust_leaderboard AS
 SELECT llm_provider,
    llm_model,
    count(*) AS total_decisions,
    sum(
        CASE
            WHEN hallucination_caught THEN 1
            ELSE 0
        END) AS hallucinations_caught,
    round(((100.0 * (sum(
        CASE
            WHEN hallucination_caught THEN 1
            ELSE 0
        END))::numeric) / (NULLIF(count(*), 0))::numeric), 2) AS hallucination_rate_pct,
    round(((100.0 * (sum(
        CASE
            WHEN (delta > 0) THEN 1
            ELSE 0
        END))::numeric) / (NULLIF(count(*), 0))::numeric), 2) AS trust_score_pct,
    round((avg(certainty_at_claim))::numeric, 3) AS avg_certainty,
    count(DISTINCT agent_id) AS agents_using,
    max(created_at) AS last_decision
   FROM repid_score_events
  WHERE ((llm_provider IS NOT NULL) AND (is_shadow = false))
  GROUP BY llm_provider, llm_model
  ORDER BY (round(((100.0 * (sum(
        CASE
            WHEN (delta > 0) THEN 1
            ELSE 0
        END))::numeric) / (NULLIF(count(*), 0))::numeric), 2)) DESC, (count(*)) DESC;

CREATE OR REPLACE VIEW public.system_liveness_v AS
 WITH lanes AS (
         SELECT 'plonky3_real_proving'::text AS lane,
            ( SELECT max(repid_zkp_proofs.created_at) AS max
                   FROM repid_zkp_proofs
                  WHERE repid_zkp_proofs.is_real) AS last_event
        UNION ALL
         SELECT 'eas_anchoring'::text,
            ( SELECT max(repid_zkp_proofs.created_at) AS max
                   FROM repid_zkp_proofs
                  WHERE (repid_zkp_proofs.eas_attestation_uid IS NOT NULL)) AS max
        UNION ALL
         SELECT 'real_settlement'::text,
            ( SELECT max(x402_settlements.created_at) AS max
                   FROM x402_settlements
                  WHERE (x402_settlements.is_simulated = false)) AS max
        UNION ALL
         SELECT 'erc8004_writes'::text,
            ( SELECT max(erc8004_reputation_writes.created_at) AS max
                   FROM erc8004_reputation_writes) AS max
        UNION ALL
         SELECT 'repid_scoring'::text,
            ( SELECT max(repid_score_events.created_at) AS max
                   FROM repid_score_events
                  WHERE (repid_score_events.is_shadow = false)) AS max
        UNION ALL
         SELECT 'peer_panel_votes'::text,
            ( SELECT max(peer_verification_votes.created_at) AS max
                   FROM peer_verification_votes) AS max
        )
 SELECT lane,
    last_event,
    round((EXTRACT(epoch FROM (now() - last_event)) / 86400.0), 1) AS days_dormant,
    ((last_event IS NULL) OR ((now() - last_event) > '1 day'::interval)) AS alert
   FROM lanes
  ORDER BY ((last_event IS NULL) OR ((now() - last_event) > '1 day'::interval)) DESC, (round((EXTRACT(epoch FROM (now() - last_event)) / 86400.0), 1)) DESC;

CREATE OR REPLACE VIEW public.trinity_swarm_health AS
 WITH expected_agents AS (
         SELECT unnest(ARRAY['trinity-orch'::text, 'trinity-w3c'::text, 'trinity-shofet'::text, 'trinity-torch'::text, 'trinity-veritas'::text, 'trinity-gcm'::text, 'trinity-chesed'::text, 'trinity-mel'::text, 'trinity-apm'::text, 'trinity-sophia'::text, 'trinity-nexus'::text, 'trinity-hdm'::text]) AS agent_name
        ), spokesperson_by_squad(squad, spokesperson_name, spokesperson_uuid) AS (
         VALUES ('alpha'::text,'SOPHIA'::text,'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271'::uuid), ('beta'::text,'VERITAS'::text,'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067'::uuid), ('gamma'::text,'SHOFET'::text,'32e0e809-c1c4-4405-913f-135c8a2d6626'::uuid), ('orchestration'::text,'CHESED'::text,'2c2c24d6-2fd0-47e6-95d5-7fc9804a19e6'::uuid)
        ), heartbeat_latest AS (
         SELECT DISTINCT ON (trinity_heartbeat.agent) trinity_heartbeat.agent,
            trinity_heartbeat.last_seen,
            trinity_heartbeat.status,
            trinity_heartbeat.version,
            (trinity_heartbeat.config ->> 'group'::text) AS heartbeat_group_label
           FROM trinity_heartbeat
          ORDER BY trinity_heartbeat.agent, trinity_heartbeat.last_seen DESC
        ), last_task_claim AS (
         SELECT trinity_tasks.claimed_by AS agent_name,
            max(trinity_tasks.claimed_at) AS last_claimed_at
           FROM trinity_tasks
          WHERE (trinity_tasks.claimed_by IS NOT NULL)
          GROUP BY trinity_tasks.claimed_by
        ), last_artifact AS (
         SELECT trinity_artifacts.agent AS agent_name,
            max(trinity_artifacts.created_at) AS last_artifact_at
           FROM trinity_artifacts
          WHERE (trinity_artifacts.agent IS NOT NULL)
          GROUP BY trinity_artifacts.agent
        )
 SELECT e.agent_name,
    asm.squad AS expected_squad,
    asm.role AS squad_role,
    s.spokesperson_name AS expected_spokesperson,
    s.spokesperson_uuid,
    hb.last_seen AS heartbeat_last_seen,
        CASE
            WHEN (hb.last_seen IS NULL) THEN NULL::numeric
            ELSE (EXTRACT(epoch FROM (now() - hb.last_seen)) / 60.0)
        END AS minutes_since_last_seen,
        CASE
            WHEN (hb.last_seen IS NULL) THEN 'red'::text
            WHEN (hb.last_seen > (now() - '00:05:00'::interval)) THEN 'green'::text
            WHEN (hb.last_seen > (now() - '01:00:00'::interval)) THEN 'yellow'::text
            ELSE 'red'::text
        END AS status_color,
    hb.status AS heartbeat_status,
    hb.version AS heartbeat_version,
    ltc.last_claimed_at AS last_task_claimed_at,
    la.last_artifact_at,
    ( SELECT max(rse.created_at) AS max
           FROM repid_score_events rse
          WHERE ((rse.agent_id = s.spokesperson_uuid) AND (rse.is_shadow = false))) AS spokesperson_last_score_event_at,
    now() AS computed_at
   FROM (((((expected_agents e
     LEFT JOIN agent_squad_map asm ON ((asm.agent_name = e.agent_name)))
     LEFT JOIN spokesperson_by_squad s ON ((s.squad = asm.squad)))
     LEFT JOIN heartbeat_latest hb ON ((hb.agent = e.agent_name)))
     LEFT JOIN last_task_claim ltc ON ((ltc.agent_name = e.agent_name)))
     LEFT JOIN last_artifact la ON ((la.agent_name = e.agent_name)))
  ORDER BY
        CASE
            WHEN (hb.last_seen IS NULL) THEN 2
            WHEN (hb.last_seen > (now() - '00:05:00'::interval)) THEN 0
            WHEN (hb.last_seen > (now() - '01:00:00'::interval)) THEN 1
            ELSE 2
        END, hb.last_seen DESC NULLS LAST, e.agent_name;

CREATE OR REPLACE VIEW public.v_active_agent_count_truth WITH (security_invoker=on) AS
 WITH cfg AS (
         SELECT (repid_config.value)::numeric AS cfg_active_count,
            repid_config.min_value AS floor_min,
            repid_config.max_value AS ceil_max,
            repid_config.last_updated AS cfg_last_updated
           FROM repid_config
          WHERE (repid_config.key = 'active_agent_count'::text)
        ), base AS (
         SELECT (repid_config.value)::numeric AS base_reward
           FROM repid_config
          WHERE (repid_config.key = 'correct_challenge_reward'::text)
        ), rl AS (
         SELECT count(DISTINCT repid_score_events.agent_id) AS real_distinct_24h,
            count(*) AS events_24h,
            max(repid_score_events.created_at) AS last_score_event
           FROM repid_score_events
          WHERE ((repid_score_events.created_at > (now() - '24:00:00'::interval)) AND (repid_score_events.is_shadow = false))
        ), live AS (
         SELECT count(*) FILTER (WHERE v_fleet_truth.is_live) AS heartbeat_live,
            count(*) AS fleet_total
           FROM v_fleet_truth
        )
 SELECT now() AS measured_at,
    c.cfg_active_count,
    r.real_distinct_24h,
    l.heartbeat_live,
    l.fleet_total,
    c.floor_min,
    c.ceil_max,
    r.events_24h,
    r.last_score_event,
    round((EXTRACT(epoch FROM (now() - r.last_score_event)) / 3600.0), 1) AS hours_since_last_score_event,
    ((r.real_distinct_24h)::numeric < c.floor_min) AS floor_inflating_now,
    (c.cfg_active_count - (l.heartbeat_live)::numeric) AS economics_minus_liveness_gap,
    round((b.base_reward * sqrt((5.0 / GREATEST(LEAST(GREATEST((r.real_distinct_24h)::numeric, c.floor_min), c.ceil_max), (1)::numeric))))) AS scaled_reward_config_driven,
    round((b.base_reward * sqrt((5.0 / (GREATEST(r.real_distinct_24h, (1)::bigint))::numeric)))) AS scaled_reward_true,
    round((b.base_reward * sqrt((5.0 / GREATEST(c.floor_min, (1)::numeric))))) AS scaled_reward_if_activity_stops,
    round((round((b.base_reward * sqrt((5.0 / GREATEST(c.floor_min, (1)::numeric))))) / GREATEST(round((b.base_reward * sqrt((5.0 / (GREATEST(r.real_distinct_24h, (1)::bigint))::numeric)))), (1)::numeric)), 2) AS floor_overpay_multiplier
   FROM (((cfg c
     CROSS JOIN base b)
     CROSS JOIN rl r)
     CROSS JOIN live l);

CREATE OR REPLACE VIEW public.v_agent_earned_observations WITH (security_invoker=true) AS
 SELECT e.agent_id,
    'integrity'::text AS signal,
    e.created_at AS observed_at,
    (e.hallucination_caught IS NOT TRUE) AS success,
    e.task_domain AS domain,
    NULL::integer AS value_ms,
    ((e.metadata ->> 'quorum_providers_used'::text))::integer AS quorum_providers_used
   FROM repid_score_events e
  WHERE ((e.agent_id IS NOT NULL) AND (e.is_shadow = false))
UNION ALL
 SELECT s.provider_agent_id AS agent_id,
    'x402'::text AS signal,
    s.created_at AS observed_at,
    (s.status = 'settled'::text) AS success,
    NULL::text AS domain,
    NULL::integer AS value_ms,
    NULL::integer AS quorum_providers_used
   FROM x402_settlements s
  WHERE ((s.provider_agent_id IS NOT NULL) AND (s.is_simulated IS NOT TRUE))
UNION ALL
 SELECT f.agent_id,
    'x402'::text AS signal,
    f.created_at AS observed_at,
    false AS success,
    NULL::text AS domain,
    NULL::integer AS value_ms,
    NULL::integer AS quorum_providers_used
   FROM x402_settlement_failures f
  WHERE (f.agent_id IS NOT NULL)
UNION ALL
 SELECT r.id AS agent_id,
    'bft'::text AS signal,
    COALESCE(b.evaluated_at, b.created_at) AS observed_at,
    b.consensus_reached AS success,
    NULL::text AS domain,
    NULL::integer AS value_ms,
    NULL::integer AS quorum_providers_used
   FROM (bft_payment_evaluations b
     JOIN repid_agents r ON (((r.agent_name = b.agent_name) OR (r.agent_name = ('trinity-'::text || lower(b.agent_name))))))
  WHERE (b.consensus_reached IS NOT NULL)
UNION ALL
 SELECT l.agent_id,
    'latency'::text AS signal,
    l.created_at AS observed_at,
    true AS success,
    l.task_hint AS domain,
    l.latency_ms AS value_ms,
    NULL::integer AS quorum_providers_used
   FROM llm_call_log l
  WHERE ((l.agent_id IS NOT NULL) AND (l.latency_ms IS NOT NULL));

CREATE OR REPLACE VIEW public.v_canon_state WITH (security_invoker=true) AS
 SELECT now() AS as_of,
    ( SELECT agent_preflight_control.global_pause
           FROM agent_preflight_control
          WHERE (agent_preflight_control.id = 1)) AS global_pause,
    ( SELECT count(*) AS count
           FROM trinity_tasks
          WHERE ((trinity_tasks.status)::text = 'pending'::text)) AS fleet_pending,
    ( SELECT count(*) AS count
           FROM trinity_tasks
          WHERE (((trinity_tasks.status)::text = 'pending'::text) AND (trinity_tasks.required_capabilities = '{}'::text[]))) AS fleet_pending_any_agent,
    ( SELECT count(*) AS count
           FROM autonomous_tasks
          WHERE ((autonomous_tasks.status = 'pending'::text) AND (autonomous_tasks.assigned_to <> 'sean'::text) AND (autonomous_tasks.requires_sean_approval = false))) AS executor_eligible,
    ( SELECT count(*) AS count
           FROM autonomous_tasks
          WHERE ((autonomous_tasks.status = 'pending'::text) AND ((autonomous_tasks.assigned_to = 'sean'::text) OR (autonomous_tasks.requires_sean_approval = true)))) AS sean_gated,
    ( SELECT max(trinity_tasks.updated_at) AS max
           FROM trinity_tasks
          WHERE ((trinity_tasks.status)::text = 'done'::text)) AS last_task_done,
    ( SELECT max(repid_score_events.created_at) AS max
           FROM repid_score_events
          WHERE (repid_score_events.is_shadow = false)) AS last_score_event,
    ( SELECT max(repid_zkp_proofs.created_at) AS max
           FROM repid_zkp_proofs) AS last_zkp_proof,
    ( SELECT count(*) AS count
           FROM repid_score_events
          WHERE ((repid_score_events.created_at > (now() - '7 days'::interval)) AND (repid_score_events.is_shadow = false))) AS score_events_7d,
    ( SELECT count(*) AS count
           FROM repid_zkp_proofs
          WHERE (repid_zkp_proofs.created_at > (now() - '7 days'::interval))) AS zkp_proofs_7d,
    ( SELECT count(*) AS count
           FROM vault.secrets) AS vault_secrets_stored;

CREATE OR REPLACE VIEW public.v_cascade_baseline_2026_05_18 AS
 SELECT id AS contract_id,
    (payload ->> 'test_marker'::text) AS test_marker,
    (payload ->> 'claimer_provider'::text) AS claimer,
    (result ->> 'judge_provider'::text) AS judge_used,
    (result ->> 'verdict'::text) AS composite_verdict,
    ((result ->> 'pcp_score'::text))::numeric AS pcp_score,
    ((result ->> 'judge_confidence'::text))::numeric AS judge_confidence,
    (result ->> 'comma_severity'::text) AS comma_severity,
    EXTRACT(epoch FROM (fulfilled_at - escrowed_at)) AS escrow_to_fulfill_seconds,
    ( SELECT count(*) AS count
           FROM repid_score_events rse
          WHERE (((rse.metadata ->> 'contract_id'::text) = (sc.id)::text) AND (rse.is_shadow = false))) AS score_events_count,
    ( SELECT count(*) AS count
           FROM hal_audit_chain hac
          WHERE (hac.source_id IN ( SELECT (rse.id)::text AS id
                   FROM repid_score_events rse
                  WHERE (((rse.metadata ->> 'contract_id'::text) = (sc.id)::text) AND (rse.is_shadow = false))))) AS anchors_count
   FROM service_contracts sc
  WHERE ((fulfilled_at IS NOT NULL) AND (created_at >= '2026-05-18 00:00:00+00'::timestamp with time zone));

CREATE OR REPLACE VIEW public.v_cascade_chokepoint_truth WITH (security_invoker=true) AS
 WITH se AS (
         SELECT max(repid_score_events.created_at) AS last_score_event_at
           FROM repid_score_events
          WHERE (repid_score_events.is_shadow = false)
        ), esc AS (
         SELECT count(*) AS escrowed_stuck_count,
            min(service_contracts.escrowed_at) AS oldest_escrowed_at,
            (array_agg((service_contracts.work_statement_hash IS NOT NULL) ORDER BY service_contracts.escrowed_at DESC))[1] AS newest_escrowed_is_bound
           FROM service_contracts
          WHERE (service_contracts.status = 'escrowed'::text)
        ), org AS (
         SELECT max(service_contracts.satisfied_at) AS last_organic_satisfied_at,
            max(service_contracts.settled_at) AS last_organic_settled_at
           FROM service_contracts
          WHERE (service_contracts.buyer_satisfaction_score > (0)::numeric)
        ), anyt AS (
         SELECT max(service_contracts.settled_at) AS last_any_settled_at
           FROM service_contracts
        ), brk AS (
         SELECT count(*) AS organic_owed_backfill
           FROM service_contracts sc,
            se se_1
          WHERE ((sc.buyer_satisfaction_score > (0)::numeric) AND (sc.satisfied_at > se_1.last_score_event_at))
        ), ff AS (
         SELECT max(service_contracts.fulfilled_at) AS last_fulfilled_at,
            count(*) FILTER (WHERE ((service_contracts.status = 'fulfilled'::text) AND (service_contracts.satisfied_at IS NULL))) AS fulfilled_awaiting_satisfy,
            count(*) FILTER (WHERE ((service_contracts.status = 'fulfilled'::text) AND (service_contracts.satisfied_at IS NULL) AND (service_contracts.fulfilled_at > (now() - '5 days'::interval)))) AS fresh_stranded_awaiting_satisfy_5d
           FROM service_contracts
        )
 SELECT se.last_score_event_at,
    org.last_organic_satisfied_at,
    org.last_organic_settled_at,
    anyt.last_any_settled_at,
    esc.escrowed_stuck_count,
    (now() - esc.oldest_escrowed_at) AS oldest_escrowed_stuck_age,
    esc.newest_escrowed_is_bound,
    (brk.organic_owed_backfill > 0) AS emit_break_proven,
    brk.organic_owed_backfill,
        CASE
            WHEN (brk.organic_owed_backfill > 0) THEN 'emit path (satisfied->SERVICE_SATISFIED): an ORGANIC (buyer_satisfaction>0) contract satisfied past the last score event'::text
            WHEN ((ff.fulfilled_awaiting_satisfy > 0) AND (ff.last_fulfilled_at > (now() - '48:00:00'::interval))) THEN (((('fulfilled->satisfied buyer /satisfy driver IDLE (escrow->fulfil is ALIVE; last fulfil '::text || to_char(ff.last_fulfilled_at, 'YYYY-MM-DD HH24:MI'::text)) || 'Z; '::text) || ff.fulfilled_awaiting_satisfy) || ' stranded at fulfilled)'::text)
            WHEN ((esc.escrowed_stuck_count > 0) AND ((ff.last_fulfilled_at IS NULL) OR (ff.last_fulfilled_at < (now() - '48:00:00'::interval)))) THEN (('escrow_advance / cascade-settlement worker (escrowed->fulfilled): no fulfil in >48h AND '::text || esc.escrowed_stuck_count) || ' stuck in escrow'::text)
            ELSE 'no single dead link evidenced (loop advancing, or idle with no backlog)'::text
        END AS proven_dead_link,
    format('DERIVED-LIVE @%s. escrow->fulfil last fired %sZ (%s). fulfilled->satisfied: %s stranded at fulfilled/satisfied_at NULL (%s in last 5d); last ORGANIC satisfy %s. emit_break_proven=%s (organic_owed_backfill=%s). NOTE last_any_settled_at %s may be a manual SQL-path plumbing orphan (buyer_satisfaction=0) that emits nothing BY DESIGN (lesson sql_path_bypasses_the_emitter), not an emit break; emit_break_proven flips TRUE only when an ORGANIC contract satisfies past the last score event.'::text, to_char(now(), 'YYYY-MM-DD HH24:MI'::text), to_char(ff.last_fulfilled_at, 'YYYY-MM-DD HH24:MI'::text),
        CASE
            WHEN (ff.last_fulfilled_at > (now() - '48:00:00'::interval)) THEN 'ALIVE <48h'::text
            ELSE 'STALE >48h'::text
        END, ff.fulfilled_awaiting_satisfy, ff.fresh_stranded_awaiting_satisfy_5d, COALESCE((to_char(org.last_organic_satisfied_at, 'YYYY-MM-DD HH24:MI'::text) || 'Z'::text), 'none'::text), (brk.organic_owed_backfill > 0), brk.organic_owed_backfill, COALESCE((to_char(anyt.last_any_settled_at, 'YYYY-MM-DD HH24:MI'::text) || 'Z'::text), 'none'::text)) AS interpretation,
    now() AS computed_at,
    ff.last_fulfilled_at,
    (ff.last_fulfilled_at > (now() - '48:00:00'::interval)) AS escrow_fulfil_alive_48h,
    ff.fulfilled_awaiting_satisfy,
    ff.fresh_stranded_awaiting_satisfy_5d
   FROM se,
    esc,
    org,
    anyt,
    brk,
    ff;

CREATE OR REPLACE VIEW public.v_economy_cascade_stall_truth WITH (security_invoker=true) AS
 SELECT ( SELECT max(repid_score_events.created_at) AS max
           FROM repid_score_events
          WHERE (repid_score_events.is_shadow = false)) AS score_events_last,
    ( SELECT max(repid_zkp_proofs.created_at) AS max
           FROM repid_zkp_proofs) AS zkp_proofs_last,
    ( SELECT max(erc8004_reputation_writes.created_at) AS max
           FROM erc8004_reputation_writes) AS erc8004_last,
    ( SELECT max(GREATEST(COALESCE(service_contracts.created_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE(service_contracts.escrowed_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE(service_contracts.fulfilled_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE(service_contracts.satisfied_at, '1970-01-01 00:00:00+00'::timestamp with time zone), COALESCE(service_contracts.settled_at, '1970-01-01 00:00:00+00'::timestamp with time zone))) AS max
           FROM service_contracts) AS contract_state_last,
    ( SELECT max(llm_call_log.created_at) AS max
           FROM llm_call_log) AS llm_call_last,
    ( SELECT max(trinity_agent_logs.created_at) AS max
           FROM trinity_agent_logs) AS agent_logs_last,
    ( SELECT count(*) AS count
           FROM service_contracts) AS contracts_lifetime,
    ( SELECT count(*) AS count
           FROM repid_proof_queue
          WHERE (repid_proof_queue.completed_at IS NULL)) AS proof_queue_unprocessed,
    84532 AS erc8004_chain_id_actual,
    177 AS hashkey_chain_id_connected,
    133 AS hashkey_chain_id_configured,
    now() AS measured_at;

CREATE OR REPLACE VIEW public.v_repid_service_loop_wash_truth WITH (security_invoker=true) AS
 WITH svc AS (
         SELECT e.id,
            e.created_at,
            e.agent_id,
            ra.agent_name AS scorer,
            e.counterparty_agent_id,
            cp.agent_name AS counterparty,
            e.event_type,
            e.delta,
            e.llm_provider,
            e.economic_impact_usdc,
            ft.is_live AS scorer_fleet_live,
            ft.minutes_since_ping AS scorer_mins_since_ping
           FROM (((repid_score_events e
             JOIN repid_agents ra ON ((ra.id = e.agent_id)))
             LEFT JOIN repid_agents cp ON ((cp.id = e.counterparty_agent_id)))
             LEFT JOIN v_fleet_truth ft ON ((ft.agent_name = ra.agent_name)))
          WHERE ((e.event_type = ANY (ARRAY['SERVICE_FULFILLED'::text, 'SERVICE_SATISFIED'::text])) AND (e.created_at >= (now() - '45 days'::interval)) AND (e.is_shadow = false))
        )
 SELECT (date_trunc('day'::text, created_at))::date AS day,
    scorer,
    counterparty,
    count(*) AS svc_events,
    sum(delta) AS repid_minted,
    count(*) FILTER (WHERE (llm_provider IS NOT NULL)) AS events_with_llm,
    sum(COALESCE(economic_impact_usdc, (0)::numeric)) AS usdc_backing,
    bool_and((COALESCE(scorer_fleet_live, false) = false)) AS scorer_dead_per_fleet_truth,
    max(scorer_mins_since_ping) AS scorer_max_mins_since_ping,
    'SERVICE_FULFILLED/SATISFIED RepID minted with (usually) NO LLM call and $0 USDC, attributed to canonical agents that v_fleet_truth reports dead (46d no ping). These synthetic events are the DISTINCT-agent_id input that holds get_scaled_reward active_agent_count off its worst-case floor (see v_reward_floor_inflation_truth). Liveness is NOT implied - v_fleet_truth is authoritative. Measured by cowork-executor 2026-09-02.'::text AS caveat
   FROM svc
  GROUP BY ((date_trunc('day'::text, created_at))::date), scorer, counterparty
  ORDER BY ((date_trunc('day'::text, created_at))::date) DESC, (sum(delta)) DESC NULLS LAST;

CREATE OR REPLACE VIEW public.v_reward_clamp_armed_truth WITH (security_invoker=on) AS
 WITH cfg AS (
         SELECT ( SELECT (repid_config.value)::numeric AS value
                   FROM repid_config
                  WHERE (repid_config.key = 'correct_challenge_reward'::text)) AS base_reward,
            ( SELECT (repid_config.value)::numeric AS value
                   FROM repid_config
                  WHERE (repid_config.key = 'active_agent_count'::text)) AS cfg_active_count,
            ( SELECT repid_config.min_value
                   FROM repid_config
                  WHERE (repid_config.key = 'active_agent_count'::text)) AS min_v,
            ( SELECT count(DISTINCT repid_score_events.agent_id) AS count
                   FROM repid_score_events
                  WHERE ((repid_score_events.created_at > (now() - '24:00:00'::interval)) AND (repid_score_events.is_shadow = false))) AS real_agents_24h,
            ( SELECT count(*) AS count
                   FROM repid_score_events
                  WHERE ((repid_score_events.created_at > (now() - '30 days'::interval)) AND ((repid_score_events.event_type ~~* '%CHALLENGE%'::text) OR (repid_score_events.event_type ~~* '%CORRECT%'::text)) AND (repid_score_events.is_shadow = false))) AS challenge_reward_events_30d,
            ( SELECT count(*) AS count
                   FROM repid_score_events
                  WHERE ((repid_score_events.created_at > (now() - '24:00:00'::interval)) AND (repid_score_events.event_type ~~* 'SERVICE%'::text) AND (repid_score_events.is_shadow = false))) AS service_wash_events_24h,
            ( SELECT count(*) AS count
                   FROM repid_score_events
                  WHERE ((repid_score_events.created_at > (now() - '24:00:00'::interval)) AND (repid_score_events.event_type = 'HAL_SCORE_EVENT'::text) AND (repid_score_events.is_shadow = false))) AS hal_probe_events_24h
        ), calc AS (
         SELECT cfg.base_reward,
            cfg.cfg_active_count,
            cfg.real_agents_24h,
            cfg.min_v,
            get_scaled_reward() AS reward_now,
            round((cfg.base_reward * sqrt((5.0 / GREATEST(cfg.min_v, (1)::numeric))))) AS reward_if_scoring_stops_floor,
            round(((cfg.base_reward * sqrt((5.0 / GREATEST(cfg.min_v, (1)::numeric)))) / (NULLIF(get_scaled_reward(), 0))::numeric), 3) AS armed_multiplier_x,
            cfg.challenge_reward_events_30d,
            (cfg.challenge_reward_events_30d = 0) AS payout_path_dormant,
            cfg.service_wash_events_24h,
            cfg.hal_probe_events_24h
           FROM cfg
        )
 SELECT base_reward,
    cfg_active_count,
    real_agents_24h,
    reward_now,
    reward_if_scoring_stops_floor,
    armed_multiplier_x,
    challenge_reward_events_30d,
    payout_path_dormant,
    service_wash_events_24h,
    hal_probe_events_24h,
    format('AUTO-DERIVED (live, recomputed each read; no hardcoded snapshot). Mechanism: reward = round(base * sqrt(5 / clamp(active_agent_count,%s,max))); neutral at count=5, rises below 5, ceiling at the floor count=%s. LIVE NOW: base=%s, active_agent_count=%s, real distinct scorers 24h=%s (service_wash=%s, hal_probe=%s), reward_now=%s (%sx base). Worst-case at floor=%s (%sx base). Payout path %s (challenge/correct reward events 30d=%s). The only DB references to get_scaled_reward are detector views (this one + siblings), so no agent is overpaid via a DB write today; the live consumer is the application challenge-settlement RPC. Hazard: the first re-enabled challenge payout lands at the multiplier live at that moment (now %sx), rising to %sx if scoring falls to the floor. This value tracks ANY scorer (service/E2E/periodic escrow->fulfil hop agents included), NOT canonical v_fleet_truth workers, so it lifts off the floor whenever the periodic hop emits. #93 economics hard-gate (Sean) guards this; see autonomous_task #93 history for the 09-02/09-04 snapshots this text used to hardcode.'::text, min_v, min_v, base_reward, cfg_active_count, real_agents_24h, service_wash_events_24h, hal_probe_events_24h, reward_now, round(((reward_now)::numeric / base_reward), 3), reward_if_scoring_stops_floor, round((reward_if_scoring_stops_floor / base_reward), 3),
        CASE
            WHEN (challenge_reward_events_30d = 0) THEN 'DORMANT'::text
            ELSE 'LIVE'::text
        END, challenge_reward_events_30d, round(((reward_now)::numeric / base_reward), 3), round((reward_if_scoring_stops_floor / base_reward), 3)) AS interpretation
   FROM calc;

CREATE OR REPLACE VIEW public.v_reward_floor_inflation_truth WITH (security_invoker=true) AS
 WITH cfg AS (
         SELECT ( SELECT (repid_config.value)::numeric AS value
                   FROM repid_config
                  WHERE (repid_config.key = 'correct_challenge_reward'::text)) AS base_reward,
            ( SELECT (repid_config.value)::numeric AS value
                   FROM repid_config
                  WHERE (repid_config.key = 'active_agent_count'::text)) AS configured_active_count,
            ( SELECT COALESCE(repid_config.min_value, '1'::numeric) AS "coalesce"
                   FROM repid_config
                  WHERE (repid_config.key = 'active_agent_count'::text)) AS min_clamp,
            ( SELECT COALESCE(repid_config.max_value, '20'::numeric) AS "coalesce"
                   FROM repid_config
                  WHERE (repid_config.key = 'active_agent_count'::text)) AS max_clamp,
            ( SELECT repid_config.last_updated
                   FROM repid_config
                  WHERE (repid_config.key = 'active_agent_count'::text)) AS count_last_synced
        ), live AS (
         SELECT count(DISTINCT repid_score_events.agent_id) AS real_scorers_24h,
            max(repid_score_events.created_at) AS last_score_event
           FROM repid_score_events
          WHERE ((repid_score_events.created_at > (now() - '24:00:00'::interval)) AND (repid_score_events.is_shadow = false))
        ), fleet AS (
         SELECT count(*) FILTER (WHERE v_fleet_truth.is_live) AS canonical_fleet_live,
            count(*) AS canonical_fleet_total
           FROM v_fleet_truth
        )
 SELECT cfg.base_reward,
    (5)::numeric AS neutral_count,
    cfg.configured_active_count,
    cfg.min_clamp,
    cfg.max_clamp,
    cfg.count_last_synced,
    live.real_scorers_24h,
    live.last_score_event,
    get_scaled_reward() AS current_scaled_reward,
    round(((get_scaled_reward())::numeric / cfg.base_reward), 4) AS current_multiplier,
    round((cfg.base_reward * sqrt((5.0 / GREATEST(cfg.min_clamp, (1)::numeric))))) AS worstcase_reward_at_floor,
    round((round((cfg.base_reward * sqrt((5.0 / GREATEST(cfg.min_clamp, (1)::numeric))))) / cfg.base_reward), 4) AS worstcase_multiplier_at_floor,
    fleet.canonical_fleet_live,
    fleet.canonical_fleet_total,
    (live.real_scorers_24h > fleet.canonical_fleet_live) AS scorers_exceed_canonical_live,
    'active_agent_count is DISTINCT agent_id in repid_score_events(24h), clamped [min,max]; it counts ANY scorer (external/service/E2E-probe agents included), NOT canonical v_fleet_truth workers. Reward multiplier = round(base*sqrt(5/count))/base; neutral at 5, inflates below 5, worst-case at the floor. Live hazard: cron active_agent_count_sync_hourly (50 * * * *) keeps it fresh. #93 economics hard-gate stays Sean-gated.'::text AS caveat
   FROM cfg,
    live,
    fleet;

CREATE OR REPLACE VIEW public.v_score_emit_backfill_truth WITH (security_invoker=on) AS
 SELECT ( SELECT max(repid_score_events.created_at) AS max
           FROM repid_score_events
          WHERE ((repid_score_events.event_type = 'SERVICE_SATISFIED'::text) AND (repid_score_events.is_shadow = false))) AS last_organic_satisfied_emit_at,
    ( SELECT repid_score_events.contract_id
           FROM repid_score_events
          WHERE ((repid_score_events.event_type = 'SERVICE_SATISFIED'::text) AND (repid_score_events.is_shadow = false))
          ORDER BY repid_score_events.created_at DESC
         LIMIT 1) AS last_emit_contract_id,
    ( SELECT count(*) AS count
           FROM service_contracts sc
          WHERE ((sc.satisfied_at > ( SELECT max(repid_score_events.created_at) AS max
                   FROM repid_score_events
                  WHERE ((repid_score_events.event_type = 'SERVICE_SATISFIED'::text) AND (repid_score_events.is_shadow = false)))) AND (COALESCE(sc.buyer_satisfaction_score, (0)::numeric) > (0)::numeric) AND (NOT (EXISTS ( SELECT 1
                   FROM repid_score_events e
                  WHERE ((e.contract_id = sc.id) AND (e.event_type = 'SERVICE_SATISFIED'::text) AND (e.is_shadow = false))))))) AS organic_owed_backfill,
    ( SELECT count(*) AS count
           FROM service_contracts sc
          WHERE ((sc.satisfied_at > ( SELECT max(repid_score_events.created_at) AS max
                   FROM repid_score_events
                  WHERE ((repid_score_events.event_type = 'SERVICE_SATISFIED'::text) AND (repid_score_events.is_shadow = false)))) AND (COALESCE(sc.buyer_satisfaction_score, (0)::numeric) = (0)::numeric) AND (NOT (EXISTS ( SELECT 1
                   FROM repid_score_events e
                  WHERE ((e.contract_id = sc.id) AND (e.event_type = 'SERVICE_SATISFIED'::text) AND (e.is_shadow = false))))))) AS sqlpath_or_zero_sat_orphans,
    ( SELECT service_contracts.id
           FROM service_contracts
          ORDER BY service_contracts.created_at DESC
         LIMIT 1) AS newest_contract_id,
    ( SELECT service_contracts.status
           FROM service_contracts
          ORDER BY service_contracts.created_at DESC
         LIMIT 1) AS newest_contract_status,
    ( SELECT service_contracts.created_at
           FROM service_contracts
          ORDER BY service_contracts.created_at DESC
         LIMIT 1) AS newest_contract_created_at,
    round((EXTRACT(epoch FROM (now() - ( SELECT service_contracts.created_at
           FROM service_contracts
          ORDER BY service_contracts.created_at DESC
         LIMIT 1))) / 3600.0), 1) AS newest_contract_age_hours,
    ( SELECT count(*) AS count
           FROM service_contracts
          WHERE (service_contracts.status = 'escrowed'::text)) AS stuck_escrowed_now,
    (( SELECT count(*) AS count
           FROM service_contracts sc
          WHERE ((sc.satisfied_at > ( SELECT max(repid_score_events.created_at) AS max
                   FROM repid_score_events
                  WHERE ((repid_score_events.event_type = 'SERVICE_SATISFIED'::text) AND (repid_score_events.is_shadow = false)))) AND (COALESCE(sc.buyer_satisfaction_score, (0)::numeric) > (0)::numeric) AND (NOT (EXISTS ( SELECT 1
                   FROM repid_score_events e
                  WHERE ((e.contract_id = sc.id) AND (e.event_type = 'SERVICE_SATISFIED'::text) AND (e.is_shadow = false))))))) > 0) AS emit_break_proven,
    now() AS measured_at;

CREATE OR REPLACE VIEW public.v_settlement_tail_truth WITH (security_invoker=true) AS
 SELECT metric,
    value
   FROM ( VALUES ('fulfil_step_last_emit_SERVICE_FULFILLED'::text,( SELECT (max(repid_score_events.created_at))::text AS max
                   FROM repid_score_events
                  WHERE ((repid_score_events.event_type = 'SERVICE_FULFILLED'::text) AND (repid_score_events.is_shadow = false)))), ('settle_step_last_emit_SERVICE_SATISFIED'::text,( SELECT (max(repid_score_events.created_at))::text AS max
                   FROM repid_score_events
                  WHERE ((repid_score_events.event_type = 'SERVICE_SATISFIED'::text) AND (repid_score_events.is_shadow = false)))), ('satisfy_step_last_bss_set'::text,( SELECT (max(service_contracts.satisfied_at))::text AS max
                   FROM service_contracts
                  WHERE (service_contracts.buyer_satisfaction_score IS NOT NULL))), ('fulfilled_backlog_total'::text,( SELECT (count(*))::text AS count
                   FROM service_contracts
                  WHERE (service_contracts.status = 'fulfilled'::text))), ('fulfilled_backlog_bss_null'::text,( SELECT (count(*))::text AS count
                   FROM service_contracts
                  WHERE ((service_contracts.status = 'fulfilled'::text) AND (service_contracts.buyer_satisfaction_score IS NULL)))), ('fulfilled_ancient_pre_fleetdeath_0718'::text,( SELECT (count(*))::text AS count
                   FROM service_contracts
                  WHERE ((service_contracts.status = 'fulfilled'::text) AND (service_contracts.created_at < '2026-07-18 00:00:00+00'::timestamp with time zone)))), ('fulfilled_fresh_since_econfreeze_0903'::text,( SELECT (count(*))::text AS count
                   FROM service_contracts
                  WHERE ((service_contracts.status = 'fulfilled'::text) AND (service_contracts.created_at > '2026-09-03 00:00:00+00'::timestamp with time zone)))), ('fresh_stranded_contract_id'::text,( SELECT (service_contracts.id)::text AS id
                   FROM service_contracts
                  WHERE ((service_contracts.status = 'fulfilled'::text) AND (service_contracts.created_at > '2026-09-03 00:00:00+00'::timestamp with time zone))
                  ORDER BY service_contracts.created_at DESC
                 LIMIT 1))) t(metric, value);

CREATE OR REPLACE VIEW public.v_throughput_daily WITH (security_invoker=true) AS
 WITH d AS (
         SELECT (generate_series((((now() - '59 days'::interval))::date)::timestamp with time zone, ((now())::date)::timestamp with time zone, '1 day'::interval))::date AS day
        )
 SELECT day,
    ( SELECT count(*) AS count
           FROM trinity_tasks t
          WHERE ((t.created_at)::date = d.day)) AS tasks_created,
    ( SELECT count(*) AS count
           FROM trinity_tasks t
          WHERE (((t.status)::text = 'done'::text) AND ((t.updated_at)::date = d.day))) AS tasks_done,
    ( SELECT count(*) AS count
           FROM repid_score_events e
          WHERE (((e.created_at)::date = d.day) AND (e.is_shadow = false))) AS score_events,
    ( SELECT count(*) AS count
           FROM repid_zkp_proofs p
          WHERE ((p.created_at)::date = d.day)) AS zkp_proofs
   FROM d
  ORDER BY day;

CREATE OR REPLACE VIEW public.v_throughput_now WITH (security_invoker=true) AS
 SELECT ( SELECT count(*) AS count
           FROM trinity_tasks
          WHERE ((trinity_tasks.status)::text = 'pending'::text)) AS fleet_pending,
    ( SELECT count(*) AS count
           FROM autonomous_tasks
          WHERE ((autonomous_tasks.status = 'pending'::text) AND (autonomous_tasks.assigned_to <> 'sean'::text) AND (autonomous_tasks.requires_sean_approval = false))) AS executor_eligible,
    ( SELECT count(*) AS count
           FROM autonomous_tasks
          WHERE ((autonomous_tasks.status = 'pending'::text) AND ((autonomous_tasks.assigned_to = 'sean'::text) OR (autonomous_tasks.requires_sean_approval = true)))) AS sean_gated,
    ( SELECT max(trinity_tasks.created_at) AS max
           FROM trinity_tasks) AS last_task_created,
    ( SELECT max(trinity_tasks.updated_at) AS max
           FROM trinity_tasks
          WHERE ((trinity_tasks.status)::text = 'done'::text)) AS last_task_done,
    ( SELECT max(repid_score_events.created_at) AS max
           FROM repid_score_events
          WHERE (repid_score_events.is_shadow = false)) AS last_score_event,
    ( SELECT max(repid_zkp_proofs.created_at) AS max
           FROM repid_zkp_proofs) AS last_zkp_proof,
    ( SELECT count(*) AS count
           FROM repid_score_events
          WHERE ((repid_score_events.created_at > (now() - '7 days'::interval)) AND (repid_score_events.is_shadow = false))) AS score_events_7d,
    ( SELECT count(*) AS count
           FROM repid_zkp_proofs
          WHERE (repid_zkp_proofs.created_at > (now() - '7 days'::interval))) AS zkp_proofs_7d,
        CASE
            WHEN (( SELECT count(*) AS count
               FROM trinity_tasks
              WHERE ((trinity_tasks.status)::text = 'pending'::text)) = 0) THEN 'QUEUE_STARVED: no pending fleet work exists; workers will no-op regardless of capability'::text
            WHEN (( SELECT count(*) AS count
               FROM autonomous_tasks
              WHERE ((autonomous_tasks.status = 'pending'::text) AND (autonomous_tasks.assigned_to <> 'sean'::text) AND (autonomous_tasks.requires_sean_approval = false))) = 0) THEN 'GATE_STARVED: all remaining autonomous work is gated to Sean'::text
            ELSE 'WORK_AVAILABLE'::text
        END AS starvation_verdict;

CREATE OR REPLACE FUNCTION public.anfis_provider_performance_lookup(p_domain text, p_window_days integer)
 RETURNS TABLE(provider text, hit_rate numeric, avg_latency_ms numeric, avg_cost_usdc numeric, sample_count bigint)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    rse.llm_provider::text AS provider,
    AVG(CASE
      WHEN rse.decision_outcome IN ('approved','APPROVED','clean','profit') THEN 1.0
      WHEN rse.decision_outcome IN ('rejected','vetoed') THEN 0.0
      ELSE NULL
    END) AS hit_rate,
    AVG(COALESCE((rse.metadata->>'latency_ms')::numeric, 0)) AS avg_latency_ms,
    AVG(COALESCE(rse.economic_impact_usdc, 0)) AS avg_cost_usdc,
    COUNT(*) AS sample_count
  FROM repid_score_events rse
  WHERE rse.llm_provider IS NOT NULL
    AND rse.is_shadow = false
    AND rse.task_domain = p_domain
    AND rse.created_at > NOW() - (p_window_days || ' days')::INTERVAL
  GROUP BY rse.llm_provider
  HAVING COUNT(*) >= 5
  ORDER BY hit_rate DESC NULLS LAST;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.compute_self_certainty(p_agent_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
  WITH hal AS (
    SELECT avg(1 - hal_score)::numeric AS hal_calib, count(*) AS n
    FROM repid_score_events
    WHERE agent_id = p_agent_id AND hal_score IS NOT NULL AND is_shadow = false
      AND created_at > now() - interval '30 days'
  ),
  peer AS (
    SELECT (count(*) FILTER (WHERE verification_status='verified'))::numeric
           / NULLIF(count(*) FILTER (WHERE verification_status IN ('verified','disputed')), 0) AS peer_rate,
           count(*) FILTER (WHERE verification_status IN ('verified','disputed')) AS n
    FROM peer_verification_queue
    WHERE source_agent_id = p_agent_id
  )
  SELECT GREATEST(0, LEAST(1,
    CASE
      WHEN hal.n > 0 AND peer.n > 0 THEN 0.5 * hal.hal_calib + 0.5 * peer.peer_rate
      WHEN hal.n > 0 THEN hal.hal_calib
      WHEN peer.n > 0 THEN peer.peer_rate
      ELSE 0.5  -- no calibration signal -> neutral prior (ignorance, NOT a RepID-derived value)
    END))::numeric
  FROM hal, peer;
$function$
;

CREATE OR REPLACE FUNCTION public.daily_system_health_check()
 RETURNS TABLE(check_name text, check_status text, detail text, action_required boolean)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_count BIGINT;
  v_vdr BIGINT;
  v_decisions BIGINT;
  v_hal_ok BOOLEAN;
BEGIN
  -- Check 1: pending_clarification bug
  SELECT COUNT(*) INTO v_count FROM trinity_tasks t
  WHERE t.status = 'pending_clarification';
  RETURN QUERY SELECT
    'pending_clarification_bug'::TEXT,
    CASE WHEN v_count > 0 THEN 'ALERT' ELSE 'OK' END::TEXT,
    (v_count || ' tasks stuck — agents cannot see these')::TEXT,
    v_count > 0;

  -- Check 2: Stalled tasks > 4 hours
  SELECT COUNT(*) INTO v_count FROM trinity_tasks t
  WHERE t.status IN ('in_progress','doing')
  AND t.updated_at < NOW() - INTERVAL '4 hours';
  RETURN QUERY SELECT
    'stalled_in_progress'::TEXT,
    CASE WHEN v_count > 0 THEN 'ALERT' ELSE 'OK' END::TEXT,
    (v_count || ' tasks stalled > 4 hours')::TEXT,
    v_count > 0;

  -- Check 3: VDR mismatch
  SELECT COUNT(*) INTO v_count FROM repid_agents ra
  WHERE ra.vdr_count = 0
  AND EXISTS (SELECT 1 FROM repid_score_events se WHERE se.agent_id = ra.id AND se.is_shadow = false);
  RETURN QUERY SELECT
    'vdr_mismatch'::TEXT,
    CASE WHEN v_count > 0 THEN 'ALERT' ELSE 'OK' END::TEXT,
    (v_count || ' agents have decisions but VDR=0')::TEXT,
    v_count > 0;

  -- Check 4: HAL thresholds
  SELECT 
    (SELECT value FROM repid_config WHERE key='hal_veto_threshold') = '0.25'
    AND (SELECT value FROM repid_config WHERE key='bft_veto_threshold') = '0.0195'
    AND (SELECT value FROM repid_config WHERE key='hal_block_threshold') = '0.48'
  INTO v_hal_ok;
  RETURN QUERY SELECT
    'hal_thresholds_intact'::TEXT,
    CASE WHEN v_hal_ok THEN 'OK' ELSE 'ALERT' END::TEXT,
    'hal=0.25 | bft=0.0195 | block=0.48'::TEXT,
    NOT v_hal_ok;

  -- Check 5: Proof queue backlog
  SELECT COUNT(*) INTO v_count FROM repid_proof_queue p
  WHERE p.status = 'pending';
  RETURN QUERY SELECT
    'proof_queue_backlog'::TEXT,
    CASE WHEN v_count > 50 THEN 'ALERT' ELSE 'OK' END::TEXT,
    (v_count || ' proofs pending')::TEXT,
    v_count > 50;

  -- Check 6: Pending tasks for agents
  SELECT COUNT(*) INTO v_count FROM trinity_tasks t
  WHERE t.status = 'pending';
  RETURN QUERY SELECT
    'pending_tasks_available'::TEXT,
    CASE WHEN v_count = 0 THEN 'ALERT' ELSE 'OK' END::TEXT,
    (v_count || ' tasks available for agents to claim')::TEXT,
    v_count = 0;

  -- Check 7: VDR vs decisions summary
  SELECT SUM(vdr_count) INTO v_vdr FROM repid_agents;
  SELECT COUNT(*) INTO v_decisions FROM repid_score_events WHERE is_shadow = false;
  RETURN QUERY SELECT
    'system_summary'::TEXT,
    'INFO'::TEXT,
    ('VDR=' || v_vdr || ' | Decisions=' || v_decisions || 
     ' | Agents=' || (SELECT COUNT(*) FROM repid_agents))::TEXT,
    FALSE;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ecosystem_capture_loop_health()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_active_agents  int;
  v_cfg_active     numeric;
  v_base_reward    numeric;
  v_scaled_now     int;
  v_correct_scaled int;
  v_lao_threshold  int;
BEGIN
  SELECT count(DISTINCT agent_id) INTO v_active_agents
    FROM public.repid_score_events WHERE created_at > now() - interval '24 hours' AND is_shadow = false;
  SELECT value INTO v_cfg_active  FROM public.repid_config WHERE key='active_agent_count';
  SELECT value INTO v_base_reward FROM public.repid_config WHERE key='correct_challenge_reward';
  SELECT value::int INTO v_lao_threshold FROM public.repid_config WHERE key='lao_latency_threshold_ms';
  v_scaled_now := public.get_scaled_reward();
  v_correct_scaled := round(v_base_reward * sqrt(5.0 / GREATEST(v_active_agents,1)));

  INSERT INTO public.ecosystem_loop_snapshots (metrics, created_by)
  VALUES (jsonb_build_object(
    -- Adaptive-weights reward multiplier
    'reward_cfg_active_agent_count', v_cfg_active,
    'reward_agents_active_24h',      v_active_agents,
    'reward_scaled_now',             v_scaled_now,
    'reward_scaled_correct',         v_correct_scaled,
    'reward_overpay_pct',            round(100.0*(v_scaled_now - v_correct_scaled)/GREATEST(v_correct_scaled,1), 1),
    -- ANFIS intelligent routing / LLM selection
    'anfis_params_last_tuned',       (SELECT max(tuned_at)   FROM public.anfis_params),
    'routing_weights_last_updated',  (SELECT max(updated_at) FROM public.routing_weights),
    'execution_log_last',            (SELECT max(created_at) FROM public.execution_log),
    'anfis_weight_history_rows',     (SELECT count(*)        FROM public.anfis_weight_history),
    'provider_perf_sample_7d',       (SELECT count(*) FROM public.repid_score_events WHERE created_at>now()-interval '7 days' AND llm_provider IS NOT NULL AND is_shadow = false),
    -- SBFA Disjoint-Families BFT / consensus
    'bft_results_total',             (SELECT count(*) FROM public.trinity_receipt_bft_results),
    'bft_validators_total',          (SELECT count(*) FROM public.trinity_receipt_validators),
    'ai_consensus_total',            (SELECT count(*) FROM public.ai_consensus_decisions),
    'prediction_consensus_total',    (SELECT count(*) FROM public.prediction_consensus),
    'shofet_rulings_total',          (SELECT count(*) FROM public.trinity_shofet_rulings),
    'cfg_decision_requires_quorum',  (SELECT value FROM public.repid_config WHERE key='HAL_DECISION_REQUIRES_QUORUM'),
    -- LAO (Latency As Opportunity)
    'lao_enabled',                   (SELECT value FROM public.repid_config WHERE key='lao_enabled'),
    'lao_threshold_ms',              v_lao_threshold,
    'lao_calls_1h',                  (SELECT count(*) FROM public.llm_call_log WHERE created_at > now()-interval '1 hour'),
    'lao_calls_over_threshold_1h',   (SELECT count(*) FROM public.llm_call_log WHERE created_at > now()-interval '1 hour' AND latency_ms > v_lao_threshold),
    'lao_opportunity_rate_pct_1h',   (SELECT round(100.0*count(*) FILTER (WHERE latency_ms > v_lao_threshold)/GREATEST(count(*),1),1) FROM public.llm_call_log WHERE created_at > now()-interval '1 hour'),
    'lao_p50_ms_1h',                 (SELECT percentile_disc(0.5)  WITHIN GROUP (ORDER BY latency_ms) FROM public.llm_call_log WHERE created_at > now()-interval '1 hour'),
    'lao_p95_ms_1h',                 (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) FROM public.llm_call_log WHERE created_at > now()-interval '1 hour')
  ), 'fn:ecosystem_capture_loop_health');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_agent_performance(p_agent_name text, p_period interval DEFAULT '24:00:00'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_result JSONB;
  v_completed INTEGER;
  v_failed INTEGER;
  v_shadow INTEGER;
  v_total INTEGER;
  v_agent_id UUID;
BEGIN
  -- Resolve agent UUID
  SELECT id INTO v_agent_id FROM public.repid_agents WHERE agent_name = p_agent_name LIMIT 1;
  
  SELECT 
    COUNT(*) FILTER (WHERE status = 'done' OR status = 'completed'),
    COUNT(*) FILTER (WHERE status = 'failed'),
    COUNT(*) FILTER (WHERE status = 'shadow_reject'),
    COUNT(*)
  INTO v_completed, v_failed, v_shadow, v_total
  FROM public.trinity_tasks
  WHERE claimed_by = p_agent_name
  AND updated_at > NOW() - p_period;
  
  v_result := jsonb_build_object(
    'agent_name', p_agent_name,
    'tasks_completed', v_completed,
    'tasks_failed', v_failed,
    'tasks_shadow_rejected', v_shadow,
    'completion_rate', CASE WHEN v_total > 0 
      THEN ROUND(100.0 * v_completed / v_total, 1) ELSE 0.0 END,
    'escalation_rate', CASE WHEN v_total > 0 THEN (
      SELECT ROUND(100.0 * COUNT(*) / GREATEST(v_total, 1), 1)
      FROM public.task_escalations 
      WHERE original_agent = p_agent_name
      AND created_at > NOW() - p_period
    ) ELSE 0.0 END,
    'avg_cost_usd', CASE WHEN v_agent_id IS NOT NULL THEN (
      SELECT COALESCE(ROUND(AVG(COALESCE(cost_usd, 0)), 6), 0.0)
      FROM public.llm_call_log
      WHERE agent_id = v_agent_id
      AND created_at > NOW() - p_period
    ) ELSE 0.0 END,
    'avg_latency_ms', CASE WHEN v_agent_id IS NOT NULL THEN (
      SELECT COALESCE(ROUND(AVG(COALESCE(latency_ms, 0)), 1), 0.0)
      FROM public.llm_call_log
      WHERE agent_id = v_agent_id
      AND created_at > NOW() - p_period
    ) ELSE 0.0 END,
    'hal_catch_rate', CASE WHEN v_agent_id IS NOT NULL THEN (
      SELECT CASE WHEN COUNT(*) > 0
        THEN ROUND(100.0 * COUNT(*) FILTER (WHERE hallucination_caught = true) / COUNT(*), 1)
        ELSE 0.0 END
      FROM public.repid_score_events
      WHERE agent_id = v_agent_id
      AND created_at > NOW() - p_period
      AND is_shadow = false
    ) ELSE 0.0 END,
    'false_positive_rate', CASE WHEN v_agent_id IS NOT NULL THEN (
      SELECT CASE WHEN COUNT(*) FILTER (WHERE hal_decision = 'vetoed') > 0
        THEN ROUND(100.0 * COUNT(*) FILTER (WHERE hal_decision = 'vetoed' AND (metadata->>'disputed')::boolean = true) / COUNT(*) FILTER (WHERE hal_decision = 'vetoed'), 1)
        ELSE 0.0 END
      FROM public.repid_score_events
      WHERE agent_id = v_agent_id
      AND created_at > NOW() - p_period
      AND is_shadow = false
    ) ELSE 0.0 END,
    'peer_agreement_rate', CASE WHEN v_agent_id IS NOT NULL THEN (
      SELECT CASE WHEN COUNT(*) > 0
        THEN ROUND(100.0 * COUNT(*) FILTER (WHERE verification_status = 'verified') / COUNT(*), 1)
        ELSE 100.0 END
      FROM public.peer_verification_queue
      WHERE source_agent_id = v_agent_id
      AND completed_at > NOW() - p_period
    ) ELSE 100.0 END
  );
  
  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_system_health_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'hal_evaluations', (SELECT COUNT(*) FROM hal_classifications),
    'hal_hash_chain', (SELECT COUNT(*) FROM hal_classifications WHERE previous_entry_hash IS NOT NULL),
    'repid_score_events', (SELECT COUNT(*) FROM repid_score_events WHERE is_shadow = false),
    'trustchat_sessions', (SELECT COUNT(*) FROM trustchat_sessions),
    'rated_sessions', (SELECT COUNT(*) FROM trustchat_sessions WHERE rating IS NOT NULL),
    'active_agents', (SELECT COUNT(DISTINCT claimed_by) FROM trinity_tasks WHERE updated_at > NOW() - INTERVAL '10 minutes'),
    'minted_agents', (SELECT COUNT(*) FROM repid_agents WHERE mint_tx_hash IS NOT NULL AND mint_tx_hash != ''),
    'total_agents', (SELECT COUNT(*) FROM repid_agents WHERE agent_name LIKE 'trinity-%' AND agent_name NOT LIKE 'trinity-mock%'),
    'staking_deposits', (SELECT COUNT(*) FROM staking_deposits WHERE status = 'active'),
    'zkp_routes_configured', (SELECT COUNT(*) FROM zkp_routing_config WHERE active = true),
    'collaboration_dna_records', (SELECT COUNT(*) FROM collaboration_dna),
    'capability_assessments', (SELECT COUNT(*) FROM agent_capabilities WHERE score > 0),
    'dispute_claims', (SELECT COUNT(*) FROM dispute_claims),
    'provider_trust_scores', (SELECT COUNT(*) FROM provider_trust_scores),
    'tables_with_rls', (SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public'),
    'daily_cost_usd', 0.01,
    'uptime_hours', EXTRACT(EPOCH FROM (NOW() - '2026-05-18'::timestamp)) / 3600,
    'generated_at', NOW()
  ) INTO result;
  RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION public.graph_rag_backfill_competence_candidates(p_min_events integer)
 RETURNS TABLE(agent_id uuid, task_domain text, backfill_key text, content text, importance numeric, n bigint, pos bigint, neg bigint, neutral bigint, net bigint, mean_hal numeric, hal_n bigint, first_at timestamp with time zone, last_at timestamp with time zone, max_event_id bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH cell AS (
    SELECT
      e.agent_id                                              AS agent_id,
      e.task_domain                                           AS task_domain,
      COUNT(*)                                                AS n,
      COUNT(*) FILTER (WHERE e.delta > 0)                     AS pos,
      COUNT(*) FILTER (WHERE e.delta < 0)                     AS neg,
      COUNT(*) FILTER (WHERE e.delta = 0)                     AS neutral,
      SUM(e.delta)::bigint                                    AS net,
      ROUND(AVG(e.hal_score), 3)                              AS mean_hal,
      COUNT(e.hal_score)                                      AS hal_n,
      MIN(e.created_at)                                       AS first_at,
      MAX(e.created_at)                                       AS last_at,
      MAX(e.id)                                               AS max_event_id
    FROM repid_score_events e
    JOIN repid_agents a ON a.id = e.agent_id
    WHERE e.task_domain IS NOT NULL
      AND e.is_shadow = false
    GROUP BY e.agent_id, e.task_domain
    HAVING COUNT(*) >= p_min_events
  )
  SELECT
    c.agent_id,
    c.task_domain,
    'competence:' || c.agent_id::text || ':' || c.task_domain,
    FORMAT(
      'Domain competence: %s. %s recorded outcomes between %s and %s — %s positive, %s negative, %s neutral (no RepID change), net RepID delta %s.%s%s Source: repid_score_events.',
      c.task_domain,
      c.n,
      TO_CHAR(c.first_at, 'YYYY-MM-DD'),
      TO_CHAR(c.last_at, 'YYYY-MM-DD'),
      c.pos,
      c.neg,
      c.neutral,
      CASE WHEN c.net >= 0 THEN '+' || c.net::text ELSE c.net::text END,
      CASE WHEN c.hal_n > 0
           THEN FORMAT(' Mean HAL score %s across %s scored events (RAW, uncalibrated).', c.mean_hal, c.hal_n)
           ELSE '' END,
      CASE WHEN c.neg > 0 THEN ' Negatives here were detected, not self-reported.' ELSE '' END
    ),
    LEAST(0.95, ROUND(0.40 + 0.10 * LOG(c.n::numeric), 2)),
    c.n, c.pos, c.neg, c.neutral, c.net, c.mean_hal, c.hal_n, c.first_at, c.last_at, c.max_event_id
  FROM cell c;
$function$
;

CREATE OR REPLACE FUNCTION public.graph_rag_backfill_counterparty_candidates()
 RETURNS TABLE(self_id uuid, other_id uuid, backfill_key text, content text, importance numeric, contracts bigint, domains text[], events bigint, pos bigint, neg bigint, neutral bigint, first_at timestamp with time zone, last_at timestamp with time zone, max_event_id bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH sides AS (
    SELECT DISTINCT
      a.agent_id    AS self_id,
      b.agent_id    AS other_id,
      a.contract_id AS contract_id,
      a.id          AS event_id,
      a.delta       AS delta,
      a.task_domain AS task_domain,
      a.created_at  AS created_at
    FROM repid_score_events a
    JOIN repid_score_events b
      ON b.contract_id = a.contract_id
     AND b.agent_id <> a.agent_id
    WHERE a.contract_id IS NOT NULL
      AND a.agent_id IS NOT NULL
      AND b.agent_id IS NOT NULL
      AND a.is_shadow = false
      AND b.is_shadow = false
  ),
  pair AS (
    SELECT
      s.self_id,
      s.other_id,
      COALESCE(NULLIF(ra.display_name, ''), NULLIF(ra.agent_name, ''), LEFT(s.other_id::text, 8)) AS other_name,
      COUNT(DISTINCT s.contract_id)                    AS contracts,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.task_domain), NULL) AS domains,
      COUNT(*)                                         AS events,
      COUNT(*) FILTER (WHERE s.delta > 0)              AS pos,
      COUNT(*) FILTER (WHERE s.delta < 0)              AS neg,
      COUNT(*) FILTER (WHERE s.delta = 0)              AS neutral,
      MIN(s.created_at)                                AS first_at,
      MAX(s.created_at)                                AS last_at,
      MAX(s.event_id)                                  AS max_event_id
    FROM sides s
    JOIN repid_agents rs ON rs.id = s.self_id
    JOIN repid_agents ra ON ra.id = s.other_id
    GROUP BY s.self_id, s.other_id, ra.display_name, ra.agent_name
  )
  SELECT
    p.self_id,
    p.other_id,
    'counterparty:' || p.self_id::text || ':' || p.other_id::text,
    FORMAT(
      'Shared work with %s (%s): %s shared contract(s) between %s and %s.%s This agent''s %s recorded outcomes on that shared work: %s positive, %s negative, %s neutral (no RepID change). Source: repid_score_events joined on contract_id.',
      p.other_name,
      LEFT(p.other_id::text, 8),
      p.contracts,
      TO_CHAR(p.first_at, 'YYYY-MM-DD'),
      TO_CHAR(p.last_at, 'YYYY-MM-DD'),
      CASE WHEN COALESCE(ARRAY_LENGTH(p.domains, 1), 0) > 0
           THEN ' Domains: ' || ARRAY_TO_STRING(p.domains, ', ') || '.'
           ELSE '' END,
      p.events,
      p.pos,
      p.neg,
      p.neutral
    ),
    LEAST(0.90, ROUND(0.45 + 0.10 * LOG(p.contracts::numeric), 2)),
    p.contracts, p.domains, p.events, p.pos, p.neg, p.neutral, p.first_at, p.last_at, p.max_event_id
  FROM pair p;
$function$
;

CREATE OR REPLACE FUNCTION public.repid_capture_baseline()
 RETURNS void
 LANGUAGE sql
 SET statement_timeout TO '30s'
AS $function$
  INSERT INTO public.repid_experiment_log (phase, metrics, notes, created_by)
  SELECT 'baseline',
    jsonb_build_object(
      'agents_total',           (SELECT count(*) FROM public.repid_agents),
      'agents_human',           (SELECT count(*) FROM public.repid_agents WHERE is_human),
      'repid_avg',              (SELECT round(avg(current_repid),1) FROM public.repid_agents),
      'repid_min',              (SELECT min(current_repid) FROM public.repid_agents),
      'repid_max',              (SELECT max(current_repid) FROM public.repid_agents),
      'repid_median',           (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY current_repid) FROM public.repid_agents),
      'tier_dist',              (SELECT jsonb_object_agg(COALESCE(tier,'null'), cnt) FROM (SELECT tier, count(*) cnt FROM public.repid_agents GROUP BY tier) t),
      'events_24h',             (SELECT count(*) FROM public.repid_score_events WHERE created_at > now() - interval '24 hours' AND is_shadow = false),
      'events_24h_by_type',     (SELECT jsonb_object_agg(event_type, cnt) FROM (SELECT event_type, count(*) cnt FROM public.repid_score_events WHERE created_at > now() - interval '24 hours' AND is_shadow = false GROUP BY event_type) t),
      'penalty_suppressed_24h', (SELECT count(*) FROM public.repid_score_events WHERE created_at > now() - interval '24 hours' AND metadata->>'penalty_suppressed' = 'true' AND is_shadow = false),
      'peer_verify_pending',    (SELECT count(*) FROM public.peer_verification_queue WHERE verification_status = 'pending'),
      'dormancy_decay_total',   (SELECT count(*) FROM public.repid_score_events WHERE event_type = 'DORMANCY_DECAY' AND is_shadow = false)
    ),
    'auto hourly snapshot', 'pg_cron:repid_baseline_hourly';
$function$
;

CREATE OR REPLACE FUNCTION public.repid_capture_models()
 RETURNS void
 LANGUAGE sql
 SET statement_timeout TO '30s'
AS $function$
  INSERT INTO public.repid_experiment_log (phase, metrics, notes, created_by)
  SELECT 'model_scorecard',
    jsonb_build_object(
      'calls_24h_by_model', (SELECT jsonb_object_agg(model, obj) FROM (
          SELECT COALESCE(model,'(null)') AS model, jsonb_build_object(
            'calls', count(*),
            'errors', count(*) FILTER (WHERE error_message IS NOT NULL),
            'avg_latency_ms', round(avg(latency_ms)),
            'cost_usd', round(sum(cost_usd)::numeric,4)
          ) AS obj
          FROM public.llm_call_log WHERE created_at > now() - interval '24 hours'
          GROUP BY 1 ORDER BY count(*) DESC LIMIT 40) s),
      'score_events_24h_by_provider', (SELECT jsonb_object_agg(provider, obj) FROM (
          SELECT COALESCE(llm_provider,'(null)') AS provider,
            jsonb_build_object('events', count(*), 'avg_delta', round(avg(delta),2)) AS obj
          FROM public.repid_score_events WHERE created_at > now() - interval '24 hours' AND is_shadow = false
          GROUP BY 1 ORDER BY count(*) DESC LIMIT 40) s),
      'model_attributed_delta_24h', (SELECT jsonb_object_agg(model, obj) FROM (
          SELECT COALESCE(l.model,'(unrecovered)') AS model,
            jsonb_build_object('events', count(*), 'avg_delta', round(avg(e.delta),2)) AS obj
          FROM public.repid_score_events e
          LEFT JOIN public.llm_call_log l ON l.call_id::text = e.llm_call_id::text
          WHERE e.created_at > now() - interval '24 hours' AND e.is_shadow = false
          GROUP BY 1 ORDER BY count(*) DESC LIMIT 30) s)
    ),
    'auto hourly model scorecard', 'pg_cron:repid_models_hourly';
$function$
;

CREATE OR REPLACE FUNCTION public.sync_active_agent_count()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_real   int;
  v_min    numeric;
  v_max    numeric;
  v_clamped int;
BEGIN
  SELECT count(DISTINCT agent_id) INTO v_real
    FROM public.repid_score_events WHERE created_at > now() - interval '24 hours' AND is_shadow = false;
  SELECT min_value, max_value INTO v_min, v_max FROM public.repid_config WHERE key='active_agent_count';
  v_clamped := LEAST(GREATEST(v_real, COALESCE(v_min,1)::int), COALESCE(v_max,20)::int);
  UPDATE public.repid_config
     SET value = v_clamped::text, last_updated = now(), updated_by = 'fn:sync_active_agent_count'
   WHERE key = 'active_agent_count';
  RETURN v_clamped;
END;
$function$
;

COMMIT;
