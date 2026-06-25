/**
 * Wired governance loop — spec v0.3 §3 + §4.
 * action → CC classifier → if T1, adversarial chamber → verdict.
 */
import { type Action, type Classification } from './consequence-classifier';
import { SessionRiskTracker, type SessionAssessment } from './session-risk';
import {
  AdversarialRouter,
  type AdversarialObjection,
  type ChamberDecision,
  type ChamberParticipant,
  type ProposedAction,
} from './adversarial-router';
import { type ActionClass } from '../config/adversarial-templates';

export type GovernanceGate = 'auto-proceed' | 'hitl' | 'chamber';

export type GovernanceVerdict =
  | {
      tier: 'T0';
      gate: 'auto-proceed';
      classification: Classification;
      reason: string;
      /** Session assessment for this action (always present once the session layer is wired). */
      sessionAssessment?: SessionAssessment;
    }
  | {
      tier: 'T2';
      gate: 'hitl';
      classification: Classification;
      reason: string;
      sessionAssessment?: SessionAssessment;
    }
  | {
      tier: 'T1';
      gate: 'chamber';
      classification: Classification;
      proposed: ProposedAction;
      decision: ChamberDecision;
      sessionAssessment?: SessionAssessment;
    };

export function inferActionClass(classification: Classification): ActionClass {
  const ruleIds = new Set(classification.hits.map((h) => h.ruleId));
  if (ruleIds.has('T1_BOUNDED_SPEND')) return 'spend';
  if (ruleIds.has('T1_NONPROD_CONFIG')) return 'prod-config';
  return 'merge';
}

export function actionToProposed(action: Action, classification: Classification): ProposedAction {
  return {
    id: `gov-${action.kind}-${classification.hits[0]?.ruleId ?? 'unknown'}`,
    actionClass: inferActionClass(classification),
    artifactSummary: action.description ?? `${action.kind} action`,
    artifactRefs: action.paths,
  };
}

export interface GovernanceLoopInput {
  action: Action;
  proposer: ChamberParticipant;
  adversary: ChamberParticipant;
  objection: AdversarialObjection;
}

export interface GovernanceLoopOptions {
  router?: AdversarialRouter;
  repoRoot?: string;
  /**
   * Persistent session for SEQUENCE-aware governance (r7). Thread the SAME tracker across a chain
   * of actions and the session layer escalates recon→credential / recon→destructive even though
   * each step alone is T0. If omitted, an ephemeral single-action session is used (no history →
   * behaves exactly like per-action classification, preserving parity for stateless callers).
   */
  session?: SessionRiskTracker;
  /** Rolling spend-window snapshot, forwarded to the classifier's velocity cap. */
  spendContext?: { windowTotalUsd: number; windowCount: number };
}

export function runGovernanceLoop(
  input: GovernanceLoopInput,
  opts: GovernanceLoopOptions = {}
): GovernanceVerdict {
  // [r7] The session layer is ON BY DEFAULT: every action runs the accumulator. A threaded session
  // gives sequence-aware escalation; an ephemeral one is a no-op (parity for single-action callers).
  const session = opts.session ?? new SessionRiskTracker('ephemeral');
  const { classification, assessment } = session.govern(
    input.action,
    opts.spendContext ? { spendContext: opts.spendContext } : {}
  );
  const effectiveTier = assessment.finalTier; // session-adjusted (≥ per-action tier)
  const router = opts.router ?? new AdversarialRouter({ repoRoot: opts.repoRoot });

  if (effectiveTier === 'T0') {
    const reason = classification.hits.map((h) => h.reason).join('; ') || 'T0 trivial action';
    return { tier: 'T0', gate: 'auto-proceed', classification, reason, sessionAssessment: assessment };
  }

  if (effectiveTier === 'T2') {
    // Prefer the session reason when the session escalated above the per-action tier.
    const reason =
      assessment.escalateTo === 'T2' && assessment.perActionTier !== 'T2'
        ? assessment.reason
        : classification.failSafe
          ? 'unmatched action — fail-safe to HITL'
          : classification.hits.map((h) => h.reason).join('; ');
    return { tier: 'T2', gate: 'hitl', classification, reason, sessionAssessment: assessment };
  }

  const proposed = actionToProposed(input.action, classification);
  const decision = router.decideT1(
    proposed,
    input.proposer,
    input.adversary,
    input.objection
  );
  return {
    tier: 'T1',
    gate: 'chamber',
    classification,
    proposed,
    decision,
    sessionAssessment: assessment,
  };
}