/**
 * HAL v2 — Tier 1: SLM cross-check.
 *
 * Three small open-weights models from independent families. Cheap, fast,
 * broad coverage. Default models target Cerebras (Llama 3.2 / 3.3) and
 * Fireworks (Gemma 3, Qwen 2.5). Fallback: any available SLM provider.
 *
 * This tier is the entry point for queries the classifier deems "in SLM
 * wheelhouse" — basic factual / geographic / common knowledge.
 */
import {
  ModelSpec, ModelCallResult, callModel, buildJudgePrompt, parseVote,
  providerKeyAvailable, isMockMode, ProviderId,
} from './hal-providers';

export interface TierResult {
  tier: 1 | 2 | 3;
  consensus: 'AGREE' | 'AGREE_DIFFERENT' | 'SPLIT' | 'ALL_DIFFERENT' | 'TIMEOUT' | 'NO_PROVIDERS';
  responses: Array<{
    provider: ProviderId;
    model: string;
    vote: 'CORRECT' | 'INCORRECT' | 'UNCERTAIN' | 'ERROR';
    correction: string;
    latency_ms: number;
    cost_usd: number;
    error?: string;
  }>;
  consensus_answer?: string;     // when AGREE_DIFFERENT, the corrected answer
  consensus_vote?: 'CORRECT' | 'INCORRECT' | 'UNCERTAIN';
  disagreement_count: number;
  cost_estimate_usd: number;
  total_latency_ms: number;
  escalation_recommended: boolean;
}

const TIER1_DEFAULT_MODELS: ModelSpec[] = [
  { provider: 'cerebras',  model: 'llama-3.3-70b',                   display_name: 'Llama 3.3 70B (Cerebras)',
    cost_per_million_in_usd: 0.85, cost_per_million_out_usd: 1.20 },
  { provider: 'fireworks', model: 'accounts/fireworks/models/qwen2p5-7b-instruct', display_name: 'Qwen 2.5 7B (Fireworks)',
    cost_per_million_in_usd: 0.20, cost_per_million_out_usd: 0.20 },
  { provider: 'fireworks', model: 'accounts/fireworks/models/gemma2-9b-it',  display_name: 'Gemma 2 9B (Fireworks)',
    cost_per_million_in_usd: 0.20, cost_per_million_out_usd: 0.20 },
];

// Fallback when neither Cerebras nor Fireworks keys are present.
const TIER1_FALLBACK_MODELS: ModelSpec[] = [
  { provider: 'groq', model: 'llama-3.3-70b-versatile', display_name: 'Llama 3.3 70B (Groq)',
    cost_per_million_in_usd: 0.59, cost_per_million_out_usd: 0.79 },
  { provider: 'groq', model: 'gemma2-9b-it',           display_name: 'Gemma 2 9B (Groq)',
    cost_per_million_in_usd: 0.20, cost_per_million_out_usd: 0.20 },
  { provider: 'groq', model: 'qwen-qwq-32b',           display_name: 'Qwen QwQ 32B (Groq)',
    cost_per_million_in_usd: 0.29, cost_per_million_out_usd: 0.39 },
];

export function selectTier1Models(override?: ModelSpec[]): ModelSpec[] {
  if (override?.length) return override;
  if (isMockMode()) return TIER1_DEFAULT_MODELS; // shape only; mock ignores keys
  const haveDefaults =
    providerKeyAvailable('cerebras') || providerKeyAvailable('fireworks');
  if (haveDefaults) {
    return TIER1_DEFAULT_MODELS.filter(m => providerKeyAvailable(m.provider));
  }
  if (providerKeyAvailable('groq')) {
    return TIER1_FALLBACK_MODELS;
  }
  return [];
}

export async function tier1SlmConsensus(
  query: string,
  claim: string,
  options?: { models?: ModelSpec[]; timeout_ms?: number },
): Promise<TierResult> {
  const models = selectTier1Models(options?.models);
  const timeoutMs = options?.timeout_ms ?? 3000;
  return runTier(1, models, query, claim, timeoutMs);
}

