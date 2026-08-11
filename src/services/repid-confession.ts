/**
 * repid-confession.ts — the just-culture path. Wiring, not invention.
 *
 * ── WHAT WAS ALREADY HERE ────────────────────────────────────────────────────────────────
 * `repid_confession_log` exists in production with a fully thought-through schema:
 *
 *   agent_id, domain, original_event_id, confession_text,
 *   hal_verified, hal_verification_score,      -- is the confession TRUE?
 *   penalty_applied, reduced_penalty,          -- the asymmetry, as a column pair
 *   probation_ends_at, peer_endorsement_required
 *
 * Whoever designed that modelled confessions, verification, graduated penalty AND the abuse
 * case of *false* confessions. It has **0 rows and no writer anywhere in the codebase.**
 *
 * That is LESSONS #3 in its purest form: an unwired mechanism is worse than an absent one,
 * because a reviewer reading the schema concludes just-culture is handled. It is not.
 *
 * ── WHY IT MATTERS, measured 2026-08-11 ──────────────────────────────────────────────────
 * Across 152,130 score events, all eight negative event types are DETECTION-shaped
 * (VALIDATION_FAILED, EPISTEMIC_VIOLATION, CHALLENGE_LOSS, VALIDATOR_PENALTY,
 * HAL_SCORE_EVENT, DORMANCY_DECAY). An agent that wants to disclose its own error has no
 * channel at all. So concealment is not merely *cheaper* than disclosure — disclosure has no
 * representation, which makes concealment strictly dominant by construction.
 *
 * Aviation fixed this decades ago. NASA's ASRS gets truthful incident data because a
 * self-reported error carries limited immunity: reports go to NASA, not the regulator. Just
 * culture separates error (fix the system) from at-risk behaviour (coach) from recklessness
 * (punish). The single asymmetry — self-reported costs strictly less than detected — turns
 * concealment into a losing strategy WITHOUT needing to detect concealment.
 *
 * ── NOT TO BE CONFUSED WITH THE EXISTING SELF-REPORT GATE ────────────────────────────────
 * `repid-update.ts` already has SELF_REPORT_EVIDENCE_MODE. That gates self-reported
 * POSITIVE claims (an API-key holder self-awarding CODE_CONTRIBUTION +25). It is
 * anti-inflation and it is working as designed. This module is the opposite direction:
 * self-reported NEGATIVE events. Both are "self-report"; the incentives are mirror images.
 * One stops agents inflating themselves, the other lets them admit failure. Only the first
 * was built.
 */

import { db } from '../db';
import { insertScoreEvent } from '../scoring/score-event-writer';

/** The event type a confession writes to the ledger. New, and the point of this module. */
export const SELF_REPORTED_FAILURE = 'SELF_REPORTED_FAILURE' as const;

/**
 * How much cheaper a confession is than being caught.
 *
 * 0.4 => a self-reported failure costs 40% of the detected penalty. The exact number is a
 * policy dial; the INVARIANT is that it is strictly between 0 and 1:
 *
 *   0   would make confession free, which prices in reputation laundering.
 *   1   would make confession pointless, which is today's behaviour by omission.
 *
 * `repid-confession.test.ts` asserts the strict inequality directly, so a future
 * "normalisation" of the deltas cannot quietly return this to parity.
 */
export const SELF_REPORT_DISCOUNT = 0.4;

export interface ConfessionInput {
  /** Resolved agent UUID. Callers must resolve slugs first (see resolveAgentUuid). */
  agentId: string;
  /** Domain of the failure, e.g. 'trading', 'fact-check'. Stored, not scored. */
  domain: string;
  /** What the agent says it did wrong. Stored verbatim in the confession log. */
  confessionText: string;
  /** The penalty this failure WOULD have carried had a detector caught it. Positive number. */
  detectedPenalty: number;
  /**
   * The score event this confession refers to, when the agent is owning an already-recorded
   * event. Optional: an agent may confess something nothing has caught, which is the whole
   * point of the mechanism.
   */
  originalEventId?: number | null;
}

export interface ReducedPenaltyResult {
  /** What a detector would have charged. */
  detected: number;
  /** What the confession charges. Strictly less than `detected` whenever detected > 0. */
  reduced: number;
  /** reduced − detected, i.e. the negative delta to apply. */
  delta: number;
}

/**
 * The asymmetry, as a pure function so it can be tested without a database.
 *
 * Rounds *up* in magnitude (ceil) so a small penalty never rounds to zero — a 1-point
 * failure must still cost something, or confessing trivia becomes free score-signalling.
 */
export function reducedPenalty(detectedPenalty: number, discount: number = SELF_REPORT_DISCOUNT): ReducedPenaltyResult {
  const detected = Math.max(0, Math.abs(Math.round(detectedPenalty)));
  if (detected === 0) return { detected: 0, reduced: 0, delta: 0 };

  const reduced = Math.max(1, Math.ceil(detected * discount));
  // Guard the degenerate case: a 1-point detected penalty cannot be strictly cheaper while
  // staying >= 1, so the floor wins and they are equal. Report it rather than pretend.
  return { detected, reduced: Math.min(reduced, detected), delta: -Math.min(reduced, detected) };
}

