import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rootLineage } from './task-lineage';

/**
 * HyperDAGReceiptAdapter event ABI fragment — must match the deployed contract's
 * actual signatures. Validated against
 * hyperdag-protocol/packages/contracts/artifacts/.../HyperDAGReceiptAdapter.json
 * (4 receipt events; non-receipt events Initialized/OwnershipTransferred/Upgraded omitted).
 */
export const RECEIPT_EVENT_ABI = [
  'event ReceiptCommitted(address indexed committer, bytes32 indexed commitHash, uint64 timestamp)',
  'event ReceiptRevealed(bytes32 indexed receiptId, uint256 indexed agentId, bytes32 indexed x402PaymentHash, bytes32 taskHash, bytes32 resultHash, bytes32 repIdCommitment, bytes32 halOutputHash, uint8 halDofVersion, uint8 halCommaBftVerdict, bytes32 receiptUriHash, bytes32 receiptContentHash, uint256 scoreVersion, address committer, uint64 timestamp)',
  'event ReceiptInvalidated(bytes32 indexed receiptId, uint256 indexed agentId, string reason, uint64 timestamp)'
] as const;

const RECEIPT_INTERFACE = new ethers.Interface(RECEIPT_EVENT_ABI as unknown as string[]);

export interface IndexOnceDeps {
  provider: ethers.JsonRpcProvider;
  contractAddress: string;
  supabase: SupabaseClient;
}

export interface IndexOnceResult {
  fromBlock: number;
  toBlock: number;
  eventsProcessed: number;
  perEvent: { revealed: number; invalidated: number; committed: number };
}

/**
 * Fetch and process all HyperDAGReceiptAdapter events in [fromBlock, toBlock]
 * inclusive. Idempotent — safe to re-run on the same range.
 *
 * Persistence model (after schema audit 2026-05-04):
 *   - ReceiptRevealed → matches off-chain row in hyperdag_receipts via
 *     receipt_content_hash and backfills contract_receipt_id, contract_tx_hash,
 *     contract_block_number. Then enqueues a trinity_tasks row of type
 *     'receipt_validation' if not already present (idempotency via
 *     metadata @> {receiptId: <off-chain receipt_id>}).
 *   - ReceiptInvalidated → sets hyperdag_receipts.status=1 (invalidated),
 *     invalidated_at, invalidation_reason on the row matching contract_receipt_id.
 *   - ReceiptCommitted → log-only. commitHash != receiptId; reveal carries the
 *     authoritative state.
 *
 * `hyperdag_receipts.status` is smallint (0=active, 1=invalidated, 2=disputed)
 * per migration 20260503_receipt_bridge.sql — never write string values.
 */
export async function indexOnce(
  fromBlock: number,
  toBlock: number,
  deps: IndexOnceDeps
): Promise<IndexOnceResult> {
  const { provider, contractAddress, supabase } = deps;

  if (toBlock < fromBlock) {
    return { fromBlock, toBlock, eventsProcessed: 0, perEvent: { revealed: 0, invalidated: 0, committed: 0 } };
  }

  const topicsByName: Record<string, string> = {};
  for (const fragment of RECEIPT_INTERFACE.fragments) {
    if (fragment.type === 'event') {
      const ev = fragment as ethers.EventFragment;
      const topic = RECEIPT_INTERFACE.getEvent(ev.name)?.topicHash;
      if (topic) topicsByName[ev.name] = topic;
    }
  }

  const allTopics = Object.values(topicsByName);
  const logs = await provider.getLogs({
    address: contractAddress,
    fromBlock,
    toBlock,
    topics: [allTopics]
  });

  const counts = { revealed: 0, invalidated: 0, committed: 0 };

  for (const log of logs) {
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = RECEIPT_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
    } catch (err) {
      console.error(`[Indexer] Failed to parse log at ${log.blockNumber}/${log.transactionHash}:`, err);
      continue;
    }
    if (!parsed) continue;

    if (parsed.name === 'ReceiptRevealed') {
      counts.revealed += 1;
      await handleReceiptRevealed(parsed, log, supabase);
    } else if (parsed.name === 'ReceiptInvalidated') {
      counts.invalidated += 1;
      await handleReceiptInvalidated(parsed, log, supabase);
    } else if (parsed.name === 'ReceiptCommitted') {
      counts.committed += 1;
      console.log(`[Indexer] ReceiptCommitted committer=${parsed.args.committer} commitHash=${parsed.args.commitHash} block=${log.blockNumber}`);
    }
  }

  return {
    fromBlock,
    toBlock,
    eventsProcessed: counts.revealed + counts.invalidated + counts.committed,
    perEvent: counts
  };
}

