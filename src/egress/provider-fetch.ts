/**
 * provider-fetch.ts — THE named egress chokepoint for LLM provider calls.
 *
 * Layer 3 of the egress work (layers 1 and 2 are the two CI guards). This exists so that
 * "every provider call goes through one place" has an actual place to name — created BEFORE
 * anything calls it, on purpose: if the chokepoint does not exist yet, every adapter grows its
 * own private `fetch` while waiting, and then there is nothing to route through.
 *
 * ── WHAT IT IS: a passthrough to the global `fetch` for every host EXCEPT the local redirect
 * host (LOCAL_LLM_BASE_URL / OPENAI_BASE_URL), where it replaces the caller's provider key (see
 * `providerFetch` below). It never changes which host is reached or what comes back. With
 * neither variable set — production as last measured, 2026-09-09 — it is a pure passthrough.
 *
 * ── WHAT ATTACHES HERE LATER (each its own reviewed slice):
 *   - base-URL resolution (today scattered as `resolveProviderEndpoint` call-by-call),
 *   - the assertion of WHICH credential source resolved (credential presentation for the
 *     local redirect attached 2026-11-15; HAL fact-check and cross-llm now route through here),
 *   - the `ONLY_ATTESTATIONS_LEAVE` egress-boundary check (src/selfhost/egress-guard.ts),
 *   - the Sealer.
 * They attach HERE, once. HYP-10 routed the four remaining type-B callsites
 * (badges, completeness, adversarial-judge, pcp-validator) through this function
 * with no host/header change. Honouring LOCAL_LLM_BASE_URL is HYP-11.
 */

/**
 * ── CREDENTIAL PRESENTATION for the local redirect (2026-11-15, the first slice listed above).
 * With LOCAL_LLM_BASE_URL (or OPENAI_BASE_URL) set, `resolveProviderEndpoint` sends every
 * openai-compat provider to that ONE host, but each caller still attached ITS OWN provider key.
 * Measured 2026-09-09 (repo CLAUDE.md): 10 distinct provider keys handed to one host. A request to
 * the redirect host now carries only LOCAL_LLM_API_KEY, or no credential. Ollama needs none; a
 * gateway (LiteLLM, OmniRoute) holds its own upstream keys. Requests to any other host: untouched.
 * Known edge: if OPENAI_BASE_URL names a real provider's own API host, direct calls to it lose
 * their key here and get a 401. Intended: that variable already redirected every OTHER provider,
 * with its key, to that host; a loud 401 beats a silent keyring hand-off.
 */
function redirectOrigin(): string | null {
  const base = (process.env.LOCAL_LLM_BASE_URL || process.env.OPENAI_BASE_URL || '').trim();
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/**
 * Call an LLM provider: the single point every provider egress routes through.
 *
 * Typed as the global `fetch` signature so it is a drop-in: `fetch(url, init)` becomes
 * `providerFetch(url, init)` with no call-site shape change.
 */
export function providerFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const origin = redirectOrigin();
  if (!origin) return fetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let target: string;
  try {
    target = new URL(url).origin;
  } catch {
    return fetch(input, init);
  }
  if (target !== origin) return fetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.delete('authorization');
  headers.delete('x-api-key');
  const localKey = (process.env.LOCAL_LLM_API_KEY || '').trim();
  if (localKey) headers.set('authorization', `Bearer ${localKey}`);
  return fetch(input, { ...init, headers });
}

export type ProviderFetch = typeof providerFetch;
