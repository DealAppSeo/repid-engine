-- scripts/verify-mvp-cascade.sql
-- Run with: psql -v contract_id='<uuid>' -f scripts/verify-mvp-cascade.sql

\echo '=== Section A: service_contract row state ==='
SELECT id, service_id, buyer_agent_id, provider_agent_id, 
       status, agreed_price_usdc_raw, payload, result, 
       metadata, created_at, escrowed_at, fulfilled_at, 
       satisfied_at, settled_at, disputed_at, resolved_at
FROM service_contracts WHERE id = :'contract_id';

\echo '=== Section B: validation_queue rows tied to contract ==='
SELECT * FROM validation_queue 
WHERE (metadata->>'contract_id')::uuid = :'contract_id'
OR id IN (
  SELECT dispute_panel_validation_queue_id FROM service_contracts 
  WHERE id = :'contract_id'
);

\echo '=== Section C: repid_score_events tied to contract/agents in last hour ==='
SELECT id, agent_id, event_type, delta, metadata, 
       created_at
FROM repid_score_events
WHERE (metadata->>'contract_id')::uuid = :'contract_id'
   OR (agent_id IN (
     SELECT buyer_agent_id FROM service_contracts WHERE id = :'contract_id'
     UNION SELECT provider_agent_id FROM service_contracts WHERE id = :'contract_id'
   )
   AND created_at > (SELECT created_at FROM service_contracts WHERE id = :'contract_id'));

\echo '=== Section D: hal_audit_chain rows anchoring B or C ==='
SELECT id, source_table, source_id, current_entry_hash, 
       previous_entry_hash, created_at
FROM hal_audit_chain
WHERE source_id IN (
  SELECT id::text FROM repid_score_events WHERE (metadata->>'contract_id')::uuid = :'contract_id'
)
ORDER BY created_at;

\echo '=== Section E: Audit surface deltas — magnitude check ==='
SELECT event_type, delta,
       CASE 
         WHEN ABS(delta) IN (40, 120, 300, 500) THEN 'CANONICAL'
         WHEN ABS(delta) IN (5, 10, 15, 30) THEN 'SERVICE_FULFILLED/SATISFIED'
         ELSE 'OUT_OF_BAND'
       END as canonical_status
FROM repid_score_events
WHERE (metadata->>'contract_id')::uuid = :'contract_id';

\echo '=== Section F: Timeline ==='
WITH contract_events AS (
  SELECT 'CONTRACT_CREATED' as event, created_at as ts FROM service_contracts WHERE id = :'contract_id'
  UNION ALL
  SELECT 'CONTRACT_ESCROWED', escrowed_at FROM service_contracts WHERE id = :'contract_id' AND escrowed_at IS NOT NULL
  UNION ALL
  SELECT 'CONTRACT_FULFILLED', fulfilled_at FROM service_contracts WHERE id = :'contract_id' AND fulfilled_at IS NOT NULL
  UNION ALL
  SELECT 'SCORE_EVENT_' || event_type, created_at FROM repid_score_events WHERE (metadata->>'contract_id')::uuid = :'contract_id'
  UNION ALL
  SELECT 'AUDIT_ANCHOR', created_at FROM hal_audit_chain WHERE source_id IN (SELECT id::text FROM repid_score_events WHERE (metadata->>'contract_id')::uuid = :'contract_id')
)
SELECT event, ts, 
       EXTRACT(EPOCH FROM (ts - (SELECT created_at FROM service_contracts WHERE id = :'contract_id'))) * 1000 as ms_since_creation
FROM contract_events
ORDER BY ts;

\echo '=== Section G: MVP_ALIVE boolean evaluation ==='
WITH base AS (
  SELECT
    COALESCE((result->>'pcp_score')::numeric > 0, false) as c1,
    COALESCE((result->>'judge_confidence')::numeric > 0, false) as c2
  FROM service_contracts
  WHERE id = :'contract_id'
),
events AS (
  SELECT 
    bool_or(event_type = 'SERVICE_FULFILLED') as has_fulfilled,
    bool_and(ABS(delta) IN (5, 10, 15, 30, 40, 120, 300, 500)) as canonical_mag,
    count(*) > 0 as has_events
  FROM repid_score_events WHERE (metadata->>'contract_id')::uuid = :'contract_id'
),
anchors AS (
  SELECT count(*) > 0 as has_anchors
  FROM hal_audit_chain 
  WHERE source_id IN (SELECT id::text FROM repid_score_events WHERE (metadata->>'contract_id')::uuid = :'contract_id')
)
SELECT 
  (COALESCE(c1, false) AND COALESCE(c2, false) AND COALESCE(has_fulfilled, false) AND COALESCE(canonical_mag, false) AND COALESCE(has_events, false) AND COALESCE(has_anchors, false)) as mvp_alive,
  COALESCE(c1, false) as criterion_1_pcp_nonzero,
  COALESCE(c2, false) as criterion_2_judge_nonzero,
  COALESCE(has_fulfilled, false) as criterion_3_service_fulfilled_event,
  COALESCE(canonical_mag, false) as criterion_4_canonical_delta_magnitude,
  COALESCE(has_anchors, false) as criterion_5_audit_chain_anchor,
  ARRAY_REMOVE(ARRAY[
    CASE WHEN NOT COALESCE(c1, false) THEN 'PCP_NONZERO' END,
    CASE WHEN NOT COALESCE(c2, false) THEN 'JUDGE_NONZERO' END,
    CASE WHEN NOT COALESCE(has_fulfilled, false) THEN 'SERVICE_FULFILLED' END,
    CASE WHEN NOT (COALESCE(canonical_mag, false) AND COALESCE(has_events, false)) THEN 'CANONICAL_MAGNITUDE' END,
    CASE WHEN NOT COALESCE(has_anchors, false) THEN 'AUDIT_CHAIN' END
  ], NULL) as failed_criteria
FROM (SELECT 1) dummy
LEFT JOIN base ON true
LEFT JOIN events ON true
LEFT JOIN anchors ON true;
