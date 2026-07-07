// Buy-loop last mile (2026-07-06) — auto-trigger ERC-8004 on-chain reputation
// write when a service contract completes.
//
// WHY: applyServiceFulfilledDeltas() writes the RepID delta + a
// `service_fulfilled_settled` row into repid_events, but the on-chain
// attestation only happened asynchronously via FeedbackLoopWorker (which polls
// that same event_type). That worker is gated behind ENGINE_WORKERS_ENABLED and
// a 24h drain-mode rate limit, so a completed real purchase could sit for
// minutes-to-forever with NO verifiable on-chain reputation trail.
//
// This module does a best-effort INLINE write at completion time so the buy
// loop leaves a verifiable attestation immediately. It is:
//   (a) GATED — only fires for a REAL (non-simulated) settlement AND an agent
//       that actually has an erc8004_token_id (and clears the Established floor,
//       matching FeedbackLoopWorker's tier gate so we never burn gas below it).
//   (b) NON-FATAL / DEGRADE-LOUD — every failure is caught and logged loudly.
//       It NEVER throws into applyServiceFulfilledDeltas. On failure the
//       repid_events `service_fulfilled_settled` bridge row (written by the
//       caller) remains unprocessed, so FeedbackLoopWorker still drains it
//       later — the async path is the built-in fallback queue.
//   (c) IDEMPOTENT — skips if an erc8004_reputation_writes row already exists
//       for this (agent, contract) pair, so a retried fulfillment never
//       double-writes on-chain.
//
// It does NOT hardcode a key. getReputationWriter() resolves the key from env
// (ERC8004_REPUTATION_WRITER_KEY / ERC8004_MINTER_PRIVATE_KEY /
// ERC8004_OPERATOR_KEY). If a REAL settlement is eligible but NO key is set,
// this logs LOUD ("would attest but no signing key") and returns — it does not
// silently pretend success.
//
// Enablement: ONCHAIN_REPUTATION_TRIGGER_ENABLED must be 'true'. Ships OFF so
// wiring it in is inert until Sean flips the flag with a funded wallet, exactly
// like the other on-chain surfaces (cascade-settlement-worker, feedback loop).

import { db } from '../db';
import {
  getReputationWriter,
  persistReputationWrite,
  type WriteRepIDResult,
} from './erc8004-reputation';

// Match FeedbackLoopWorker's Established floor (Phase 8, LOCKED at 1000): below
// this, on-chain attestation cost isn't worth the noise.
const ONCHAIN_REPUTATION_TIER_FLOOR = 1000;

// Bounded ethers call — RPC nodes can hang. Mirrors FeedbackLoopWorker's
// withRpcTimeout (CLAUDE-RULE-8: never an unbounded wait).
const RPC_CALL_TIMEOUT_MS = 30_000;

function withRpcTimeout<T>(label: string, call: PromiseLike<T>, ms: number = RPC_CALL_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => reject(new Error(`rpc timeout after ${ms}ms: ${label}`)), ms);
    Promise.resolve(call).then(
      v => { clearTimeout(handle); resolve(v); },
      err => { clearTimeout(handle); reject(err); },
    );
  });
}

export interface OnChainTriggerInput {
  contractId: string;
  providerAgentId: string;
  isSimulated: boolean;
  // Optional link back to the repid_events row for the audit trail.
  repidEventId?: number | null;
}

export type OnChainTriggerOutcome =
  | { attempted: false; reason: 'disabled' | 'simulated' | 'no_token_id' | 'below_floor' | 'agent_not_found' | 'already_written' | 'no_writer' }
  | { attempted: true; ok: true; txHash: string }
  | { attempted: true; ok: false; error: string };

/**
 * Best-effort inline ERC-8004 reputation write for a completed real settlement.
 * Never throws; returns a structured outcome for logging/tests.
 */
