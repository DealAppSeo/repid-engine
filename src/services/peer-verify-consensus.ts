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
  /** how many distinct verifiers the reader ASSIGNED to this queue row (set by resolvePanel) */
  assigned?: number;
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

/**
 * NO-MAJORITY CLOSE — a full panel that cannot reach 2-of-3 is FINISHED, not pending.
 *
 * [V 2026-10-14] 4 of the 7 real panels (queue 142077, 142080, 142081, 142083) received all
 * three ballots with no majority (3x timeout, or disputed + 2x timeout) and sat in `in_review`
 * for good. The route answered the last voter "202, wait for more votes", but no further vote
 * can arrive: one ballot per verifier (UNIQUE + ON CONFLICT DO NOTHING), and the reader stops
 * re-issuing ballots after PEER_VERIFY_RECLAIM_CAP. Nothing else ever closed them.
 *
 * STATUS 'timeout', NOT 'disputed' — deliberately. `compute_self_certainty()` (prod, read
 * 2026-10-14) computes the PRODUCER's peer_rate as verified / (verified + disputed) over its
 * queue rows, and `peer_verify_reward_multiplier()` counts the same two statuses. Closing a
 * no-majority row as 'disputed' would book it as a LOSS against the producer, which is a
 * correctness signal this panel did not produce. 'timeout' is CHECK-allowed and terminal. It
 * already means "the verifiers could not settle it" (41,495 rows), and neither function counts
 * it. No score event is emitted on this path either: no consensus means score 0 for everyone,
 * and it is never a pass.
 *
 * The tally and every ballot go into `closure_reason`, the queue's only free-text column (it has
 * no result/metadata column). The ballots themselves stay in peer_verification_votes.
 *
 * FLAG PANEL_CLOSE_NO_MAJORITY: 'enforce' closes the row. Anything else, including unset, is
 * SHADOW: it logs what WOULD close and writes nothing, so deploying this changes nothing until
 * the flag is set.
 */
export const NO_MAJORITY_CLOSE_STATUS = 'timeout';

export function panelNoMajorityMode(): 'shadow' | 'enforce' {
  return (process.env.PANEL_CLOSE_NO_MAJORITY || '').trim().toLowerCase() === 'enforce' ? 'enforce' : 'shadow';
}

/**
 * The panel is the verifiers the reader ASSIGNED to this queue row — not every identity whose
 * ballot the insert accepted. XC1 (PR #1366 review): POST /respond takes a ballot from any
 * repid_agents row that passes the HMAC, so counting every row under the claim lets an extra
 * identity complete (or swing) a panel. The reader writes one trinity_tasks row per assigned
 * verifier, carrying metadata.peer_verification_queue_id; that is the authority.
 *
 * Bounded so it stays on indexes (agent_assigned + created_at BitmapAnd, ~43 ms measured on prod
 * for queue 142077, vs a statement timeout without the bounds): panel tasks are created after
 * their queue row, and the reader only assigns names from PANEL_VERIFIER_POOL. A name outside the
 * pool would be missed — which can only keep a row OPEN, never close it.
 *
 * Params: $1 = queue id, $2 = PANEL_VERIFIER_POOL.
 */
const ASSIGNED_PANEL_CTE = `
  assigned AS (
    SELECT DISTINCT t.agent_assigned::text AS name
      FROM peer_verification_queue pq
      JOIN trinity_tasks t
        ON t.created_at >= pq.created_at
       AND t.agent_assigned = ANY($2::text[])
       AND t.task_type = 'peer_verify'
       AND t.metadata->>'panel' = 'blind_2of3'
       AND t.metadata->>'peer_verification_queue_id' = pq.id::text
     WHERE pq.id = $1
  )`;

/**
 * All PANEL_SIZE assigned verifiers have a ballot in and none reached 2-of-3. Fewer = still waiting.
 * A panel the reader assigned fewer than PANEL_SIZE verifiers is never closed here.
 */
export function isNoMajorityFinal(c: ConsensusResult): boolean {
  const assigned = c.assigned ?? 0;
  return !c.reached && assigned >= PANEL_SIZE && c.votes.length >= assigned;
}

export function noMajorityClosureReason(c: ConsensusResult): string {
  const tally = `verified=${c.tally.verified ?? 0} disputed=${c.tally.disputed ?? 0} timeout=${c.tally.timeout ?? 0}`;
  const ballots = c.votes.map((v) => `${v.verifier_agent_name ?? v.verifier_agent_id}:${v.verdict}`).join(', ');
  return `panel_no_majority(${c.reason}) ${tally} | ${ballots}`;
}

/** Ballot COUNTS only. Safe to return over HTTP: no verifier names, no per-verifier verdicts. */
export interface PanelTally {
  verified: number;
  disputed: number;
  timeout: number;
}

export interface NoMajorityCloseResult {
  mode: 'shadow' | 'enforce';
  /** true only when enforce mode actually moved the row out of pending/in_review */
  closed: boolean;
  status: typeof NO_MAJORITY_CLOSE_STATUS;
  tally: PanelTally;
}

const countsOf = (c: ConsensusResult): PanelTally => ({
  verified: c.tally.verified ?? 0,
  disputed: c.tally.disputed ?? 0,
  timeout: c.tally.timeout ?? 0,
});

/**
 * Close (enforce) or report (shadow) a finished no-majority panel. NEVER scores. Returns null
 * when the snapshot is not a finished no-majority panel, so a caller cannot close a live one.
 *
 * Enforce is ONE statement that re-reads the assigned ballots and changes status only if, at that
 * moment, every assigned verifier is in and none of the verdicts is a 2-of-3 majority. The
 * caller's snapshot is never trusted for the write, and closure_reason is built from the re-read.
 * A row another path already finished (panel_resolved, verified, ...) is not touched, so a
 * majority that closed first wins.
 *
 * closure_reason (DB) keeps verifier names. The return value — which the route sends over HTTP —
 * carries counts only.
 */
