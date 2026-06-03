/**
 * S-ONCHAIN Phase 7: Inject T12 agent verification tasks.
 * These make VERITAS, SOPHIA, SHOFET exercise the new on-chain + ZKP + staking infra.
 * Run with DB keys present (e.g. in Railway env).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.railway') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE keys required for task insert');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  console.log('=== PHASE 7: Inject T12 verification tasks ===');

  const tasks = [
    {
      task_type: 'onchain_audit',
      title: 'Verify all T12 agents have valid on-chain ERC-8004 tokens',
      agent_assigned: 'trinity-veritas',
      payload: { action: 'verify_all_agents_onchain' }
    },
    {
      task_type: 'zkp_routing_test',
      title: 'Test ZKP routing returns correct system for each of 12 proof types',
      agent_assigned: 'trinity-sophia',
      payload: { action: 'test_all_proof_routes' }
    },
    {
      task_type: 'staking_test',
      title: 'Test deposit → verify stake → request withdrawal → hold period enforcement',
      agent_assigned: 'trinity-shofet',
      payload: { action: 'test_staking_flow' }
    }
  ];

  for (const t of tasks) {
    const { data, error } = await db.from('trinity_tasks').insert({
      ...t,
      status: 'pending',
      created_at: new Date().toISOString()
    }).select('id, task_type, agent_assigned').single();
    if (error) {
      console.error('Insert error for', t.task_type, error.message);
    } else {
      console.log('Injected task:', data);
    }
  }
  console.log('T12 tasks injected. Agents will pick up via runLoop / getNextTask.');
}

main().catch(console.error);