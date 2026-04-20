const apikey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFubnBqaGx4bGp0cXlpZ2Vkd2tiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5Mzk1OTEsImV4cCI6MjA2NzUxNTU5MX0.6oG2DU_BD1uBnBrDoQFauvN1ZnkKo2ywkuwY-tPaQFw';
const SUPA_URL = 'https://qnnpjhlxljtqyigedwkb.supabase.co';
const API_URL = 'https://repid-engine-production.up.railway.app/api/v1';

async function run() {
  const r = await fetch(`${SUPA_URL}/rest/v1/repid_agents?select=id,agent_name,constitution&agent_name=in.(cre-underwriting-agent,cre-legal-agent,demo-openai-agent)`, {
    headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey }
  });
  const agents = await r.json();
  console.log(`Found ${agents.length} target agents for Track 3`);

  if (!agents || agents.length === 0) {
      console.log(await r.text());
      return;
  }

  // Seeding 50 events
  const domains = ['financial', 'legal', 'compliance', 'cre-underwriting', 'general'];
  let complianceCount = 0;
  let halCount = 0;

  for (let i = 0; i < 50; i++) {
    const agent = agents[i % agents.length];
    const apiKey = agent.constitution.api_key;
    const provider = agent.constitution.llm_provider || 'OpenAI';
    
    // We need at least 5 compliance domain events
    let domain = domains[Math.floor(Math.random() * domains.length)];
    let alignment = 'other';
    if (complianceCount < 5) {
        domain = 'compliance';
        alignment = 'ecosystem';
        complianceCount++;
    } else if (i % 5 === 0) {
        domain = 'compliance';
        alignment = 'ecosystem';
    }

    // Mix of certainties
    const isApproval = Math.random() > 0.5;
    const certainty = isApproval ? (0.85 + Math.random() * 0.1) : (0.25 + Math.random() * 0.1);
    
    // At least 10 hallucination_caught events
    let hallucination_caught = false;
    if (halCount < 10) {
        hallucination_caught = true;
        halCount++;
    } else if (Math.random() > 0.8) {
        hallucination_caught = true;
    }

    const payload = {
        llm_provider: provider,
        llm_model: provider === 'OpenAI' ? 'gpt-4' : 'claude-3',
        certainty,
        decision_text: `Targeted sprint 7 event ${Date.now()}_${i}`,
        outcome: isApproval ? 'APPROVED' : 'VETOED',
        task_domain: domain,
        alignment_category: alignment,
        hallucination_caught
    };

    const res = await fetch(`${API_URL}/agents/${agent.id}/score-event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });
    
    if (!res.ok) {
        console.log("Error:", res.status, await res.text());
    }
  }

  // Execute proof queries via RPC
  const q1 = await fetch(`${SUPA_URL}/rest/v1/rpc/exec_sql`, {
      method: "POST", headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT SUM(vdr_count) as c FROM repid_agents' })
  });
  console.log("Total VDR:", await q1.text());

  const q2 = await fetch(`${SUPA_URL}/rest/v1/rpc/exec_sql`, {
      method: "POST", headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT COUNT(DISTINCT llm_provider) as c FROM repid_score_events WHERE llm_provider IS NOT NULL' })
  });
  console.log("Distinct Providers:", await q2.text());

  const q3 = await fetch(`${SUPA_URL}/rest/v1/rpc/exec_sql`, {
      method: "POST", headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT COUNT(*) as c FROM hal_training_cases' })
  });
  console.log("Hal Training Cases:", await q3.text());
}
run();
