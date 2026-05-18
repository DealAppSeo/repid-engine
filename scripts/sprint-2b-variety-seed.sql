DO $$
DECLARE
  new_id uuid;
BEGIN
  -- 1
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, metadata) VALUES 
  ('da530b0a-8d70-471b-bcf2-f5c3c3074211', '84f2d7de-5bb9-4f3b-92ca-aecc7c498271', '942860a6-e26f-4334-ae94-b7c1abed1e8c', 'pending', 500000, 
  '{"title": "Fact check", "criteria": ["Is this scientifically true?"], "content": "Water freezes at 0°C at standard atmospheric pressure.", "claimer_provider": "anthropic", "test_marker": "SPRINT_2B_VARIETY_1"}'::jsonb, 
  '{"sprint": "2B", "category": "positive", "expected_outcome": "approve"}'::jsonb) RETURNING id INTO new_id;
  UPDATE service_contracts SET status = 'escrowed', escrowed_at = NOW() WHERE id = new_id;

  -- 2
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, metadata) VALUES 
  ('da530b0a-8d70-471b-bcf2-f5c3c3074211', '84f2d7de-5bb9-4f3b-92ca-aecc7c498271', '942860a6-e26f-4334-ae94-b7c1abed1e8c', 'pending', 500000, 
  '{"title": "Fact check", "criteria": ["Is this true?"], "content": "The mitochondrion is the powerhouse of the cell.", "claimer_provider": "groq", "test_marker": "SPRINT_2B_VARIETY_2"}'::jsonb, 
  '{"sprint": "2B", "category": "positive", "expected_outcome": "approve"}'::jsonb) RETURNING id INTO new_id;
  UPDATE service_contracts SET status = 'escrowed', escrowed_at = NOW() WHERE id = new_id;

  -- 3
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, metadata) VALUES 
  ('da530b0a-8d70-471b-bcf2-f5c3c3074211', '84f2d7de-5bb9-4f3b-92ca-aecc7c498271', '942860a6-e26f-4334-ae94-b7c1abed1e8c', 'pending', 500000, 
  '{"title": "Fact check", "criteria": ["Is this historically accurate?"], "content": "JavaScript was created by Brendan Eich at Netscape in 1995.", "claimer_provider": "openai", "test_marker": "SPRINT_2B_VARIETY_3"}'::jsonb, 
  '{"sprint": "2B", "category": "positive", "expected_outcome": "approve"}'::jsonb) RETURNING id INTO new_id;
  UPDATE service_contracts SET status = 'escrowed', escrowed_at = NOW() WHERE id = new_id;

  -- 4
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, metadata) VALUES 
  ('da530b0a-8d70-471b-bcf2-f5c3c3074211', '84f2d7de-5bb9-4f3b-92ca-aecc7c498271', '942860a6-e26f-4334-ae94-b7c1abed1e8c', 'pending', 500000, 
  '{"title": "Fact check", "criteria": ["Is this true?"], "content": "The Pacific Ocean is the smallest ocean on Earth.", "claimer_provider": "anthropic", "test_marker": "SPRINT_2B_VARIETY_4"}'::jsonb, 
  '{"sprint": "2B", "category": "negative", "expected_outcome": "reject"}'::jsonb) RETURNING id INTO new_id;
  UPDATE service_contracts SET status = 'escrowed', escrowed_at = NOW() WHERE id = new_id;

  -- 5
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, metadata) VALUES 
  ('da530b0a-8d70-471b-bcf2-f5c3c3074211', '84f2d7de-5bb9-4f3b-92ca-aecc7c498271', '942860a6-e26f-4334-ae94-b7c1abed1e8c', 'pending', 500000, 
  '{"title": "Fact check", "criteria": ["Is this accurate?"], "content": "Mount Everest is located in Antarctica.", "claimer_provider": "groq", "test_marker": "SPRINT_2B_VARIETY_5"}'::jsonb, 
  '{"sprint": "2B", "category": "negative", "expected_outcome": "reject"}'::jsonb) RETURNING id INTO new_id;
  UPDATE service_contracts SET status = 'escrowed', escrowed_at = NOW() WHERE id = new_id;

  -- 6
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, metadata) VALUES 
  ('da530b0a-8d70-471b-bcf2-f5c3c3074211', '84f2d7de-5bb9-4f3b-92ca-aecc7c498271', '942860a6-e26f-4334-ae94-b7c1abed1e8c', 'pending', 500000, 
  '{"title": "Fact check", "criteria": ["Is this physically true?"], "content": "Sound travels faster than light in a vacuum.", "claimer_provider": "openai", "test_marker": "SPRINT_2B_VARIETY_6"}'::jsonb, 
  '{"sprint": "2B", "category": "negative", "expected_outcome": "reject"}'::jsonb) RETURNING id INTO new_id;
  UPDATE service_contracts SET status = 'escrowed', escrowed_at = NOW() WHERE id = new_id;

  -- 7
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, metadata) VALUES 
  ('da530b0a-8d70-471b-bcf2-f5c3c3074211', '84f2d7de-5bb9-4f3b-92ca-aecc7c498271', '942860a6-e26f-4334-ae94-b7c1abed1e8c', 'pending', 500000, 
  '{"title": "Fact check", "criteria": ["Is this unequivocally true?"], "content": "Pluto is a planet.", "claimer_provider": "anthropic", "test_marker": "SPRINT_2B_VARIETY_7"}'::jsonb, 
  '{"sprint": "2B", "category": "ambiguous", "expected_outcome": "mixed"}'::jsonb) RETURNING id INTO new_id;
  UPDATE service_contracts SET status = 'escrowed', escrowed_at = NOW() WHERE id = new_id;

  -- 8
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, metadata) VALUES 
  ('da530b0a-8d70-471b-bcf2-f5c3c3074211', '84f2d7de-5bb9-4f3b-92ca-aecc7c498271', '942860a6-e26f-4334-ae94-b7c1abed1e8c', 'pending', 500000, 
  '{"title": "Fact check", "criteria": ["Is this botanically accurate?"], "content": "Tomatoes are vegetables for culinary purposes.", "claimer_provider": "groq", "test_marker": "SPRINT_2B_VARIETY_8"}'::jsonb, 
  '{"sprint": "2B", "category": "ambiguous", "expected_outcome": "mixed"}'::jsonb) RETURNING id INTO new_id;
  UPDATE service_contracts SET status = 'escrowed', escrowed_at = NOW() WHERE id = new_id;

  -- 9
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, metadata) VALUES 
  ('da530b0a-8d70-471b-bcf2-f5c3c3074211', '84f2d7de-5bb9-4f3b-92ca-aecc7c498271', '942860a6-e26f-4334-ae94-b7c1abed1e8c', 'pending', 500000, 
  '{"title": "Fact check", "criteria": ["Is the reasoning sound?"], "content": "Sharks are mammals because they give birth to live young.", "claimer_provider": "openai", "test_marker": "SPRINT_2B_VARIETY_9"}'::jsonb, 
  '{"sprint": "2B", "category": "misleading", "expected_outcome": "reject"}'::jsonb) RETURNING id INTO new_id;
  UPDATE service_contracts SET status = 'escrowed', escrowed_at = NOW() WHERE id = new_id;

  -- 10
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, metadata) VALUES 
  ('da530b0a-8d70-471b-bcf2-f5c3c3074211', '84f2d7de-5bb9-4f3b-92ca-aecc7c498271', '942860a6-e26f-4334-ae94-b7c1abed1e8c', 'pending', 500000, 
  '{"title": "Fact check", "criteria": ["Is this a factual statement?"], "content": "Lightning never strikes the same place twice.", "claimer_provider": "anthropic", "test_marker": "SPRINT_2B_VARIETY_10"}'::jsonb, 
  '{"sprint": "2B", "category": "misleading", "expected_outcome": "reject"}'::jsonb) RETURNING id INTO new_id;
  UPDATE service_contracts SET status = 'escrowed', escrowed_at = NOW() WHERE id = new_id;

  -- 11
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, metadata) VALUES 
  ('da530b0a-8d70-471b-bcf2-f5c3c3074211', '84f2d7de-5bb9-4f3b-92ca-aecc7c498271', '942860a6-e26f-4334-ae94-b7c1abed1e8c', 'pending', 500000, 
  '{"title": "Fact check", "criteria": ["Is this technically precise?"], "content": "PostgreSQL''s default isolation level is READ COMMITTED.", "claimer_provider": "groq", "test_marker": "SPRINT_2B_VARIETY_11"}'::jsonb, 
  '{"sprint": "2B", "category": "technical", "expected_outcome": "approve"}'::jsonb) RETURNING id INTO new_id;
  UPDATE service_contracts SET status = 'escrowed', escrowed_at = NOW() WHERE id = new_id;

  -- 12
  INSERT INTO service_contracts (service_id, buyer_agent_id, provider_agent_id, status, agreed_price_usdc_raw, payload, metadata) VALUES 
  ('da530b0a-8d70-471b-bcf2-f5c3c3074211', '84f2d7de-5bb9-4f3b-92ca-aecc7c498271', '942860a6-e26f-4334-ae94-b7c1abed1e8c', 'pending', 500000, 
  '{"title": "Fact check", "criteria": ["Is this factually precise?"], "content": "TypeScript was developed by Microsoft and first released in 2012.", "claimer_provider": "openai", "test_marker": "SPRINT_2B_VARIETY_12"}'::jsonb, 
  '{"sprint": "2B", "category": "technical", "expected_outcome": "approve"}'::jsonb) RETURNING id INTO new_id;
  UPDATE service_contracts SET status = 'escrowed', escrowed_at = NOW() WHERE id = new_id;

END $$;
