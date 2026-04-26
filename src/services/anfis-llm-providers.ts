/**
 * ANFIS-Ikigai v0.1 — Local LLM provider adapter.
 *
 * Why this file exists: Sean's v0.1 spec said "reuse src/services/hal-providers.ts
 * callModel()". That file lives on `feat/hal-v2-tiered-consensus`, which we are
 * forbidden to touch and which has not yet merged to main. So we mirror the same
 * callModel signature here, scoped to ANFIS use, with the same MOCK_MODE +
 * graceful-degradation contract. When HAL v2 lands on main, this file is
 * meant to be deleted and the SBFA service rewired to import from
 * hal-providers — no caller-side changes required.
 *
 * MOCK_MODE: process.env.HAL_V2_MOCK === '1' bypasses real APIs and returns
 * deterministic mocked rationales. Same env var as HAL v2 so a single flag
 * controls both stacks in CI.
 *
 * Providers supported:
 *   - anthropic, openai, google (mirrors HAL v2 set)
 *   - groq (free-tier llama; used for mission_aligned_peer)
 * If a provider's key is missing, the call returns ok=false and the SBFA
 * orchestrator treats it as a missing perspective — never a crash.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'groq';

export interface ModelSpec {
  provider: ProviderId;
  model: string;
  display_name: string;
  cost_per_million_in_usd?: number;
  cost_per_million_out_usd?: number;
}

export interface ModelCallResult {
  ok: boolean;
  answer: string;
  latency_ms: number;
  cost_estimate_usd: number;
  tokens_in?: number;
  tokens_out?: number;
  error?: string;
  model: string;
  provider: ProviderId;
}

const MOCK_MODE = process.env.HAL_V2_MOCK === '1';

export function isMockMode(): boolean { return MOCK_MODE; }

export function providerKeyAvailable(provider: ProviderId): boolean {
  if (MOCK_MODE) return true;
  switch (provider) {
    case 'anthropic': return !!process.env.ANTHROPIC_API_KEY;
    case 'openai':    return !!process.env.OPENAI_API_KEY;
    case 'google':    return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    case 'groq':      return !!process.env.GROQ_API_KEY;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout(${ms}ms): ${label}`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

function estimateCost(spec: ModelSpec, tokensIn: number, tokensOut: number): number {
  const inCost = (spec.cost_per_million_in_usd ?? 0.5) * tokensIn / 1_000_000;
  const outCost = (spec.cost_per_million_out_usd ?? 1.5) * tokensOut / 1_000_000;
  return inCost + outCost;
}

/**
 * Deterministic mock — derives a 0-1 score plus a one-line rationale from
 * the prompt, model name, and signal hash. Per-model variation comes from
 * hashing the model name into a small seed offset, so the five SBFA
 * perspectives produce somewhat different scores even on the same signal.
 *
 * The "answer" emitted is a strict JSON line:
 *
 *     {"score": 0.74, "why": "..."}
 *
 * which the SBFA orchestrator parses without needing a real LLM.
 */
function mockCall(spec: ModelSpec, prompt: string): ModelCallResult {
  const seed = (spec.model + prompt).split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  // Deterministic 0-1 score; the spread per model adds some noise so the
  // SBFA aggregator sees realistic disagreement variance.
  const baseScore = (seed % 1000) / 1000;
  const modelOffset = ((spec.model.length * 13) % 100) / 1000;  // ±0.0..0.099
  const rawScore = clamp01(baseScore * 0.6 + 0.2 + modelOffset);

  // Heuristic mock rationale picks a phrase from the prompt to look
  // plausible. Real prompts will mention a perspective_role; we surface it.
  const roleMatch = /perspective:\s*([a-z_]+)/i.exec(prompt);
  const role = roleMatch?.[1] ?? 'perspective';
  const stance =
    rawScore > 0.7 ? 'strong fit' :
    rawScore > 0.45 ? 'plausible fit' :
    rawScore > 0.25 ? 'weak fit' :
                      'poor fit';
  const answer = JSON.stringify({
    score: round4(rawScore),
    why: `[mock:${spec.model}] ${role} reads this as a ${stance}.`,
  });

  const tokensIn = Math.ceil(prompt.length / 4);
  const tokensOut = Math.ceil(answer.length / 4);

  return {
    ok: true,
    answer,
    latency_ms: 30 + (seed % 80),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_estimate_usd: estimateCost(spec, tokensIn, tokensOut),
    model: spec.model,
    provider: spec.provider,
  };
}

export async function callModel(
  spec: ModelSpec,
  prompt: string,
  timeoutMs: number = 5000,
): Promise<ModelCallResult> {
  const start = Date.now();
  const baseFail = (error: string): ModelCallResult => ({
    ok: false,
    answer: '',
    latency_ms: Date.now() - start,
    cost_estimate_usd: 0,
    error,
    model: spec.model,
    provider: spec.provider,
  });

  if (MOCK_MODE) return mockCall(spec, prompt);
  if (!providerKeyAvailable(spec.provider)) return baseFail('no_api_key');

  try {
    let answer = '';
    let tokensIn = 0;
    let tokensOut = 0;

    if (spec.provider === 'anthropic') {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
      const r: any = await withTimeout(
        client.messages.create({
          model: spec.model,
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }) as any,
        timeoutMs, spec.model);
      answer = r.content?.[0]?.text ?? '';
      tokensIn = r.usage?.input_tokens ?? 0;
      tokensOut = r.usage?.output_tokens ?? 0;
    } else if (spec.provider === 'google') {
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY!;
      const genai = new GoogleGenerativeAI(apiKey);
      const model = genai.getGenerativeModel({ model: spec.model });
      const r: any = await withTimeout(model.generateContent(prompt) as any, timeoutMs, spec.model);
      answer = r.response.text();
      tokensIn = r.response.usageMetadata?.promptTokenCount ?? 0;
      tokensOut = r.response.usageMetadata?.candidatesTokenCount ?? 0;
    } else {
      // OpenAI-compatible: openai, groq.
      const baseURL = spec.provider === 'groq'
        ? 'https://api.groq.com/openai/v1'
        : undefined;
      const apiKey = spec.provider === 'openai'
        ? process.env.OPENAI_API_KEY!
        : process.env.GROQ_API_KEY!;
      const client = new OpenAI({ apiKey, baseURL });
      const r = await withTimeout(
        client.chat.completions.create({
          model: spec.model,
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }), timeoutMs, spec.model);
      answer = r.choices[0]?.message?.content ?? '';
      tokensIn = r.usage?.prompt_tokens ?? 0;
      tokensOut = r.usage?.completion_tokens ?? 0;
    }

    return {
      ok: true,
      answer,
      latency_ms: Date.now() - start,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_estimate_usd: estimateCost(spec, tokensIn, tokensOut),
      model: spec.model,
      provider: spec.provider,
    };
  } catch (e: any) {
    return baseFail(e?.message || 'unknown_error');
  }
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
