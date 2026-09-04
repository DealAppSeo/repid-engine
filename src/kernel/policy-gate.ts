/**
 * policy-gate.ts — TrustShell deterministic Policy Decision Gate (kernel).
 *
 * THE ONE INVARIANT THIS FILE EXISTS TO ENFORCE:
 *   Models propose. HAL advises. TrustShell disposes.
 *   Probabilistic components (HAL, validators, ANFIS) EMIT EVIDENCE.
 *   This gate is the ONLY thing that authorizes a durable RepID move, a pass
 *   flip, a budget release, or a skill promotion. It is deterministic, pure,
 *   fail-closed, and takes NO LLM call.
 *
 * WHY (authority audit 2026-09-03): `scoring/pipeline.ts::runScoreEvent` lets a
 * HAL decision drive `computeDelta` → direct `current_repid` UPDATE, and
 * `applyValidationEvent` applies a RAW caller-supplied delta with no quorum /
 * purpose gate at all (the money path). There is no single authorizer and no
 * Trust Receipt precondition. This module is that authorizer. Both writers route
 * their durable move through `gate()`; if it does not return ALLOW with
 * `durable_move_authorized: true`, the score does not move.
 *
 * The inline gates already living in runScoreEvent (quorum, purpose,
 * hallucination_caught, reward-requires-provider) are expressed ONCE here so
 * there is a single source of truth; the scattered copies become follow-up deletes.
 *
 * Pure + dependency-free on purpose: unit-testable without DB/HAL mocks.
 */

export type GateDecision = 'ALLOW' | 'ASK' | 'DENY';

export type ActionClass =
  | 'durable_repid_move'
  | 'execute_mutating'
  | 'release_budget'
  | 'promote_skill';

/** HAL is EVIDENCE, never authority. All fields optional → absence is uncertainty. */
export interface HalEvidence {
  hal_score?: number;
  decision?: 'clean' | 'flagged' | 'vetoed';
  mode?: 'fact-check' | 'extractor' | 'extractor-fallback' | null;
  families_used?: number;
  providers_succeeded?: number;
  error?: boolean;
}

export interface Sensors {
  tests_passed?: boolean;
  schema_valid?: boolean;
  wal_present?: boolean;
  hash_verified?: boolean;
  reexec_matched?: boolean;
}

export interface RepidContext {
  n: number;
  u: number;
  lcb?: number;
}

export interface Capability {
  valid: boolean;
  in_scope: boolean;
}

export interface Purpose {
  is_deliverable: boolean;
}

/**
 * Independent-validation evidence — grounds a validation-ROLE durable move
 * (VALIDATION_FAILED penalty, VALIDATOR_REWARD) when there is no HAL fact-check
 * quorum. Valid ONLY when it links to a real validation record AND the validator
 * is not the subject (a validator may never judge itself). A bare caller-supplied
 * `verdict` string is NOT independent validation.
 */
export interface ValidationEvidence {
  validation_id?: string | null;   // links to a recorded validation (peer_verification / adjudication)
  source?: 'redteam_adjudication' | 'counterparty_dispute' | 'peer_verification' | 'challenge' | null;
  validator_agent_id?: string | null; // who judged
  subject_agent_id?: string | null;   // who is judged
  method?: string | null;             // L0..L5 verification level, when known
  blinded?: boolean;
}

export interface EvidenceBundle {
  action_class: ActionClass;
  risk_class: number;
  proposed_delta?: number;
  settled_receipt_id?: string | null;
  hal?: HalEvidence;
  sensors?: Sensors;
  repid?: RepidContext;
  capability?: Capability;
  purpose?: Purpose;
  validation?: ValidationEvidence;
  budget_remaining?: number;
  constitution_violations?: string[];
}

export interface GateResult {
  decision: GateDecision;
  durable_move_authorized: boolean;
  authorized_delta: number;
  escalate_to?: 'human' | 'jury';
  reasons: string[];
}

const N_MIN_HIGH_IMPACT = 1;
const U_MAX = 0.85;
const QUORUM_MIN = 2;

