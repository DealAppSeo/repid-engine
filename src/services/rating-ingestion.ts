/**
 * rating-ingestion.ts — TrustMarket rating ingestion, un-gameable by construction.
 *
 * A rating is a counterparty's verdict on an agent's outcome at one of three
 * stages (the three-touchpoint model): the transaction SETTLED, the work met the
 * SPEC, and the result was RETAINED after a hold period (the deepest signal).
 *
 * The property that makes ratings worth anything is that you cannot rate a
 * transaction that did not happen, was not authorised, or was not yours. That is
 * enforced here, not by trusting the client, but by anchoring every rating to a
 * real outcome the SERVER already holds:
 *
 *   - the outcome must EXIST (looked up server-side, never supplied by the rater);
 *   - its dual-auth gate decision must have been ALLOW — you cannot rate an
 *     interaction the gate refused, because no authorised deliverable exists to rate;
 *   - it must be ABOUT the agent being rated;
 *   - the rater must be the COUNTERPARTY the server recorded, not a drive-by;
 *   - a rater cannot rate themselves;
 *   - the rating is bound to the outcome's committed FOLD ROOT, so it is provably
 *     tied to one specific, recomputable economic event.
 *
 * The admission logic is PURE over (submission, server-looked-up context), so a
 * reviewer can reproduce every accept/reject decision without a database.
 */

import type { Decision } from './dual-auth-gate';

export enum RatingStage {
  /** T1 — the x402 settlement cleared. */
  SETTLED = 'settled',
  /** T2 — the delivered work met the agreed spec. */
  TO_SPEC = 'to_spec',
  /** T3 — the result held up after a hold period (24–72h). Weighted highest. */
  RETAINED = 'retained',
}

export enum RatingVerdict {
  GOOD = 'good',
  OK = 'ok',
  BAD = 'bad',
}

/** What a client submits. Note it does NOT get to assert the outcome's truth. */
export interface RatingSubmission {
  /** The agent being rated. */
  subjectAgentId: string;
  /** Who is rating (a client id / owner sbt / agent id). */
  raterId: string;
  stage: RatingStage;
  verdict: RatingVerdict;
  /** The id of the outcome being rated. The server resolves the rest. */
  outcomeId: string;
  /**
   * Optional: the fold root the rater believes this outcome committed to. If
   * supplied, it must match the server's — a cheap cross-check that catches a
   * rater pointing at outcome A while quoting outcome B's root.
   */
  claimedFoldRoot?: number;
}

/**
 * The truth about an outcome, resolved SERVER-SIDE from persisted records. The
 * rater never supplies these fields; that is the whole point.
 */
export interface OutcomeContext {
  exists: boolean;
  /** The agent the outcome is about. */
  agentId: string | null;
  /** The dual-auth decision recorded for the underlying action. */
  gateDecision: Decision | null;
  /** The committed fold root (Poseidon2/BabyBear), the anchor a rating binds to. */
  foldRoot: number | null;
  /** The counterparty the server recorded — the only party allowed to rate deep stages. */
  counterpartyId: string | null;
}

export type AdmissionReason =
  | 'outcome_not_found'
  | 'outcome_not_authorized'
  | 'subject_mismatch'
  | 'self_rating'
  | 'not_the_counterparty'
  | 'fold_root_mismatch'
  | 'invalid_stage'
  | 'invalid_verdict'
  | 'missing_fields';

export interface AdmittedRating {
  subjectAgentId: string;
  raterId: string;
  stage: RatingStage;
  verdict: RatingVerdict;
  outcomeId: string;
  /** Bound at admission from the SERVER's context, never the client's claim. */
  foldRoot: number;
}

export interface AdmissionResult {
  admitted: boolean;
  /** Present when admitted === false; every failed check, not just the first. */
  reasons: AdmissionReason[];
  /** Present when admitted === true — the normalized row to persist. */
  rating?: AdmittedRating;
  /** Human-readable, safe to return to the caller. */
  explanation: string;
}

const STAGES = new Set<string>(Object.values(RatingStage));
const VERDICTS = new Set<string>(Object.values(RatingVerdict));

/** Stages where only the recorded counterparty may rate (deep, personal signal). */
const COUNTERPARTY_ONLY: ReadonlySet<RatingStage> = new Set([
  RatingStage.TO_SPEC,
  RatingStage.RETAINED,
]);

const MESSAGES: Record<AdmissionReason, string> = {
  outcome_not_found: 'the referenced outcome does not exist',
  outcome_not_authorized: 'the outcome was not gate-authorized (ALLOW), so there is nothing legitimate to rate',
  subject_mismatch: 'the outcome is about a different agent than the one being rated',
  self_rating: 'an agent cannot rate its own outcome',
  not_the_counterparty: 'only the counterparty recorded for this outcome may rate this stage',
  fold_root_mismatch: 'the claimed fold root does not match the outcome the server holds',
  invalid_stage: 'the rating stage is not one of settled | to_spec | retained',
  invalid_verdict: 'the verdict is not one of good | ok | bad',
  missing_fields: 'subjectAgentId, raterId and outcomeId are all required',
};

