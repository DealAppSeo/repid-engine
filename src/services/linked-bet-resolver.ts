/**
 * Linked bets — placement and atomic resolution.
 *
 * Place: caller checks authority, gets a Plonky3 trade-auth proof, and
 * inserts an open bet.
 *
 * Resolve: oracle outcome arrives, atomic SQL function applies the
 * linked token + RepID deltas (one-way valve enforced both at the
 * application layer and at the table CHECK).
 *
 * Sign rule:
 *   correct + confidence > 0  → token_delta > 0  AND repid_delta > 0
 *   wrong   + confidence > 0  → token_delta < 0  AND repid_delta < 0
 *   confidence = 0 (counts as wrong) ⇒ both deltas = 0 (no-op)
 *
 * Settlement always emits an audit-chain row. Wisdom + Character
 * scores update on resolve.
 */

import { createHmac } from 'crypto';
import { db } from '../db';
import { emitAuditEvent } from './audit-emit';
import { snapshotAuthority } from './stake-vault';
import { getBuilderForAgent, recomputeBuilderRepID } from './builder-registry';
import { generateTradeAuthProof } from './plonky3-bridge';
import { updateWisdomScore } from './wisdom-score';
import { recordCharacterEvent, getCurrentCharacter } from './character-score';

const ORACLE_HMAC_SECRET = process.env.ORACLE_HMAC_SECRET || 'reponomics-default-oracle-secret';

export interface PlaceBetInput {
  agentId: string;                       // UUID
  betAmount: bigint;                      // smallest-unit USDC
  claimedConfidence: number;              // basis points 0-10000
  predictionPayload: Record<string, unknown>;
  oracleEndpoint: string;
  expectedResolutionTime: Date;
  demoBuilderId?: string;
}

export interface PlaceBetResult {
  betId: string;
  plonky3ProofBytes: string;
  is_simulated: boolean;
  authority_used: string;
}