async function handleReceiptRevealed(
  parsed: ethers.LogDescription,
  log: ethers.Log,
  supabase: SupabaseClient
): Promise<void> {
  const onChainReceiptId = parsed.args.receiptId as string;
  const receiptContentHash = parsed.args.receiptContentHash as string;
  const agentId = (parsed.args.agentId as bigint).toString();

  console.log(`[Indexer] ReceiptRevealed onChainId=${onChainReceiptId} contentHash=${receiptContentHash} agentId=${agentId} block=${log.blockNumber} tx=${log.transactionHash}`);

  // Match off-chain row by content hash and backfill contract identifiers.
  const { data: matchedRows, error: matchErr } = await supabase
    .from('hyperdag_receipts')
    .update({
      contract_receipt_id: onChainReceiptId,
      contract_tx_hash: log.transactionHash,
      contract_block_number: log.blockNumber
    })
    .eq('receipt_content_hash', receiptContentHash)
    .select('receipt_id, receipt_uri');

  if (matchErr) {
    console.error(`[Indexer] hyperdag_receipts update failed for contentHash=${receiptContentHash}:`, matchErr);
    return;
  }

  if (!matchedRows || matchedRows.length === 0) {
    console.warn(`[Indexer] No off-chain row for contentHash=${receiptContentHash} (onChainId=${onChainReceiptId}). Issuer may not have run, or hash mismatch.`);
    return;
  }

  const matched = matchedRows[0] as { receipt_id: string; receipt_uri: string };
  const offChainReceiptId = matched.receipt_id;
  const receiptUri = matched.receipt_uri;

  // Idempotent enqueue of validation task for downstream Trinity agents.
  const { data: existing, error: existErr } = await supabase
    .from('trinity_tasks')
    .select('id')
    .eq('task_type', 'receipt_validation')
    .contains('metadata', { receiptId: offChainReceiptId })
    .limit(1);

  if (existErr) {
    console.error(`[Indexer] trinity_tasks lookup failed:`, existErr);
    return;
  }

  if (existing && existing.length > 0) {
    return;
  }

  const { error: insErr } = await supabase.from('trinity_tasks').insert({
    title: `Validate Receipt ${offChainReceiptId}`,
    description: `Trinity swarm needs to validate revealed receipt ${offChainReceiptId} (on-chain id ${onChainReceiptId})`,
    task_type: 'receipt_validation',
    status: 'pending',
    priority: 90,
    assigned_to: null,
    metadata: {
      receiptId: offChainReceiptId,
      contractReceiptId: onChainReceiptId,
      receiptUri,
      agentId,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber
    },
    // L2 breaker 2.2 — an indexed on-chain receipt is a genuine ROOT: the
    // trigger is a blockchain event, not another task. Written explicitly so
    // the row asserts its lineage rather than leaving it to a column default.
    ...rootLineage()
  });

  if (insErr) {
    console.error(`[Indexer] trinity_tasks insert failed for ${offChainReceiptId}:`, insErr);
  } else {
    console.log(`[Indexer] Enqueued trinity_tasks/receipt_validation for ${offChainReceiptId}`);
  }
}

async function handleReceiptInvalidated(
  parsed: ethers.LogDescription,
  log: ethers.Log,
  supabase: SupabaseClient
): Promise<void> {
  const onChainReceiptId = parsed.args.receiptId as string;
  const reason = parsed.args.reason as string;
  const timestamp = (parsed.args.timestamp as bigint).toString();

  console.log(`[Indexer] ReceiptInvalidated onChainId=${onChainReceiptId} reason=${reason} block=${log.blockNumber}`);

  const invalidatedAt = new Date(Number(timestamp) * 1000).toISOString();

  const { error } = await supabase
    .from('hyperdag_receipts')
    .update({
      status: 1,
      invalidated_at: invalidatedAt,
      invalidation_reason: reason
    })
    .eq('contract_receipt_id', onChainReceiptId);

  if (error) {
    console.error(`[Indexer] hyperdag_receipts invalidation update failed for ${onChainReceiptId}:`, error);
  }
}

/**
 * BFT aggregation poll — preserved from prior implementation. Scans receipts
 * with on-chain reveal recorded and computes BFT verdict from
 * trinity_receipt_validators rows. Writes to trinity_receipt_bft_results.
 *
 * The simple-majority + veto-wins logic is retained from the prior code; the
 * Pythagorean Comma 531441/524288 dissonance check is a v1.1 hardening item
 * (parking-lot — see report).
 */
export async function checkBftAggregation(supabase: SupabaseClient): Promise<{ resolved: number }> {
  let resolved = 0;
  const { data: receipts, error } = await supabase
    .from('hyperdag_receipts')
    .select('receipt_id')
    .not('contract_receipt_id', 'is', null)
    .eq('status', 0);

  if (error || !receipts) return { resolved };

  for (const r of receipts as Array<{ receipt_id: string }>) {
    const { data: validators } = await supabase
      .from('trinity_receipt_validators')
      .select('verdict')
      .eq('receipt_id', r.receipt_id);

    if (!validators) continue;

    const decisive = validators.filter((v: { verdict: string }) => v.verdict !== 'indeterminate' && v.verdict !== 'pending');
    if (decisive.length < 4) continue;

    const passCount = decisive.filter((v: { verdict: string }) => v.verdict === 'pass').length;
    const vetoCount = decisive.filter((v: { verdict: string }) => v.verdict === 'veto').length;
    const ratio = passCount / decisive.length;

    let finalVerdict = 'inconclusive';
    if (vetoCount >= 1) {
      finalVerdict = 'veto';
    } else if (ratio >= 0.618) {
      finalVerdict = 'pass';
    }

    if (finalVerdict === 'inconclusive') continue;

    const { error: bftErr } = await supabase.from('trinity_receipt_bft_results').upsert({
      receipt_id: r.receipt_id,
      final_verdict: finalVerdict,
      pass_count: passCount,
      veto_count: vetoCount,
      indeterminate_count: validators.length - decisive.length,
      decisive_count: decisive.length,
      pass_ratio: ratio
    }, { onConflict: 'receipt_id' });

    if (!bftErr) {
      resolved += 1;
      console.log(`[Indexer] BFT resolved ${r.receipt_id} → ${finalVerdict} (pass=${passCount}, veto=${vetoCount}, decisive=${decisive.length})`);
    }
  }

  return { resolved };
}