export function gate(b: EvidenceBundle): GateResult {
  const reasons: string[] = [];
  const deny = (r: string): GateResult => {
    reasons.push(r);
    return { decision: 'DENY', durable_move_authorized: false, authorized_delta: 0, reasons };
  };

  // 0. Constitution hard layer — first, absolute, non-overridable.
  if (b.constitution_violations && b.constitution_violations.length > 0) {
    return deny(`constitution_violation:${b.constitution_violations.join(',')}`);
  }

  // 1. Capability + budget — deterministic authority preconditions.
  if (b.capability && (!b.capability.valid || !b.capability.in_scope)) {
    return deny(!b.capability.valid ? 'capability_invalid' : 'capability_out_of_scope');
  }
  if ((b.action_class === 'release_budget' || b.action_class === 'execute_mutating') &&
      typeof b.budget_remaining === 'number' && b.budget_remaining <= 0) {
    return deny('budget_exhausted');
  }

  // 2. Non-durable action classes: authorize on deterministic sensors only.
  if (b.action_class !== 'durable_repid_move') {
    const s = b.sensors ?? {};
    const sensorsClean = s.tests_passed === true &&
      (s.schema_valid !== false) && (s.hash_verified !== false);
    if (!sensorsClean) {
      reasons.push('sensors_not_clean');
      return { decision: b.risk_class >= 3 ? 'ASK' : 'DENY',
               durable_move_authorized: false, authorized_delta: 0,
               escalate_to: b.risk_class >= 3 ? 'human' : undefined, reasons };
    }
    if (b.hal?.decision === 'vetoed' || (typeof b.hal?.hal_score === 'number' && b.hal.hal_score >= 0.75)) {
      reasons.push('hal_flag_escalate');
      return { decision: 'ASK', durable_move_authorized: false, authorized_delta: 0,
               escalate_to: b.risk_class >= 4 ? 'human' : 'jury', reasons };
    }
    if (b.risk_class >= 5) {
      reasons.push('risk_class_5_requires_human');
      return { decision: 'ASK', durable_move_authorized: false, authorized_delta: 0, escalate_to: 'human', reasons };
    }
    reasons.push('sensors_clean');
    return { decision: 'ALLOW', durable_move_authorized: false, authorized_delta: 0, reasons };
  }

  // 3. DURABLE RepID move — the strict path.

  // 3a. A settled Trust Receipt is a PRECONDITION.
  if (!b.settled_receipt_id) {
    return deny('no_settled_receipt');
  }

  const delta = typeof b.proposed_delta === 'number' ? b.proposed_delta : 0;
  if (delta === 0) {
    reasons.push('zero_delta');
    return { decision: 'ALLOW', durable_move_authorized: true, authorized_delta: 0, reasons };
  }

  // 3b. Zero-evidence gate. n==0 ⇒ unknown; hold for evidence.
  const rc = b.repid;
  if (!rc || rc.n <= 0) {
    reasons.push('zero_evidence_gate:n=0');
    return { decision: 'ASK', durable_move_authorized: false, authorized_delta: 0, escalate_to: 'jury', reasons };
  }
  if (rc.u >= U_MAX) {
    reasons.push(`high_uncertainty:u=${rc.u}`);
    return { decision: 'ASK', durable_move_authorized: false, authorized_delta: 0, escalate_to: 'jury', reasons };
  }

  // 3c. Purpose gate — non-deliverable ⇒ HAL delta 0 in BOTH directions.
  if (b.purpose && !b.purpose.is_deliverable) {
    reasons.push('non_deliverable_purpose:delta_zeroed');
    return { decision: 'ALLOW', durable_move_authorized: true, authorized_delta: 0, reasons };
  }

  const hal = b.hal ?? {};
  const quorumMet = hal.mode === 'fact-check' && (hal.families_used ?? 0) >= QUORUM_MIN;

  // Independent-validation evidence: a linked validation record judged by someone
  // OTHER than the subject. This is the grounding for validation-role moves
  // (adjudicated challenges, counterparty disputes) that never run a HAL quorum.
  const v = b.validation;
  const indepValidation = !!(
    v && (v.validation_id || v.source) &&
    v.validator_agent_id && v.subject_agent_id &&
    v.validator_agent_id !== v.subject_agent_id
  );

  // 3d. PENALTY requires grounding: a ≥2-family HAL quorum OR independent
  //     validation. A bare caller `verdict` is not grounding → neutralize (fail-safe).
  if (delta < 0) {
    if (hal.error && !indepValidation) { reasons.push('penalty_neutralized:hal_error'); return allowZero(reasons); }
    if (!quorumMet && !indepValidation) { reasons.push('penalty_neutralized:ungrounded'); return allowZero(reasons); }
    reasons.push(quorumMet ? `penalty_authorized:quorum_families=${hal.families_used}` : 'penalty_authorized:independent_validation');
  }

  // 3e. REWARD requires the RIGHT evidence for the event:
  //   - HAL claim-quality reward → ≥1 provider that returned a verdict.
  //   - ECONOMIC settlement reward → deterministic settlement (delivery verified).
  //   - VALIDATOR reward → independent validation (they judged someone else's work).
  //   Any one suffices; absence of all three does not.
  if (delta > 0) {
    const s = b.sensors ?? {};
    const settlementConfirmed = s.tests_passed === true || s.reexec_matched === true;
    const halProviderEvidence = !hal.error && (hal.providers_succeeded ?? 0) >= 1;
    if (!settlementConfirmed && !halProviderEvidence && !indepValidation) {
      reasons.push('reward_neutralized:no_evidence');
      return allowZero(reasons);
    }
    reasons.push(
      settlementConfirmed ? 'reward_authorized:settlement_sensors'
      : halProviderEvidence ? 'reward_authorized:provider_evidence'
      : 'reward_authorized:independent_validation'
    );
  }

  // 3f. High-impact move on thin history ⇒ escalate rather than auto-apply.
  if (b.risk_class >= 4 && rc.n <= N_MIN_HIGH_IMPACT) {
    reasons.push(`high_impact_thin_history:n=${rc.n}`);
    return { decision: 'ASK', durable_move_authorized: false, authorized_delta: 0, escalate_to: 'human', reasons };
  }

  return { decision: 'ALLOW', durable_move_authorized: true, authorized_delta: delta, reasons };
}

function allowZero(reasons: string[]): GateResult {
  return { decision: 'ALLOW', durable_move_authorized: true, authorized_delta: 0, reasons };
}
