const apikey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFubnBqaGx4bGp0cXlpZ2Vkd2tiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5Mzk1OTEsImV4cCI6MjA2NzUxNTU5MX0.6oG2DU_BD1uBnBrDoQFauvN1ZnkKo2ywkuwY-tPaQFw';
const SUPA_URL = 'https://qnnpjhlxljtqyigedwkb.supabase.co';

async function runSQL(name, query) {
  const req = await fetch(`${SUPA_URL}/rest/v1/rpc/exec_sql`, {
      method: "POST", headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
  });
  const text = await req.text();
  console.log(`[${name}] Status:`, req.status, "Body:", text);
}

async function run() {
  await runSQL('Track 6.1', `
    UPDATE repid_agents ra
    SET vdr_count = (
      SELECT COUNT(*) FROM repid_score_events se
      WHERE se.agent_id = ra.id
    )
    WHERE EXISTS (
      SELECT 1 FROM repid_score_events se
      WHERE se.agent_id = ra.id
    );
  `);

  await runSQL('Track 6.2', `
    UPDATE repid_verified_decisions rvd
    SET vdr_count = (
      SELECT COUNT(*) FROM repid_score_events se
      WHERE se.agent_id = rvd.agent_id
    )
    WHERE EXISTS (
      SELECT 1 FROM repid_score_events se
      WHERE se.agent_id = rvd.agent_id
    );
  `);

  await runSQL('Track 6.3', `
    INSERT INTO repid_verified_decisions 
      (agent_id, vdr_count, last_verified_at)
    SELECT 
      ra.id,
      COUNT(se.id),
      MAX(se.created_at)
    FROM repid_agents ra
    JOIN repid_score_events se ON se.agent_id = ra.id
    GROUP BY ra.id
    ON CONFLICT (agent_id) DO UPDATE SET
      vdr_count = EXCLUDED.vdr_count,
      last_verified_at = EXCLUDED.last_verified_at,
      updated_at = NOW();
  `);

  await runSQL('Track 8.1', `
    INSERT INTO hal_training_cases
      (source_event_id, agent_id, llm_provider, 
      llm_model, hallucination_type, 
      original_claim, dissonance_score,
      hal_layer_triggered, added_to_test_suite)
    SELECT 
      se.id,
      se.agent_id,
      se.llm_provider,
      se.llm_model,
      'factual_error',
      se.metadata->>'decision_text',
      se.hal_score,
      1,
      true
    FROM repid_score_events se
    WHERE se.hallucination_caught = true
    ON CONFLICT DO NOTHING;
  `);

  // Verify Track 6
  console.log('--- TRACK 6 PROOF ---');
  await runSQL('Proof 6', `
    SELECT agent_name, current_repid, vdr_count
    FROM repid_agents
    WHERE vdr_count > 0
    ORDER BY current_repid DESC
    LIMIT 15;
  `);

  // Verify Track 8
  console.log('--- TRACK 8 PROOF ---');
  await runSQL('Proof 8', `
    SELECT COUNT(*) FROM hal_training_cases;
  `);
}

run();
