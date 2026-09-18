/**
 * output-confidence-scorer.ts — post-call heuristic output confidence scorer (backlog item 8).
 *
 * `runSpeculativeCascade` (./speculative-cascade.ts) requires the caller to supply a measured
 * `confidence` on the draft and escalated outputs. No existing code in this repo provides that:
 * `anfisConfidence` in router.ts is a pre-call routing score; `confidence_required` in slm-tier.ts
 * is a caller-declared policy threshold. This module is the missing post-call measurement.
 *
 * Pure function, no I/O, deterministic. Callers invoke it on the returned text output of any
 * provider call to get a [0.05, 0.95] confidence estimate before deciding whether to escalate.
 * Gate lives entirely in the caller — this scorer is always computable.
 */

export interface OutputConfidenceResult {
  confidence: number; // clamped to [0.05, 0.95]
  factors: Record<string, number>;
}

const UNCERTAINTY_PATTERNS: RegExp[] = [
  /i(?:'m| am) not sure/i,
  /i don't know/i,
  /i cannot confirm/i,
  /i(?:'m| am) unable to/i,
  /i(?:'m| am) uncertain/i,
  /it(?:'s| is) hard to say/i,
  /it(?:'s| is) difficult to say/i,
  /i can't say/i,
  /i cannot say/i,
  /i(?:'m| am) not certain/i,
  /possibly/i,
  /i might be wrong/i,
];

const REFUSAL_PATTERNS: RegExp[] = [
  /i(?:'m| am) sorry,? i (?:cannot|can't|won't|am unable to) (?:help|assist|provide|answer|respond)/i,
  /i cannot (?:help|assist|provide|answer) (?:with )?(?:that|this)/i,
  /i don't have (?:access|information) (?:to|about) that/i,
  /(?:that(?:'s| is) outside|beyond) (?:my|what i can)/i,
];

const CONFIDENCE_MIN = 0.05;
const CONFIDENCE_MAX = 0.95;
const BASE_CONFIDENCE = 0.75;

/**
 * Score the confidence of a model's text output using lightweight heuristics.
 * Returns a value in [0.05, 0.95] alongside named factor contributions.
 */
export function scoreOutputConfidence(
  output: string,
  _opts?: { provider?: string; eventType?: string },
): OutputConfidenceResult {
  const factors: Record<string, number> = {};

  if (!output || output.trim().length === 0) {
    factors['empty'] = -1.0;
    return { confidence: CONFIDENCE_MIN, factors };
  }

  const trimmed = output.trim();
  const len = trimmed.length;

  // 1. Length floor: very short responses suggest refusal or uncertainty
  let base = BASE_CONFIDENCE;
  if (len < 50) {
    base = 0.30;
    factors['length_very_short'] = -0.45;
  } else if (len < 150) {
    base = 0.60;
    factors['length_short'] = -0.15;
  } else {
    factors['length_ok'] = 0;
  }

  // 2. Refusal pattern — hard floor at 0.05
  let isRefusal = false;
  for (const pat of REFUSAL_PATTERNS) {
    if (pat.test(trimmed)) {
      isRefusal = true;
      factors['refusal'] = -(CONFIDENCE_MAX - CONFIDENCE_MIN);
      break;
    }
  }
  if (isRefusal) {
    return { confidence: CONFIDENCE_MIN, factors };
  }

  // 3. Uncertainty markers — each -0.12, cumulative floor 0.10
  let uncertaintyPenalty = 0;
  let hitCount = 0;
  for (const pat of UNCERTAINTY_PATTERNS) {
    if (pat.test(trimmed)) {
      hitCount++;
      uncertaintyPenalty += 0.12;
    }
  }
  if (hitCount > 0) {
    factors['uncertainty_markers'] = -uncertaintyPenalty;
  }

  // 4. Factual density: digit ratio and uppercase-word density → small bonus
  const digitMatches = trimmed.match(/\d/g);
  const digitRatio = digitMatches ? digitMatches.length / len : 0;
  const digitBonus = Math.min(digitRatio * 10, 0.10);
  if (digitBonus > 0.01) {
    factors['factual_digit_density'] = digitBonus;
  }

  const words = trimmed.split(/\s+/);
  const uppercaseWords = words.filter((w) => w.length > 1 && /^[A-Z]/.test(w) && !/^[A-Z]+$/.test(w));
  const uppercaseRatio = uppercaseWords.length / Math.max(words.length, 1);
  const uppercaseBonus = Math.min(uppercaseRatio * 0.5, 0.05);
  if (uppercaseBonus > 0.01) {
    factors['factual_proper_noun_density'] = uppercaseBonus;
  }

  const raw = base - uncertaintyPenalty + digitBonus + uppercaseBonus;
  const confidence = Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, raw));

  return { confidence, factors };
}
