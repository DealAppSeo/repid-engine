/**
 * HAL Phase 1.5 — Layer 0 ANFIS Prompt-Category Classifier
 *
 * Cheap SLM call that routes a prompt into one of six categories.
 * Used by HAL extractor to gate cross-LLM verification (Layer 1):
 * only `factual` and `time-sensitive` trigger the (more expensive)
 * cross-LLM fan-out, since those are the categories where two LLMs
 * could disagree on ground truth.
 *
 * Provider: groq llama-3.1-8b-instant (selected for p50 < 200ms; 8B
 * is sufficient for 6-class classification with few-shot grounding).
 *
 * Persistence: hal_classifications table (Supabase).
 */

import crypto from 'crypto';
import { db } from '../db';

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
  apiKey?: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
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

const DEFAULT_MODEL = 'llama-3.1-8b-instant';
const DEFAULT_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 5000;

function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 32);
}

async function callGroq(
  prompt: string,
  apiKey: string,
  model: string,
  endpoint: string,
  timeoutMs: number,
): Promise<{ raw: string; latency_ms: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
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
  promptHash: string,
  result: ClassificationResult,
): Promise<void> {
  try {
    await db.from('hal_classifications').insert({
      prompt_hash: promptHash,
      category: result.category,
      confidence: result.confidence,
      latency_ms: result.latency_ms,
      provider: result.provider,
      model: result.model,
    });
  } catch (e: any) {
    console.error('[classifier] persist failed:', e?.message ?? e);
  }
}

export async function classify(
  prompt: string,
  opts: ClassifyOptions = {},
): Promise<ClassificationResult> {
  const apiKey = opts.apiKey ?? process.env.GROQ_API_KEY ?? '';
  const model = opts.model ?? DEFAULT_MODEL;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const persist = opts.persist !== false;

  if (!apiKey) {
    return {
      category: 'factual',
      confidence: 'low',
      latency_ms: 0,
      provider: 'fallback',
      model: 'no-key',
    };
  }

  let attempt = 0;
  let lastErr: any;
  while (attempt < 2) {
    try {
      const { raw, latency_ms } = await callGroq(
        prompt, apiKey, model, endpoint, timeoutMs,
      );
      const { category, confidence } = parseClassification(raw);
      const result: ClassificationResult = {
        category, confidence, latency_ms,
        provider: 'groq', model, raw,
      };
      if (persist) {
        const promptHash = hashPrompt(prompt);
        void persistClassification(promptHash, result);
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

  console.error('[classifier] failed after retry:', lastErr?.message ?? lastErr);
  return {
    category: 'factual',
    confidence: 'low',
    latency_ms: 0,
    provider: 'fallback',
    model: 'parse-error',
  };
}

if (require.main === module) {
  (async () => {
    const sample = process.argv.slice(2).join(' ') || 'Who wrote Hamlet?';
    const r = await classify(sample, { persist: false });
    console.log(JSON.stringify(r, null, 2));
  })();
}
