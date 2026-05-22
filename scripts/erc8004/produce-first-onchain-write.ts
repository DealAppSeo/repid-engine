/**
 * produce-first-onchain-write.ts — produce ONE real ERC-8004 reputation write
 * on Base Sepolia, deterministically, for the lifetime-first verifiable tx.
 *
 * WHY THIS EXISTS
 * ---------------
 * The FeedbackLoopWorker only writes on-chain when it finds unprocessed
 * `x402_*_settled` rows in repid_events — a stream that production does not
 * currently fill (x402 producers are unmounted/test-only; see CC2's audit).
 * So even with a valid funded ERC8004_REPUTATION_WRITER_KEY, zero real writes
 * have ever landed. This admin script bypasses the event loop and drives the
 * SAME production writer (Erc8004ReputationWriter.writeRepIDFeedback ->
 * contract.giveFeedback) directly for one eligible agent, then persists the
 * receipt to erc8004_reputation_writes — exactly mirroring the worker's own
 * persistence call. It is the cleanest path to the historic first write.
 *
 * SAFETY
 * ------
 *   - DRY RUN BY DEFAULT. No transaction is broadcast unless you pass --execute.
 *   - Requires a funded ERC8004_REPUTATION_WRITER_KEY (or fallback) in env. On
 *     Railway this is already set; locally the committed .env is a dummy, so run
 *     this on the deployed service (or an env with the real funded key + RPC).
 *   - Reads only; the only mutation (with --execute) is the on-chain giveFeedback
 *     tx + the audit row in erc8004_reputation_writes. No other state changes.
 *
 * USAGE
 * -----
 *   npx tsx scripts/erc8004/produce-first-onchain-write.ts            # dry run
 *   npx tsx scripts/erc8004/produce-first-onchain-write.ts --execute  # broadcast
 *   npx tsx scripts/erc8004/produce-first-onchain-write.ts --agent <uuid|name> --execute
 *
 * Default agent selection: highest current_repid among agents that are minted
 * (erc8004_token_id IS NOT NULL) AND ESTABLISHED+ (current_repid >= 1000),
 * matching the FeedbackLoopWorker's eligibility gates. --agent overrides the
 * pick (still must be minted — a token id is required to call giveFeedback).
 */

import { getReputationWriter, persistReputationWrite } from '../../src/services/erc8004-reputation';
import { db } from '../../src/db';

const ESTABLISHED_FLOOR = 1000; // matches FeedbackLoopWorker tier_floor

interface EligibleAgent {
  id: string;
  agent_name: string;
  current_repid: number;
  tier: string;
  erc8004_token_id: string;
}

async function resolveAgent(agentArg: string | undefined): Promise<EligibleAgent | null> {
  if (agentArg) {
    // Explicit target: try id, then agent_name. Must be minted (token id present).
    const isUuid = /^[0-9a-f-]{36}$/i.test(agentArg);
    const { data } = await db
      .from('repid_agents')
      .select('id, agent_name, current_repid, tier, erc8004_token_id')
      .eq(isUuid ? 'id' : 'agent_name', agentArg)
      .not('erc8004_token_id', 'is', null)
      .maybeSingle();
    return (data as EligibleAgent | null) ?? null;
  }
  // Default: highest-repid minted ESTABLISHED+ agent.
  const { data } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, tier, erc8004_token_id')
    .not('erc8004_token_id', 'is', null)
    .gte('current_repid', ESTABLISHED_FLOOR)
    .order('current_repid', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as EligibleAgent | null) ?? null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const agentIdx = args.indexOf('--agent');
  const agentArg = agentIdx >= 0 ? args[agentIdx + 1] : undefined;

  const writer = getReputationWriter();
  if (!writer) {
    console.error(
      'FATAL: no signing key resolved (ERC8004_REPUTATION_WRITER_KEY / ' +
        'ERC8004_MINTER_PRIVATE_KEY / ERC8004_OPERATOR_KEY). Set the funded key ' +
        'on this environment (Railway) and retry.'
    );
    process.exit(1);
  }

  const operator = await writer.getOperatorAddress();
  const contract = writer.getContractAddress();
  console.log(`[first-write] operator wallet : ${operator}`);
  console.log(`[first-write] contract        : ${contract}`);
  console.log(`[first-write] chainId         : ${writer.chainId}`);
  console.log(`[first-write] gas check       : fund ${operator} with Base Sepolia ETH if the tx reverts on gas`);

  const agent = await resolveAgent(agentArg);
  if (!agent) {
    console.error(
      agentArg
        ? `FATAL: agent "${agentArg}" not found or not minted (erc8004_token_id is NULL).`
        : `FATAL: no eligible agent (minted AND current_repid >= ${ESTABLISHED_FLOOR}). ` +
            `Mint a token / raise a score first, or pass --agent <uuid|name>.`
    );
    process.exit(1);
  }

  console.log(
    `[first-write] target agent    : ${agent.agent_name} ` +
      `(id=${agent.id}, repid=${agent.current_repid}, tier=${agent.tier}, token=${agent.erc8004_token_id})`
  );

  if (!execute) {
    console.log(
      '[first-write] DRY RUN — no transaction broadcast. Re-run with --execute to ' +
        'call giveFeedback on-chain and persist the receipt.'
    );
    return;
  }

  console.log('[first-write] EXECUTE — broadcasting giveFeedback on Base Sepolia...');
  const result = await writer.writeRepIDFeedback({
    agentTokenId: agent.erc8004_token_id,
    repid: Math.round(agent.current_repid),
    tier: agent.tier,
    endpoint: `https://trustrepid.dev/api/v1/agents/${agent.id}/reputation/payload.json`,
    feedbackURI: `https://trustrepid.dev/api/v1/agents/${agent.id}/reputation/payload.json`,
  });

  console.log(`[first-write] ✅ tx hash       : ${result.txHash}`);
  console.log(`[first-write] basescan        : https://sepolia.basescan.org/tx/${result.txHash}`);
  console.log(`[first-write] block / gas     : ${result.blockNumber} / ${result.gasUsed}`);

  // Persist the audit row exactly as the FeedbackLoopWorker does.
  await persistReputationWrite(db, {
    agent_id: agent.id,
    agent_token_id: agent.erc8004_token_id,
    repid_value: Math.round(agent.current_repid),
    tier: agent.tier,
    tx_hash: result.txHash,
    block_number: result.blockNumber,
    gas_used: result.gasUsed,
    chain_id: writer.chainId,
    contract_address: contract,
  });
  console.log('[first-write] persisted to erc8004_reputation_writes. Done.');
}

main().catch((e: any) => {
  console.error('[first-write] FATAL:', e?.message ?? String(e), e?.stack ?? '');
  process.exit(1);
});
