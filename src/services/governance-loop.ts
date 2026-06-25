/**
 * Wired governance loop — spec v0.3 §3 + §4.
 * action → CC classifier → if T1, adversarial chamber → verdict.
 */
import { type Action, type Classification, classifyAction as defaultClassifyAction } from './consequence-classifier';
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
    }
  | {
      tier: 'T2';
      gate: 'hitl';
      classification: Classification;
      reason: string;
    }
  | {
      tier: 'T1';
      gate: 'chamber';
      classification: Classification;
      proposed: ProposedAction;
      decision: ChamberDecision;
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

export type ClassifyFn = (
  action: Action,
  opts?: { config?: import('./consequence-classifier').ClassifierConfig }
) => Classification;

export interface GovernanceLoopOptions {
  router?: AdversarialRouter;
  repoRoot?: string;
  /** Red-team / hardened profiles inject alternate classification. */
  classifyFn?: ClassifyFn;
}

export function runGovernanceLoop(
  input: GovernanceLoopInput,
  opts: GovernanceLoopOptions = {}
): GovernanceVerdict {
  const classify = opts.classifyFn ?? defaultClassifyAction;
  const classification = classify(input.action);
  const router = opts.router ?? new AdversarialRouter({ repoRoot: opts.repoRoot });

  if (classification.tier === 'T0') {
    const reason = classification.hits.map((h) => h.reason).join('; ') || 'T0 trivial action';
    return { tier: 'T0', gate: 'auto-proceed', classification, reason };
  }

  if (classification.tier === 'T2') {
    const reason = classification.failSafe
      ? 'unmatched action — fail-safe to HITL'
      : classification.hits.map((h) => h.reason).join('; ');
    return { tier: 'T2', gate: 'hitl', classification, reason };
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
  };
}