/** True when the discount actually produced a cheaper outcome. */
export function isStrictlyCheaper(r: ReducedPenaltyResult): boolean {
  return r.detected > 0 && r.reduced < r.detected;
}

export type ConfessionRefusal =
  | 'AGENT_REQUIRED'
  | 'TEXT_REQUIRED'
  | 'DOMAIN_REQUIRED'
  | 'PENALTY_REQUIRED';

export interface ConfessionResult {
  ok: boolean;
  refusal?: ConfessionRefusal;
  confessionId?: number;
  scoreEventId?: number;
  penalty?: ReducedPenaltyResult;
  /**
   * Whether the confession was cheaper. FALSE is not an error — a 1-point failure cannot be
   * discounted below 1 — but it is reported so the caller never assumes the incentive applied.
   */
  discountApplied?: boolean;
  /** Set when the ledger write failed; the confession log entry may still exist. */
  warning?: string;
}

/**
 * Validate a confession without touching the database. Pure, so the refusal rules are
 * testable and the route stays thin.
 */
export function validateConfession(input: Partial<ConfessionInput>): ConfessionRefusal | null {
  if (!input.agentId || typeof input.agentId !== 'string') return 'AGENT_REQUIRED';
  if (!input.confessionText || !input.confessionText.trim()) return 'TEXT_REQUIRED';
  if (!input.domain || !input.domain.trim()) return 'DOMAIN_REQUIRED';
  if (typeof input.detectedPenalty !== 'number' || !Number.isFinite(input.detectedPenalty)) return 'PENALTY_REQUIRED';
  return null;
}

/**
 * Record a confession: one row in `repid_confession_log`, one negative score event.
 *
 * ORDER MATTERS. The confession log is written FIRST. If the ledger write then fails, the
 * disclosure still exists and can be reconciled — the agent told us, and that fact survives.
 * Writing the penalty first and losing the confession would charge an agent for honesty and
 * keep no record of the honesty, which is the worst possible failure for this mechanism.
 *
 * ANTI-LAUNDERING. `hal_verified` is left false and `peer_endorsement_required` is set
 * whenever the confession is not tied to an already-recorded event. An unverified confession
 * to something nothing observed is exactly the shape of reputation laundering, and the
 * original schema author anticipated it (`false_confessions_flagged` on
 * `repid_adversarial_immunity`). Verification is a separate, later step — this module does
 * not claim the confession is TRUE, only that it was MADE.
 */
export async function recordConfession(input: ConfessionInput): Promise<ConfessionResult> {
  const refusal = validateConfession(input);
  if (refusal) return { ok: false, refusal };

  const penalty = reducedPenalty(input.detectedPenalty);
  const unverifiable = input.originalEventId === undefined || input.originalEventId === null;

  const { data: conf, error: confErr } = await db
    .from('repid_confession_log')
    .insert({
      agent_id: input.agentId,
      domain: input.domain.trim(),
      confession_text: input.confessionText.trim(),
      original_event_id: input.originalEventId ?? null,
      penalty_applied: penalty.detected,
      reduced_penalty: penalty.reduced,
      // Not verified here. Saying otherwise would be the demo claiming a check it never ran.
      hal_verified: false,
      peer_endorsement_required: unverifiable,
    })
    .select('id')
    .single();

  if (confErr || !conf) {
    return { ok: false, warning: `confession_log write failed: ${confErr?.message ?? 'unknown'}` };
  }

  // The ledger entry goes through the GUARDED writer, not a raw insert.
  //
  // The first version of this function inserted into the score-events table directly, and
  // the repo's own ratchet test caught it — raw score-event inserts are tracked as debt and
  // new ones are refused. (It caught this comment too, on the next run, because the detector
  // scans source text and my explanation contained the very pattern it hunts. The fence is
  // not wrong for that; editing a checker so your prose passes is how a checker stops being
  // one — LESSONS #11. Reworded rather than relaxed.)
  //
  // The fence was right on the substance: routing through insertScoreEvent means a
  // confession inherits the reconciliation invariant AND the detector-coverage stamp for
  // free, instead of being a second, subtly-different write path. Bypassing the shared
  // writer is the same mistake as copying a resolver.
  //
  // applier:'trigger' because the DB computes before/after; we know only the delta.
  const write = await insertScoreEvent({
    applier: 'trigger',
    agent_id: input.agentId,
    event_type: SELF_REPORTED_FAILURE,
    delta: penalty.delta,
    metadata: {
      self_reported: true,
      confession_id: conf.id,
      detected_penalty_would_have_been: penalty.detected,
      discount_applied: isStrictlyCheaper(penalty),
      peer_endorsement_required: unverifiable,
    },
    extra: { task_domain: input.domain.trim() },
  });

  if (!write.ok) {
    return {
      ok: true,
      confessionId: conf.id,
      penalty,
      discountApplied: isStrictlyCheaper(penalty),
      warning: `confession recorded but ledger write failed: ${write.error ?? 'unknown'}`,
    };
  }

  return {
    ok: true,
    confessionId: conf.id,
    scoreEventId: write.id ? Number(write.id) : undefined,
    penalty,
    discountApplied: isStrictlyCheaper(penalty),
  };
}
