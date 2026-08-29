/**
 * RepID PREVIEW — what an action is worth, computed without touching a row.
 *
 * ============================================================================
 * THIS MODULE IMPORTS NOTHING THAT CAN WRITE, AND THAT IS THE DESIGN.
 * ============================================================================
 *
 * The progressive-trust signup (`docs/design/progressive-trust-ladder.v0.md`)
 * decided PREVIEW-ONLY over provisional-and-vesting: a Rung 0 visitor sees what
 * their actions would be worth, and **nothing is persisted** — no
 * `repid_score_events` row, no `current_repid` write. The failure direction
 * decided it. A subtle bug in a vesting path turns the signup into a reputation
 * mint, and the counterparty gate does not cover the band such a farm would sit
 * in (`ESTABLISHED` and `EARNING` have no gate). A leaked write, by contrast, is
 * visible in an append-only log.
 *
 * The obvious implementation — a `dryRun` flag threaded through `updateRepId` —
 * was rejected. That function interleaves the delta computation with a fetch, a
 * decay write, an agent update, an audit-row insert, a supply-rate bump and a
 * badge sweep. One missed write site and a "preview" mutates real reputation,
 * which is precisely the class of defect this codebase keeps rediscovering.
 * So this module imports only `../scoring/repid-deltas`, a file with no imports
 * of its own. It cannot write because there is nothing here to write with, and
 * `tests/repid-preview.test.ts` asserts that by walking the import graph rather
 * than by trusting this paragraph.
 *
 * ---------------------------------------------------------------------------
 * A PREVIEW IS NEVER `MEASURED`.
 * ---------------------------------------------------------------------------
 *
 * Four vocabulary states, and the distinctions are the product:
 *
 *   MEASURED     a named check ran and passed
 *   APPROXIMATE  measured against a documented proxy; always carries its caveat
 *   NOT_CHECKED  nobody looked — an absence, not a warning and not a failure
 *   FAILED       a check ran and did not pass
 *
 * Every delta this module returns is `APPROXIMATE` at best, because the live
 * value depends on four things no pure function can see: the agent's decay from
 * 30-day activity, the ecosystem-need weight, the redemption modifier on
 * negative deltas, and — for the self-reported positives — whether an evidence
 * reference was attached. Following the pattern `src/services/effective-authority.ts`
 * established for `A_eff`, the caveat is carried in the SHAPE (`measurement`,
 * `omits`, `persisted`) rather than in prose beside it, so a consumer that
 * ignores the docs still cannot read a preview as an earned score.
 *
 * Events whose live delta is decided by data this module does not have return
 * `NOT_CHECKED` with `delta: null` — never a plausible-looking number. STAKE is
 * the case worth naming: the tariff says +5 and the live path awards 0, pending
 * a server-side on-chain verifier. A preview that read the table would show +5
 * for an action that earns nothing.
 */

import {
  FIXED_DELTAS,
  REPID_MAX,
  REPID_MIN,
  type RepIdEventType,
} from '../scoring/repid-deltas';

/** A preview is never MEASURED — see the module header. */
export type PreviewVerdict = 'APPROXIMATE' | 'NOT_CHECKED' | 'FAILED';

/**
 * Why an event's live delta cannot be previewed. Each value names the input the
 * preview does not have, so a `NOT_CHECKED` is always traceable to a reason
 * rather than being a shrug.
 */
type NotPreviewableReason =
  | 'scored_from_challenge_inputs'
  | 'scored_from_prediction_inputs'
  | 'gated_on_detection_proof'
  | 'gated_on_onchain_verification';

const NOT_PREVIEWABLE_DETAIL: Record<NotPreviewableReason, string> = {
  scored_from_challenge_inputs:
    'computed by the challenge scorer from the certainty asserted at claim time and the live ecosystem-need weight — neither is known before the event happens',
  scored_from_prediction_inputs:
    'computed by the prediction scorer from the stated probability, the resolved outcome and how long the prediction was open',
  gated_on_detection_proof:
    'the heavy deception tiers require a confirmed, grounded detection; without one the delta collapses to 0, and the shadow/enforce mode then decides whether it is applied at all',
  gated_on_onchain_verification:
    'the tariff lists a positive value but the live path awards nothing for this event until a server-side on-chain verifier exists, so previewing the table value would overstate it',
};

/**
 * Every event class, classified. Exhaustive by type: adding a member to
 * `RepIdEventType` fails to compile here until it is classified, so a new event
 * can never fall through to a silent 0 the way a `?? 0` lookup would let it.
 */
const CLASSIFICATION: Record<
  RepIdEventType,
  { previewable: true } | { previewable: false; reason: NotPreviewableReason }
