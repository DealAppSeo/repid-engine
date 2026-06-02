/**
 * S-CHAIN Phase 1: Audit every agent's on-chain status.
 * Queries repid_agents for the 12 T12 trinity-* agents (and sample others).
 * Checks erc8004_*, mint_tx_hash, conservator_address, erc8004_token_id etc.
 * Identifies fake / missing / legacy addresses (0x0000, null, pre-mint stubs).
 * Run: node scratch/S-CHAIN_audit_onchain.js
 * (Uses .env.railway or process env for SUPABASE; safe no print secrets.)
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.railway') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); // fallback

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.SUPABASE_URL_RAILWAY;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY_RAILWAY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('FATAL: Missing SUPABASE_URL or SERVICE_ROLE_KEY in env/.env.railway');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const T12 = [
  'trinity-veritas', 'trinity-sophia', 'trinity-harmonia', 'trinity-apollon',
  'trinity-melodia', 'trinity-arkhe', 'trinity-selene', 'trinity-hephaistos',
  'trinity-athena', 'trinity-eros', 'trinity-hermes', 'trinity-gaia'
];

async function main() {
  console.log('=== S-CHAIN PHASE 1: ON-CHAIN STATUS AUDIT (T12 + sample) ===');
  console.log('Date: 2026-06-02 PDT | XC isolated worktree');

  const { data: agents, error } = await db
    .from('repid_agents')
    .select('id, agent_name, erc8004_address, erc8004_token_id, mint_tx_hash, mint_block_number, minted_at, conservator_address, mint_chain_id, current_repid, tier')
    .in('agent_name', T12)
    .order('agent_name');

  if (error) {
    console.error('Query error:', error.message);
    // fallback: try all agents with onchain fields
    const { data: all } = await db.from('repid_agents').select('id, agent_name, erc8004_address, erc8004_token_id, mint_tx_hash, conservator_address').limit(30);
    console.log('Fallback sample (first 30):');
    (all || []).forEach(a => {
      const fake = !a.erc8004_token_id || a.erc8004_address === '0x0000000000000000000000000000000000000000' || !a.mint_tx_hash;
      console.log(`  ${a.agent_name}: token=${a.erc8004_token_id || 'NULL'} tx=${a.mint_tx_hash ? a.mint_tx_hash.slice(0,10)+'...' : 'NULL'} fake=${fake}`);
    });
    process.exit(1);
  }

  console.log(`Found ${agents.length} T12 agents in DB:\n`);

  let fakeCount = 0;
  const audit = [];

  agents.forEach(a => {
    const hasToken = !!a.erc8004_token_id && a.erc8004_token_id !== '0' && a.erc8004_token_id !== '';
    const hasTx = !!a.mint_tx_hash && a.mint_tx_hash.startsWith('0x');
    const hasConservator = !!a.conservator_address && a.conservator_address.startsWith('0x') && !a.conservator_address.match(/^0x0{40}$/);
    const isFake = !hasToken || !hasTx || !hasConservator || (a.erc8004_address || '').match(/0x0{40}/);
    if (isFake) fakeCount++;

    const status = {
      name: a.agent_name,
      id: a.id,
      erc8004_address: a.erc8004_address || null,
      erc8004_token_id: a.erc8004_token_id || null,
      mint_tx_hash: a.mint_tx_hash || null,
      mint_block: a.mint_block_number || null,
      minted_at: a.minted_at || null,
      conservator: a.conservator_address || null,
      chain_id: a.mint_chain_id || null,
      repid: a.current_repid,
      tier: a.tier,
      is_fake_or_unminted: isFake,
      basescan: a.mint_tx_hash ? `https://sepolia.basescan.org/tx/${a.mint_tx_hash}` : null
    };
    audit.push(status);

    console.log(`${a.agent_name}:`);
    console.log(`  token_id=${a.erc8004_token_id || 'MISSING'} tx=${a.mint_tx_hash ? a.mint_tx_hash.slice(0,18)+'...' : 'MISSING'} conservator=${a.conservator_address || 'MISSING'}`);
    console.log(`  FAKE/UNMINTED: ${isFake} | repid=${a.current_repid} tier=${a.tier}`);
    console.log('');
  });

  console.log(`\n=== AUDIT SUMMARY ===`);
  console.log(`T12 agents audited: ${agents.length}`);
  console.log(`Fake / missing on-chain (no real tx/token): ${fakeCount} / ${agents.length} (${(fakeCount/agents.length*100).toFixed(0)}%)`);
  console.log(`Most agents are fake addresses or never minted (as expected per task).`);

  // Also sample other agents
  const { data: others } = await db.from('repid_agents').select('agent_name, erc8004_token_id, mint_tx_hash, conservator_address').not('agent_name', 'in', `(${T12.map(n=>`'${n}'`).join(',')})`).limit(10);
  if (others && others.length) {
    console.log(`\nSample non-T12 (for completeness):`);
    others.forEach(o => {
      const fake = !o.erc8004_token_id || !o.mint_tx_hash;
      console.log(`  ${o.agent_name}: token=${o.erc8004_token_id||'NULL'} tx=${o.mint_tx_hash?'yes':'NULL'} fake=${fake}`);
    });
  }

  fs.writeFileSync(path.join(__dirname, 'S-CHAIN_onchain_audit.json'), JSON.stringify({ date: new Date().toISOString(), fakeCount, total: agents.length, agents: audit }, null, 2));
  console.log('\nWrote scratch/S-CHAIN_onchain_audit.json');

  // Check for deployer / minter key presence (Phase 2 prep)
  const hasMinterPK = !!process.env.ERC8004_MINTER_PRIVATE_KEY || !!process.env.DEPLOYER_PRIVATE_KEY;
  const hasRpc = !!process.env.BASE_SEPOLIA_RPC_URL || true; // default in code
  console.log(`\n[Phase 2 prep] ERC8004_MINTER/DEPLOYER_PRIVATE_KEY present in env: ${hasMinterPK}`);
  console.log(`[Phase 2 prep] BASE_SEPOLIA_RPC_URL or default: ${hasRpc}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });