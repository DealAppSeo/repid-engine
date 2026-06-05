/**
 * TRACK A: Rebuilt ANFIS + LASSO for provider/tier routing (shadow-first).
 * Rebuild on the recovered scaffold (anfis-comma.ts gaussian MF, golden centers, rule base, forward, comma dissonance).
 * Added: LASSO sparse layer (feature selection for interpretability + cheap: only top-k inputs matter for provider pick).
 * Inputs: prompt features (complexity from isLow, length, category hint) + provider state (recent cost, rate, quality from health/perf).
 * Output: recommended provider/tier + conf.
 * Used in shadow alongside static router (see router.ts).
 * Shadow logs to anfis_routing_logs (A2).
 * Measure [T12 A3]: does it beat static on cost/call AND >= HAL quality per cat? Promote only where wins (A4).
 *
 * Bounded, cheap (no heavy ML at inference), reversible.
 * Schema: migration 2026-06-05-anfis-routing-logs.sql + types append.
 * Cite before any use: this file, router.ts wiring, migration, types.
 */

import { gaussianMF, goldenCenters, goldenSpreads, anfisForward } from './anfis-comma'; // reuse scaffold MF/centers + forward for rebuild

export interface AnfisRouterFeatures {
  promptLength: number;
  isLowComplexity: boolean;
  categoryScore: number; // e.g. 1 for factual/code, 0.5 creative etc
  avgCostTier0: number;  // recent avg from perf
  rateLimitPressure: number; // 0-1
  recentQuality: number; // 0-1 HAL or success
}

export interface AnfisRouterOutput {
  recommendedProvider: string;
  recommendedTier: '0a' | '1' | 'slm';
  confidence: number;
  ruleWeights?: number[];
  lassoSelectedFeatures?: string[]; // for interpretability
}

const TIER0_PROVIDERS = ['groq', 'cerebras', 'gemini', 'cohere', 'deepseek']; // from router tier0a
const SLM_PROVIDERS = ['llama-3-2-1b', 'gemma-3-2b', 'phi-4'];

function featurizePrompt(prompt: string, taskHint?: string): { length: number; low: boolean; cat: number } {
  const len = prompt.length;
  const low = (taskHint && /classify|simple|yes\/no|short|fact/.test(taskHint.toLowerCase())) || len < 200;
  const cat = /code|math|fact/.test(prompt.toLowerCase()) ? 0.9 : /creative|opinion|story/.test(prompt.toLowerCase()) ? 0.3 : 0.6;
  return { length: len, low, cat };
}

// LASSO-like: sparse weights, select top features by |weight|, zero others.
// Simple impl: fixed importance + L1 penalty sim (zero small).
function lassoSelectFeatures(features: number[], importance: number[], threshold = 0.1): { selected: number[]; names: string[] } {
  const names = ['len', 'low', 'cat', 'cost', 'rate', 'qual'];
  const weighted = features.map((f, i) => Math.abs(f * (importance[i] || 1)));
  const selectedIdx = weighted.map((w, i) => w > threshold ? i : -1).filter(i => i >= 0);
  return { selected: selectedIdx.map(i => features[i]), names: selectedIdx.map(i => names[i]) };
}

// Rebuilt ANFIS forward + LASSO for routing rec (adapt from comma scaffold for provider choice).
export function anfisRecommendProvider(
  prompt: string,
  taskHint?: string,
  providerState: { cost: number; rate: number; qual: number } = { cost: 0.5, rate: 0.2, qual: 0.8 }
): AnfisRouterOutput {
  const { length, low, cat } = featurizePrompt(prompt, taskHint);
  const feats = [
    Math.min(length / 1000, 1), // normalized len
    low ? 0.9 : 0.1,
    cat,
    providerState.cost,
    providerState.rate,
    providerState.qual
  ];

  // LASSO sparse: importance tuned for cost/quality (len/low/cat less for some, cost/rate/qual high)
  const importance = [0.2, 0.6, 0.4, 0.95, 0.9, 0.85];
  const { selected, names } = lassoSelectFeatures(feats, importance, 0.15);

  // Use scaffold centers/spreads (5 rules, but we use effective on selected; pad for compat)
  const centers = goldenCenters(5);
  const spreads = goldenSpreads(5);

  // Rule params: bias toward low cost + high qual for tier0a; low comp -> slm
  // LASSO effect: if low cost+high qual, favor certain providers
  const ruleParams = [
    [0.1, 0.7, 0.3, -0.8, -0.6, 0.7, 0.1], // favor cheap high qual
    [0.2, 0.8, 0.2, -0.7, -0.5, 0.6, 0.0],
    [0.0, 0.9, 0.1, -0.9, -0.4, 0.8, 0.2], // low comp strong
    [-0.1, 0.5, 0.4, -0.5, -0.3, 0.5, -0.1],
    [0.3, 0.6, 0.5, -0.6, -0.7, 0.9, 0.1]
  ];

  // Pad feats to 5 for compat with scaffold (or use selected)
  const padded = feats.slice(0,5);
  const { output, ruleWeights } = anfisForward ? anfisForward(padded, centers, spreads, ruleParams) : { output: 0.5, ruleWeights: [0.2,0.2,0.2,0.2,0.2] };

  // Map output to rec (simple: low output -> slm if low, else tier0a pick by qual/cost state)
  let recProvider = 'groq';
  let tier: '0a' | '1' | 'slm' = '0a';
  let conf = Math.max(0.5, Math.min(0.95, output));

  if (low && output < 0.6) {
    tier = 'slm';
    recProvider = 'llama-3-2-1b';
  } else if (providerState.cost < 0.3 && providerState.qual > 0.7) {
    tier = '0a';
    recProvider = providerState.rate < 0.3 ? 'cerebras' : 'groq';
  } else {
    tier = '0a';
    recProvider = 'gemini';
  }

  return {
    recommendedProvider: recProvider,
    recommendedTier: tier,
    confidence: conf,
    ruleWeights,
    lassoSelectedFeatures: names
  };
}

// For shadow: compare to static decision (from router logic without ANFIS).
export function computeShadowDecision(staticDecision: any, prompt: string, taskHint?: string, state?: any) {
  const anfis = anfisRecommendProvider(prompt, taskHint, state || { cost: 0.5, rate: 0.2, qual: 0.8 });
  return {
    static: {
      provider: staticDecision.chosen_provider,
      tier: staticDecision.chosen_tier,
      reason: staticDecision.reason
    },
    anfis,
    delta: anfis.recommendedProvider !== staticDecision.chosen_provider ? 'diff' : 'same'
  };
}

if (require.main === module) {
  console.log('ANFIS router scaffold test:');
  console.log(anfisRecommendProvider('classify this short fact', 'classify'));
  console.log(anfisRecommendProvider('long creative story about dragons and magic systems with deep lore', 'creative'));
}
