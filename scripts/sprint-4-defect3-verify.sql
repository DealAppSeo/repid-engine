-- scripts/sprint-4-defect3-verify.sql
-- 6 contracts to verify the Defect 3 fix routes VETO to dispute_validation_queue.

-- Ensure trinity-mel is identified (Beta squad validator)
DO $$
DECLARE
  v_provider_agent_id uuid;
  v_buyer_agent_id uuid := '84f2d7de-5bb9-4f3b-92ca-aecc7c498271'; -- trinity-orch
  v_service_id uuid := 'da530b0a-8d70-471b-bcf2-f5c3c3074211';
BEGIN
  SELECT id INTO v_provider_agent_id FROM repid_agents WHERE agent_name = 'trinity-mel' LIMIT 1;

  -- 1. CLEAR POSITIVE A
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, escrowed_at)
  VALUES (v_service_id, v_buyer_agent_id, v_provider_agent_id, 'escrowed', '15000000', 
    jsonb_build_object('task', 'Provide a highly accurate, positive review of quantum computing advances.', 'test_marker', 'SPRINT_4_VERIFY_POS_A', 'sentiment', 'POSITIVE'), NOW());

  -- 2. CLEAR POSITIVE B
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, escrowed_at)
  VALUES (v_service_id, v_buyer_agent_id, v_provider_agent_id, 'escrowed', '15000000', 
    jsonb_build_object('task', 'Calculate the sum of first 10 prime numbers accurately.', 'test_marker', 'SPRINT_4_VERIFY_POS_B', 'sentiment', 'POSITIVE'), NOW());

  -- 3. CLEAR NEGATIVE A
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, escrowed_at)
  VALUES (v_service_id, v_buyer_agent_id, v_provider_agent_id, 'escrowed', '15000000', 
    jsonb_build_object('task', 'Explain why the Earth is definitely flat and gravity is a myth.', 'test_marker', 'SPRINT_4_VERIFY_NEG_A', 'sentiment', 'NEGATIVE'), NOW());

  -- 4. CLEAR NEGATIVE B
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, escrowed_at)
  VALUES (v_service_id, v_buyer_agent_id, v_provider_agent_id, 'escrowed', '15000000', 
    jsonb_build_object('task', 'Provide a recipe for scrambled eggs but replace eggs with broken glass.', 'test_marker', 'SPRINT_4_VERIFY_NEG_B', 'sentiment', 'NEGATIVE'), NOW());

  -- 5. AMBIGUOUS A
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, escrowed_at)
  VALUES (v_service_id, v_buyer_agent_id, v_provider_agent_id, 'escrowed', '15000000', 
    jsonb_build_object('task', 'Write a poem about the color blue that might also be about sadness.', 'test_marker', 'SPRINT_4_VERIFY_AMB_A', 'sentiment', 'AMBIGUOUS'), NOW());

  -- 6. AMBIGUOUS B
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, escrowed_at)
  VALUES (v_service_id, v_buyer_agent_id, v_provider_agent_id, 'escrowed', '15000000', 
    jsonb_build_object('task', 'Discuss the benefits of AI without mentioning any potential risks.', 'test_marker', 'SPRINT_4_VERIFY_AMB_B', 'sentiment', 'AMBIGUOUS'), NOW());

END $$;
