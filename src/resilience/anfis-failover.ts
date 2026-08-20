/**
 * anfis-failover.ts — the GENERALIZED ANFIS failover brain (PRIVATE module).
 *
 * Repurposes PR #94/#99's ANFIS/LASSO router from "which LLM provider" to "WHEN does graceful
 * degradation / failover fire" across all eight resilience surfaces (compute / llm / db_read /
 * db_write / rpc / payments / deploy / liveness). It REUSES the proven forward pass + golden-ratio
 * centers/spreads from `../services/anfis-comma` (does NOT fork the math) and maps each surface's
 * per-target signals into the 5-input ANFIS vector.
 *
 * DISCLOSURE HARD-STOP (repo CLAUDE.md): the ANFIS coefficient/consequent matrices below are proprietary
 * and must NEVER appear in any public doc. They live only in this private module.
 *
 * SHADOW-FIRST: `decideFailover` returns `shadow:true` for every surface by default (no enable flag
 * set). It NEVER throws to the caller and NEVER mutates RepID/money/on-chain — its only side effect
 * is a swallowed shadow log. See decision-contract.ts for the full guarantee list.
 */

import { anfisForward, goldenCenters, goldenSpreads } from '../services/anfis-comma';
import {
  decisionIsShadow,
  RESILIENCE_MIN_CONFIDENCE,
  type FailoverAction,
  type FailoverDecision,
  type Surface,
  type SurfaceSignal,
  type TargetState,
} from './decision-contract';
import { logFailoverDecision } from './shadow-log';

/**
 * Five normalized ANFIS inputs derived from a candidate's live state + the request stakes.
 * Order is fixed and named for LASSO interpretability: [health, errorRate, latency, cost, stakes].
 * All in [0,1] so the golden-ratio centers (anfis-comma) fire meaningfully.
 */
const FEATURE_NAMES = ['health', 'error_rate', 'latency', 'cost', 'stakes'] as const;

/** Surface-normalization budgets used to squash raw metrics into [0,1]. Documented bootstrap priors. */
const LATENCY_BUDGET_MS: Record<Surface, number> = {
  compute: 2000,
  llm: 5000,
  db_read: 500,
  db_write: 800,
  rpc: 3000,
  payments: 8000,
  deploy: 60000,
  liveness: 1000,
};

/**
 * LASSO sparse importance per feature. Re-derived per-surface from telemetry where available; where
 * absent these are DOCUMENTED BOOTSTRAP priors (NOT memory's stale provider numbers). Health and
 * error-rate dominate the failover decision; cost is a tiebreaker; stakes modulates conservatism
 * (handled separately, kept low here so it does not by itself trigger a failover).
 */
const SURFACE_IMPORTANCE: Record<Surface, [number, number, number, number, number]> = {
  //          health  error  latency  cost  stakes
  compute:  [0.95, 0.90, 0.40, 0.30, 0.20],
  llm:      [0.90, 0.85, 0.50, 0.45, 0.20],
  db_read:  [0.95, 0.90, 0.60, 0.15, 0.20],
  db_write: [0.98, 0.95, 0.50, 0.10, 0.30], // writes: very conservative
  rpc:      [0.92, 0.88, 0.55, 0.20, 0.20],
  payments: [0.98, 0.95, 0.40, 0.25, 0.40], // money: most conservative
  deploy:   [0.90, 0.85, 0.30, 0.20, 0.20],
  liveness: [0.95, 0.92, 0.60, 0.05, 0.15],
};

const LASSO_THRESHOLD = 0.15;

/** ANFIS consequent params (5 rules × [a0..a4, bias]). Proprietary — private to this module. */
const RULE_PARAMS: number[][] = [
  // bias toward "primary is fine" when health high + errors low
  [-0.9, 0.8, 0.3, 0.1, 0.1, 0.2],
  [-0.8, 0.85, 0.25, 0.05, 0.05, 0.15],
  [-0.95, 0.9, 0.2, 0.0, 0.1, 0.1],
  [-0.7, 0.7, 0.35, 0.15, 0.05, 0.25],
  [-0.85, 0.88, 0.3, 0.1, 0.2, 0.18],
];

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Map one target's live state into the 5 normalized ANFIS inputs for a given surface + stakes. */
export function featurizeTarget(
  t: TargetState,
  surface: Surface,
  requestStakes: number
): [number, number, number, number, number] {
  const budget = LATENCY_BUDGET_MS[surface] || 3000;
  const health = t.healthy ? 0.1 : 0.9; // high value = "unhealthy" pressure to move
  const errorRate = clamp01(t.errorRate);
  const latency = t.latencyMsP50 == null ? 0.3 : clamp01(t.latencyMsP50 / budget);
  const cost = clamp01(t.costPerUnit); // expected pre-normalized by the wrapper; clamp defensively
  const stakes = clamp01(requestStakes);
  return [health, errorRate, latency, cost, stakes];
}

/** LASSO-style sparse selection: keep features whose |feature × importance| clears the threshold. */
function lassoSelect(
  feats: readonly number[],
  importance: readonly number[]
): { names: string[] } {
  const names: string[] = [];
  for (let i = 0; i < feats.length; i++) {
    const w = Math.abs((feats[i] ?? 0) * (importance[i] ?? 1));
    if (w > LASSO_THRESHOLD) names.push(FEATURE_NAMES[i]!);
  }
  // never return empty — fall back to the dominant feature so callers always get interpretability
  if (names.length === 0) names.push(FEATURE_NAMES[0]!);
  return { names };
}

