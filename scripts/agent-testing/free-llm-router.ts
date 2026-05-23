/**
 * Free-tier LLM router for the agent testing framework.
 *
 * Routes agent "reasoning" to a FREE inference provider so dogfooding tests
 * never burn premium API quota (sprint hard-stop). All four providers expose an
 * OpenAI-compatible /chat/completions surface, so one call path serves all.
 *
 * freeComplete() tries every provider whose key is set, in priority order, and
 * FALLS THROUGH to the next on any failure (bad model id, HTTP error, timeout),
 * logging each hop. If ALL free providers fail it returns ok:false — it NEVER
 * falls back to a paid provider.
 *
 * Set ANY ONE of: CEREBRAS_API_KEY, GROQ_API_KEY, TOGETHER_API_KEY,
 * HF_API_KEY (or HF_TOKEN). If none is set, freeComplete() returns ok:false
 * with a clear reason and callers SKIP.
 */

export interface LlmProvider {
  name: string;
  endpoint: string;
  envVars: string[];
  defaultModel: string;
}

// Priority order: fastest/most-generous free tiers first.
export const FREE_PROVIDERS: LlmProvider[] = [
  { name: 'cerebras', endpoint: 'https://api.cerebras.ai/v1/chat/completions', envVars: ['CEREBRAS_API_KEY'], defaultModel: 'llama3.1-8b' },
  { name: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', envVars: ['GROQ_API_KEY'], defaultModel: 'llama-3.3-70b-versatile' },
  { name: 'together', endpoint: 'https://api.together.xyz/v1/chat/completions', envVars: ['TOGETHER_API_KEY'], defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free' },
  { name: 'huggingface', endpoint: 'https://router.huggingface.co/v1/chat/completions', envVars: ['HF_API_KEY', 'HF_TOKEN'], defaultModel: 'meta-llama/Llama-3.1-8B-Instruct' },
];

/** All free providers (priority order) that have a key set. */
export function keyedProviders(): Array<{ provider: LlmProvider; key: string }> {
  const out: Array<{ provider: LlmProvider; key: string }> = [];
  for (const p of FREE_PROVIDERS) {
    for (const v of p.envVars) {
      const key = process.env[v];
      if (key && key.trim()) { out.push({ provider: p, key: key.trim() }); break; }
    }
  }
  return out;
}

/** First keyed provider (priority order), or null. Kept for the run-all header. */
export function selectProvider(): { provider: LlmProvider; key: string } | null {
  return keyedProviders()[0] ?? null;
}

export interface CompleteResult {
  ok: boolean;
  provider?: string;
  text?: string;
  error?: string;
  /** Per-provider trace of the fallthrough chain (additive; safe to ignore). */
  attempts?: Array<{ provider: string; ok: boolean; error?: string }>;
}

export interface CompleteOpts {
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/** Single bounded (RULE-8) OpenAI-compatible chat completion against ONE provider. */
async function attemptProvider(provider: LlmProvider, key: string, prompt: string, opts: CompleteOpts): Promise<CompleteResult> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(provider.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: opts.model ?? provider.defaultModel,
        messages: [
          ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
          { role: 'user', content: prompt },
        ],
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.2,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, provider: provider.name, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const data: any = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? '';
    return { ok: true, provider: provider.name, text };
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (e?.message ?? String(e));
    return { ok: false, provider: provider.name, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded (RULE-8) free-tier completion with provider fallthrough.
 * Tries every keyed provider in priority order; on failure logs the hop and
 * advances to the next. If all fail, returns ok:false — NEVER a paid provider.
 */
export async function freeComplete(prompt: string, opts: CompleteOpts = {}): Promise<CompleteResult> {
  const providers = keyedProviders();
  if (providers.length === 0) {
    return { ok: false, error: 'no free-tier LLM key set (CEREBRAS_API_KEY / GROQ_API_KEY / TOGETHER_API_KEY / HF_API_KEY)' };
  }
  const attempts: Array<{ provider: string; ok: boolean; error?: string }> = [];
  for (let i = 0; i < providers.length; i++) {
    const { provider, key } = providers[i]!;
    const r = await attemptProvider(provider, key, prompt, opts);
    attempts.push({ provider: provider.name, ok: r.ok, error: r.error });
    if (r.ok) return { ...r, attempts };
    const next = providers[i + 1]?.provider.name;
    console.warn(`[free-llm] ${provider.name} failed (${r.error}); ${next ? 'falling through to ' + next : 'no more free providers'}`);
  }
  // All free providers failed — do NOT fall back to a paid provider.
  return {
    ok: false,
    error: `all ${providers.length} free provider(s) failed: ${attempts.map((a) => `${a.provider}:${a.error}`).join(' | ')}`,
    attempts,
  };
}
