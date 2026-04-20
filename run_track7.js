const apikey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFubnBqaGx4bGp0cXlpZ2Vkd2tiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5Mzk1OTEsImV4cCI6MjA2NzUxNTU5MX0.6oG2DU_BD1uBnBrDoQFauvN1ZnkKo2ywkuwY-tPaQFw';
const SUPA_URL = 'https://qnnpjhlxljtqyigedwkb.supabase.co';
const API_URL = 'https://repid-engine-production.up.railway.app/api/v1';

const events = [
  // CAT A: Cap Rate (10)
  ...Array(10).fill().map((_,i) => ({ domain: 'cre-underwriting', alignment: 'ecosystem', outcome: 'approved', hal: false, text: `Cap Rate Scenario ${i}: industrial cap rate compression`, certainty: 0.9 + i*0.005 })),
  // CAT B: Lease Abstraction (8)
  ...Array(8).fill().map((_,i) => ({ domain: 'legal', alignment: 'ecosystem', outcome: 'approved', hal: false, text: `Lease Abstraction ${i}: NNN lease term extraction`, certainty: 0.88 + i*0.005 })),
  // CAT C: Hallucination (12)
  ...Array(12).fill().map((_,i) => ({ domain: 'cre-underwriting', alignment: 'ecosystem', outcome: 'vetoed', hal: true, text: `Hallucination Catch ${i}: wrong vacancy rate stated`, certainty: 0.92 })),
  // CAT D: Colorado AI (8)
  ...Array(8).fill().map((_,i) => ({ domain: 'compliance', alignment: 'ecosystem', outcome: 'approved', hal: false, text: `Colorado AI ${i}: explainability verify`, certainty: 0.91 })),
  // CAT E: Portfolio Risk (7)
  ...Array(7).fill().map((_,i) => ({ domain: 'financial', alignment: 'ecosystem', outcome: 'approved', hal: false, text: `Risk Analysis ${i}: LTV verification limit breach`, certainty: 0.89 })),
  // CAT F: HAL Veto (5)
  ...Array(5).fill().map((_,i) => ({ domain: 'cre-underwriting', alignment: 'self', outcome: 'vetoed', hal: false, text: `Speculative projection ${i}: circular reasoning`, certainty: 0.3 }))
];

async function run() {
  const r = await fetch(`${SUPA_URL}/rest/v1/repid_agents?select=id,agent_name,constitution&agent_name=in.(cre-underwriting-agent,cre-legal-agent,demo-openai-agent)`, { headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey } });
  const agents = await r.json();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const agent = agents[i % agents.length];
    const provider = agent.constitution.llm_provider || 'OpenAI';
    
    await fetch(`${API_URL}/agents/${agent.id}/score-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agent.constitution.api_key}` },
      body: JSON.stringify({
        llm_provider: provider,
        llm_model: provider === 'OpenAI' ? 'gpt-4' : 'claude-3',
        certainty: ev.certainty,
        decision_text: ev.text,
        outcome: ev.outcome,
        task_domain: ev.domain,
        alignment_category: ev.alignment,
        hallucination_caught: ev.hal
      })
    });
  }

  // Backfill Track 6 style for the newly added VDR to increment total immediately:
  await fetch(`${SUPA_URL}/rest/v1/rpc/exec_sql`, {
      method: "POST", headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `
        UPDATE repid_agents ra
        SET vdr_count = (SELECT COUNT(*) FROM repid_score_events se WHERE se.agent_id = ra.id AND se.hallucination_caught = false)
        WHERE EXISTS (SELECT 1 FROM repid_score_events se WHERE se.agent_id = ra.id);
      `})
  });

  // Execute Proofs
  const p1 = await fetch(`${SUPA_URL}/rest/v1/rpc/exec_sql`, {
      method: "POST", headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT COUNT(*) as total, SUM(CASE WHEN hallucination_caught THEN 1 ELSE 0 END) as catches, COUNT(DISTINCT task_domain) as domains, COUNT(DISTINCT llm_provider) as providers FROM repid_score_events' })
  });
  console.log("Stats:", await p1.text());

  const p2 = await fetch(`${SUPA_URL}/rest/v1/rpc/exec_sql`, {
      method: "POST", headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT SUM(vdr_count) as total_vdr FROM repid_agents' })
  });
  console.log("VDR:", await p2.text());
}
run();