/** Shared tier execution — also reused by tier 2 and tier 3. */
export async function runTier(
  tier: 1 | 2 | 3,
  models: ModelSpec[],
  query: string,
  claim: string,
  timeoutMs: number,
): Promise<TierResult> {
  if (models.length === 0) {
    return {
      tier, consensus: 'NO_PROVIDERS',
      responses: [], disagreement_count: 0,
      cost_estimate_usd: 0, total_latency_ms: 0,
      escalation_recommended: true,
    };
  }

  const prompt = buildJudgePrompt(query, claim);
  const start = Date.now();
  const settled = await Promise.allSettled(models.map(m => callModel(m, prompt, claim, timeoutMs)));

  const responses: TierResult['responses'] = settled.map((s, i) => {
    const m = models[i]!;
    if (s.status === 'rejected' || !s.value.ok) {
      const r: ModelCallResult | undefined = s.status === 'fulfilled' ? s.value : undefined;
      return {
        provider: m.provider,
        model: m.model,
        vote: 'ERROR',
        correction: '',
        latency_ms: r?.latency_ms ?? timeoutMs,
        cost_usd: 0,
        error: r?.error || (s.status === 'rejected' ? String(s.reason) : 'unknown'),
      };
    }
    const parsed = parseVote(s.value.answer);
    return {
      provider: m.provider,
      model: m.model,
      vote: parsed.vote,
      correction: parsed.correction,
      latency_ms: s.value.latency_ms,
      cost_usd: s.value.cost_estimate_usd,
    };
  });

  const totalLatency = Date.now() - start;
  const totalCost = responses.reduce((a, r) => a + r.cost_usd, 0);

  const valid = responses.filter(r => r.vote !== 'ERROR');
  if (valid.length === 0) {
    return {
      tier, consensus: 'TIMEOUT', responses,
      disagreement_count: 0, cost_estimate_usd: totalCost, total_latency_ms: totalLatency,
      escalation_recommended: true,
    };
  }

  const tally: Record<string, number> = { CORRECT: 0, INCORRECT: 0, UNCERTAIN: 0 };
  for (const r of valid) tally[r.vote] = (tally[r.vote] ?? 0) + 1;
  const correct = tally['CORRECT']!;
  const incorrect = tally['INCORRECT']!;
  const uncertain = tally['UNCERTAIN']!;

  // ALL_AGREE_DIFFERENT: every valid responder said INCORRECT — strongest
  // hallucination signal. Pick the most common correction.
  if (valid.length >= 2 && incorrect === valid.length) {
    const correction = mostFrequentCorrection(valid.map(v => v.correction).filter(Boolean));
    return {
      tier, consensus: 'AGREE_DIFFERENT',
      responses,
      consensus_answer: correction || 'unknown',
      consensus_vote: 'INCORRECT',
      disagreement_count: 0,
      cost_estimate_usd: totalCost,
      total_latency_ms: totalLatency,
      escalation_recommended: false,
    };
  }

  // AGREE: 2+ of 3 say CORRECT or 2+ say UNCERTAIN with no INCORRECT.
  if (correct >= 2 && incorrect === 0) {
    return {
      tier, consensus: 'AGREE',
      responses,
      consensus_vote: 'CORRECT',
      disagreement_count: valid.length - correct,
      cost_estimate_usd: totalCost,
      total_latency_ms: totalLatency,
      escalation_recommended: false,
    };
  }
  if (uncertain >= 2 && correct === 0 && incorrect === 0) {
    return {
      tier, consensus: 'AGREE',
      responses,
      consensus_vote: 'UNCERTAIN',
      disagreement_count: valid.length - uncertain,
      cost_estimate_usd: totalCost,
      total_latency_ms: totalLatency,
      escalation_recommended: true, // uncertain consensus → escalate
    };
  }

  // Otherwise: SPLIT or ALL_DIFFERENT — escalate.
  const distinct = new Set(valid.map(v => v.vote)).size;
  return {
    tier,
    consensus: distinct >= 3 ? 'ALL_DIFFERENT' : 'SPLIT',
    responses,
    disagreement_count: valid.length - Math.max(correct, incorrect, uncertain),
    cost_estimate_usd: totalCost,
    total_latency_ms: totalLatency,
    escalation_recommended: true,
  };
}

function mostFrequentCorrection(corrections: string[]): string {
  if (corrections.length === 0) return '';
  const counts: Record<string, number> = {};
  for (const c of corrections) {
    const norm = c.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
    counts[norm] = (counts[norm] ?? 0) + 1;
  }
  let best = '';
  let bestN = 0;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestN) { bestN = n; best = k; }
  }
  return best;
}
