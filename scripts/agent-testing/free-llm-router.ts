/**
 * Free-tier LLM router for the agent testing framework.
 *
 * Routes agent "reasoning" to a FREE inference provider so dogfooding tests
 * never burn premium API quota (sprint hard-stop). All four providers expose an
 * OpenAI-compatible /chat/completions surface, so one call path serves all.
 * Picks the first provider whose API key env var is set, in priority order.
 *
 * Set ANY ONE of: CEREBRAS_API_KEY, GROQ_API_KEY, TOGETHER_API_KEY,
 * HF_API_KEY (or HF_TOKEN). If none is set, freeComplete() returns ok:false
 * with a clear reason and callers SKIP — never fall back to a paid provider.
 */

export interface LlmProvider {
  name: string;
  endpoint: string;
  envVars: string[];
  defaultModel: string;
}

// Priority order: fastest/most-generous free tiers first.
export const FREE_PROVIDERS: LlmProvider[] = [
  { name: 'cerebras', endpoint: 'https://api.cerebras.ai/v1/chat/completions', envVars: ['CEREBRAS_API_KEY'], defaultModel: 'llama-3.3-70b' },
  { name: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', envVars: ['GROQ_API_KEY'], defaultModel: 'llama-3.3-70b-versatile' },
  { name: 'together', endpoint: 'https://api.together.xyz/v1/chat/completions', envVars: ['TOGETHER_API_KEY'], defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free' },
  { name: 'huggingface', endpoint: 'https://router.huggingface.co/v1/chat/completions', envVars: ['HF_API_KEY', 'HF_TOKEN'], defaultModel: 'meta-llama/Llama-3.1-8B-Instruct' },
];

export function selectProvider(): { provider: LlmProvider; key: string } | null {
  for (const p of FREE_PROVIDERS) {
    for (const v of p.envVars) {
      const key = process.env[v];
      if (key && key.trim()) return { provider: p, key: key.trim() };
    }
  }
  return null;
}

export interface CompleteResult {
  ok: boolean;
  provider?: string;
  text?: string;
  error?: string;
}

export interface CompleteOpts {
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/** Single bounded (RULE-8) OpenAI-compatible chat completion against a free provider. */
export async function freeComplete(prompt: string, opts: CompleteOpts = {}): Promise<CompleteResult> {
  const sel = selectProvider();
  if (!sel) {
    return { ok: false, error: 'no free-tier LLM key set (CEREBRAS_API_KEY / GROQ_API_KEY / TOGETHER_API_KEY / HF_API_KEY)' };
  }
  const { provider, key } = sel;
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
      return { ok: false, provider: provider.name, error: `${provider.name} HTTP ${res.status}: ${body.slice(0, 200)}` };
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
