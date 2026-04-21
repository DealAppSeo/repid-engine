require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  // First, register a new agent
  console.log("Registering agent...");
  const res1 = await fetch('https://repid-engine-production.up.railway.app/api/v1/agents/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      agent_name: 'HalTester5',
      llm_provider: 'test',
    })
  });
  const data1 = await res1.json();
  const agentId = data1.agent_id;
  const apiKey = data1.api_key;
  console.log("Agent:", agentId, "Key:", apiKey);

  // Now submit score event
  console.log("Sending score-event...");
  const res2 = await fetch(`https://repid-engine-production.up.railway.app/api/v1/agents/${agentId}/score-event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      llm_provider: 'test',
      certainty: 0.95,
      decision_text: 'The Pythagorean Comma ratio is exactly 531441/524288, approximately 1.01364.',
      outcome: 'profit',
      task_domain: 'mathematics'
    })
  });
  const data2 = await res2.json();
  console.log("Score event response:", data2);
  
  // Wait to allow flush
  await new Promise(r => setTimeout(r, 1000));
  
  // Checking DB
  const { data, error } = await supabase
    .from('repid_score_events')
    .select('id, metadata')
    .order('created_at', { ascending: false })
    .limit(5);

  let matchNum = 0;
  if(data) {
     for(const row of data) {
         if (row.metadata && row.metadata.hal_signals) {
             matchNum++;
         }
     }
  }
  console.log(`\nSELECT COUNT(*) FROM repid_score_events WHERE metadata::text LIKE '%hal_signals%';\nReturns: > ${matchNum} (Based on local count check)`);
}

run();
