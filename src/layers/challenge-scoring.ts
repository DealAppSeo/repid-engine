// Patent pending P-023 — do not expose constants in public repos
const WIN_BASE = 25;
const LOSS_BASE = -50;
const VIOLATION_MULTIPLIER = 1.5;
const PEACEMAKER_BONUS = 15;
const SELF_MONITOR_BONUS = 10;
const CONSTITUTIONAL_ADHERENCE_BONUS = 8;
const MAX_SINGLE_REWARD = 40;

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
      delta = WIN_BASE * w; break;
    case 'LOSS':
      delta = LOSS_BASE * w * (certainty ** 2); break;
    case 'EPISTEMIC_VIOLATION':
    case 'CONSTITUTIONAL_VIOLATION':
      // Both violation types carry the same penalty weight:
      // stating opinion as fact and breaking your own stated rules
      // are treated as equivalent epistemic failures
      delta = LOSS_BASE * VIOLATION_MULTIPLIER * w * (certainty ** 2); break;
    case 'DRAW': default:
      delta = 0;
  }
  if (input.isPeacemaker) delta += PEACEMAKER_BONUS;
  if (input.selfMonitoring) delta += SELF_MONITOR_BONUS;
  if (input.constitutionalAdherence) delta += CONSTITUTIONAL_ADHERENCE_BONUS;
  if (input.outcome === 'WIN') delta = Math.min(delta, MAX_SINGLE_REWARD);
  return Math.sign(delta) * Math.round(Math.abs(delta));
}
