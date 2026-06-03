/**
 * S-ONCHAIN Phase 7: Inject T12 verification tasks into trinity_tasks.
 * Run: node scratch/S-ONCHAIN_inject_t12_tasks.js (after DB keys)
 * These make VERITAS/SOPHIA/SHOFET exercise the new onchain/ZKP/staking infra.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.railway') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Need SUPABASE keys in env for task insert');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  console.log('=== PHASE 7: Inject T12 on-chain/ZKP/staking verification tasks ===');

  const tasks = [
    {
      task_type: 'onchain_audit',
      title: 'Verify all T12 agents have valid on-chain ERC-8004 tokens and DB matches basescan',
      description: 'Use onchain-verifier + /verify-onchain. Confirm every agent has real tx visible to Marco.',
      agent_assigned: 'trinity-veritas',
      payload: { action: 'verify_all_agents_onchain', chain: 'base-sepolia' },
      priority: 10,
      status: 'pending'
    },
    {
      task_type: 'zkp_routing_test',
      title: 'Test ZKP routing returns correct system (fast_groth16 / plonky3 / hash) for each of 12 proof types',
      description: 'Exercise proof-router + stager. Check pre-stage + Dragonfly cache path.',
      agent_assigned: 'trinity-sophia',
      payload: { action: 'test_all_proof_routes', proof_types: ['trade_auth','reputation','identity','sponsorship','dispute','x402','staking','epoch','cross_llm','hal','agent_card','default'] },
      priority: 9,
      status: 'pending'
    },
    {
      task_type: 'staking_test',
      title: 'Test deposit → verify stake → request withdrawal → hold period + dispute/RepID/HAL gates',
      description: 'Full flow via staking-vault.ts. Confirm 4x rule and sponsorship capacity.',
      agent_assigned: 'trinity-shofet',
      payload: { action: 'test_staking_flow', tiers: ['EARNING','ESTABLISHED','AUTONOMOUS','VETERAN'] },
      priority: 8,
      status: 'pending'
    }
  ];

  for (const t of tasks) {
    const { data, error } = await db.from('trinity_tasks').insert({
      ...t,
      created_at: new Date().toISOString()
    }).select('id, task_type, agent_assigned').single();
    if (error) console.error('insert fail for', t.task_type, error.message);
    else console.log('Injected:', data);
  }

  console.log('T12 tasks injected. Agents (VERITAS/SOPHIA/SHOFET) will pick up in runLoop.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });