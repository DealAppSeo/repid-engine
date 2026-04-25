/**
 * HAL v2 — ANFIS query classifier.
 *
 * Routes incoming (query, claim) pairs to the appropriate starting tier.
 * Classification is the cheap-first part of the pipeline so we don't burn
 * Tier 2/3 spend on queries that an SLM should resolve, or on opinion /
 * creative content that doesn't have a factual ground truth at all.
 *
 * Implementation strategy:
 *  - Use the cheapest available SLM for classification when keys exist.
 *  - When mock mode is on, classify via lightweight heuristics so the
 *    orchestrator can be benchmarked end-to-end.
 *  - Cache classifications by (query, claim) hash so repeat checks don't
 *    re-bill the LLM.
 */
import { createHash } from 'crypto';
import {
  ModelSpec, callModel, providerKeyAvailable, isMockMode,
} from './hal-providers';

export type QueryType =
  | 'geographic' | 'mathematical' | 'historical' | 'scientific'
  | 'temporal' | 'opinion' | 'creative' | 'unclassified';

export interface QueryClassification {
  query_type: QueryType;
  in_slm_wheelhouse: boolean;
  recommended_starting_tier: 0 | 1 | 2 | 3; // 0 = OUT_OF_SCOPE
  domain: string;
  confidence: number;
  reasoning: string;
}

const cache = new Map<string, QueryClassification>();

function cacheKey(query: string, claim: string): string {
  return createHash('sha256').update(query + '\u0000' + claim).digest('hex');
}

