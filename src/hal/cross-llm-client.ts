/**
 * HAL Phase 1.5 — Layer 1 cross-LLM client (repid-engine side).
 *
 * Mirrors the API surface of the canonical
 * trinity-ecosystem/lib/trust/cross-llm-verifier.ts module so HAL can call
 * cross-LLM agreement checks in-process without taking a cross-package
 * runtime dependency on trinity-ecosystem.
 *
 * If CROSS_LLM_VERIFIER_URL is set in env, posts to that URL (HTTP
 * variant — useful when the canonical module runs in the trinity-ecosystem
 * Next.js app). Otherwise calls the same providers directly using the
 * same Llama+GPT-OSS pair on Groq.
 *
 * Persistence: cross_llm_comparisons (Supabase) — same table.
 */

import crypto from 'crypto';
import { db } from '../db';

export interface ProviderAnswer {
  provider: string;
  model: string;
  answer: string;
  latency_ms: number;
  error?: string;
}

export interface CrossLLMResult {
  prompt_hash: string;
  answers: ProviderAnswer[];
  agreement_score: number;
  embedding_distance: number;
  methodology: 'embedding-cosine' | 'fallback-jaccard';
  latency_ms: number;
}

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const OPENAI_EMBEDDING_ENDPOINT = 'https://api.openai.com/v1/embeddings';
const PROVIDER_1_MODEL = 'llama-3.1-8b-instant';
const PROVIDER_2_MODEL = 'openai/gpt-oss-20b';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const ANSWER_MAX_TOKENS = 400;
const DEFAULT_TIMEOUT_MS = 10000;

const ANSWER_SYSTEM_PROMPT =
  "You are a careful, truthful assistant. Answer in 1-3 sentences. " +
  "If you do not know, say so. Never fabricate facts. No preamble.";

function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 32);
}

async function callGroqChat(
  apiKey: string,
  model: string,
  userPrompt: string,
  timeoutMs: number,
): Promise<{ text: string; latency_ms: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: ANSWER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: ANSWER_MAX_TOKENS,
        temperature: 0.1,
      }),
      signal: ctrl.signal,
    });
    const latency_ms = Date.now() - start;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`groq ${res.status}: ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    let text: string = (data?.choices?.[0]?.message?.content ?? '').trim();
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    text = text.replace(/^<think>[\s\S]*$/i, '').trim();
    return { text, latency_ms };
  } finally {
    clearTimeout(timer);
  }
}

async function queryGroqModel(
  model: string,
  apiKey: string,
  prompt: string,
  timeoutMs: number,
): Promise<ProviderAnswer> {
  const start = Date.now();
  try {
    const { text, latency_ms } = await callGroqChat(apiKey, model, prompt, timeoutMs);
    return { provider: 'groq', model, answer: text, latency_ms };
  } catch (e: any) {
    return {
      provider: 'groq', model, answer: '',
      latency_ms: Date.now() - start,
      error: e?.message ?? String(e),
    };
  }
}

async function getEmbedding(
  text: string, apiKey: string, model: string, timeoutMs: number,
): Promise<number[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(OPENAI_EMBEDDING_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: text }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`embedding ${res.status}: ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    const vec: number[] = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('empty embedding vector');
    }
    return vec;
  } finally {
    clearTimeout(timer);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function jaccardSimilarity(a: string, b: string): number {
  const tok = (s: string) => new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 1)
  );
  const sa = tok(a), sb = tok(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

async function persist(promptHash: string, r: CrossLLMResult): Promise<void> {
  try {
    await db.from('cross_llm_comparisons').insert({
      prompt_hash: promptHash,
      provider_1: r.answers[0]?.provider ?? 'unknown',
      provider_2: r.answers[1]?.provider ?? 'unknown',
      model_1: r.answers[0]?.model ?? null,
      model_2: r.answers[1]?.model ?? null,
      agreement_score: r.agreement_score,
      embedding_distance: r.embedding_distance,
      methodology: r.methodology,
      latency_ms: r.latency_ms,
      answer_1_preview: (r.answers[0]?.answer ?? '').slice(0, 500),
      answer_2_preview: (r.answers[1]?.answer ?? '').slice(0, 500),
    });
  } catch (e: any) {
    console.error('[cross-llm-client] persist failed:', e?.message ?? e);
  }
}

async function compareViaHttp(
  url: string, prompt: string, timeoutMs: number,
): Promise<CrossLLMResult | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`[cross-llm-client] HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as CrossLLMResult;
  } catch (e: any) {
    console.error('[cross-llm-client] HTTP error:', e?.message ?? e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkCrossLLM(
  prompt: string,
  opts: { persist?: boolean; timeoutMs?: number } = {},
): Promise<CrossLLMResult | null> {
  const persistFlag = opts.persist !== false;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const httpUrl = process.env.CROSS_LLM_VERIFIER_URL;
  if (httpUrl) {
    const r = await compareViaHttp(httpUrl, prompt, timeoutMs);
    if (r) return r;
    // fall through to in-process on HTTP failure
  }

  const groqKey = process.env.GROQ_API_KEY ?? '';
  const openaiKey = process.env.OPENAI_API_KEY ?? '';
  if (!groqKey) {
    console.error('[cross-llm-client] GROQ_API_KEY missing — skipping');
    return null;
  }

  const start = Date.now();
  const [a1, a2] = await Promise.all([
    queryGroqModel(PROVIDER_1_MODEL, groqKey, prompt, timeoutMs),
    queryGroqModel(PROVIDER_2_MODEL, groqKey, prompt, timeoutMs),
  ]);
  const answers = [a1, a2];
  const promptHash = hashPrompt(prompt);

  const bothAnswered = !a1.error && !a2.error && a1.answer && a2.answer;
  let agreement_score = 0;
  let embedding_distance = 1;
  let methodology: 'embedding-cosine' | 'fallback-jaccard' = 'fallback-jaccard';

  if (bothAnswered) {
    let usedEmbedding = false;
    if (openaiKey) {
      try {
        const [v1, v2] = await Promise.all([
          getEmbedding(a1.answer, openaiKey, EMBEDDING_MODEL, timeoutMs),
          getEmbedding(a2.answer, openaiKey, EMBEDDING_MODEL, timeoutMs),
        ]);
        const sim = cosineSimilarity(v1, v2);
        agreement_score = Math.max(0, Math.min(1, sim));
        embedding_distance = Math.max(0, 1 - sim);
        methodology = 'embedding-cosine';
        usedEmbedding = true;
      } catch (e: any) {
        // fall through to jaccard
      }
    }
    if (!usedEmbedding) {
      const sim = jaccardSimilarity(a1.answer, a2.answer);
      agreement_score = sim;
      embedding_distance = 1 - sim;
      methodology = 'fallback-jaccard';
    }
  }

  const result: CrossLLMResult = {
    prompt_hash: promptHash,
    answers,
    agreement_score: Number(agreement_score.toFixed(4)),
    embedding_distance: Number(embedding_distance.toFixed(4)),
    methodology,
    latency_ms: Date.now() - start,
  };
  if (persistFlag) void persist(promptHash, result);
  return result;
}
