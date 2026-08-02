/**
 * provider-key-probe.ts — ONE definition of "is this provider key alive?".
 *
 * Used by the ops CLI (scripts/liveness-probes/probe-provider-keys.ts) and by
 * BYOK custody, which refuses to store a key it has not seen work. Two copies of
 * this table would drift, and a BYOK gate that disagrees with the ops report
 * about whether a key is dead is worse than having neither.
 *
 * WHY PROBE AT ALL: a key can be PRESENT and DEAD. HUGGINGFACE_API_TOKEN was set
 * in .env.master and on the deployed service while HuggingFace answered "not
 * supported by any provider you have enabled" — an entitlement failure, not
 * auth. Every presence check said fine; it took the whole LLM broker down (503)
 * because the dead provider sat at the cheapest tier.
 *
 * SECRETS: this module accepts key values and sends them to their own provider.
 * It never logs, returns, or embeds one in an error. Callers get a status.
 */

export type KeyProbeStatus = 'LIVE' | 'DEAD' | 'INCONCLUSIVE';

export interface KeyProbeResult {
  status: KeyProbeStatus;
  /** Safe to log and to store — contains no key material. */
  detail: string;
}

export interface ProviderProbe {
  /** Canonical provider id, as used by the router's adapters. */
  provider: string;
  /** Env var this key lives in for fleet-wide (non-BYOK) use. */
  env: string;
  /**
   * The independent model family this key buys.
   *
   * This is the column that matters. HAL counts distinct FAMILIES, not hosts —
   * two Llama endpoints are one vote, not two (fact-check.ts R5) — so a fleet
   * can lose quorum width while the key count still looks healthy. 'mixed'
   * marks a reseller carrying several families; it can never be counted as one
   * independent vote.
   */
  family: string;
  /** Cheapest authenticated endpoint that proves the credential works. */
  url: string;
  headers: (key: string) => Record<string, string>;
}

export const PROVIDER_PROBES: ProviderProbe[] = [
  { provider: 'groq', env: 'GROQ_API_KEY', family: 'llama', url: 'https://api.groq.com/openai/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { provider: 'cerebras', env: 'CEREBRAS_API_KEY', family: 'llama', url: 'https://api.cerebras.ai/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { provider: 'gemini', env: 'GEMINI_API_KEY', family: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: (k) => ({ 'x-goog-api-key': k }) },
  { provider: 'deepseek', env: 'DEEPSEEK_API_KEY', family: 'deepseek', url: 'https://api.deepseek.com/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { provider: 'mistral', env: 'MISTRAL_API_KEY', family: 'mistral', url: 'https://api.mistral.ai/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { provider: 'grok', env: 'GROK_API_KEY', family: 'grok', url: 'https://api.x.ai/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { provider: 'anthropic', env: 'ANTHROPIC_API_KEY', family: 'claude', url: 'https://api.anthropic.com/v1/models', headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
  { provider: 'openai', env: 'OPENAI_API_KEY', family: 'gpt', url: 'https://api.openai.com/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { provider: 'cohere', env: 'COHERE_API_KEY', family: 'cohere', url: 'https://api.cohere.com/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { provider: 'fireworks', env: 'FIREWORKS_API_KEY', family: 'mixed', url: 'https://api.fireworks.ai/inference/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { provider: 'deepinfra', env: 'DEEPINFRA_API_KEY', family: 'mixed', url: 'https://api.deepinfra.com/v1/openai/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { provider: 'openrouter', env: 'OPENROUTER_API_KEY', family: 'mixed', url: 'https://openrouter.ai/api/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { provider: 'huggingface', env: 'HUGGINGFACE_API_TOKEN', family: 'mixed', url: 'https://huggingface.co/api/whoami-v2', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
];

export const probeFor = (provider: string): ProviderProbe | undefined =>
  PROVIDER_PROBES.find((p) => p.provider === provider.toLowerCase());

export const supportedProviders = (): string[] => PROVIDER_PROBES.map((p) => p.provider);

/**
 * Ask the provider whether this credential works.
 *
 * The status mapping is deliberately conservative, because calling a working key
 * dead is how someone burns a good key and an afternoon:
 *   401/403 -> DEAD          the credential itself was rejected
 *   402     -> LIVE          valid key, account unfunded
 *   429     -> LIVE          valid key, rate limited
 *   other   -> INCONCLUSIVE  never treated as evidence about the key
 * Network errors and timeouts are INCONCLUSIVE for the same reason.
 */
export async function probeProviderKey(
  provider: string,
  key: string,
  timeoutMs = 12_000,
): Promise<KeyProbeResult> {
  const p = probeFor(provider);
  if (!p) return { status: 'INCONCLUSIVE', detail: `unknown provider '${provider}'` };
  if (!key) return { status: 'DEAD', detail: 'empty key' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(p.url, { headers: p.headers(key), signal: ctrl.signal });
    if (res.ok) return { status: 'LIVE', detail: `HTTP ${res.status}` };
    if (res.status === 401 || res.status === 403) {
      return { status: 'DEAD', detail: `HTTP ${res.status} — credential rejected` };
    }
    if (res.status === 402) return { status: 'LIVE', detail: 'HTTP 402 — key valid, account unfunded' };
    if (res.status === 429) return { status: 'LIVE', detail: 'HTTP 429 — key valid, rate limited' };
    return { status: 'INCONCLUSIVE', detail: `HTTP ${res.status}` };
  } catch (e) {
    return {
      status: 'INCONCLUSIVE',
      detail: (e as Error)?.name === 'AbortError' ? `timeout ${timeoutMs}ms` : 'network error',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many INDEPENDENT families a set of live providers actually buys.
 * Resellers ('mixed') are excluded rather than flattering the count.
 */
export function independentFamilies(liveProviders: string[]): string[] {
  const fams = new Set<string>();
  for (const name of liveProviders) {
    const p = probeFor(name);
    if (p && p.family !== 'mixed') fams.add(p.family);
  }
  return [...fams].sort();
}
