// ERC-8004 Mass Mint Backfill — 20 agents (ATLAS + 19 named).
// Checkpoint pattern: mint 5, pause for operator review, continue.
// Strict failure halt: if any mint fails, STOP. Sean decides whether to
// continue via --resume-from N+1.
//
// Modes:
//   --dry-run                    Print gas estimates only. No transactions.
//   --skip-atlas                 Skip ATLAS (already minted in Sprint 6 test plan).
//   --resume-from <index>        Skip to that index (0-based, after a prior failure).
//   --no-checkpoint              Skip the readline pause between batches of 5.
//
// State persistence: scripts/.erc8004-backfill-state.json (one row per
// completed mint). Append-only. Used for --resume-from + audit log.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//               ERC8004_MINTER_PRIVATE_KEY (Trinity Deployer),
//               TRUST_IDENTITY_REGISTRY (optional, defaults to 0x8004A818...).
//
// Usage:
//   npm run backfill:erc8004:mass -- --dry-run --skip-atlas
//   npm run backfill:erc8004:mass -- --skip-atlas
//   npm run backfill:erc8004:mass -- --resume-from 8
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Erc8004Minter } from '../src/services/erc8004-minter';

dotenv.config();

const DEFAULT_IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const DEFAULT_CHAIN_ID = 84532;
const STATE_PATH = path.join(__dirname, '.erc8004-backfill-state.json');
const CHECKPOINT_EVERY = 5;

interface MintTarget {
  name: string;
  tier: 'EARNING' | 'VETERAN' | 'AUTONOMOUS' | 'ESTABLISHED';
  id: string;
}

