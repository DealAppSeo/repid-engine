/**
 * RRL — per-agent/provider LEARNING-CURVE reducer.
 * ----------------------------------------------------------------------------
 * The "is the swarm learning to use free LLMs well?" signal, expressed as the
 * change in a producer's confidence CALIBRATION over time. It COMPOSES the
 * existing single-window calibration primitives (./calibration) — it does not
 * re-implement ECE or the self-baseline credential.
 *
 * Given ONE agent/provider's (confidence, correct) pairs in CHRONOLOGICAL order,
 * split them into an early (baseline) and a late (current) window and ask: did
 * calibration improve? calibration.ts's selfBaselineCredential already turns that
 * delta into an antifragile multiplier (reward improving on your OWN past); it was
 * written needing "a temporal baseline the single-shot corpus does not yet have"
 * (calibration.ts §Option C). This supplies exactly that baseline.
 *
 * DISCIPLINE: pure + total. No I/O, DB, network, clock, RNG. Wired to NO scoring
 * path — returns a verdict object, moves no RepID. Unit-tested.
 *
 * ponytail: the harvest that produces time-ordered (conf,correct) pairs per agent
 * is a LIVE, Sean-gated step — tool_call_log (213k rows [V 2026-11-04]) records
 * confidence but NO correctness, and anfis_routing_logs (the clean (conf,outcome)
 * source) is dormant. Until that query lands this reducer is correct-but-inert.
 * Upgrade path: feed it harvested pairs; no code change here.
 */
import {
  ConfCorrectPair,
  expectedCalibrationError,
  selfBaselineCredential,
  defaultCredentialOpts,
  CredentialOpts,
} from './calibration';

export interface LearningCurveOpts {
  /** Fraction of the (time-ordered) pairs forming the EARLY baseline window. Default 0.5. */
  splitFraction: number;
  /** Minimum pairs required in EACH window to trust the comparison. Below → insufficient. */
  minWindow: number;
  /** ECE bins (match calibration.ts default 10). */
  nBins: number;
  /** |improvement| at or below this is treated as flat (neither learning nor regressing). */
  epsilon: number;
  /** Credential shaping passed through to selfBaselineCredential. */
  credential: CredentialOpts;
}

export function defaultLearningCurveOpts(): LearningCurveOpts {
  return { splitFraction: 0.5, minWindow: 20, nBins: 10, epsilon: 0.01, credential: defaultCredentialOpts() };
}

export interface LearningCurveVerdict {
  subject: string;
  nEarly: number;
  nLate: number;
  insufficient: boolean; // either window too thin → verdict is neutral, never rewards/punishes
  baselineEce: number; // ECE of the early window (1 = maximally uncalibrated / empty)
  currentEce: number; // ECE of the late window
  improvement: number; // baselineEce - currentEce ( >0 = calibration got better )
  learning: boolean; // improvement > epsilon and not insufficient
  regressing: boolean; // improvement < -epsilon and not insufficient
  selfCredential: number; // selfBaselineCredential(current, baseline); neutral (1) when insufficient
}

/**
 * Reduce ONE subject's chronologically-ordered (conf,correct) pairs to a learning verdict.
 * Order matters: orderedPairs[0] is the OLDEST call. The caller harvests and orders them.
 */
export function learningCurve(
  subject: string,
  orderedPairs: ConfCorrectPair[],
  opts: LearningCurveOpts = defaultLearningCurveOpts(),
): LearningCurveVerdict {
  const n = orderedPairs.length;
  const frac = opts.splitFraction <= 0 || opts.splitFraction >= 1 ? 0.5 : opts.splitFraction;
  const cut = Math.floor(n * frac);
  const early = orderedPairs.slice(0, cut);
  const late = orderedPairs.slice(cut);

  const insufficient = early.length < opts.minWindow || late.length < opts.minWindow;
  const baselineEce = expectedCalibrationError(early, opts.nBins);
  const currentEce = expectedCalibrationError(late, opts.nBins);
  const improvement = baselineEce - currentEce;

  return {
    subject,
    nEarly: early.length,
    nLate: late.length,
    insufficient,
    baselineEce,
    currentEce,
    improvement,
    learning: !insufficient && improvement > opts.epsilon,
    regressing: !insufficient && improvement < -opts.epsilon,
    // Thin data → pass equal ECEs so the credential is neutral (1). Never reward/punish on noise.
    selfCredential: insufficient
      ? selfBaselineCredential(0, 0, opts.credential)
      : selfBaselineCredential(currentEce, baselineEce, opts.credential),
  };
}