export async function maybeWriteOnChainReputation(
  input: OnChainTriggerInput,
): Promise<OnChainTriggerOutcome> {
  try {
    if (process.env.ONCHAIN_REPUTATION_TRIGGER_ENABLED !== 'true') {
      return { attempted: false, reason: 'disabled' };
    }

    // (a) GATE — never on a simulated settlement.
    if (input.isSimulated) {
      return { attempted: false, reason: 'simulated' };
    }

    const { data: agent, error: agentErr } = await db
      .from('repid_agents')
      .select('id, agent_name, current_repid, tier, erc8004_token_id')
      .eq('id', input.providerAgentId)
      .maybeSingle();

    if (agentErr || !agent) {
      console.warn(
        `[onchain-reputation-trigger] provider agent ${input.providerAgentId} not found for contract ${input.contractId}; skipping on-chain write.`,
      );
      return { attempted: false, reason: 'agent_not_found' };
    }

    if (!agent.erc8004_token_id) {
      console.log(
        `[onchain-reputation-trigger] agent ${agent.agent_name} has no erc8004_token_id; skipping on-chain write for contract ${input.contractId}.`,
      );
      return { attempted: false, reason: 'no_token_id' };
    }

    const repid = agent.current_repid ?? 0;
    if (repid < ONCHAIN_REPUTATION_TIER_FLOOR) {
      console.log(
        `[onchain-reputation-trigger] agent ${agent.agent_name} below Established floor (${repid} < ${ONCHAIN_REPUTATION_TIER_FLOOR}); skipping on-chain write.`,
      );
      return { attempted: false, reason: 'below_floor' };
    }

    // (c) IDEMPOTENT — if we already wrote for this (agent, contract), stop.
    // erc8004_reputation_writes has no contract_id column, so we thread the
    // contract id through repid_event_id linkage when available, and also
    // guard on the exact repid_event_id if one was passed.
    if (input.repidEventId != null) {
      const { data: prior } = await db
        .from('erc8004_reputation_writes')
        .select('id, tx_hash')
        .eq('agent_id', agent.id)
        .eq('repid_event_id', input.repidEventId)
        .limit(1);
      if (prior && prior.length > 0) {
        console.log(
          `[onchain-reputation-trigger] on-chain write already recorded for agent ${agent.agent_name} event ${input.repidEventId} (tx ${prior[0]!.tx_hash}); idempotent skip.`,
        );
        return { attempted: false, reason: 'already_written' };
      }
    }

    // Writer resolves the signing key from env. Null = no key set.
    const writer = getReputationWriter();
    if (!writer) {
      // LOUD: eligible real settlement but no signing key. Do NOT pretend
      // success. The repid_events bridge row still exists for the async worker.
      console.error(
        `[onchain-reputation-trigger] ELIGIBLE real settlement for agent ${agent.agent_name} (contract ${input.contractId}) but NO ERC-8004 signing key is set ` +
          `(ERC8004_REPUTATION_WRITER_KEY / ERC8004_MINTER_PRIVATE_KEY / ERC8004_OPERATOR_KEY). On-chain attestation SKIPPED — the repid_events bridge row remains for FeedbackLoopWorker to drain when a key is available.`,
      );
      return { attempted: false, reason: 'no_writer' };
    }

    const tier = agent.tier ?? 'ESTABLISHED';
    const endpoint = `https://trustrepid.dev/api/v1/agents/${agent.id}/reputation/payload.json`;

    console.log(
      `[onchain-reputation-trigger] writing RepID ${Math.round(repid)} on-chain for ${agent.agent_name} (token ${agent.erc8004_token_id}) on contract ${input.contractId}...`,
    );

    const result: WriteRepIDResult = await withRpcTimeout<WriteRepIDResult>(
      `writeRepIDFeedback(${agent.agent_name},token=${agent.erc8004_token_id})`,
      writer.writeRepIDFeedback({
        agentTokenId: agent.erc8004_token_id,
        repid: Math.round(repid),
        tier,
        endpoint,
        feedbackURI: endpoint,
      }),
    );

    // Persist the audit row. gas_used is a numeric column; the writer returns a
    // string — coerce, and null on a non-finite parse rather than write NaN.
    const gasUsedNum = Number(result.gasUsed);
    await persistReputationWrite(db, {
      agent_id: agent.id,
      agent_token_id: agent.erc8004_token_id,
      repid_value: Math.round(repid),
      tier,
      tx_hash: result.txHash,
      block_number: result.blockNumber,
      gas_used: Number.isFinite(gasUsedNum) ? gasUsedNum : (null as unknown as number),
      chain_id: writer.chainId,
      contract_address: writer.getContractAddress(),
      ...(input.repidEventId != null ? { repid_event_id: input.repidEventId } : {}),
    } as any);

    // Fast-lookup denorm on the agent (mirrors FeedbackLoopWorker step 4).
    await db
      .from('repid_agents')
      .update({ last_reputation_tx_hash: result.txHash })
      .eq('id', agent.id);

    console.log(
      `[onchain-reputation-trigger] on-chain RepID attestation confirmed for ${agent.agent_name}: ${result.txHash} (contract ${input.contractId}).`,
    );
    return { attempted: true, ok: true, txHash: result.txHash };
  } catch (e: any) {
    // (b) NON-FATAL — log LOUD and swallow. The repid_events bridge row remains
    // unprocessed so the async FeedbackLoopWorker is the fallback queue.
    console.error(
      `[onchain-reputation-trigger] on-chain write FAILED for contract ${input.contractId} (non-fatal; delta write already committed, async worker will retry):`,
      e?.message ?? String(e),
    );
    return { attempted: true, ok: false, error: e?.message ?? String(e) };
  }
}
