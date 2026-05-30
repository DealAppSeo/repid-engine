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
 * Next.js app). Otherwise calls the providers directly.
 *
 * Persistence: cross_llm_comparisons (Supabase).
 *
 * --- 2026-05-03 EXTENSION (CC1 sprint) ---
 *
 * Grew from 2 providers to 3 (groq + anthropic + deepseek) for true
 * cross-family redundancy — one provider per training-data family.
 * Added Pythagorean Comma BFT veto (P-003), ported from
 * trinity-ecosystem/lib/trust/BFTEngine.ts:checkPythagoreanComma.
 *
 * Per-provider belief is derived as b_i = mean(sim(answer_i, answer_j)
 * for j != i). Comma_gap = max(beliefs) - min(beliefs); avg = mean(beliefs).
 * Severity tiers preserved from BFTEngine (none / minor / major / critical);
 * only `critical` triggers a hard veto. Veto requires >= 3 providers
 * responding (gap is meaningless with 2).
 *
 * KNOWN LIMITATION: when CROSS_LLM_VERIFIER_URL is set, the HTTP path
 * routes to trinity-ecosystem's canonical module which has not yet been
 * upgraded to emit comma_veto / comma_gap / comma_severity. The HTTP-path
 * result coerces those fields to defaults (no veto, no severity). Mirror
 * upgrade in trinity-ecosystem is post-MVP work.
 */

import crypto from 'crypto';
import { db } from '../db';
import { createDefaultEmbeddingClient } from './lib/cross-llm/embedding-client';
import { logLlmCall } from '../billing/log-call';
import { calculateCost } from '../billing/pricing';

export type Squad = 'alpha' | 'beta' | 'gamma';
export type CommaSeverity = 'none' | 'minor' | 'major' | 'critical';

export interface ProviderAnswer {
  provider: string;
  squad: Squad;
  model: string;
  answer: string;
  latency_ms: number;
  error?: string;
}

export interface CrossLLMResult {
  prompt_hash: string;
  answers: ProviderAnswer[];
  agreement_score: number;        // mean of pairwise sims across answered providers
  embedding_distance: number;     // 1 - agreement_score
  methodology: 'embedding-cosine' | 'fallback-jaccard';
  // Pythagorean Comma BFT (P-003) — only meaningful with 3+ answered providers.
  comma_veto: boolean;            // true iff severity === 'critical'
  comma_gap: number | null;       // max(beliefs) - min(beliefs); null when < 3 answered
  comma_severity: CommaSeverity;  // 'none' default; tier-only telemetry below 'critical'
  beliefs: number[];              // per-provider belief = mean(sim with other answered)
  latency_ms: number;
}

const PYTHAGOREAN_COMMA_RATIO = 531441 / 524288;       // 1.0136433 — informational
const COMMA_VETO_GAP = 0.05;                            // BFTEngine.checkPythagoreanComma
const COMMA_VETO_AVG = 0.85;
const COMMA_MAJOR_GAP = 0.10;
const COMMA_MAJOR_AVG = 0.75;
const COMMA_MINOR_GAP = 0.15;

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const OPENAI_EMBEDDING_ENDPOINT = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const ANSWER_MAX_TOKENS = 400;
const DEFAULT_TIMEOUT_MS = 10000;

const ANSWER_SYSTEM_PROMPT =
  'You are a careful, truthful assistant. Answer in 1-3 sentences. ' +
  'If you do not know, say so. Never fabricate facts. No preamble.';

interface ProviderConfig {
  squad: Squad;
  provider: string;
  model: string;
  endpoint: string;
  apiKey: string;
  callType: 'openai-compat' | 'anthropic-native';
}

function buildProviderConfigs(): ProviderConfig[] {
  return [
    {
      squad: 'alpha',
      provider: 'groq',
      model: process.env.CROSS_LLM_PROVIDER_1_MODEL ?? 'llama-3.3-70b-versatile',
      endpoint: process.env.CROSS_LLM_PROVIDER_1_ENDPOINT ?? GROQ_ENDPOINT,
      apiKey: process.env.GROQ_API_KEY ?? '',
      callType: 'openai-compat',
    },
    {
      squad: 'beta',
      provider: 'anthropic',
      model: process.env.CROSS_LLM_PROVIDER_2_MODEL ?? 'claude-haiku-4-5-20251001',
      endpoint: process.env.CROSS_LLM_PROVIDER_2_ENDPOINT ?? ANTHROPIC_ENDPOINT,
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      callType: 'anthropic-native',
    },
    {
      squad: 'gamma',
      provider: 'deepseek',
      model: process.env.CROSS_LLM_PROVIDER_3_MODEL ?? 'deepseek-chat',
      endpoint: process.env.CROSS_LLM_PROVIDER_3_ENDPOINT ?? DEEPSEEK_ENDPOINT,
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
      callType: 'openai-compat',
    },
  ];
}

