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
import { randomUUID } from 'crypto';
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
     LIMIT 10
  )`;

/**
 * Fast-fail options for the panel lookups. direct-pg's default is five attempts at 10 s each with
 * backoff up to 256 s (XC1 round 2); a ballot request must not hang on that. One attempt, 2 s.
 * A failure throws, and every caller leaves the queue row untouched and unscored.
 */
export const PANEL_LOOKUP_OPTS = { retries: 1, timeoutMs: 2000 } as const;

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
    { label: 'panel-close-no-majority', ...PANEL_LOOKUP_OPTS },
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

/**
 * PEER_VERIFY_ASSIGNED_ONLY — which ballots the MAJORITY (scoring) path counts.
 *   'enforce' (default, = what #1366 deployed): only the verifiers the reader assigned.
 *   'off': every verifier's first ballot on the queue row (the rollback lever).
 * The no-majority close is assigned-only in both modes: its single statement re-reads the
 * assigned panel in SQL, which is what makes that write safe.
 */
export function peerVerifyAssignedOnlyMode(): 'enforce' | 'off' {
  return (process.env.PEER_VERIFY_ASSIGNED_ONLY || '').trim().toLowerCase() === 'off' ? 'off' : 'enforce';
}

/** One line for boot: every panel switch and its resolved value. */
export function panelModesBootLine(): string {
  return (
    `[peer-verify/panel] PEER_VERIFY_PANEL_ENABLED=${peerVerifyPanelEnabled()} ` +
    `PEER_VERIFY_ASSIGNED_ONLY=${peerVerifyAssignedOnlyMode()} PANEL_CLOSE_NO_MAJORITY=${panelNoMajorityMode()}`
  );
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
export async function fetchPanelVotes(
  queueId: number | string,
): Promise<{ assigned: string[]; votes: PanelVote[]; allBallots: PanelVote[] }> {
  const rows = await pgQuery<{ assigned: string[] | null; ballots: PanelVote[] | null }>(
    `WITH ${ASSIGNED_PANEL_CTE}
     SELECT (SELECT coalesce(array_agg(name ORDER BY name), '{}') FROM assigned) AS assigned,
            (SELECT coalesce(json_agg(json_build_object(
                       'verifier_agent_id', v.verifier_agent_id,
                       'verifier_agent_name', v.verifier_agent_name,
                       'provider', v.provider,
                       'verdict', v.verdict) ORDER BY v.created_at), '[]'::json)
               FROM (SELECT * FROM peer_verification_votes
                      WHERE queue_id = $1
                      ORDER BY created_at ASC
                      LIMIT 50) v) AS ballots`,
    [queueId, [...PANEL_VERIFIER_POOL]],
    { label: 'panel-fetch-votes', ...PANEL_LOOKUP_OPTS }
  );
  const assigned = rows[0]?.assigned ?? [];
  const allBallots = rows[0]?.ballots ?? [];
  return { assigned, votes: assignedBallots(assigned, allBallots), allBallots };
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
  const fetched = await fetchPanelVotes(input.queueId);
  const assigned = fetched.assigned;
  const votes = peerVerifyAssignedOnlyMode() === 'off'
    ? assignedBallots([...new Set(fetched.allBallots.map((b) => b.verifier_agent_name ?? ''))], fetched.allBallots)
    : fetched.votes;
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

  await applyPanelScoreEvents(input, consensus, scoreEvents);
  return { consensus, scored: true, scoreEvents };
}

/** Thrown when scoring stops part-way; `applied` says how many events were written first. */
export class PanelScoreError extends Error {
  constructor(message: string, readonly applied: number, readonly total: number) {
    super(message);
    this.name = 'PanelScoreError';
  }
}

/**
 * Apply already-computed panel score events, in order, through applyValidationEvent. Does NO
 * lookup: the caller passes the events it computed from the same assigned-ballot read it
 * resolved consensus on. Throws PanelScoreError with the count applied before the failure.
 */
export async function applyPanelScoreEvents(
  input: Pick<ResolveInput, 'contractId' | 'sourceResponseId' | 'claimText' | 'certaintyAtClaim'>,
  consensus: ConsensusResult,
  scoreEvents: ResolveResult['scoreEvents'],
  closeToken?: string,
): Promise<number> {
  // metadata.contract_id MUST be a valid uuid (repid_score_events.contract_id is a uuid column).
  const baseMeta = {
    contract_id: input.contractId,
    source_response_id: input.sourceResponseId,
    panel: 'blind_2of3',
    consensus_verdict: consensus.verdict,
    tally: consensus.tally,
    claim: input.claimText ?? null,
    certainty_at_claim: input.certaintyAtClaim ?? null,
    // Lets panelScoreEventsWritten() count what THIS close wrote, from the DB, after a failure.
    ...(closeToken ? { panel_close_token: closeToken } : {}),
  };
  let applied = 0;
  for (const ev of scoreEvents) {
    try {
      await applyValidationEvent(ev.agent_id, ev.event_type, ev.delta, {
        ...baseMeta,
        role: ev.role,
        agreed_with_consensus: ev.role === 'verifier' ? ev.agreed : undefined,
      });
    } catch (e: any) {
      throw new PanelScoreError(String(e?.message ?? e), applied, scoreEvents.length);
    }
    applied++;
  }
  return applied;
}

// ============================================================================
// MAJORITY CLOSE WITH A TOKEN (XC1, PR #1375 review)
// ----------------------------------------------------------------------------
// pgQuery's timeout does not cancel the statement, and a write that "timed out" may have
// committed. So: every write below runs ONCE (pgQuery's default for writes), carries a token
// unique to this request in closure_reason, and when it throws we RE-READ the row to learn
// whether our token landed. A 0-row result is never read as success, and the reopen can only
// revert the close that carries its own token — never a later, legitimately scored one.
// ============================================================================

const CLOSE_TOKEN_PREFIX = 'panel_resolved close_token=';

export function newPanelCloseToken(): string {
  return `${CLOSE_TOKEN_PREFIX}${randomUUID()}`;
}

async function closureReasonOf(queueId: number | string): Promise<{ status: string; closure_reason: string | null } | null> {
  const rows = await pgQuery<{ verification_status: string; closure_reason: string | null }>(
    `SELECT verification_status, closure_reason FROM peer_verification_queue WHERE id = $1`,
    [queueId],
    { label: 'panel-close-reread', ...PANEL_LOOKUP_OPTS },
  );
  return rows[0] ? { status: rows[0].verification_status, closure_reason: rows[0].closure_reason } : null;
}

/**
 * Close the row as panel_resolved, stamped with `token`. 'won' = this request closed it; 'lost' =
 * someone else had. If the UPDATE throws, the row is re-read: our token there means it committed.
 * If even the re-read fails, this throws — the outcome is unknown and the caller must not score.
 */
export async function closePanelWithToken(queueId: number | string, token: string): Promise<'won' | 'lost'> {
  try {
    const rows = await pgQuery<{ id: number | string }>(
      `UPDATE peer_verification_queue
          SET verification_status = 'panel_resolved',
              completed_at = now(),
              closure_reason = $2
        WHERE id = $1
          AND verification_status IN ('pending','in_review')
        RETURNING id`,
      [queueId, token],
      { label: 'panel-close-queue' },
    );
    return rows.length > 0 ? 'won' : 'lost';
  } catch (e) {
    const now = await closureReasonOf(queueId);
    if (now && now.closure_reason === token) return 'won';
    if (now && !['pending', 'in_review'].includes(now.status)) return 'lost';
    throw e; // still open and not ours: the close did not happen; surface the error
  }
}

/** How many repid_score_events this close actually wrote (by the token stamped in their metadata). */
export async function panelScoreEventsWritten(contractId: string, token: string): Promise<number> {
  const rows = await pgQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM repid_score_events
      WHERE contract_id = $1::uuid
        AND metadata->>'panel_close_token' = $2`,
    [contractId, token],
    { label: 'panel-score-events-written', ...PANEL_LOOKUP_OPTS },
  );
  return rows[0]?.n ?? 0;
}

/**
 * Reopen ONLY the close this request made (its token), back to in_review. One attempt; if it
 * throws, re-read. 'reopened' | 'not-ours' (the row no longer carries our token).
 */
export async function reopenOwnPanelClose(queueId: number | string, token: string): Promise<'reopened' | 'not-ours'> {
  try {
    const rows = await pgQuery<{ id: number | string }>(
      `UPDATE peer_verification_queue
          SET verification_status = 'in_review',
              completed_at = NULL,
              closure_reason = NULL
        WHERE id = $1
          AND verification_status = 'panel_resolved'
          AND closure_reason = $2
        RETURNING id`,
      [queueId, token],
      { label: 'panel-reopen-unscored' },
    );
    return rows.length > 0 ? 'reopened' : 'not-ours';
  } catch (e) {
    // Ambiguous: the reopen may have committed. Only this request ever clears its own token,
    // so the token gone + the row back in_review means it did.
    const now = await closureReasonOf(queueId);
    if (now && now.closure_reason === token) throw e;
    return now && now.status === 'in_review' && now.closure_reason === null ? 'reopened' : 'not-ours';
  }
}
