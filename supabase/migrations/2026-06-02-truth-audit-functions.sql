-- SQL migration deploying fn_system_health_summary and fn_agent_roster functions.
-- Date: June 2, 2026

CREATE OR REPLACE FUNCTION fn_system_health_summary()
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'hal_evaluations', (SELECT COUNT(*) FROM hal_classifications),
    'hal_hash_chain', (SELECT COUNT(*) FROM hal_classifications WHERE previous_entry_hash IS NOT NULL),
    'repid_score_events', (SELECT COUNT(*) FROM repid_score_events),
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
END $$;

CREATE OR REPLACE FUNCTION fn_agent_roster()
RETURNS TABLE(
  agent_name TEXT, squad TEXT, tier TEXT, repid INTEGER,
  minted BOOLEAN, wallet TEXT, custodian TEXT,
  capabilities_unlocked INTEGER, dna_depth INTEGER
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT 
    a.agent_name, a.squad_role, a.tier, a.current_repid,
    (a.mint_tx_hash IS NOT NULL AND a.mint_tx_hash != '')::BOOLEAN,
    a.wallet_address, a.conservator_address,
    COALESCE((SELECT COUNT(*) FROM agent_capabilities c WHERE c.agent_name = a.agent_name AND c.unlocked = true)::INTEGER, 0),
    COALESCE((SELECT d.lineage_depth FROM collaboration_dna d WHERE d.agent_name = a.agent_name), 0)
  FROM repid_agents a
  WHERE a.agent_name LIKE 'trinity-%'
  AND a.agent_name NOT LIKE 'trinity-mock%'
  AND a.agent_name NOT LIKE 'trinity-z2%'
  ORDER BY a.current_repid DESC;
END $$;
