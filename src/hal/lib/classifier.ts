/**
 * Layer 0 prompt classifier — DI form.
 *
 * Ported from src/hal/classifier.ts:156-210 with no semantic change other
 * than env-key lookup being replaced by caller-supplied provider config.
 *
 * Single classifier provider (default: Groq llama-3.1-8b-instant) — chosen
 * for p50 < 200ms. Strict JSON output mode where supported.
 */
import crypto from 'crypto';
import type { HALProviderConfig } from './types';

export type Category =
  | 'factual'
  | 'opinion'
  | 'math'
  | 'code'
  | 'creative'
  | 'time-sensitive';

export type Confidence = 'high' | 'medium' | 'low';

export interface ClassificationResult {
  category: Category;
  confidence: Confidence;
  latency_ms: number;
  provider: string;
  model: string;
  raw?: string;
}

export interface ClassifyOptions {
  /** Required for live calls. Pass `null` to force the fallback (no-key) path. */
  provider: HALProviderConfig | null;
  /** Supabase client for hal_classifications persistence. Null/undefined ⇒ no logging. */
  supabase?: unknown | null;
  /** Default true — set false to skip Supabase writes. */
  persist?: boolean;
}

const VALID_CATEGORIES: Category[] = [
  'factual', 'opinion', 'math', 'code', 'creative', 'time-sensitive',
];
const VALID_CONFIDENCES: Confidence[] = ['high', 'medium', 'low'];

const SYSTEM_PROMPT = `Classify a prompt into ONE category. Return only JSON: {"category":"X","confidence":"high|medium|low"}.

Categories:
- time-sensitive: needs current/today/now/latest/price/score/this-week info. (e.g. "BTC price now?")
- math: arithmetic, equation, integral, derivative, computation. (e.g. "47*53?")
- code: read/write/fix/explain source code, syntax, libraries. (e.g. "Python quicksort")
- creative: story, poem, brainstorm names, lyrics, fiction. (e.g. "Haiku about rain")
- opinion: best/favorite/should/recommend/prefer/pros-cons. (e.g. "Best language?")
- factual: verifiable fact/definition/historical claim with single ground truth. (e.g. "Who wrote Hamlet?")

Rules: time-sensitive overrides factual when temporal markers present. Math overrides factual when computation asked. Code wins when source/syntax involved. Creative only when generation explicitly requested.
Confidence: high=unambiguous, medium=fits two, low=malformed.`;

const DEFAULT_TIMEOUT_MS = 5000;

function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 32);
}

async function callGroqCompat(
  prompt: string, provider: HALProviderConfig,
): Promise<{ raw: string; latency_ms: number }> {
  const ctrl = new AbortController();
  const timeoutMs = provider.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(provider.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Classify this prompt:\n${prompt}` },
        ],
        max_tokens: 40,
        temperature: 0.0,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    const latency_ms = Date.now() - start;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`groq ${res.status}: ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    const raw = data?.choices?.[0]?.message?.content ?? '';
    return { raw, latency_ms };
  } finally {
    clearTimeout(timer);
  }
}

function parseClassification(raw: string): {
  category: Category;
  confidence: Confidence;
} {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[^}]*\}/);
    if (!match) throw new Error('no JSON object in classifier output');
    parsed = JSON.parse(match[0]);
  }
  const category = String(parsed.category || '').toLowerCase().trim() as Category;
  const confidence = String(parsed.confidence || '').toLowerCase().trim() as Confidence;
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`invalid category: ${category}`);
  }
  if (!VALID_CONFIDENCES.includes(confidence)) {
    throw new Error(`invalid confidence: ${confidence}`);
  }
  return { category, confidence };
}

async function persistClassification(
  supabase: any, promptHash: string, result: ClassificationResult,
): Promise<void> {
  if (!supabase || typeof supabase.from !== 'function') return;
  try {
    await supabase.from('hal_classifications').insert({
      prompt_hash: promptHash,
      category: result.category,
      confidence: result.confidence,
      latency_ms: result.latency_ms,
      provider: result.provider,
      model: result.model,
    });
  } catch (e: any) {
    console.error('[hal/lib/classifier] persist failed:', e?.message ?? e);
  }
}

/**
 * Classify a prompt into one of 6 categories. On any error or missing
 * provider, returns a `factual / low / fallback` result rather than
 * throwing — the upstream HAL composer treats fallback as "skip Layer 1
 * cross-LLM check."
 */
export async function classify(
  prompt: string,
  opts: ClassifyOptions,
): Promise<ClassificationResult> {
  if (!opts.provider || !opts.provider.apiKey) {
    return {
      category: 'factual',
      confidence: 'low',
      latency_ms: 0,
      provider: 'fallback',
      model: 'no-key',
    };
  }

  const persist = opts.persist !== false;

  let attempt = 0;
  let lastErr: any;
  while (attempt < 2) {
    try {
      const { raw, latency_ms } = await callGroqCompat(prompt, opts.provider);
      const { category, confidence } = parseClassification(raw);
      const result: ClassificationResult = {
        category, confidence, latency_ms,
        provider: opts.provider.provider,
        model: opts.provider.model,
        raw,
      };
      if (persist && opts.supabase) {
        const promptHash = hashPrompt(prompt);
        void persistClassification(opts.supabase, promptHash, result);

        // NEW: Dual-write to hal_evaluations (unified architecture)
        try {
          const { writeHalEvaluation } = require('../../services/hal-evaluations-writer');
          void writeHalEvaluation({
            mode: 'production',
            prompt_text: prompt,
            prompt_source: 'production_traffic',
            gen_provider: result.provider,
            gen_model: result.model,
            gen_latency_ms: result.latency_ms,
            hal_signals: result,
            // Layer 0 classifier produces a category, not a numeric hal_score.
            hal_score: undefined,
            // Layer 0 classifier categorizes prompts; it does not render APPROVE/HITL/BLOCK verdicts.
            decision: undefined,
            notes: `Layer 0 classification: category=${result.category} confidence=${result.confidence}`
          });
        } catch (e) {
          // writer helper handles its own internal errors; this catch is for require/params errors
          console.warn('[hal/lib/classifier] dual-write hook failed:', e);
        }
      }
      return result;
    } catch (e: any) {
      lastErr = e;
      attempt += 1;
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 250 * attempt));
      }
    }
  }

  console.error('[hal/lib/classifier] failed after retry:', lastErr?.message ?? lastErr);
  return {
    category: 'factual',
    confidence: 'low',
    latency_ms: 0,
    provider: 'fallback',
    model: 'parse-error',
  };
}