function newBetId(): string {
  return `bet_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export async function placeBet(input: PlaceBetInput): Promise<PlaceBetResult> {
  if (input.claimedConfidence < 0 || input.claimedConfidence > 10000) {
    throw new Error(`claimedConfidence must be 0..10000, got ${input.claimedConfidence}`);
  }

  const builder = await getBuilderForAgent(input.agentId);
  if (!builder) throw new Error(`agent ${input.agentId} has no builder`);

  const authority = await snapshotAuthority(input.demoBuilderId ?? builder.builderId);
  if (input.betAmount > authority.authority) {
    let human_message = `Your agent tried to bet $${(Number(input.betAmount) / 1_000_000).toFixed(2)} but its authority limit is $${(Number(authority.authority) / 1_000_000).toFixed(3)}. The system stopped it.`;
    
    if (input.demoBuilderId) {
      const { getTierForRepId } = require('../config/tier-limits');
      const { current: currentTier } = getTierForRepId(authority.basis.builder_repid);
      const authDollars = (Number(authority.authority) / 1_000_000).toFixed(0);
      const pct = Math.floor(currentTier.pctOfStake * 100);
      human_message = `Your agent can bet up to $${authDollars} right now — ${pct}% of what you staked. As your agent earns a higher RepID, that percentage goes up. Try an amount between $1 and $${authDollars}.`;
    }

    const errorJson = JSON.stringify({
      error: 'BET_EXCEEDS_AUTHORITY',
      human_message,
      details: {
        attempted_bet_raw: Number(input.betAmount),
        attempted_bet_human_usdc: Number(input.betAmount) / 1_000_000,
        authority_raw: Number(authority.authority),
        authority_human_usdc: Number(authority.authority) / 1_000_000,
        recommended_bet_raw: Math.floor(Number(authority.authority) * 0.5),
        recommended_bet_human_usdc: Math.floor(Number(authority.authority) * 0.5) / 1_000_000
      },
      next_step: 'retry_with_recommended'
    });
    throw new Error(errorJson);
  }

  const proof = generateTradeAuthProof({
    agentId: input.agentId,
    builderId: builder.builderId,
    tradeAmount: input.betAmount,
    timestamp: BigInt(Date.now()),
    thresholdCombinedScore: 0,
  });

  const betId = newBetId();
  const { error } = await db.from('linked_bets').insert({
    id: betId,
    agent_id: input.agentId,
    bet_amount: input.betAmount.toString(),
    claimed_confidence: input.claimedConfidence,
    prediction_payload: input.predictionPayload,
    oracle_endpoint: input.oracleEndpoint,
    expected_resolution_time: input.expectedResolutionTime.toISOString(),
    status: 'open',
    plonky3_proof_bytes: proof.proofBytesHex,
    is_simulated: proof.isSimulated,
  });
  if (error) throw new Error(`linked_bets insert failed: ${error.message}`);

  await emitAuditEvent({
    event_type: 'bet_placed',
    source_table: 'linked_bets',
    source_id: betId,
    payload: {
      bet_id: betId,
      agent_id: input.agentId,
      builder_id: builder.builderId,
      amount: input.betAmount.toString(),
      claimed_confidence: input.claimedConfidence,
      authority_used: authority.authority.toString(),
      is_simulated: proof.isSimulated,
    },
  });

  // Touch agent.last_active_at
  await db.from('repid_agents').update({ last_active_at: new Date().toISOString() }).eq('id', input.agentId);

  return {
    betId,
    plonky3ProofBytes: proof.proofBytesHex,
    is_simulated: proof.isSimulated,
    authority_used: authority.authority.toString(),
  };
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export function signOracleOutcome(betId: string, outcome: boolean): string {
  return createHmac('sha256', ORACLE_HMAC_SECRET).update(`${betId}|${outcome ? '1' : '0'}`).digest('hex');
}

export function verifyOracleSignature(betId: string, outcome: boolean, signature: string): boolean {
  return signOracleOutcome(betId, outcome) === signature;
}

/**
 * Derive an oracle outcome AND its signature in one call. Tries the
 * Base Sepolia block-hash oracle first; falls back to a deterministic
 * HMAC over the betId on RPC failure. Never throws.
 *
 * Returns { outcome, signature, oracle_source, block_number?,
 * block_hash?, basescan_url? } so the caller can persist the
 * provenance alongside the bet resolution.
 *
 * agent-trader.resolveOpenRounds calls signOracleOutcome directly
 * with a deterministic mock outcome; this NEW helper is the path for
 * any caller that wants real-chain provenance. Backward-compatible
 * by addition.
 */
export async function deriveAndSignOracleOutcome(betId: string): Promise<{
  outcome: boolean;
  signature: string;
  oracle_source: 'onchain_blockhash' | 'fallback_hmac';
  block_number: number;
  block_hash: string;
  basescan_url: string;
}> {
  // Lazy require so existing sync callers of this module aren't forced
  // to load ethers + the RPC stack at module-load time. (Using require
  // because ts-jest doesn't support dynamic import() without
  // --experimental-vm-modules.)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { deriveOutcomeFromChain } = require('./onchain-oracle') as typeof import('./onchain-oracle');
  try {
    const r = await deriveOutcomeFromChain(betId);
    const outcome = r.outcome === 1;
    return {
      outcome,
      signature: signOracleOutcome(betId, outcome),
      oracle_source: r.oracle_source,
      block_number: r.block_number,
      block_hash: r.block_hash,
      basescan_url: r.basescan_url,
    };
  } catch (e: any) {
    // Last-line catch — deriveOutcomeFromChain itself never throws,
    // but if a future change made it throw we still keep the resolver
    // alive with a deterministic HMAC fallback on the betId.
    const seed = createHmac('sha256', ORACLE_HMAC_SECRET).update(betId).digest('hex');
    const outcome = parseInt(seed.slice(-2), 16) % 2 === 1;
    return {
      outcome,
      signature: signOracleOutcome(betId, outcome),
      oracle_source: 'fallback_hmac',
      block_number: 0,
      block_hash: '0x' + seed,
      basescan_url: '',
    };
  }
}

export interface ResolveBetResult {
  ok: boolean;
  bet_id: string;
  correct: boolean;
  token_delta: string;
  repid_delta: number;
  new_wisdom: number;
  new_character: number;
  builder_repid_after: number;
  audit_chain_id: number | null;
  error?: string;
}

export interface PredictionPayloadShape {
  predicted_outcome?: boolean;
  counterparty_repid?: number;
  [k: string]: unknown;
}

export function computeLinkedDeltas(args: {
  betAmount: bigint;
  claimedConfidence: number;       // basis points
  correct: boolean;
}): { tokenDelta: bigint; repidDelta: number } {
  const confidenceFactor = args.claimedConfidence / 10000;
  // Token delta scales with bet amount and confidence.
  const tokenAbs = (args.betAmount * BigInt(Math.floor(confidenceFactor * 100))) / 100n;
  // RepID delta scales with confidence (max ±100 per bet).
  const repidAbs = Math.floor(confidenceFactor * 100);
  if (args.correct) {
    return { tokenDelta: tokenAbs, repidDelta: repidAbs };
  }
  return { tokenDelta: -tokenAbs, repidDelta: -repidAbs };
}

export async function resolveBet(
  betId: string,
  oracleOutcome: boolean,
  oracleSignature: string,
): Promise<ResolveBetResult> {
  if (!verifyOracleSignature(betId, oracleOutcome, oracleSignature)) {
    return mkErrorResult(betId, 'oracle signature invalid');
  }

  const { data: bet } = await db.from('linked_bets').select('*').eq('id', betId).maybeSingle();
  if (!bet || bet.status !== 'open') {
    return mkErrorResult(betId, `bet not found or not open (status=${bet?.status ?? 'missing'})`);
  }

  const payload = (bet.prediction_payload ?? {}) as PredictionPayloadShape;
  const predicted = !!payload.predicted_outcome;
  const correct = predicted === oracleOutcome;
  const betAmount = BigInt(bet.bet_amount);

  const { tokenDelta, repidDelta } = computeLinkedDeltas({
    betAmount,
    claimedConfidence: Number(bet.claimed_confidence ?? 0),
    correct,
  });

  // Defense-in-depth: verify atomic linkage rule before calling the RPC
  // (which also enforces it).
  if ((tokenDelta > 0n && repidDelta < 0) || (tokenDelta < 0n && repidDelta > 0)) {
    return mkErrorResult(betId, 'atomic linkage violation');
  }

  const { error: rpcErr } = await db.rpc('apply_linked_bet_resolution', {
    p_bet_id: betId,
    p_token_delta: tokenDelta.toString(),
    p_repid_delta: repidDelta,
    p_resolved_at: new Date().toISOString(),
  });
  if (rpcErr) return mkErrorResult(betId, `apply_linked_bet_resolution failed: ${rpcErr.message}`);

  // Update wisdom + character outside the SQL transaction (those are
  // appendable history rows + simple agent updates; failing one here
  // does not invalidate the bet resolution).
  const wisdomR = await updateWisdomScore(bet.agent_id, Number(bet.claimed_confidence ?? 0), correct);

  const counterpartyRepId = typeof payload.counterparty_repid === 'number' ? payload.counterparty_repid : undefined;
  let newCharacter = await getCurrentCharacter(bet.agent_id);
  if (counterpartyRepId !== undefined) {
    const { data: agent } = await db.from('repid_agents').select('current_repid').eq('id', bet.agent_id).maybeSingle();
    const selfRepId = Number(agent?.current_repid ?? 0);
    if (counterpartyRepId < selfRepId) {
      const cr = await recordCharacterEvent({
        agentId: bet.agent_id,
        eventType: 'trade_with_low_repid',
        counterpartyRepId,
        agentSelfRepId: selfRepId,
      });
      newCharacter = cr.new_character;
    }
  }

  // Recompute builder RepID + audit row.
  const builder = await getBuilderForAgent(bet.agent_id);
  let builderRepidAfter = 0;
  if (builder) {
    const r = await recomputeBuilderRepID(builder.builderId);
    builderRepidAfter = r.builder_repid;
  }

  const audit = await emitAuditEvent({
    event_type: 'bet_resolved',
    source_table: 'linked_bets',
    source_id: betId,
    payload: {
      bet_id: betId,
      agent_id: bet.agent_id,
      correct,
      token_delta: tokenDelta.toString(),
      repid_delta: repidDelta,
      new_wisdom: wisdomR.new_wisdom,
      new_character: newCharacter,
    },
  });

  return {
    ok: true,
    bet_id: betId,
    correct,
    token_delta: tokenDelta.toString(),
    repid_delta: repidDelta,
    new_wisdom: wisdomR.new_wisdom,
    new_character: newCharacter,
    builder_repid_after: builderRepidAfter,
    audit_chain_id: audit.audit_chain_id,
  };
}

function mkErrorResult(betId: string, error: string): ResolveBetResult {
  return {
    ok: false,
    bet_id: betId,
    correct: false,
    token_delta: '0',
    repid_delta: 0,
    new_wisdom: 0,
    new_character: 0,
    builder_repid_after: 0,
    audit_chain_id: null,
    error,
  };
}
