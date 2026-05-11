// ERC-8004 reputation backfill — writes feedback for the 4 squad spokespersons.
// Sequential (no nonce collisions), checkpointed every 2 writes (small batch
// since there are only 4), state-persisted in scripts/.erc8004-reputation-state.json.
//
// Modes:
//   --dry-run             Print gas estimates only. No transactions.
//   --resume-from <idx>   Skip to that index (0-based).
//   --no-checkpoint       Skip the readline pause between batches.
//
// Required env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   ERC8004_REPUTATION_WRITER_KEY (or ERC8004_MINTER_PRIVATE_KEY fallback),
//   BASE_SEPOLIA_RPC_URL (optional, defaults to https://sepolia.base.org).
//
// Pre-requisite: all 4 spokespersons must already have erc8004_token_id
// (i.e. Sean must run the Sprint 6 mass-mint backfill first).
//
// Usage:
//   npm run reputation:backfill:spokespersons -- --dry-run
//   npm run reputation:backfill:spokespersons
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {
  Erc8004ReputationWriter,
  persistReputationWrite,
} from '../src/services/erc8004-reputation';
import { SQUADS, type Squad } from '../src/config/squad-architecture';

dotenv.config();

const STATE_PATH = path.join(__dirname, '.erc8004-reputation-state.json');
const CHECKPOINT_EVERY = 2;

interface StateEntry {
  index: number;
  agent_name: string;
  agent_id: string;
  agent_token_id: string;
  repid_value: number;
  tier: string;
  tx_hash: string;
  block_number: number;
  timestamp: string;
}

