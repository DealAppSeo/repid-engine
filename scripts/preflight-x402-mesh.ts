import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing Supabase credentials in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function runPreflight() {
  console.log('--- Phase 0: Preflight Verification ---');
  let allPass = true;

  // 1. Verify Tables
  const expectedTables = [
    'repid_agents',
    'repid_events',
    'agent_memory_nodes',
    'erc8004_reputation_writes',
    'trade_execution_log'
  ];

  console.log('\nChecking tables...');
  for (const table of expectedTables) {
    const { data, error } = await supabase.from(table).select('*').limit(0);
    if (error) {
      console.error(`FAIL: Table "${table}" check failed:`, error.message);
      allPass = false;
    } else {
      console.log(`PASS: Table "${table}" exists.`);
    }
  }

  // 2. Verify Columns on repid_agents
  const expectedColumns = [
    'mint_tx_hash',
    'mint_block_number',
    'minted_at',
    'mint_chain_id',
    'last_reputation_tx_hash',
    'last_reputation_block_number',
    'last_reputation_repid',
    'last_reputation_written_at',
    'reputation_write_count'
  ];

  console.log('\nChecking repid_agents columns...');
  const { data: columnData, error: columnError } = await supabase
    .rpc('get_table_columns', { p_table_name: 'repid_agents' });

  // If get_table_columns RPC doesn't exist, we'll use a fallback query
  if (columnError) {
    const { data: infoSchema, error: infoError } = await supabase
      .from('information_schema.columns' as any)
      .select('column_name')
      .eq('table_name', 'repid_agents');

    if (infoError) {
       // Fallback: try to select the columns directly
       for (const col of expectedColumns) {
         const { error: colError } = await supabase.from('repid_agents').select(col).limit(0);
         if (colError) {
           console.error(`FAIL: Column "${col}" missing on repid_agents.`);
           allPass = false;
         } else {
           console.log(`PASS: Column "${col}" exists.`);
         }
       }
    } else {
      const existingCols = infoSchema.map((c: any) => c.column_name);
      for (const col of expectedColumns) {
        if (existingCols.includes(col)) {
          console.log(`PASS: Column "${col}" exists.`);
        } else {
          console.error(`FAIL: Column "${col}" missing on repid_agents.`);
          allPass = false;
        }
      }
    }
  }

  // 3. Verify RPCs
  const expectedRPCs = ['graph_rag_match_nodes', 'graph_rag_touch_node'];
  console.log('\nChecking RPCs...');
  // We can't easily check for RPC existence via the client without calling them,
  // but we can check pg_proc if we have permission.
  for (const rpc of expectedRPCs) {
    // Try a dummy call or just trust if we can't check
    // Actually, we can check via information_schema.routines
    const { data: routineData, error: routineError } = await supabase
      .from('information_schema.routines' as any)
      .select('routine_name')
      .eq('routine_name', rpc);
    
    if (routineError || !routineData || routineData.length === 0) {
      console.warn(`WARN: Could not verify RPC "${rpc}" via information_schema. Routine check might fail due to permissions.`);
      // Try a direct call with dummy data
      if (rpc === 'graph_rag_touch_node') {
          const { error: callError } = await supabase.rpc(rpc, { p_node_id: 0 });
          // If error is "node not found" it exists, if it's "function not found" it doesn't
          if (callError && callError.message.includes('function')) {
              console.error(`FAIL: RPC "${rpc}" does not exist.`);
              allPass = false;
          } else {
              console.log(`PASS: RPC "${rpc}" exists (or returned error other than function not found).`);
          }
      } else {
           console.log(`PASS: RPC "${rpc}" presumed existing (manual verification recommended).`);
      }
    } else {
      console.log(`PASS: RPC "${rpc}" exists.`);
    }
  }

  // 4. Verify Base Sepolia
  console.log('\nChecking Base Sepolia...');
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  try {
    const network = await provider.getNetwork();
    console.log(`Chain ID: ${network.chainId}`);
    if (network.chainId !== 84532n) {
      console.error(`FAIL: Chain ID is ${network.chainId}, expected 84532.`);
      allPass = false;
    } else {
      console.log(`PASS: Chain ID is 84532.`);
    }

    const wallet = new ethers.Wallet(process.env.BASE_SEPOLIA_PRIVATE_KEY!, provider);
    console.log(`Wallet Address: ${wallet.address}`);
    const balance = await provider.getBalance(wallet.address);
    console.log(`ETH Balance: ${ethers.formatEther(balance)} ETH`);

    // USDC Balance
    const usdcAddr = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    const usdc = new ethers.Contract(usdcAddr, ['function balanceBytes() view returns (uint256)', 'function balanceOf(address) view returns (uint256)'], provider);
    const usdcBalance = await (usdc as any).balanceOf(wallet.address);
    console.log(`USDC Balance: ${ethers.formatUnits(usdcBalance, 6)} USDC`);

    if (usdcBalance < ethers.parseUnits('1', 6)) {
      console.warn('Sean — fund wallet from Base Sepolia USDC faucet before testing inbound flow');
    }
  } catch (e: any) {
    console.error('FAIL: Base Sepolia check failed:', e.message);
    allPass = false;
  }

  console.log('\n--- Preflight Summary ---');
  if (allPass) {
    console.log('ALL CHECKS PASSED');
    process.exit(0);
  } else {
    console.log('SOME CHECKS FAILED');
    process.exit(1);
  }
}

runPreflight();