function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 32);
}

async function callOpenAICompat(
  endpoint: string, apiKey: string, model: string, prompt: string, timeoutMs: number,
): Promise<{ text: string; usage?: { prompt_tokens: number; completion_tokens: number } }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
          { role: 'system', content: ANSWER_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: ANSWER_MAX_TOKENS,
        temperature: 0.1,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status}: ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    let text: string = (data?.choices?.[0]?.message?.content ?? '').trim();
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    text = text.replace(/^<think>[\s\S]*$/i, '').trim();
    return {
      text,
      usage: {
        prompt_tokens: data.usage?.prompt_tokens || 0,
        completion_tokens: data.usage?.completion_tokens || 0,
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropicNative(
  endpoint: string, apiKey: string, model: string, prompt: string, timeoutMs: number,
): Promise<{ text: string; usage?: { prompt_tokens: number; completion_tokens: number } }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: ANSWER_MAX_TOKENS,
        temperature: 0.1,
        system: ANSWER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status}: ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
    const text = blocks
      .filter(b => b?.type === 'text')
      .map(b => String(b.text ?? ''))
      .join('')
      .trim();
    return {
      text,
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

async function queryProvider(
  cfg: ProviderConfig, prompt: string, timeoutMs: number,
): Promise<ProviderAnswer> {
  const start = Date.now();
  const call_id = crypto.randomUUID();
  const tier = cfg.provider === 'anthropic' || cfg.provider === 'openai' ? '1' : '0a';
  if (!cfg.apiKey) {
    return {
      provider: cfg.provider, squad: cfg.squad, model: cfg.model, answer: '',
      latency_ms: 0, error: 'api key not set',
    };
  }
  try {
    const res = cfg.callType === 'anthropic-native'
      ? await callAnthropicNative(cfg.endpoint, cfg.apiKey, cfg.model, prompt, timeoutMs)
      : await callOpenAICompat(cfg.endpoint, cfg.apiKey, cfg.model, prompt, timeoutMs);
    const latency_ms = Date.now() - start;
    const tokensIn = res.usage?.prompt_tokens || 0;
    const tokensOut = res.usage?.completion_tokens || 0;
    const cost_usd = calculateCost(cfg.provider, cfg.model, tokensIn, tokensOut);

    logLlmCall({
      call_id,
      provider: cfg.provider,
      tier,
      model: cfg.model,
      prompt_tokens: tokensIn,
      completion_tokens: tokensOut,
      cost_usd,
      latency_ms,
      status: 'success',
      task_hint: 'hal_cross_llm'
    }).catch(err => console.error('[cross-llm-client] logLlmCall error:', err));

    return {
      provider: cfg.provider, squad: cfg.squad, model: cfg.model,
      answer: res.text, latency_ms,
    };
  } catch (e: any) {
    const latency_ms = Date.now() - start;
    logLlmCall({
      call_id,
      provider: cfg.provider,
      tier,
      model: cfg.model,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      latency_ms,
      status: 'failed',
      error_message: e.message || String(e),
      task_hint: 'hal_cross_llm'
    }).catch(err => console.error('[cross-llm-client] logLlmCall error:', err));

    return {
      provider: cfg.provider, squad: cfg.squad, model: cfg.model, answer: '',
      latency_ms, error: e?.message ?? String(e),
    };
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

/**
 * Pythagorean Comma BFT veto check (P-003).
 * Ported from trinity-ecosystem/lib/trust/BFTEngine.ts:checkPythagoreanComma.
 *
 * Semantic shift: belief is no longer the provider's self-reported confidence;
 * it's derived from how much the provider's textual answer agrees with the
 * others. b_i = mean(sim(answer_i, answer_j) for j != i).
 *
 * Severity tiers (from BFTEngine):
 *   - critical: gap < 0.05 AND avg > 0.85 → VETO (coordinated bias signature)
 *   - major:    gap < 0.10 AND avg > 0.75 → log/monitor (no veto)
 *   - minor:    gap < 0.15                → log (no veto)
 *   - none:     else                       → healthy SBFA divergence
 *
 * Veto requires >= 3 providers responding — gap is meaningless with 2.
 */
// Phase 2.10: exported (was module-private) for CrossValidationServiceHandler.
// Public-export change only — behavior unchanged.
export function checkPythagoreanComma(beliefs: number[]): {
  severity: CommaSeverity;
  comma_gap: number | null;
  comma_veto: boolean;
} {
  if (beliefs.length < 3) {
    return { severity: 'none', comma_gap: null, comma_veto: false };
  }
  const gap = Math.max(...beliefs) - Math.min(...beliefs);
  const avg = beliefs.reduce((s, b) => s + b, 0) / beliefs.length;
  if (gap < COMMA_VETO_GAP && avg > COMMA_VETO_AVG) {
    return { severity: 'critical', comma_gap: gap, comma_veto: true };
  }
  if (gap < COMMA_MAJOR_GAP && avg > COMMA_MAJOR_AVG) {
    return { severity: 'major', comma_gap: gap, comma_veto: false };
  }
  if (gap < COMMA_MINOR_GAP) {
    return { severity: 'minor', comma_gap: gap, comma_veto: false };
  }
  return { severity: 'none', comma_gap: gap, comma_veto: false };
}

async function computeAgreement(
  answered: { idx: number; text: string }[],
  openaiKey: string,
  timeoutMs: number,
): Promise<{
  beliefs: number[];
  meanAgreement: number;
  methodology: 'embedding-cosine' | 'fallback-jaccard';
}> {
  const n = answered.length;
  if (n < 2) {
    return { beliefs: [], meanAgreement: 0, methodology: 'fallback-jaccard' };
  }

  let methodology: 'embedding-cosine' | 'fallback-jaccard' = 'fallback-jaccard';
  let embeddings: number[][] | null = null;

  try {
    const client = createDefaultEmbeddingClient(openaiKey, process.env.VOYAGE_API_KEY ? 'voyage' : undefined);
    embeddings = await client.embedMany(answered.map(a => a.text));
    methodology = 'embedding-cosine';
  } catch (e: any) {
    console.error('[cross-llm-client] embedding fallback:', e?.message ?? e);
    embeddings = null;
  }

  // Pairwise sim matrix (symmetric); compute upper triangle, mirror.
  const sims: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = embeddings
        ? cosineSimilarity(embeddings[i]!, embeddings[j]!)
        : jaccardSimilarity(answered[i]!.text, answered[j]!.text);
      sims[i]![j] = s;
      sims[j]![i] = s;
    }
  }

  const beliefs: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) if (j !== i) sum += sims[i]![j]!;
    beliefs.push(sum / (n - 1));
  }

  // Mean of all pairwise sims = mean of beliefs (algebraically equivalent for full pairs).
  const meanAgreement = beliefs.length === 0
    ? 0
    : beliefs.reduce((s, b) => s + b, 0) / beliefs.length;

  return { beliefs, meanAgreement, methodology };
}