const MINT_TARGETS: MintTarget[] = [
  // Test-first: ATLAS (EARNING tier, lowest stakes)
  { name: 'ATLAS', tier: 'EARNING', id: 'db5ea9f4-f1ad-445e-8c00-e13495e580f6' },

  // Tier VETERAN (1)
  { name: 'SOPHIA', tier: 'VETERAN', id: 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271' },

  // Tier AUTONOMOUS (7)
  { name: 'SAGE', tier: 'AUTONOMOUS', id: 'cde8f5af-c39e-44cc-bd69-82ce4c08a35f' },
  { name: 'SYBIL_W01', tier: 'AUTONOMOUS', id: '029fbfa2-02c9-4f98-a303-3600cab575dd' },
  { name: 'SYBIL_W02', tier: 'AUTONOMOUS', id: 'e383c84f-eed4-427e-8cd9-03cec45088c0' },
  { name: 'SYBIL_W03', tier: 'AUTONOMOUS', id: 'ccd37584-ba1c-4f26-a3f4-b9b14bf94f4f' },
  { name: 'SYBIL_W04', tier: 'AUTONOMOUS', id: '5d21da1c-aeee-44ba-b7af-54c4832eba5e' },
  { name: 'VERITAS', tier: 'AUTONOMOUS', id: 'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067' },
  { name: 'SYBIL_W05', tier: 'AUTONOMOUS', id: '288ac427-24b1-41aa-9c79-b7801db1481f' },

  // Tier ESTABLISHED (11)
  { name: 'MENTOR', tier: 'ESTABLISHED', id: 'be599a22-2d31-4158-9d46-a87cb5d598ea' },
  { name: 'RAVEN', tier: 'ESTABLISHED', id: '66741f3f-4dd2-4a36-87cb-1a7accd45b1a' },
  { name: 'ORACLE', tier: 'ESTABLISHED', id: 'a16f14e7-3690-40ed-a013-f45c3f724bf7' },
  { name: 'NEXUS', tier: 'ESTABLISHED', id: '848da285-93c5-4e99-a989-3d9e49ebed09' },
  { name: 'SHOFET', tier: 'ESTABLISHED', id: '32e0e809-c1c4-4405-913f-135c8a2d6626' },
  { name: 'MEDIATOR', tier: 'ESTABLISHED', id: '394b6ee4-62e7-4c66-8445-29107b097b4c' },
  { name: 'CHESED', tier: 'ESTABLISHED', id: '2c2c24d6-2fd0-47e6-95d5-7fc9804a19e6' },
  { name: 'MEL', tier: 'ESTABLISHED', id: '942860a6-e26f-4334-ae94-b7c1abed1e8c' },
  { name: 'RESEARCHER', tier: 'ESTABLISHED', id: 'd244f6fc-35af-4131-b649-285bfac64b63' },
  { name: 'TORCH', tier: 'ESTABLISHED', id: '9c0dc740-8c16-4862-ad62-9ba3d515369d' },
  { name: 'GUARDIAN', tier: 'ESTABLISHED', id: '5b81eaa8-b15b-44fb-b27c-c02e7ee58a7c' },
];

interface StateEntry {
  index: number;
  name: string;
  tokenId: string;
  txHash: string;
  blockNumber: number;
  timestamp: string;
}

function loadState(): StateEntry[] {
  if (!fs.existsSync(STATE_PATH)) return [];
  try {
    const lines = fs.readFileSync(STATE_PATH, 'utf8').split('\n').filter(Boolean);
    return lines.map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function appendState(entry: StateEntry): void {
  fs.appendFileSync(STATE_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

function parseArgs(): {
  dryRun: boolean;
  skipAtlas: boolean;
  resumeFrom: number;
  noCheckpoint: boolean;
} {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipAtlas = args.includes('--skip-atlas');
  const noCheckpoint = args.includes('--no-checkpoint');
  const resumeIdx = args.findIndex((a) => a === '--resume-from');
  const resumeFrom =
    resumeIdx >= 0 && args[resumeIdx + 1] ? parseInt(args[resumeIdx + 1]!, 10) : 0;
  return { dryRun, skipAtlas, resumeFrom, noCheckpoint };
}

function waitForEnter(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (ans) => {
      rl.close();
      const trimmed = ans.trim().toLowerCase();
      resolve(trimmed !== 'q' && trimmed !== 'quit');
    });
  });
}

async function main(): Promise<void> {
  const { dryRun, skipAtlas, resumeFrom, noCheckpoint } = parseArgs();

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
    contractAddress:
      process.env.TRUST_IDENTITY_REGISTRY || DEFAULT_IDENTITY_REGISTRY,
    minterPrivateKey: pk,
    chainId: parseInt(
      process.env.BASE_SEPOLIA_CHAIN_ID || String(DEFAULT_CHAIN_ID),
      10
    ),
    supabase,
  });

  // Build the working list based on flags.
  let workList: Array<{ index: number; target: MintTarget }> = MINT_TARGETS.map(
    (target, index) => ({ index, target })
  );
  if (skipAtlas) {
    workList = workList.filter((w) => w.target.name !== 'ATLAS');
  }
  if (resumeFrom > 0) {
    workList = workList.filter((w) => w.index >= resumeFrom);
  }

  console.log('=== ERC-8004 Mass Mint Backfill ===');
  console.log(`Mode:           ${dryRun ? 'DRY RUN' : 'LIVE MINT'}`);
  console.log(`Signer:         ${minter.getSignerAddress()}`);
  console.log(`Registry:       ${process.env.TRUST_IDENTITY_REGISTRY || DEFAULT_IDENTITY_REGISTRY}`);
  console.log(`Skip ATLAS:     ${skipAtlas}`);
  console.log(`Resume from:    ${resumeFrom}`);
  console.log(`Checkpoint:     ${noCheckpoint ? 'OFF' : `every ${CHECKPOINT_EVERY}`}`);
  console.log(`Targets:        ${workList.length} agents`);
  console.log(`State file:     ${STATE_PATH}`);
  console.log('');

  // Phase 1: dry-run gas estimates for everything in scope.
  let totalGas = 0n;
  console.log('--- Gas estimates ---');
  for (const { index, target } of workList) {
    try {
      const gas = await minter.estimateGas({ agentId: target.id });
      console.log(
        `  [${String(index).padStart(2, ' ')}] ${target.name.padEnd(12)} ` +
          `(${target.tier.padEnd(11)}) gas=${gas.toString()}`
      );
      totalGas += gas;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(
        `  [${String(index).padStart(2, ' ')}] ${target.name.padEnd(12)} ` +
          `(${target.tier.padEnd(11)}) estimate FAILED: ${msg.slice(0, 80)}`
      );
    }
  }
  console.log(`\nTotal estimated gas: ${totalGas.toString()}`);

  if (dryRun) {
    console.log('\nDry run complete. Run without --dry-run to execute.');
    return;
  }

  // Phase 2: live mint with checkpointed batches.
  console.log('\n*** PROCEEDING WITH LIVE MINTS IN 5 SECONDS — CTRL-C TO ABORT ***');
  await new Promise<void>((r) => setTimeout(r, 5000));

  const successes: StateEntry[] = [];
  const failures: Array<{ index: number; name: string; reason: string }> = [];
  let inBatchCount = 0;

  for (const { index, target } of workList) {
    console.log(`\n[${index}] Minting ${target.name}...`);
    try {
      const result = await minter.mint({ agentId: target.id });
      const entry: StateEntry = {
        index,
        name: target.name,
        tokenId: result.tokenId,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        timestamp: new Date().toISOString(),
      };
      appendState(entry);
      successes.push(entry);
      console.log(
        `  ✅ token=${result.tokenId} tx=${result.txHash} block=${result.blockNumber}`
      );
      console.log(
        `     basescan: https://sepolia.basescan.org/tx/${result.txHash}`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ index, name: target.name, reason: msg });
      console.log(`  ❌ FAILED: ${msg}`);
      console.log('\n*** HALTING — review state and rerun with --resume-from ' + index + ' ***');
      break;
    }

    inBatchCount++;
    const isLastTarget = workList[workList.length - 1]!.index === index;
    if (
      !noCheckpoint &&
      inBatchCount >= CHECKPOINT_EVERY &&
      !isLastTarget
    ) {
      const proceed = await waitForEnter(
        `\n✋ CHECKPOINT — ${successes.length} minted so far. ` +
          `Verify on Basescan, then press Enter to continue (or "q" to stop): `
      );
      if (!proceed) {
        console.log('Operator requested stop. Halting.');
        break;
      }
      inBatchCount = 0;
    }
  }

  console.log('\n=== Run summary ===');
  console.log(`Successes: ${successes.length}`);
  console.log(`Failures:  ${failures.length}`);
  if (failures.length > 0) {
    console.log('\nFailed agents:');
    for (const f of failures) {
      console.log(`  [${f.index}] ${f.name}: ${f.reason.slice(0, 120)}`);
    }
  }

  console.log('\nVerify in Supabase:');
  console.log(`  SELECT agent_name, erc8004_token_id, mint_tx_hash, minted_at`);
  console.log(`    FROM repid_agents`);
  const namesSql = workList.map((w) => `'${w.target.name}'`).join(',');
  console.log(`   WHERE agent_name IN (${namesSql})`);
  console.log(`   ORDER BY agent_name;`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
