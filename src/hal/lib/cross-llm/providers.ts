/**
 * Provider HTTP callers — DI form (no env reads, no global state).
 *
 * Two call shapes are supported:
 *   - openai-compat: OpenAI's /chat/completions JSON shape (Groq, DeepSeek,
 *     Together, OpenRouter, OpenAI itself all conform)
 *   - anthropic-native: the Anthropic Messages API
 *
 * Ported from src/hal/cross-llm-client.ts:125-225 with no semantic change
 * other than env-key lookup being replaced by the caller-supplied apiKey.
 */
import type { HALProviderConfig } from '../types';

const ANSWER_SYSTEM_PROMPT =
  'You are a careful, truthful assistant. Answer in 1-3 sentences. ' +
  'If you do not know, say so. Never fabricate facts. No preamble.';

const ANSWER_MAX_TOKENS = 400;
const DEFAULT_TIMEOUT_MS = 10000;

export interface ProviderAnswer {
  provider: string;
  squad: string;
  model: string;
  answer: string;
  latency_ms: number;
  error?: string;
}

async function callOpenAICompat(
  endpoint: string, apiKey: string, model: string, prompt: string, timeoutMs: number,
): Promise<string> {
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
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropicNative(
  endpoint: string, apiKey: string, model: string, prompt: string, timeoutMs: number,
): Promise<string> {
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
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function queryProvider(
  cfg: HALProviderConfig, prompt: string,
): Promise<ProviderAnswer> {
  const start = Date.now();
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!cfg.apiKey) {
    return {
      provider: cfg.provider, squad: cfg.squad ?? 'alpha', model: cfg.model, answer: '',
      latency_ms: 0, error: 'api key not set',
    };
  }
  try {
    const text = cfg.callType === 'anthropic-native'
      ? await callAnthropicNative(cfg.endpoint, cfg.apiKey, cfg.model, prompt, timeoutMs)
      : await callOpenAICompat(cfg.endpoint, cfg.apiKey, cfg.model, prompt, timeoutMs);
    return {
      provider: cfg.provider, squad: cfg.squad ?? 'alpha', model: cfg.model,
      answer: text, latency_ms: Date.now() - start,
    };
  } catch (e: any) {
    return {
      provider: cfg.provider, squad: cfg.squad ?? 'alpha', model: cfg.model, answer: '',
      latency_ms: Date.now() - start, error: e?.message ?? String(e),
    };
  }
}