> = {
  CHALLENGE_WIN: { previewable: false, reason: 'scored_from_challenge_inputs' },
  CHALLENGE_LOSS: { previewable: false, reason: 'scored_from_challenge_inputs' },
  CHALLENGE_DRAW: { previewable: false, reason: 'scored_from_challenge_inputs' },
  EPISTEMIC_VIOLATION: { previewable: false, reason: 'scored_from_challenge_inputs' },
  CONSTITUTIONAL_VIOLATION: { previewable: false, reason: 'scored_from_challenge_inputs' },
  PREDICTION_RESOLVE: { previewable: false, reason: 'scored_from_prediction_inputs' },

  // STAKE is in FIXED_DELTAS at +5 and the live path hard-codes 0. Previewing
  // the tariff here would be the exact overstatement the STAKE stopgap exists
  // to prevent, so it is NOT_CHECKED until a real verifier lands.
  STAKE: { previewable: false, reason: 'gated_on_onchain_verification' },

  GENESIS: { previewable: true },
  REFERRAL: { previewable: true },
  PEACEMAKER: { previewable: true },
  SELF_MONITOR: { previewable: true },
  CODE_CONTRIBUTION: { previewable: true },
  WORKFLOW_CONTRIBUTION: { previewable: true },
  TOOL_PIONEER: { previewable: true },
  AGENT_TEACHING: { previewable: true },
  AUDIT_CONTRIBUTION: { previewable: true },
  HANDOFF_COSIGN_VERIFIED: { previewable: true },
  HANDOFF_COSIGN_FALSE_PASS_SLASH: { previewable: true },
  PEER_VERIFY_WRONG_CALL: { previewable: true },
  UNSUPPORTED_CLAIM: { previewable: true },

  DEFENDED_DECEPTION_DENIAL_OF_PRIOR_OUTPUT: { previewable: false, reason: 'gated_on_detection_proof' },
  DEFENDED_DECEPTION_DOUBT_ATTACK: { previewable: false, reason: 'gated_on_detection_proof' },
  DEFENDED_DECEPTION_FABRICATED_CITATION: { previewable: false, reason: 'gated_on_detection_proof' },
  DEFENDED_DECEPTION_FABRICATED_TOOL_RESULT: { previewable: false, reason: 'gated_on_detection_proof' },
  DEFENDED_DECEPTION_FABRICATED_BENCHMARK: { previewable: false, reason: 'gated_on_detection_proof' },
  DEFENDED_DECEPTION_THRESHOLD_DANCING: { previewable: false, reason: 'gated_on_detection_proof' },
  DEFENDED_DECEPTION_SYCOPHANTIC_FALSE_PREMISE: { previewable: false, reason: 'gated_on_detection_proof' },
  DEFENDED_DECEPTION_STORY_CHANGE: { previewable: false, reason: 'gated_on_detection_proof' },
};

/**
 * The self-reported positives. `updateRepId` can zero any of these when the
 * evidence gate is enforcing and no evidence reference was attached, so their
 * preview carries that contingency explicitly. The gate's mode is deliberately
 * NOT read here: a preview shows the tariff for an action, not a prediction of
 * one caller's outcome, and reading an env var would make this module's answer
 * depend on process state it cannot show the reader.
 */
const CONTINGENT_ON_EVIDENCE = new Set<RepIdEventType>([
  'REFERRAL', 'CODE_CONTRIBUTION', 'PEACEMAKER',
  'WORKFLOW_CONTRIBUTION', 'TOOL_PIONEER', 'SELF_MONITOR',
  'AGENT_TEACHING', 'AUDIT_CONTRIBUTION',
]);

export interface PreviewedEvent {
  eventType: string;
  verdict: PreviewVerdict;
  /** The tariff value. `null` for every verdict except APPROXIMATE — never a stand-in 0. */
  delta: number | null;
  /** Whether the evidence gate can zero this delta when it is enforcing. */
  contingentOnEvidence: boolean;
  /** Why this verdict, in words a caller can show a user. */
  reason: string;
}

export interface RepIdPreview {
  /** Never 'MEASURED'. A preview omits inputs only the database has. */
  measurement: 'APPROXIMATE';
  /** Structural, not decorative: nothing on this path writes. */
  persisted: false;
  baseRepId: number;
  /** Base plus every APPROXIMATE delta, clamped. NOT_CHECKED events contribute nothing. */
  projectedRepId: number;
  /** From the pure score ladder only. See `tierCaveat` — the live tier can be lower. */
  projectedTier: string;
  tierIsCounterpartyGateApproximation: true;
  tierCaveat: string;
  events: PreviewedEvent[];
  /** What a live score change applies that this projection does not. */
  omits: string[];
  disclaimer: string;
}

/**
 * The pure score->tier ladder. Deliberately a local copy rather than an import
 * of `computeTier` from `repid-update.ts`, which would drag `../db` in and break
 * the guarantee this module exists for. `tests/repid-preview.test.ts` pins the
 * two against each other so they cannot drift apart silently.
 *
 * This is NOT the tier the database will produce. The live trigger calls a
 * two-argument overload that additionally demotes `VETERAN` and `AUTONOMOUS`
 * when an agent has fewer than 2 unique counterparties — which is exactly the
 * position a brand-new visitor is in. `tierCaveat` says so in the response.
 */