function appendState(entry: StateEntry): void {
  fs.appendFileSync(STATE_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

function parseArgs(): {
  dryRun: boolean;
  resumeFrom: number;
  noCheckpoint: boolean;
} {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const noCheckpoint = args.includes('--no-checkpoint');
  const resumeIdx = args.findIndex((a) => a === '--resume-from');
  const resumeFrom =
    resumeIdx >= 0 && args[resumeIdx + 1]
      ? parseInt(args[resumeIdx + 1]!, 10)
      : 0;
  return { dryRun, resumeFrom, noCheckpoint };
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
  const { dryRun, resumeFrom, noCheckpoint } = parseArgs();

  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  const pk =
    process.env.ERC8004_REPUTATION_WRITER_KEY ||
    process.env.ERC8004_MINTER_PRIVATE_KEY ||
    process.env.ERC8004_OPERATOR_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  if (!pk) {
    throw new Error(
      'Missing reputation writer key (ERC8004_REPUTATION_WRITER_KEY / ERC8004_MINTER_PRIVATE_KEY / ERC8004_OPERATOR_KEY)'
    );
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const writer = new Erc8004ReputationWriter({
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    privateKey: pk,
    contractAddress: process.env.ERC8004_REPUTATION_CONTRACT,
    chainId: parseInt(process.env.ERC8004_REPUTATION_CHAIN_ID || '84532', 10),
  });

  const operatorAddress = await writer.getOperatorAddress();
  console.log('=== ERC-8004 Reputation Backfill — squad spokespersons ===');
  console.log(`Mode:             ${dryRun ? 'DRY RUN' : 'LIVE WRITE'}`);
  console.log(`Operator wallet:  ${operatorAddress}`);
  console.log(`Contract:         ${writer.getContractAddress()}`);
  console.log(`Chain ID:         ${writer.chainId}`);
  console.log(`Resume from:      ${resumeFrom}`);
  console.log(`Checkpoint:       ${noCheckpoint ? 'OFF' : `every ${CHECKPOINT_EVERY}`}`);
  console.log(`Squads:           ${SQUADS.length}`);
  console.log(`State file:       ${STATE_PATH}`);
  console.log('');

  // Resolve the 4 spokespersons from Supabase (verify they're minted).
  type Target = {
    index: number;
    squad: Squad;
    agent: {
      id: string;
      agent_name: string;
      current_repid: number;
      tier: string;
      erc8004_token_id: string;
    };
  };
  const targets: Target[] = [];
  const unminted: string[] = [];

  for (let i = 0; i < SQUADS.length; i++) {
    const squad = SQUADS[i]!;
    if (i < resumeFrom) continue;
    const { data: agent, error } = await supabase
      .from('repid_agents')
      .select('id, agent_name, current_repid, tier, erc8004_token_id')
      .eq('id', squad.spokesperson.agent_id)
      .single();
    if (error || !agent) {
      console.log(`  [${i}] ${squad.spokesperson.agent_name.padEnd(10)} (${squad.id}) ❌ NOT IN repid_agents`);
      unminted.push(squad.spokesperson.agent_name);
      continue;
    }
    if (!agent.erc8004_token_id) {
      console.log(`  [${i}] ${agent.agent_name.padEnd(10)} (${squad.id}) ❌ UNMINTED — run Sprint 6 mass-mint first`);
      unminted.push(agent.agent_name);
      continue;
    }
    console.log(
      `  [${i}] ${agent.agent_name.padEnd(10)} (${squad.id.padEnd(11)}) ` +
        `token=${agent.erc8004_token_id} repid=${agent.current_repid} tier=${agent.tier}`
    );
    targets.push({ index: i, squad, agent: agent as any });
  }

  if (unminted.length > 0) {
    console.log(
      `\n*** HALTING — ${unminted.length} spokespersons are unminted: ${unminted.join(', ')} ***`
    );
    console.log('Run Sprint 6 mass-mint backfill first, then retry this script.');
    process.exit(1);
  }

  if (targets.length === 0) {
    console.log('\nNo targets to write. Done.');
    return;
  }

  // Gas estimates for everything in scope.
  console.log('\n--- Gas estimates ---');
  let totalGas = 0n;
  for (const t of targets) {
    try {
      const est = await writer.estimateWriteGas({
        agentTokenId: t.agent.erc8004_token_id,
        repid: t.agent.current_repid,
        tier: t.agent.tier,
      });
      console.log(
        `  [${t.index}] ${t.agent.agent_name.padEnd(10)} gas=${est.gasEstimate} @ ${est.gasPriceGwei} gwei`
      );
      totalGas += est.gasEstimate;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(
        `  [${t.index}] ${t.agent.agent_name.padEnd(10)} estimate FAILED: ${msg.slice(0, 80)}`
      );
    }
  }
  console.log(`\nTotal estimated gas: ${totalGas}`);

  if (dryRun) {
    console.log('\nDry run complete. Run without --dry-run to execute.');
    return;
  }

  console.log('\n*** PROCEEDING WITH LIVE WRITES IN 5 SECONDS — CTRL-C TO ABORT ***');
  await new Promise<void>((r) => setTimeout(r, 5000));

  const successes: StateEntry[] = [];
  const failures: Array<{ index: number; name: string; reason: string }> = [];
  let batchCount = 0;

  for (const t of targets) {
    console.log(`\n[${t.index}] Writing ${t.agent.agent_name}...`);
    try {
      const baseUrl =
        process.env.PUBLIC_ENGINE_BASE_URL ||
        'https://repid-engine-production.up.railway.app';
      const result = await writer.writeRepIDFeedback({
        agentTokenId: t.agent.erc8004_token_id,
        repid: t.agent.current_repid,
        tier: t.agent.tier,
        endpoint: `${baseUrl}/api/v1/agents/${t.agent.id}`,
        feedbackURI: `${baseUrl}/api/v1/agents/${t.agent.id}/reputation/payload.json`,
      });

      await persistReputationWrite(supabase, {
        agent_id: t.agent.id,
        agent_token_id: t.agent.erc8004_token_id,
        repid_value: t.agent.current_repid,
        tier: t.agent.tier,
        tx_hash: result.txHash,
        block_number: result.blockNumber,
        gas_used: result.gasUsed,
        chain_id: writer.chainId,
        contract_address: writer.getContractAddress(),
      });

      // Update repid_agents last_reputation_* + count
      const { data: current } = await supabase
        .from('repid_agents')
        .select('reputation_write_count')
        .eq('id', t.agent.id)
        .single();
      const nextCount =
        ((current as { reputation_write_count?: number } | null)
          ?.reputation_write_count ?? 0) + 1;
      await supabase
        .from('repid_agents')
        .update({
          last_reputation_tx_hash: result.txHash,
          last_reputation_block_number: result.blockNumber,
          last_reputation_repid: t.agent.current_repid,
          last_reputation_written_at: new Date().toISOString(),
          reputation_write_count: nextCount,
        })
        .eq('id', t.agent.id);

      const entry: StateEntry = {
        index: t.index,
        agent_name: t.agent.agent_name,
        agent_id: t.agent.id,
        agent_token_id: t.agent.erc8004_token_id,
        repid_value: t.agent.current_repid,
        tier: t.agent.tier,
        tx_hash: result.txHash,
        block_number: result.blockNumber,
        timestamp: new Date().toISOString(),
      };
      appendState(entry);
      successes.push(entry);
      console.log(
        `  ✅ tx=${result.txHash} block=${result.blockNumber} gas=${result.gasUsed}`
      );
      console.log(`     basescan: https://sepolia.basescan.org/tx/${result.txHash}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ index: t.index, name: t.agent.agent_name, reason: msg });
      console.log(`  ❌ FAILED: ${msg}`);
      console.log(
        `\n*** HALTING — review state and rerun with --resume-from ${t.index} ***`
      );
      break;
    }

    batchCount++;
    const isLast = targets[targets.length - 1]!.index === t.index;
    if (!noCheckpoint && batchCount >= CHECKPOINT_EVERY && !isLast) {
      const ok = await waitForEnter(
        `\n✋ CHECKPOINT — ${successes.length} written. Verify on Basescan, then press Enter (or "q" to stop): `
      );
      if (!ok) {
        console.log('Operator requested stop.');
        break;
      }
      batchCount = 0;
    }
  }

  console.log('\n=== Run summary ===');
  console.log(`Successes: ${successes.length}`);
  console.log(`Failures:  ${failures.length}`);
  if (failures.length > 0) {
    console.log('\nFailed:');
    for (const f of failures) {
      console.log(`  [${f.index}] ${f.name}: ${f.reason.slice(0, 120)}`);
    }
  }
  console.log(
    `\nVerify via:\n  curl https://repid-engine-production.up.railway.app/api/v1/agents/<id>/reputation/onchain\n  Or query: SELECT agent_id, repid_value, tier, tx_hash FROM erc8004_reputation_writes ORDER BY created_at DESC;`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
