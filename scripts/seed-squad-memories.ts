import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { embed } from '../src/services/graph-rag/embedding-service';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const AGENTS = [
  { id: '550e8400-e29b-41d4-a716-446655440000', name: 'ALPHA_SQUAD_REP' },
  { id: '550e8400-e29b-41d4-a716-446655440001', name: 'BETA_SQUAD_REP' },
  { id: '550e8400-e29b-41d4-a716-446655440002', name: 'GAMMA_SQUAD_REP' }
];

async function seed() {
  console.log('Seeding squad spokespersons...');
  for (const a of AGENTS) {
    const { error } = await supabase.from('repid_agents').upsert({
      id: a.id,
      agent_name: a.name,
      agent_type: 'fleet',
      current_repid: 5000,
      tier: 'AUTONOMOUS',
      erc8004_address: `fleet:${a.id}`
    });

    if (error) console.error(`Error seeding ${a.name}:`, error.message);
  }

  const MEMORIES = [
    { 
      agent_id: AGENTS[0].id, 
      content: "HyperDAG x402 mesh protocol uses USDC on Base Sepolia for all agentic settlement in Sprint 1.",
      node_type: 'observation'
    },
    {
      agent_id: AGENTS[1].id,
      content: "RepID attestation v1 uses EIP-712 signing with the domain 'HyperDAG' and chainId 84532.",
      node_type: 'observation'
    },
    {
      agent_id: AGENTS[2].id,
      content: "Pythagorean Comma BFT veto (P-003) triggers when gap < 0.05 and avg > 0.85 across 3+ providers.",
      node_type: 'observation'
    }
  ];

  console.log('Seeding memories...');
  for (const m of MEMORIES) {
    console.log(`Embedding memory for ${m.agent_id}...`);
    const embedding = await embed(m.content);
    const { error } = await supabase.from('agent_memory_nodes').insert({
      agent_id: m.agent_id,
      content: m.content,
      node_type: m.node_type,
      embedding: `[${embedding.join(',')}]`,
      importance: 0.9,
      metadata: { source: 'sprint_seed' }
    });
    if (error) console.error(`Error seeding memory:`, error.message);
  }

  console.log('Done.');
}

seed();