/**
 * Decide whether a rating may be recorded. PURE — the outcome context is passed
 * in (the route resolves it from the database), so this is fully reproducible.
 */
export function admitRating(
  submission: RatingSubmission,
  ctx: OutcomeContext,
): AdmissionResult {
  const reasons: AdmissionReason[] = [];

  // ── shape ──────────────────────────────────────────────────────────────────
  if (!submission.subjectAgentId || !submission.raterId || !submission.outcomeId) {
    reasons.push('missing_fields');
  }
  if (!STAGES.has(submission.stage)) reasons.push('invalid_stage');
  if (!VERDICTS.has(submission.verdict)) reasons.push('invalid_verdict');

  // ── the outcome must be real and authorized ─────────────────────────────────
  if (!ctx.exists) {
    reasons.push('outcome_not_found');
  } else {
    // A refused (or never-decided) interaction produced no authorised deliverable.
    // Unknown/absent decisions fail closed — an unrecorded ALLOW is not an ALLOW.
    if (ctx.gateDecision !== 'ALLOW') reasons.push('outcome_not_authorized');

    if (ctx.agentId && submission.subjectAgentId && ctx.agentId !== submission.subjectAgentId) {
      reasons.push('subject_mismatch');
    }

    // Deep stages are personal: only the recorded counterparty may speak.
    if (
      STAGES.has(submission.stage) &&
      COUNTERPARTY_ONLY.has(submission.stage as RatingStage) &&
      ctx.counterpartyId &&
      submission.raterId !== ctx.counterpartyId
    ) {
      reasons.push('not_the_counterparty');
    }

    // Cross-check the client's claimed root against the server's, when supplied.
    if (
      typeof submission.claimedFoldRoot === 'number' &&
      ctx.foldRoot !== null &&
      submission.claimedFoldRoot !== ctx.foldRoot
    ) {
      reasons.push('fold_root_mismatch');
    }
  }

  // ── no self-dealing ──────────────────────────────────────────────────────────
  if (submission.subjectAgentId && submission.raterId === submission.subjectAgentId) {
    reasons.push('self_rating');
  }

  if (reasons.length > 0 || ctx.foldRoot === null) {
    // A missing fold root means we cannot bind the rating to a committed event,
    // even if nothing else failed — fail closed rather than record an unanchored rating.
    if (reasons.length === 0) reasons.push('outcome_not_found');
    return {
      admitted: false,
      reasons,
      explanation: `Rating rejected: ${reasons.map((r) => MESSAGES[r]).join('; ')}.`,
    };
  }

  return {
    admitted: true,
    reasons: [],
    rating: {
      subjectAgentId: submission.subjectAgentId,
      raterId: submission.raterId,
      stage: submission.stage as RatingStage,
      verdict: submission.verdict as RatingVerdict,
      outcomeId: submission.outcomeId,
      foldRoot: ctx.foldRoot,
    },
    explanation: 'Rating admitted: anchored to a real, gate-authorized outcome the rater is party to.',
  };
}

/** Stage weights — the retained (T3) signal counts for the most. */
export const STAGE_WEIGHT: Record<RatingStage, number> = {
  [RatingStage.SETTLED]: 1,
  [RatingStage.TO_SPEC]: 2,
  [RatingStage.RETAINED]: 4,
};

/** Verdict values in [-1, 1]. */
export const VERDICT_VALUE: Record<RatingVerdict, number> = {
  [RatingVerdict.GOOD]: 1,
  [RatingVerdict.OK]: 0,
  [RatingVerdict.BAD]: -1,
};

export interface RatingSummary {
  agentId: string;
  count: number;
  byStage: Record<RatingStage, { good: number; ok: number; bad: number }>;
  /**
   * Stage-weighted score in [-1, 1]: sum(weight * verdictValue) / sum(weight).
   * Null when there are no ratings (do not invent a neutral score from nothing).
   */
  weightedScore: number | null;
}

/**
 * Aggregate a set of admitted ratings for one agent. Pure — the caller passes the
 * rows it read. Distinct raters are the caller's responsibility to enforce at
 * write time (a unique index); this function trusts the set it is given.
 */
export function aggregateRatings(agentId: string, ratings: AdmittedRating[]): RatingSummary {
  const byStage: RatingSummary['byStage'] = {
    [RatingStage.SETTLED]: { good: 0, ok: 0, bad: 0 },
    [RatingStage.TO_SPEC]: { good: 0, ok: 0, bad: 0 },
    [RatingStage.RETAINED]: { good: 0, ok: 0, bad: 0 },
  };

  let weightedSum = 0;
  let weightTotal = 0;

  for (const r of ratings) {
    if (r.subjectAgentId !== agentId) continue;
    byStage[r.stage][r.verdict] += 1;
    const w = STAGE_WEIGHT[r.stage];
    weightedSum += w * VERDICT_VALUE[r.verdict];
    weightTotal += w;
  }

  const count = ratings.filter((r) => r.subjectAgentId === agentId).length;

  return {
    agentId,
    count,
    byStage,
    weightedScore: weightTotal > 0 ? weightedSum / weightTotal : null,
  };
}
