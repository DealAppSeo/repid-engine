import { db } from "./src/db";
import app from "./src/index";
import * as http from "http";

const URL = 'http://127.0.0.1:3001/api/v1';

async function run() {
  const server = http.createServer(app);
  server.listen(3001, "127.0.0.1", async () => {
    console.log("Server listening on 3001 for VDR seeding...");

    const agents: { id: string; key: string; provider: string }[] = [];
    const providers = ['OpenAI', 'Anthropic', 'Google'];

    for (let i = 0; i < 3; i++) {
        const res = await fetch(`${URL}/agents/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent_name: `Test_Agent_VDR_${i}`,
                llm_provider: providers[i],
                is_human: false
            })
        });
        const data: any = await res.json();
        if (data.agent_id) {
            agents.push({ id: data.agent_id as string, key: data.api_key as string, provider: providers[i] as string });
        } else {
            console.log("Failed to register agent", data);
        }
    }

    if (agents.length === 0) {
      console.log("Failed to register and no agents available.");
      server.close();
      return process.exit(1);
    }
    console.log(`Registered agents: ${agents.map(a => a.id).join(', ')}`);

    let totalVdr = 0;
    let eventsSent = 0;
    while (totalVdr < 100 && eventsSent < 110) {
      for (const agent of agents) {
        if (totalVdr >= 100) break;
        
        eventsSent++;
        const reqBody = {
            llm_provider: agent.provider,
            llm_model: agent.provider === 'OpenAI' ? 'gpt-4' : 'claude-3',
            certainty: 0.8 + (Math.random() * 0.1),
            decision_text: `Decision test ${Date.now()}_${Math.random()}`,
            outcome: 'PENDING',
            task_domain: 'finance',
            hallucination_caught: Math.random() > 0.95
        };

        const res = await fetch(`${URL}/agents/${agent.id}/score-event`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${agent.key}`
          },
          body: JSON.stringify(reqBody)
        });

        if (!res.ok) {
           console.log("Error posting score:", await res.text(), "Code:", res.status);
           await new Promise(r => setTimeout(r, 1000));
           continue;
        }

        const data: any = await res.json();
        if (data.vdr_count) {
          totalVdr = data.vdr_count;
        }
      }
    }
    
    console.log(`Generated enough events! Latest agent VDR: ${totalVdr}. Sent ${eventsSent} requests.`);

    // Display leaderboard
    const board = await fetch(`${URL}/llm-trust`);
    console.log("=== LLM TRUST LEADERBOARD ===");
    console.log(JSON.stringify(await board.json(), null, 2));

    server.close();
    process.exit(0);
  });
}

run().catch(console.error);
