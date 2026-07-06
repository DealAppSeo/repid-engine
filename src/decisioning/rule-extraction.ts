/**
 * RULE EXTRACTION (glass box) — fired rules + strengths + LASSO drivers -> decision-record columns.
 * OUTPUT_PATH: src/decisioning/rule-extraction.ts
 * SPEC: PRIORITY_B_ANFIS_DECISIONING_CHARTER_v1.md §2 ("every fired fuzzy rule + strength logged"), §7.
 *
 * VERIFIED-BEFORE-BUILD (R1, task constraint — do NOT assume an external interface): I READ the actual
 * ANFIS core and extract only what it truly exposes.
 *
 *  - src/services/anfis-router.ts `anfisRecommendProvider(prompt, taskHint, providerState)` returns
 *    `AnfisRouterOutput { recommendedProvider, recommendedTier, confidence, ruleWeights?, lassoSelectedFeatures? }`.
 *    `ruleWeights` = the 5 NORMALIZED firing strengths from anfisForward (Layer-3 normalize). `lassoSelectedFeatures`
 *    = the subset of ['len','low','cat','cost','rate','qual'] that survived lassoSelectFeatures' L1 threshold.
 *  - src/services/anfis-comma.ts `commaANFIS(inputs)` returns `{ halScore, vetoed, dissonance, ruleWeights,
 *    pythagoreanVeto }`. `ruleWeights` again = normalized firing strengths (5 rules).
 *
 * HONEST LIMITS (R4 NO THEATER — stated, not fabricated):
 *  - The rule base is golden-ratio-SEEDED with HAND-TUNED (untrained) consequent params (anfis-comma.ts
 *    ruleParams comment: "learned/tuned by ANFIS training. For now: ..."; spec §7 confirms hand-tuned).
 *    So "rule strength" is REAL (the firing weight per rule) but the rules carry NO learned human-named
 *    semantics. We therefore label rules by INDEX (rule[0..4]) and expose their strengths — we do NOT
 *    invent a name/meaning the core never assigned. That is the true extent of the glass box today.
 *  - "LASSO top-drivers" = the feature NAMES the router's lassoSelectFeatures already selected (real),
 *    NOT a fresh regression we didn't run.
 *  - There is NO per-rule LASSO coefficient exposed; extractLassoDrivers reads the selected-feature list,
 *    not fabricated coefficients. If a caller passes a router output WITHOUT lassoSelectedFeatures, we
 *    report an empty driver list and say so — we do not fill it in.
 *
 * ADVISORY PURITY (R3): pure. Produces the glass-box fields for decision-record.schema.json
 * (anfis_rule_weights, anfis_lasso_features) + a human-readable summary. No routing, no DB writes.
 */

import type { AnfisRouterOutput } from '../services/anfis-router';

/** A single fired rule's contribution — strength only (the core exposes no learned rule name). */
export interface FiredRule {
  /** rule index in the 5-rule golden-ratio base (0..4). The core identifies rules by position only. */
  ruleIndex: number;
  /** normalized firing strength in [0,1] (Layer-3 output of anfisForward). REAL, not fabricated. */
  strength: number;
}

export interface ExtractedRules {
  /** fired rules sorted by descending strength (the drivers of THIS decision). */
  firedRules: FiredRule[];
  /** the dominant rule (max strength), or null if no rule weights were exposed. */
  topRule: FiredRule | null;
  /** LASSO-selected feature names (real, from the router). Empty when the source didn't expose them. */
  lassoDrivers: string[];
  /** true iff the source actually exposed rule weights (so callers can distinguish "no rules" from "empty"). */
  hasRuleWeights: boolean;
  /** true iff the source exposed LASSO-selected features. */
  hasLassoDrivers: boolean;
  /** human-readable one-line glass-box summary (RULE-4-honest: names the untrained-params caveat). */
  summary: string;
  /** the exact array to persist to decision-record `anfis_rule_weights`. */
  ruleWeights: number[];
}