export function previewTier(repId: number): string {
  if (repId >= 8000) return 'VETERAN';
  if (repId >= 5000) return 'AUTONOMOUS';
  if (repId >= 1000) return 'ESTABLISHED';
  if (repId >= 500) return 'EARNING';
  return 'PROBATIONARY';
}

const TIER_CAVEAT =
  'Score-ladder tier only. The database derives the real tier from a trigger that also demotes AUTONOMOUS and VETERAN below 2 unique counterparties, so a previewed top tier is not reachable by score alone.';

const OMITS = [
  'decay — the live path decays the current score against 30-day activity before applying any delta',
  'ecosystem-need weight — a live multiplier read from the supply-rate counters',
  'redemption modifier — dampens negative deltas for prosocial agents, so penalties previewed here are the undampened worst case',
  'the self-report evidence gate — when enforcing, an unproven self-reported positive earns 0 instead of its tariff',
];

const DISCLAIMER =
  'Preview only. Nothing here was written and no reputation was earned. These are the published values for each action, not a prediction of what any particular account would be awarded.';

export interface PreviewRepIdInput {
  /** Where the projection starts. Defaults to a fresh account's baseline. */
  baseRepId?: number;
  /** The actions to price, in order. */
  eventTypes: readonly string[];
}

function isKnownEventType(value: string): value is RepIdEventType {
  return Object.prototype.hasOwnProperty.call(CLASSIFICATION, value);
}

/** Price one action. Exported so a caller can build a menu without a projection. */
export function previewEvent(eventType: string): PreviewedEvent {
  if (!isKnownEventType(eventType)) {
    return {
      eventType,
      verdict: 'FAILED',
      delta: null,
      contingentOnEvidence: false,
      reason: 'not a RepID event class — nothing scores this, so there is no value to preview',
    };
  }

  const classification = CLASSIFICATION[eventType];
  if (!classification.previewable) {
    return {
      eventType,
      verdict: 'NOT_CHECKED',
      delta: null,
      contingentOnEvidence: CONTINGENT_ON_EVIDENCE.has(eventType),
      reason: NOT_PREVIEWABLE_DETAIL[classification.reason],
    };
  }

  const delta = FIXED_DELTAS[eventType];
  if (delta === undefined) {
    // Classified previewable but absent from the tariff — a contradiction
    // between two tables that must agree. Report the gap; never invent a 0.
    return {
      eventType,
      verdict: 'FAILED',
      delta: null,
      contingentOnEvidence: CONTINGENT_ON_EVIDENCE.has(eventType),
      reason: 'classified as previewable but carries no tariff entry — the two tables disagree',
    };
  }

  const contingent = CONTINGENT_ON_EVIDENCE.has(eventType);
  return {
    eventType,
    verdict: 'APPROXIMATE',
    delta,
    contingentOnEvidence: contingent,
    reason: contingent
      ? 'published tariff for this action; a live award of it is contingent on an attached evidence reference and is then subject to decay and the ecosystem-need weight'
      : 'published tariff for this action; a live award of it is subject to decay and the ecosystem-need weight',
  };
}

/** The baseline a newly created account starts from. */
export const PREVIEW_BASE_REPID = 200;

/**
 * Project a sequence of actions from a starting score. Only `APPROXIMATE`
 * events move the projection — a `NOT_CHECKED` event contributes nothing rather
 * than contributing zero, and the difference is visible in `events`.
 */
export function previewRepId(input: PreviewRepIdInput): RepIdPreview {
  const baseRepId = input.baseRepId ?? PREVIEW_BASE_REPID;
  const events = input.eventTypes.map(previewEvent);

  const total = events.reduce(
    (sum, e) => (e.verdict === 'APPROXIMATE' && e.delta !== null ? sum + e.delta : sum),
    baseRepId,
  );
  const projectedRepId = Math.max(REPID_MIN, Math.min(REPID_MAX, total));

  return {
    measurement: 'APPROXIMATE',
    persisted: false,
    baseRepId,
    projectedRepId,
    projectedTier: previewTier(projectedRepId),
    tierIsCounterpartyGateApproximation: true,
    tierCaveat: TIER_CAVEAT,
    events,
    omits: OMITS,
    disclaimer: DISCLAIMER,
  };
}

/**
 * The full menu — every event class with its preview verdict. This is what a
 * "what earns trust here?" screen renders, and it deliberately includes the
 * NOT_CHECKED entries: an action whose value cannot be stated up front is a more
 * honest thing to show than an action quietly omitted from the list.
 */
export function previewCatalog(): PreviewedEvent[] {
  return (Object.keys(CLASSIFICATION) as RepIdEventType[]).map(previewEvent);
}