export async function closeNoMajorityPanel(
  queueId: number | string,
  c: ConsensusResult,
): Promise<NoMajorityCloseResult | null> {
  if (!isNoMajorityFinal(c)) return null;
  const mode = panelNoMajorityMode();

  if (mode !== 'enforce') {
    console.warn(
      `[peer-verify/panel] SHADOW (PANEL_CLOSE_NO_MAJORITY is not 'enforce'): queue ${queueId} WOULD close as ` +
        `'${NO_MAJORITY_CLOSE_STATUS}' — ${noMajorityClosureReason(c)}. Left in_review; set PANEL_CLOSE_NO_MAJORITY=enforce to close.`,
    );
    return { mode, closed: false, status: NO_MAJORITY_CLOSE_STATUS, tally: countsOf(c) };
  }

  const rows = await pgQuery<{ id: number | string; verified: number; disputed: number; timeout: number; closure_reason: string }>(
    `WITH ${ASSIGNED_PANEL_CTE},
     ballots AS (
       SELECT DISTINCT ON (a.name) a.name, v.verdict
         FROM assigned a
         JOIN peer_verification_votes v
           ON v.queue_id = $1
          AND v.verifier_agent_name = a.name
        ORDER BY a.name, v.created_at ASC
     ),
     t AS (
       SELECT (SELECT count(*) FROM assigned)                  AS n_assigned,
              count(*)                                         AS n_in,
              count(*) FILTER (WHERE verdict = 'verified')     AS ver,
              count(*) FILTER (WHERE verdict = 'disputed')     AS dis,
              count(*) FILTER (WHERE verdict = 'timeout')      AS tmo,
              string_agg(name || ':' || verdict, ', ' ORDER BY name) AS who
         FROM ballots
     )
     UPDATE peer_verification_queue q
        SET verification_status = $3,
            completed_at = now(),
            closure_reason = format('panel_no_majority(%s) verified=%s disputed=%s timeout=%s | %s',
                                    CASE WHEN t.ver + t.dis = 0 THEN 'all_timeout' ELSE 'no_majority' END,
                                    t.ver, t.dis, t.tmo, t.who)
       FROM t
      WHERE q.id = $1
        AND q.verification_status IN ('pending','in_review')
        AND t.n_assigned >= $4
        AND t.n_in = t.n_assigned
        AND NOT ((t.ver >= $5 AND t.ver > t.dis) OR (t.dis >= $5 AND t.dis > t.ver))
      RETURNING q.id, t.ver::int AS verified, t.dis::int AS disputed, t.tmo::int AS timeout, q.closure_reason`,
    [queueId, [...PANEL_VERIFIER_POOL], NO_MAJORITY_CLOSE_STATUS, PANEL_SIZE, CONSENSUS_QUORUM],
    { label: 'panel-close-no-majority' },
  );
  const row = rows[0];
  console.warn(
    row
      ? `[peer-verify/panel] queue ${queueId} CLOSED as '${NO_MAJORITY_CLOSE_STATUS}' — ${row.closure_reason}. Not scored.`
      : `[peer-verify/panel] queue ${queueId} NOT closed: already finished, or the assigned ballots no longer show a ` +
          'full no-majority panel (re-read at write time). Not scored.',
  );
  return {
    mode,
    closed: !!row,
    status: NO_MAJORITY_CLOSE_STATUS,
    tally: row ? { verified: row.verified, disputed: row.disputed, timeout: row.timeout } : countsOf(c),
  };
}

/** Keep only ballots from assigned verifiers, first ballot per verifier. Extra identities are ignored. */
export function assignedBallots(assigned: readonly string[], ballots: PanelVote[]): PanelVote[] {
  const seen = new Set<string>();
  const out: PanelVote[] = [];
  for (const b of ballots) {
    const name = b.verifier_agent_name ?? '';
    if (!assigned.includes(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(b);
  }
  return out;
}

/**
 * The assigned panel for a queue row, and that panel's ballots. Keyed by queue_id — not by
 * source_response_id, which two queue rows could share.
 */
export async function fetchPanelVotes(queueId: number | string): Promise<{ assigned: string[]; votes: PanelVote[] }> {
  const rows = await pgQuery<{ assigned: string[] | null; ballots: PanelVote[] | null }>(
    `WITH ${ASSIGNED_PANEL_CTE}
     SELECT (SELECT coalesce(array_agg(name ORDER BY name), '{}') FROM assigned) AS assigned,
            (SELECT coalesce(json_agg(json_build_object(
                       'verifier_agent_id', v.verifier_agent_id,
                       'verifier_agent_name', v.verifier_agent_name,
                       'provider', v.provider,
                       'verdict', v.verdict) ORDER BY v.created_at), '[]'::json)
               FROM peer_verification_votes v
              WHERE v.queue_id = $1) AS ballots`,
    [queueId, [...PANEL_VERIFIER_POOL]],
    { label: 'panel-fetch-votes' }
  );
  const assigned = rows[0]?.assigned ?? [];
  return { assigned, votes: assignedBallots(assigned, rows[0]?.ballots ?? []) };
}

export interface ResolveInput {
  /** the peer_verification_queue row; the panel and its ballots are keyed by it */
  queueId: number | string;
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
  const { assigned, votes } = await fetchPanelVotes(input.queueId);
  const consensus: ConsensusResult = { ...computeConsensus(votes), assigned: assigned.length };

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