/** Round to 4dp for stable, readable output. */
function r4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Extract fired rules + strengths from a raw ruleWeights vector (the shape BOTH anfisRecommendProvider
 * and commaANFIS expose). Sorted descending; index-labeled (the core names rules by position only).
 */
export function extractFiredRules(ruleWeights: number[] | undefined): { firedRules: FiredRule[]; topRule: FiredRule | null; hasRuleWeights: boolean } {
  if (!ruleWeights || ruleWeights.length === 0) {
    return { firedRules: [], topRule: null, hasRuleWeights: false };
  }
  const fired = ruleWeights
    .map((strength, ruleIndex) => ({ ruleIndex, strength: r4(strength) }))
    .sort((a, b) => b.strength - a.strength);
  return { firedRules: fired, topRule: fired[0] ?? null, hasRuleWeights: true };
}

/** LASSO drivers = the feature names the router selected. Real list or empty (never fabricated). */
export function extractLassoDrivers(lassoSelectedFeatures: string[] | undefined): { lassoDrivers: string[]; hasLassoDrivers: boolean } {
  if (!lassoSelectedFeatures) return { lassoDrivers: [], hasLassoDrivers: false };
  return { lassoDrivers: [...lassoSelectedFeatures], hasLassoDrivers: true };
}

/**
 * Build a human-readable summary. Honest about untrained params: it describes WHICH rule fired hardest
 * and WHICH features drove the pick, and it does NOT claim a learned rule meaning.
 */
export function summarizeExtraction(firedRules: FiredRule[], topRule: FiredRule | null, lassoDrivers: string[]): string {
  if (!topRule) return 'no fired rules exposed (source produced no rule weights).';
  const strengthsStr = firedRules.map((f) => `rule[${f.ruleIndex}]=${f.strength}`).join(', ');
  const driversStr = lassoDrivers.length ? lassoDrivers.join(', ') : '(none exposed)';
  return (
    `top driver rule[${topRule.ruleIndex}] (strength ${topRule.strength}); ` +
    `LASSO features: ${driversStr}; all strengths: ${strengthsStr}. ` +
    `NOTE: golden-ratio-seeded rule base with HAND-TUNED (untrained) consequent params — strengths are ` +
    `real firing weights; rules are index-labeled (no learned semantic name).`
  );
}

/** Extract glass-box rules from an AnfisRouterOutput (the routing decision path). */
export function extractFromRouterOutput(out: AnfisRouterOutput): ExtractedRules {
  const { firedRules, topRule, hasRuleWeights } = extractFiredRules(out.ruleWeights);
  const { lassoDrivers, hasLassoDrivers } = extractLassoDrivers(out.lassoSelectedFeatures);
  return {
    firedRules,
    topRule,
    lassoDrivers,
    hasRuleWeights,
    hasLassoDrivers,
    summary: summarizeExtraction(firedRules, topRule, lassoDrivers),
    ruleWeights: out.ruleWeights ? out.ruleWeights.map(r4) : [],
  };
}

/**
 * Extract glass-box rules from a commaANFIS result (the HAL/veto decision path). commaANFIS exposes
 * ruleWeights + dissonance but NO LASSO features (it is not the routing path) — so lassoDrivers is
 * correctly empty and hasLassoDrivers=false. Dissonance is surfaced in the summary (real signal).
 */
export function extractFromCommaResult(res: { ruleWeights: number[]; dissonance?: number; vetoed?: boolean }): ExtractedRules {
  const { firedRules, topRule, hasRuleWeights } = extractFiredRules(res.ruleWeights);
  const base = summarizeExtraction(firedRules, topRule, []);
  const diss = typeof res.dissonance === 'number' ? ` comma-dissonance=${r4(res.dissonance)}${res.vetoed ? ' (VETOED)' : ''}.` : '';
  return {
    firedRules,
    topRule,
    lassoDrivers: [],
    hasRuleWeights,
    hasLassoDrivers: false,
    summary: base + diss,
    ruleWeights: res.ruleWeights ? res.ruleWeights.map(r4) : [],
  };
}