async function persist(promptHash: string, r: CrossLLMResult): Promise<void> {
  try {
    await db.from('cross_llm_comparisons').insert({
      prompt_hash: promptHash,
      provider_1: r.answers[0]?.provider ?? null,
      provider_2: r.answers[1]?.provider ?? null,
      model_1: r.answers[0]?.model ?? null,
      model_2: r.answers[1]?.model ?? null,
      answer_1_preview: (r.answers[0]?.answer ?? '').slice(0, 500),
      answer_2_preview: (r.answers[1]?.answer ?? '').slice(0, 500),
      agreement_score: r.agreement_score,
      embedding_distance: r.embedding_distance,
      methodology: r.methodology,
      latency_ms: r.latency_ms,
      provider_responses: r.answers.map(a => ({
        provider: a.provider,
        squad: a.squad,
        model: a.model,
        answer_preview: (a.answer ?? '').slice(0, 500),
        latency_ms: a.latency_ms,
        error: a.error ?? null,
      })),
      provider_count: r.answers.filter(a => !a.error && a.answer).length,
      comma_veto: r.comma_veto,
      comma_gap: r.comma_gap,
      comma_severity: r.comma_severity,
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
    const raw = await res.json() as any;
    // trinity-ecosystem canonical doesn't yet emit comma_* / beliefs / squad — coerce defaults.
    const answers: ProviderAnswer[] = (Array.isArray(raw.answers) ? raw.answers : [])
      .map((a: any, i: number) => ({
        provider: String(a.provider ?? 'unknown'),
        squad: (a.squad as Squad) ?? (['alpha', 'beta', 'gamma'][i] as Squad) ?? 'alpha',
        model: String(a.model ?? ''),
        answer: String(a.answer ?? ''),
        latency_ms: Number(a.latency_ms ?? 0),
        error: a.error ?? undefined,
      }));
    return {
      prompt_hash: String(raw.prompt_hash ?? hashPrompt(prompt)),
      answers,
      agreement_score: Number(raw.agreement_score ?? 0),
      embedding_distance: Number(raw.embedding_distance ?? 1),
      methodology: (raw.methodology === 'embedding-cosine' ? 'embedding-cosine' : 'fallback-jaccard'),
      comma_veto: Boolean(raw.comma_veto ?? false),
      comma_gap: raw.comma_gap == null ? null : Number(raw.comma_gap),
      comma_severity: (raw.comma_severity as CommaSeverity) ?? 'none',
      beliefs: Array.isArray(raw.beliefs) ? raw.beliefs.map((b: any) => Number(b)) : [],
      latency_ms: Number(raw.latency_ms ?? 0),
    };
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
  const start = Date.now();

  const httpUrl = process.env.CROSS_LLM_VERIFIER_URL;
  if (httpUrl) {
    const r = await compareViaHttp(httpUrl, prompt, timeoutMs);
    if (r) return r;
    // fall through to in-process on HTTP failure
  }

  const promptHash = hashPrompt(prompt);
  const providers = buildProviderConfigs();
  const openaiKey = process.env.OPENAI_API_KEY ?? '';

  const settled = await Promise.allSettled(
    providers.map(cfg => queryProvider(cfg, prompt, timeoutMs))
  );
  const answers: ProviderAnswer[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    return {
      provider: providers[i]!.provider,
      squad: providers[i]!.squad,
      model: providers[i]!.model,
      answer: '',
      latency_ms: 0,
      error: String((s as PromiseRejectedResult).reason),
    };
  });

  const answered = answers
    .map((a, i) => ({ idx: i, text: a.answer ?? '', error: a.error }))
    .filter(x => !x.error && x.text.trim().length > 0)
    .map(x => ({ idx: x.idx, text: x.text }));

  // < 2 answered: no comparison possible.
  if (answered.length < 2) {
    const result: CrossLLMResult = {
      prompt_hash: promptHash,
      answers,
      agreement_score: 0,
      embedding_distance: 1,
      methodology: 'fallback-jaccard',
      comma_veto: false,
      comma_gap: null,
      comma_severity: 'none',
      beliefs: [],
      latency_ms: Date.now() - start,
    };
    if (persistFlag) void persist(promptHash, result);
    return result;
  }

  const { beliefs, meanAgreement, methodology } = await computeAgreement(
    answered, openaiKey, timeoutMs,
  );
  const { severity, comma_gap, comma_veto } = checkPythagoreanComma(beliefs);

  const agreement_score = Math.max(0, Math.min(1, meanAgreement));
  const embedding_distance = Math.max(0, 1 - agreement_score);

  const result: CrossLLMResult = {
    prompt_hash: promptHash,
    answers,
    agreement_score: Number(agreement_score.toFixed(4)),
    embedding_distance: Number(embedding_distance.toFixed(4)),
    methodology,
    comma_veto,
    comma_gap: comma_gap === null ? null : Number(comma_gap.toFixed(4)),
    comma_severity: severity,
    beliefs: beliefs.map(b => Number(b.toFixed(4))),
    latency_ms: Date.now() - start,
  };
  if (persistFlag) void persist(promptHash, result);
  return result;
}

// PYTHAGOREAN_COMMA_RATIO is exported for tests / smoke runners that compare
// against the canonical 531441/524288 ratio in their assertions.
export { PYTHAGOREAN_COMMA_RATIO };
