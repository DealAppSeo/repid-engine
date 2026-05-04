/**
 * One-shot smoke for the new indexer. Calls indexOnce against a small block
 * window covering Run 1 (block 41037121) to verify ABI parsing, DB lookup,
 * trinity_tasks enqueue, and contract_* backfill all work end-to-end.
 *
 * NOT a permanent script — debug aid for Phase 4 of the 2026-05-04 sprint.
 * Safe to delete after sprint sign-off.
 */
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import { indexOnce } from '../src/services/receipt-indexer';

dotenv.config();

async function main() {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  const contractAddress = process.env.HYPERDAG_RECEIPT_ADAPTER_ADDRESS;
  if (!contractAddress) throw new Error('Missing HYPERDAG_RECEIPT_ADAPTER_ADDRESS');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('Missing Supabase env');

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const fromArg = process.argv[2];
  const toArg = process.argv[3];
  const fromBlock = fromArg ? parseInt(fromArg, 10) : 41037100;
  const toBlock = toArg ? parseInt(toArg, 10) : 41037200;

  const tip = await provider.getBlockNumber();
  console.log(`[smoke] tip=${tip}, scanning [${fromBlock}..${toBlock}] on ${contractAddress}`);

  const start = Date.now();
  const result = await indexOnce(fromBlock, toBlock, { provider, contractAddress, supabase });
  const elapsedMs = Date.now() - start;

  console.log(`[smoke] result: ${JSON.stringify(result)} elapsedMs=${elapsedMs}`);
  process.exit(0);
}

main().catch(err => { console.error('[smoke] failed:', err); process.exit(1); });