/**
 * Score one candidate's "move-away pressure" via the ANFIS forward pass (higher = more reason to
 * leave this target). Deterministic for identical input.
 */
function targetPressure(feats: [number, number, number, number, number]): number {
  const centers = goldenCenters(5);
  const spreads = goldenSpreads(5);
  const { output } = anfisForward(feats, centers, spreads, RULE_PARAMS);
  return clamp01(output);
}

/**
 * Safe, deterministic default: stay on primary, advisory only, never throws.
 */
function safeDefault(sig: SurfaceSignal, reason: string): FailoverDecision {
  return {
    surface: sig.surface,
    action: 'use_primary',
    chosenTarget: sig.primary,
    confidence: 0,
    reason,
    selectedFeatures: [FEATURE_NAMES[0]!],
    shadow: true,
  };
}

/**
 * The one entry point. Pure + synchronous in its decision; the ONLY side effect is a fire-and-forget
 * shadow log (awaited-but-swallowed). NEVER throws to the caller (guarantee 2).
 */
export function decideFailover(sig: SurfaceSignal): FailoverDecision {
  let decision: FailoverDecision;
  try {
    decision = computeDecision(sig);
  } catch (e: any) {
    console.error('[anfis-failover] decision threw, failing safe to use_primary:', e?.message ?? e);
    decision = safeDefault(sig, `error:${e?.message ?? 'unknown'}`);
  }
  // Observability: swallowed shadow log. Do not await (decision is already returned); the promise's
  // rejection is handled inside logFailoverDecision so this never produces an unhandled rejection.
  void logFailoverDecision(sig, decision);
  return decision;
}

function computeDecision(sig: SurfaceSignal): FailoverDecision {
  const shadow = decisionIsShadow(sig.surface);
  const minConf = RESILIENCE_MIN_CONFIDENCE();

  // Guarantee 2: malformed/empty candidates → safe default.
  if (!sig || !Array.isArray(sig.candidates) || sig.candidates.length === 0) {
    return { ...safeDefault(sig, 'no_candidates'), shadow };
  }

  const stakes = clamp01(sig.requestStakes ?? 0);
  const importance = SURFACE_IMPORTANCE[sig.surface] || SURFACE_IMPORTANCE.compute;

  const primary =
    sig.candidates.find(c => c.target === sig.primary) ?? sig.candidates[0]!;
  const primaryFeats = featurizeTarget(primary, sig.surface, stakes);
  const primaryPressure = targetPressure(primaryFeats);
  const { names: selectedFeatures } = lassoSelect(primaryFeats, importance);

  // If the primary is healthy with low move-pressure, stay. (Stakes raises the bar to leave: a
  // high-stakes request stays on a marginal primary rather than gamble on a standby — guarantee 4.)
  const stayBias = 0.45 + 0.35 * stakes; // 0.45 (low stakes) … 0.80 (high stakes)
  if (primary.healthy && primaryPressure < stayBias) {
    return {
      surface: sig.surface,
      action: 'use_primary',
      chosenTarget: primary.target,
      confidence: clamp01(1 - primaryPressure),
      reason: `primary_ok pressure=${primaryPressure.toFixed(3)} stayBias=${stayBias.toFixed(3)}`,
      selectedFeatures,
      shadow,
    };
  }

  // Primary is under pressure. Rank the healthy fallbacks by lowest move-pressure (best target).
  const fallbacks = sig.candidates
    .filter(c => c.target !== primary.target)
    .map(c => ({ c, pressure: targetPressure(featurizeTarget(c, sig.surface, stakes)) }))
    .filter(x => x.c.healthy)
    .sort((a, b) => a.pressure - b.pressure);

  // No healthy fallback → trip the breaker / degrade (serve last-known-good / enqueue / local floor).
  if (fallbacks.length === 0) {
    const action: FailoverAction = sig.surface === 'rpc' ? 'rotate' : 'trip_breaker';
    return {
      surface: sig.surface,
      action: stakes > 0.5 ? 'degrade' : action,
      chosenTarget: primary.target,
      confidence: clamp01(primaryPressure),
      reason: `no_healthy_fallback primary_pressure=${primaryPressure.toFixed(3)}`,
      selectedFeatures,
      shadow,
    };
  }

  const best = fallbacks[0]!;
  // Confidence in failover = how much better the chosen target is than the primary, gated by stakes.
  const margin = clamp01(primaryPressure - best.pressure);
  // Higher stakes demand a bigger margin to justify a move → lower confidence at equal margin.
  const confidence = clamp01(margin * (1 - 0.4 * stakes) + (primary.healthy ? 0 : 0.2));

  // Guarantee 2 surfaced as a decision property: if confidence is below the floor, advise use_primary.
  if (confidence < minConf) {
    return {
      surface: sig.surface,
      action: 'use_primary',
      chosenTarget: primary.target,
      confidence,
      reason: `low_confidence ${confidence.toFixed(3)}<${minConf} → hold primary`,
      selectedFeatures,
      shadow,
    };
  }

  const action: FailoverAction = sig.surface === 'rpc' ? 'rotate' : 'failover';
  return {
    surface: sig.surface,
    action,
    chosenTarget: best.c.target,
    confidence,
    reason: `failover ${primary.target}→${best.c.target} margin=${margin.toFixed(3)} stakes=${stakes.toFixed(2)}`,
    selectedFeatures,
    shadow,
  };
}
