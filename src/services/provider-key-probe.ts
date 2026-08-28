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

import { XAI_KEY_VARS } from '../providers/xai-key';

export type KeyProbeStatus = 'LIVE' | 'DEAD' | 'INCONCLUSIVE';

export interface KeyProbeResult {
  status: KeyProbeStatus;
  /** Safe to log and to store — contains no key material. */
  detail: string;
}

export interface ProviderProbe {
  /** Canonical provider id, as used by the router's adapters. */
  provider: string;
  /** Canonical env var this key lives in for fleet-wide (non-BYOK) use. Also the display name. */
  env: string;
  /**
   * Legacy/alias env names accepted AFTER `env`, most-canonical-first.
   *
   * Not cosmetic. `grok` read only `GROK_API_KEY` while `.env.master` was canonicalised to
   * `XAI_API_KEY` (#398), so a present, live key was reported ABSENT wherever that inventory is the
   * source — which includes the ops CLI, the main consumer of this table. "Not configured" is a
   * quiet row in the doctor report, not a failure, so it read as an unset key rather than a bug.
   *
   * Railway still supplies `GROK_API_KEY` [V 2026-08-14], so the fleet-liveness path was resolving
   * correctly; the two inventories disagree and the alias list is what makes both work.
   */
  envFallbacks?: string[];
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
  // Z.AI direct — the `glm` family from the vendor. Added when zai joined the HAL quorum: without a
  // row here `catalogIsMeasured('zai')` is false forever, so the one provider added AFTER the
  // self-healing work would have been the only one exempt from it — a new member permanently unable
  // to notice its own model retiring, which is the exact failure that started that work.
  //
  // THE URL IS NOT_CHECKED: no Z.AI credential is reachable from a dev sandbox, so this path is
  // derived from the chat endpoint's shape (`/api/paas/v4/chat/completions` → `/api/paas/v4/models`)
  // and the vendor's OpenAI compatibility, not observed. That is survivable BY CONSTRUCTION rather
  // than by luck: a wrong URL fails the fetch, the entry never reaches status MEASURED,
  // `catalogIsMeasured` stays false, and selection falls back to the configured/static model exactly
  // as it does for a cold cache. A bad guess here degrades to today's behaviour; it cannot invent a
  // model. Confirm against provider_health after deploy and delete this paragraph when it is seen
  // MEASURED.
  { provider: 'zai', env: 'ZAI_API_KEY', family: 'glm', url: 'https://api.z.ai/api/paas/v4/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  // env/envFallbacks are DERIVED from XAI_KEY_VARS rather than spelled out, so this row cannot
  // drift from HAL, CRAG and the dispatcher by someone editing one list.
  { provider: 'grok', env: XAI_KEY_VARS[0], envFallbacks: [...XAI_KEY_VARS.slice(1)], family: 'grok', url: 'https://api.x.ai/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
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

/** Every env name this probe accepts, canonical first. */
export const probeEnvNames = (p: ProviderProbe): string[] => [p.env, ...(p.envFallbacks ?? [])];

/**
 * Find this provider's key across all names it accepts, canonical first.
 *
 * Returns the NAME as well as the value so a caller can report which one answered — when two names
 * are live with different values, "which key did we actually probe?" is the whole question. Blank
 * values are treated as absent so a blank canonical cannot shadow a real legacy key.
 *
 * `lookup` is injectable because the ops CLI resolves through `.env.master` as well as `process.env`.
 */
export function resolveProbeKey(
  p: ProviderProbe,
  lookup: (name: string) => string | undefined = (n) => process.env[n],
): { name: string; key: string } | undefined {
  for (const name of probeEnvNames(p)) {
    const key = lookup(name)?.trim();
    if (key) return { name, key };
  }
  return undefined;
}

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
