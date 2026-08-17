/**
 * reward-curve.ts — what the RepID reward actually pays, over the domain it can actually receive.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ════════════════════════════════════════════════════════════════════════════════
 * "Does RepID incentivise good behaviour?" is not answerable by reading the delta formula, because
 * the formula's input is produced by another function with an opinion about orientation. The
 * question is only answerable over the REACHABLE domain: the set of (decision, score) pairs the
 * pipeline can actually hand to `computeDelta`.
 *
 * So this module composes the REAL functions — `deriveHalDecision` from the scoring pipeline and
 * `computeDelta` from the delta module — and enumerates what comes out. It imports them rather than
 * restating them, because a reimplementation would measure a copy (LESSONS §2: verify the thing
 * itself, never a proxy for it).
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE ORIENTATION FACT EVERYTHING TURNS ON
 * ════════════════════════════════════════════════════════════════════════════════
 * `hal_score` is a hallucination-RISK score: HIGH IS BAD. `src/hal/lib/score.ts` says so, and
 * `deriveHalDecision` confirms it operationally — it returns 'clean' only BELOW 0.40 and 'flagged'
 * at or above.
 *
 * `computeDelta`'s clean branch reads that same number as though HIGH WERE GOOD. Its own comment
 * says "0.5 → +1, 1.0 → +3, 0.0 → −1", which is only coherent for a quality score. The pipeline
 * passes one value to both without inverting it.
 *
 * Composed, the two disagree, and the disagreement is not academic — see `monotonicityViolations`.
 * This module does not fix either function. `computeDelta` is on the live scoring path and changing
 * it is Sean's call (CLAUDE-RULE-2/3); the job here is to measure and to make the measurement
 * impossible to lose.
 *
 * PURITY: no I/O, no DB, no network. `deltaFloor()` inside `computeDelta` reads one env flag; the
 * sampling functions here pass explicit agent state and are otherwise functions of their arguments.
 */

import { computeDelta, HALDecision } from '../scoring/repid-delta';
import { deriveHalDecision } from '../scoring/pipeline';

/** Agent state held fixed while sweeping the score, so the curve isolates the score's effect. */
export interface CurveAgentState {
  current_repid: number;
  agent_tier: string;
  vesting_cliff_active: boolean;
}

/** A well-clear-of-boundaries agent: no floor protection, no vesting absorption. */
export const NEUTRAL_AGENT: CurveAgentState = {
  current_repid: 1000,
  agent_tier: 'ESTABLISHED',
  vesting_cliff_active: false,
};

/** One point on the composed curve. */
export interface CurvePoint {
  /** The hallucination-RISK score. LOWER IS BETTER quality. */
  risk: number;
  /** What `deriveHalDecision` returns for this risk — not assumed, called. */
  decision: HALDecision;
  delta_calculated: number;
  delta_applied: number;
}

/**
 * Sample the composed pipeline across the whole risk range.
 *
 * `steps` points inclusive of both ends. The decision is DERIVED at each point rather than
 * supplied, which is the difference between measuring the system and measuring an assumption
 * about it: a caller who passed `decision: 'clean'` with `risk: 0.95` would be probing a
 * combination the pipeline cannot produce, which is exactly how the existing unit tests came to
 * validate an orientation production never uses.
 */
export function sampleCurve(
  steps = 101,
  agent: CurveAgentState = NEUTRAL_AGENT,
): CurvePoint[] {
  const out: CurvePoint[] = [];
  const n = Math.max(2, Math.floor(steps));
  for (let i = 0; i < n; i++) {
    const risk = i / (n - 1);
    const decision = deriveHalDecision(risk, false, null);
    const d = computeDelta({ hal_score: risk, hal_decision: decision, ...agent });
    out.push({
      risk,
      decision,
      delta_calculated: d.delta_calculated,
      delta_applied: d.delta_applied,
    });
  }
  return out;
}

/** Only the points the pipeline classifies as `clean` — the reward-bearing branch. */
export function reachableCleanPoints(
  steps = 4001,
  agent: CurveAgentState = NEUTRAL_AGENT,
): CurvePoint[] {
  return sampleCurve(steps, agent).filter((p) => p.decision === 'clean');
}

/** The best and worst a `clean` event can pay, and the risk each occurs at. */
export interface CleanExtrema {
  best: CurvePoint;
  worst: CurvePoint;
  /** True when the BEST reward is paid at HIGHER risk than the worst — i.e. quality is penalised. */
  inverted: boolean;
}

export function cleanExtrema(
  steps = 4001,
  agent: CurveAgentState = NEUTRAL_AGENT,
): CleanExtrema {
  const pts = reachableCleanPoints(steps, agent);
  if (pts.length === 0) throw new Error('[reward-curve] no reachable clean points — pipeline changed');
  let best = pts[0]!;
  let worst = pts[0]!;
  for (const p of pts) {
    if (p.delta_applied > best.delta_applied) best = p;
    if (p.delta_applied < worst.delta_applied) worst = p;
  }
  return { best, worst, inverted: best.risk > worst.risk };
}

/**
 * A pair of reachable clean points where MORE risk earned MORE reward.
 *
 * The property a reputation system needs is that reward is non-increasing in risk: a
 * better-grounded claim must never be paid less than a worse one. Each element here is a
 * counterexample to that.
 */
export interface MonotonicityViolation {
  lowerRisk: CurvePoint;
  higherRisk: CurvePoint;
  /** How much MORE the riskier claim earned. Always > 0. */
  rewardGain: number;
}

/**
 * Every adjacent-pair violation of "reward is non-increasing in risk", over reachable clean points.
 *
 * Adjacent pairs suffice: a monotone-decreasing sequence has no adjacent increase, so an empty
 * result is a proof of the property over the sampled grid rather than weak evidence for it.
 */
export function monotonicityViolations(
  steps = 401,
  agent: CurveAgentState = NEUTRAL_AGENT,
): MonotonicityViolation[] {
  const pts = reachableCleanPoints(steps, agent);
  const out: MonotonicityViolation[] = [];
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    if (cur.delta_applied > prev.delta_applied) {
      out.push({ lowerRisk: prev, higherRisk: cur, rewardGain: cur.delta_applied - prev.delta_applied });
    }
  }
  return out;
}

/**
 * The risk a reward-maximising agent would aim for, and what it pays.
 *
 * This is the operational meaning of the curve: whatever this returns is the behaviour the system
 * currently pays the most for, regardless of what anyone intended it to pay for.
 */
export function rewardMaximisingRisk(
  steps = 4001,
  agent: CurveAgentState = NEUTRAL_AGENT,
): CurvePoint {
  return cleanExtrema(steps, agent).best;
}

/** Whether a decision can occur at all across the sampled risk range. */
export function reachableDecisions(steps = 4001): Set<HALDecision> {
  return new Set(sampleCurve(steps).map((p) => p.decision));
}