function pickClassifierModel(): ModelSpec | null {
  if (isMockMode()) {
    return { provider: 'cerebras', model: 'mock-classifier', display_name: 'mock' };
  }
  if (providerKeyAvailable('groq')) {
    return { provider: 'groq', model: 'llama-3.1-8b-instant', display_name: 'Llama 3.1 8B (Groq)',
      cost_per_million_in_usd: 0.05, cost_per_million_out_usd: 0.08 };
  }
  if (providerKeyAvailable('cerebras')) {
    return { provider: 'cerebras', model: 'llama-3.3-70b', display_name: 'Llama 3.3 70B (Cerebras)' };
  }
  if (providerKeyAvailable('fireworks')) {
    return { provider: 'fireworks', model: 'accounts/fireworks/models/qwen2p5-7b-instruct',
      display_name: 'Qwen 2.5 7B (Fireworks)' };
  }
  if (providerKeyAvailable('anthropic')) {
    return { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' };
  }
  if (providerKeyAvailable('openai')) {
    return { provider: 'openai', model: 'gpt-5-mini', display_name: 'GPT-5 mini' };
  }
  return null;
}

function heuristicClassify(query: string, claim: string): QueryClassification {
  const q = (query + ' ' + claim).toLowerCase();

  const opinion = /(\bbest\b|\bbetter than\b|favourite|favorite|most\s+(beautiful|underrated|overrated|important|amazing|wonderful)|prettier|prettiest|tastier|funniest|funnier|nicer|cooler|greatest\b|should we|should\s+(remote|in-person|i|you|companies|society|we)|in my opinion|i think|do you prefer|preferable|acceptable on|acceptable\?|opinion)/i.test(q);
  if (opinion) {
    return {
      query_type: 'opinion',
      in_slm_wheelhouse: false,
      recommended_starting_tier: 0,
      domain: 'general',
      confidence: 0.85,
      reasoning: 'Subjective markers detected (best/favourite/should/etc.). No factual ground truth to verify.',
    };
  }
  const creative = /(write a|compose a|tell me a story|draft a poem|imagine|hypothetically|pretend|fiction)/i.test(q);
  if (creative) {
    return {
      query_type: 'creative',
      in_slm_wheelhouse: false,
      recommended_starting_tier: 0,
      domain: 'general',
      confidence: 0.85,
      reasoning: 'Creative / hypothetical task — no fact-check applicable.',
    };
  }

  const geographic = /(capital of|city of|country|continent|located in|river|ocean|mountain|located|where is)/i.test(q);
  if (geographic) {
    return {
      query_type: 'geographic',
      in_slm_wheelhouse: true,
      recommended_starting_tier: 1,
      domain: 'general',
      confidence: 0.9,
      reasoning: 'Geographic factual query — well within SLM wheelhouse.',
    };
  }
  const math = /(\d+\s*[\+\-\*\/x×÷]\s*\d+|sqrt|square root|derivative|integral|equation|theorem|proof|sum of|product of|prime number|factorial)/i.test(q);
  if (math) {
    const complex = /(derivative|integral|theorem|proof)/i.test(q) || query.length > 200;
    return {
      query_type: 'mathematical',
      in_slm_wheelhouse: !complex,
      recommended_starting_tier: complex ? 2 : 1,
      domain: 'mathematics',
      confidence: 0.85,
      reasoning: complex
        ? 'Multi-step mathematical reasoning — escalate to mini frontier.'
        : 'Basic arithmetic — SLM territory.',
    };
  }
  const historical = /(in \d{3,4}|year \d{3,4}|war|empire|treaty|revolution|founded|invented|discovered|ancient|medieval)/i.test(q);
  if (historical) {
    return {
      query_type: 'historical',
      in_slm_wheelhouse: true,
      recommended_starting_tier: 1,
      domain: 'history',
      confidence: 0.8,
      reasoning: 'Historical factual query — common-knowledge SLM tier.',
    };
  }
  const scientific = /(speed of light|gravity|electron|atom|molecule|cell|dna|enzyme|element|periodic|boiling point|melting|orbit|planet|galaxy|species|evolution|photosynthesis)/i.test(q);
  if (scientific) {
    return {
      query_type: 'scientific',
      in_slm_wheelhouse: true,
      recommended_starting_tier: 1,
      domain: 'science',
      confidence: 0.85,
      reasoning: 'Scientific factual query — SLM tier viable.',
    };
  }
  const temporal = /(current|today|now|latest|this year|recent|2024|2025|2026)/i.test(q);
  if (temporal) {
    return {
      query_type: 'temporal',
      in_slm_wheelhouse: false,
      recommended_starting_tier: 2,
      domain: 'current_events',
      confidence: 0.7,
      reasoning: 'Time-sensitive query — SLMs may have stale training data.',
    };
  }
  return {
    query_type: 'unclassified',
    in_slm_wheelhouse: false,
    recommended_starting_tier: 1,
    domain: 'general',
    confidence: 0.4,
    reasoning: 'No strong type signal; default to Tier 1 with escalation enabled.',
  };
}

const SCHEMA_PROMPT = `You are a query classifier for a hallucination-detection system. Classify a (query, claim) pair into a JSON object with these exact keys:
- query_type: one of "geographic", "mathematical", "historical", "scientific", "temporal", "opinion", "creative", "unclassified"
- in_slm_wheelhouse: boolean — would a 3B–9B parameter open-weights model reliably know the correct answer?
- domain: short string — domain name (e.g., "geography", "physics", "us_history", "general")
- confidence: number 0–1 — your confidence in the classification
- reasoning: one short sentence

Output ONLY the JSON object. No code fences, no commentary.`;

function buildClassifierPrompt(query: string, claim: string): string {
  return `${SCHEMA_PROMPT}\n\nQuery: ${query}\nClaim: ${claim}`;
}

function deriveTier(
  query_type: QueryType,
  in_slm_wheelhouse: boolean,
  query: string,
): 0 | 1 | 2 | 3 {
  if (query_type === 'opinion' || query_type === 'creative') return 0;
  if (query_type === 'mathematical') {
    const complex = /(derivative|integral|theorem|proof)/i.test(query) || query.length > 200;
    return complex ? 2 : 1;
  }
  if (query_type === 'temporal') return 2;
  if (in_slm_wheelhouse) return 1;
  return 1;
}

export async function classifyQuery(
  query: string,
  claim: string,
): Promise<QueryClassification> {
  const key = cacheKey(query, claim);
  const cached = cache.get(key);
  if (cached) return cached;

  // Always start with the heuristic — it's free and often decisive on
  // opinion/creative inputs where we don't want to waste an LLM call.
  const heuristic = heuristicClassify(query, claim);
  if (heuristic.confidence >= 0.85) {
    cache.set(key, heuristic);
    return heuristic;
  }

  const model = pickClassifierModel();
  if (!model) {
    cache.set(key, heuristic);
    return heuristic;
  }

  if (isMockMode()) {
    cache.set(key, heuristic);
    return heuristic;
  }

  try {
    const r = await callModel(model, buildClassifierPrompt(query, claim), claim, 4000);
    if (!r.ok) {
      cache.set(key, heuristic);
      return heuristic;
    }
    const jsonText = (r.answer.match(/\{[\s\S]*\}/) || [r.answer])[0]!;
    const parsed = JSON.parse(jsonText) as Partial<QueryClassification>;
    const cls: QueryClassification = {
      query_type: (parsed.query_type as QueryType) || 'unclassified',
      in_slm_wheelhouse: !!parsed.in_slm_wheelhouse,
      recommended_starting_tier: 1,
      domain: parsed.domain || 'general',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      reasoning: parsed.reasoning || '',
    };
    cls.recommended_starting_tier = deriveTier(cls.query_type, cls.in_slm_wheelhouse, query);
    cache.set(key, cls);
    return cls;
  } catch {
    cache.set(key, heuristic);
    return heuristic;
  }
}

export function clearClassifierCache(): void {
  cache.clear();
}
