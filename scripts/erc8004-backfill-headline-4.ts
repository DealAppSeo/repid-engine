// Backfill ERC-8004 mints for the 4 headline production agents.
// Sequential (not parallel) to avoid nonce collisions on the deployer wallet.
//
// Modes:
//   --dry-run       Print gas estimates only. No transactions.
//   (default)       Estimate, confirm with 5s grace, then mint sequentially.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SERVICE_KEY),
//               ERC8004_MINTER_PRIVATE_KEY (Trinity Deployer key),
//               TRUST_IDENTITY_REGISTRY (optional, defaults to 0x8004A818...).
//
// Usage:
//   npm run backfill:erc8004:headline-4 -- --dry-run
//   npm run backfill:erc8004:headline-4
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { Erc8004Minter } from '../src/services/erc8004-minter';

dotenv.config();

const DEFAULT_IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const DEFAULT_CHAIN_ID = 84532;

const HEADLINE_AGENTS: Array<{ name: string; id: string }> = [
  { name: 'ATLAS', id: 'db5ea9f4-f1ad-445e-8c00-e13495e580f6' },
  { name: 'GUARDIAN', id: '5b81eaa8-b15b-44fb-b27c-c02e7ee58a7c' },
  { name: 'RAVEN', id: '66741f3f-4dd2-4a36-87cb-1a7accd45b1a' },
  { name: 'SOPHIA', id: 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271' },
];

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  const pk = process.env.ERC8004_MINTER_PRIVATE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  if (!pk) {
    throw new Error('Missing ERC8004_MINTER_PRIVATE_KEY (Trinity Deployer)');
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const minter = new Erc8004Minter({
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    contractAddress: process.env.TRUST_IDENTITY_REGISTRY || DEFAULT_IDENTITY_REGISTRY,
    minterPrivateKey: pk,
    chainId: parseInt(process.env.BASE_SEPOLIA_CHAIN_ID || String(DEFAULT_CHAIN_ID), 10),
    supabase,
  });

  console.log(`Mode:    ${dryRun ? 'DRY RUN (gas estimate only)' : 'LIVE MINT'}`);
  console.log(`Signer:  ${minter.getSignerAddress()}`);
  console.log(`Target:  ${process.env.TRUST_IDENTITY_REGISTRY || DEFAULT_IDENTITY_REGISTRY}`);
  console.log('');

  // Phase 1: estimate gas for all 4.
  let totalGas = 0n;
  for (const agent of HEADLINE_AGENTS) {
    try {
      const gas = await minter.estimateGas({ agentId: agent.id });
      console.log(`  ${agent.name.padEnd(10)} estimated_gas=${gas.toString()}`);
      totalGas += gas;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ${agent.name.padEnd(10)} estimate FAILED: ${msg}`);
    }
  }
  console.log(`\nTotal estimated gas across 4 mints: ${totalGas.toString()}`);

  if (dryRun) {
    console.log('\nDry run complete. Run without --dry-run to execute.');
    return;
  }

  console.log('\n*** PROCEEDING WITH LIVE MINTS IN 5 SECONDS — CTRL-C TO ABORT ***');
  await new Promise<void>((r) => setTimeout(r, 5000));

  // Phase 2: mint sequentially.
  for (const agent of HEADLINE_AGENTS) {
    try {
      console.log(`\nMinting ${agent.name}...`);
      const result = await minter.mint({ agentId: agent.id });
      console.log(
        `  ✅ token=${result.tokenId} tx=${result.txHash} block=${result.blockNumber}`
      );
      console.log(
        `     basescan: https://sepolia.basescan.org/tx/${result.txHash}`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ❌ ${agent.name} FAILED: ${msg}`);
    }
  }

  console.log(
    "\nDone. Verify in Supabase: SELECT agent_name, erc8004_token_id, mint_tx_hash FROM repid_agents WHERE agent_name IN ('SOPHIA','RAVEN','GUARDIAN','ATLAS');"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
