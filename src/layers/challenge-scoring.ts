// Patent pending P-023 — TUNED constants come from config/scoring-params.ts
// (environment-sourced); they are deliberately absent from this public repo.
import { scoringParams } from '../config/scoring-params';

export interface ChallengeInput {
  outcome: 'WIN'|'LOSS'|'DRAW'|'EPISTEMIC_VIOLATION'|'CONSTITUTIONAL_VIOLATION';
  certaintyAtClaim: number;
  ecosystemNeedWeight: number;
  isPeacemaker?: boolean;
  selfMonitoring?: boolean;
  constitutionalAdherence?: boolean;
}

export function scoreChallengeOutcome(input: ChallengeInput): number {
  const certainty = Math.min(1.0, Math.max(0.0, input.certaintyAtClaim));
  const w = input.ecosystemNeedWeight;
  let delta: number;
  switch (input.outcome) {
    case 'WIN':
      delta = scoringParams().challengeWinBase * w; break;
    case 'LOSS':
      delta = scoringParams().challengeLossBase * w * (certainty ** 2); break;
    case 'EPISTEMIC_VIOLATION':
    case 'CONSTITUTIONAL_VIOLATION':
      // Both violation types carry the same penalty weight:
      // stating opinion as fact and breaking your own stated rules
      // are treated as equivalent epistemic failures
      delta = scoringParams().challengeLossBase * scoringParams().challengeViolationMultiplier * w * (certainty ** 2); break;
    case 'DRAW': default:
      delta = 0;
  }
  if (input.isPeacemaker) delta += scoringParams().challengePeacemakerBonus;
  if (input.selfMonitoring) delta += scoringParams().challengeSelfMonitorBonus;
  if (input.constitutionalAdherence) delta += scoringParams().challengeAdherenceBonus;
  if (input.outcome === 'WIN') delta = Math.min(delta, scoringParams().challengeMaxSingleReward);
  return Math.sign(delta) * Math.round(Math.abs(delta));
}
