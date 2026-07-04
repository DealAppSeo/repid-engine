/**
 * BLIND 2-of-3 ADJUDICATION PANEL — consensus resolver + honest scoring.
 *
 * Sean's BFT-triple canon + the "blind beats context-contaminated reviewer"
 * lesson, in code. Replaces the single-unadjudicated-verifier theater (one
 * opinion, +3, gameable) with a real correctness PROXY: three INDEPENDENT
 * verifiers vote WITHOUT seeing each other's verdicts; the 2-of-3 majority is
 * the correctness signal that reward is derived from.
 *
 * HONESTY (state it plainly): 2-of-3 blind consensus is a STRONG PROXY for
 * correctness, NOT perfection. A majority can still be wrong (correlated model
 * error, shared blind spot). But it is a real, gameable-resistant signal —
 * vastly better than one context-contaminated opinion — and independence
 * (distinct agents, distinct providers where the model allows) is exactly what
 * makes the majority informative.
 *
 * FLAG: everything here is inert unless PEER_VERIFY_PANEL_ENABLED === 'true'.
 * Default false → prod behavior unchanged; the legacy single-verifier path in
 * routes/peer-verification.ts keeps working untouched.
 *
 * SCORING: honest, via applyValidationEvent (scoring/pipeline.ts):
 *   - verifier who AGREED with consensus  → small positive (VALIDATOR_REWARD)
 *   - verifier who DIVERGED from consensus → PEER_VERIFY_WRONG_CALL (-5) as a
 *     VALIDATOR_PENALTY
 *   - producer scored per the consensus verdict (verified → positive, disputed
 *     → penalty)
 *   - no-consensus / tie / timeout → score 0 for everyone
 */
import { pgQuery } from '../db/direct-pg';
import { applyValidationEvent } from '../scoring/pipeline';

// Canonical verifier pool + a distinct-provider hint per verifier so panel
// votes are genuinely independent where the model allows. The reader assigns
// providers round-robin from this map; the actual LLM call is the verifier
// agent's concern — this is the independence *intent* recorded on the vote.
export const PANEL_VERIFIER_POOL = ['trinity-mel', 'trinity-shofet', 'trinity-gcm'] as const;

// Free-tier providers only (never paid). One per verifier keeps votes on
// distinct models where possible; if the pool is larger than providers, it
// wraps — still distinct agents.
export const PANEL_PROVIDER_HINTS: Record<string, string> = {
  'trinity-mel': 'groq',
  'trinity-shofet': 'cerebras',
  'trinity-gcm': 'gemini',
};

export const PANEL_SIZE = 3;
export const CONSENSUS_QUORUM = 2; // 2-of-3

export type PanelVerdict = 'verified' | 'disputed' | 'timeout';

export function peerVerifyPanelEnabled(): boolean {
  return (process.env.PEER_VERIFY_PANEL_ENABLED || 'false').toLowerCase() === 'true';
}

// Reward for a verifier who agreed with the 2-of-3 majority. Small + bounded;
// overridable by env. Uses VALIDATOR_REWARD event type in applyValidationEvent.
const PANEL_AGREE_DELTA = Number(process.env.PEER_VERIFY_PANEL_AGREE_DELTA || 3);
// PEER_VERIFY_WRONG_CALL canonical value (FIXED_DELTAS = -5). Kept in sync but
// overridable for calibration; a diverging verifier takes this.
const PANEL_DIVERGE_DELTA = Number(process.env.PEER_VERIFY_PANEL_DIVERGE_DELTA || -5);
// Producer delta on a 'verified' consensus (positive) vs 'disputed' (penalty).
const PANEL_PRODUCER_VERIFIED_DELTA = Number(process.env.PEER_VERIFY_PANEL_PRODUCER_VERIFIED_DELTA || 3);
const PANEL_PRODUCER_DISPUTED_DELTA = Number(process.env.PEER_VERIFY_PANEL_PRODUCER_DISPUTED_DELTA || -5);

export interface PanelVote {
  verifier_agent_id: string;
  verifier_agent_name?: string | null;
  provider?: string | null;
  verdict: PanelVerdict;
}

export interface ConsensusResult {
  reached: boolean;
  /** the 2-of-3 majority verdict when reached; null on tie/timeout/insufficient */
  verdict: PanelVerdict | null;
  votes: PanelVote[];
  tally: Record<string, number>;
  reason: 'reached' | 'insufficient_votes' | 'no_majority' | 'all_timeout';
}

/**
 * Pure consensus computation over a set of votes. Timeouts DO NOT count toward a
 * verdict (they are absence-of-signal). A verdict needs >= CONSENSUS_QUORUM
 * matching NON-timeout votes AND must be a strict plurality (no tie).
 *
 * This is the correctness signal. Deterministic, unit-testable, no DB.
 */
export function computeConsensus(votes: PanelVote[]): ConsensusResult {
  const tally: Record<string, number> = { verified: 0, disputed: 0, timeout: 0 };
  for (const v of votes) {
    tally[v.verdict] = (tally[v.verdict] ?? 0) + 1;
  }

  const decisive = votes.filter((v) => v.verdict !== 'timeout');
  if (decisive.length === 0) {
    return { reached: false, verdict: null, votes, tally, reason: 'all_timeout' };
  }

  // Not enough votes in yet to possibly reach quorum.
  if (votes.length < CONSENSUS_QUORUM) {
    return { reached: false, verdict: null, votes, tally, reason: 'insufficient_votes' };
  }

  const verifiedCount = tally.verified ?? 0;
  const disputedCount = tally.disputed ?? 0;

  if (verifiedCount >= CONSENSUS_QUORUM && verifiedCount > disputedCount) {
    return { reached: true, verdict: 'verified', votes, tally, reason: 'reached' };
  }
  if (disputedCount >= CONSENSUS_QUORUM && disputedCount > verifiedCount) {
    return { reached: true, verdict: 'disputed', votes, tally, reason: 'reached' };
  }

  // Fewer than quorum agree, or a tie → no correctness signal.
  return {
    reached: false,
    verdict: null,
    votes,
    tally,
    reason: votes.length < PANEL_SIZE ? 'insufficient_votes' : 'no_majority',
  };
}

/** Fetch all votes cast for a claim from peer_verification_votes. */
export async function fetchVotes(sourceResponseId: string): Promise<PanelVote[]> {
  const rows = await pgQuery<{
    verifier_agent_id: string;
    verifier_agent_name: string | null;
    provider: string | null;
    verdict: PanelVerdict;
  }>(
    `SELECT verifier_agent_id, verifier_agent_name, provider, verdict
       FROM peer_verification_votes
      WHERE source_response_id = $1::uuid
      ORDER BY created_at ASC`,
    [sourceResponseId],
    { label: 'panel-fetch-votes' }
  );
  return rows;
}

export interface ResolveInput {
  sourceResponseId: string;
  producerAgentId: string;
  /** valid uuid — used for repid_score_events.contract_id (a uuid column) */
  contractId: string;
  claimText?: string | null;
  certaintyAtClaim?: number | null;
  /** when true, do NOT call applyValidationEvent — just compute + return (dry-run) */
  dryRun?: boolean;
}

export interface ResolveResult {
  consensus: ConsensusResult;
  scored: boolean;
  /** planned or applied score events (agent_id, event_type, delta, role) */
  scoreEvents: Array<{
    agent_id: string;
    role: 'producer' | 'verifier';
    event_type: 'VALIDATION_PASSED' | 'VALIDATION_FAILED' | 'VALIDATOR_REWARD' | 'VALIDATOR_PENALTY';
    delta: number;
    agreed?: boolean;
  }>;
}

/**
 * Resolve a claim: fetch votes, compute the 2-of-3 majority, and (unless dryRun)
 * emit HONEST score events through applyValidationEvent.
 *
 * Producer:  verified → VALIDATION_PASSED (+); disputed → VALIDATION_FAILED (−).
 * Verifiers: agreed-with-consensus → VALIDATOR_REWARD (+); diverged →
 *            VALIDATOR_PENALTY = PEER_VERIFY_WRONG_CALL (−5). Timeout votes are
 *            neither rewarded nor penalized (no signal, no score).
 * No consensus / tie / all-timeout → nobody is scored (score 0).
 */
export async function resolvePanel(input: ResolveInput): Promise<ResolveResult> {
  const votes = await fetchVotes(input.sourceResponseId);
  const consensus = computeConsensus(votes);

  const scoreEvents: ResolveResult['scoreEvents'] = [];

  if (!consensus.reached || consensus.verdict === null) {
    // No correctness signal → score 0 for everyone. Nothing to emit.
    return { consensus, scored: false, scoreEvents };
  }

  const consensusVerdict = consensus.verdict;

  // ----- Producer (scored per consensus verdict) ---------------------------
  const producerEventType =
    consensusVerdict === 'verified' ? 'VALIDATION_PASSED' : 'VALIDATION_FAILED';
  const producerDelta =
    consensusVerdict === 'verified'
      ? PANEL_PRODUCER_VERIFIED_DELTA
      : PANEL_PRODUCER_DISPUTED_DELTA;
  if (producerDelta !== 0) {
    scoreEvents.push({
      agent_id: input.producerAgentId,
      role: 'producer',
      event_type: producerEventType,
      delta: producerDelta,
    });
  }

  // ----- Verifiers (agree → reward, diverge → wrong-call penalty) ----------
  for (const v of votes) {
    if (v.verdict === 'timeout') continue; // no signal → no score
    const agreed = v.verdict === consensusVerdict;
    scoreEvents.push({
      agent_id: v.verifier_agent_id,
      role: 'verifier',
      event_type: agreed ? 'VALIDATOR_REWARD' : 'VALIDATOR_PENALTY',
      delta: agreed ? PANEL_AGREE_DELTA : PANEL_DIVERGE_DELTA,
      agreed,
    });
  }

  if (input.dryRun) {
    return { consensus, scored: false, scoreEvents };
  }

  // ----- Emit honestly via applyValidationEvent ----------------------------
  // metadata.contract_id MUST be a valid uuid (repid_score_events.contract_id
  // is a uuid column). Caller passes a real/synthetic uuid.
  const baseMeta = {
    contract_id: input.contractId,
    source_response_id: input.sourceResponseId,
    panel: 'blind_2of3',
    consensus_verdict: consensusVerdict,
    tally: consensus.tally,
    claim: input.claimText ?? null,
    certainty_at_claim: input.certaintyAtClaim ?? null,
  };

  for (const ev of scoreEvents) {
    await applyValidationEvent(ev.agent_id, ev.event_type, ev.delta, {
      ...baseMeta,
      role: ev.role,
      agreed_with_consensus: ev.role === 'verifier' ? ev.agreed : undefined,
    });
  }

  return { consensus, scored: true, scoreEvents };
}
