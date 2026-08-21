export interface ProviderAdapter {
  name: string;
  tier: 0 | 1;
  free: boolean;
  isHealthy(): Promise<boolean>;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export interface CompletionRequest {
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  apiKey: string;
  timeout?: number;
}

export interface CompletionResponse {
  answer: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  provider: string;
  model: string;
  rawResponse?: any;
}

export class RateLimitError extends Error {
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Build a provider HTTP error that CARRIES THE VENDOR'S EXPLANATION.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every adapter used to end with `throw new Error(\`X HTTP error: ${res.status}\`)`,
 * discarding the response body. A status code alone cannot distinguish the two
 * failures that look identical from the outside and need opposite responses:
 *
 *   404 "model does not exist"  -> our config is stale. Fix the model name.
 *   404 <anything else>         -> something else entirely.
 *
 * On 2026-08-21 a user hit a 503 on their FIRST run of the day. The router's log
 * row read `Groq HTTP error: 404` with `model: 'unknown'` — no vendor text, no
 * model name. The UI, given only "max routing attempts reached", told them
 * "Free tier exhausted. Add a paid key or wait a minute." All three claims were
 * false: the tier was not exhausted, a paid key would not have helped, and
 * waiting would never have fixed it. The real cause — a retired model id — sat in
 * the vendor's response body, which this line had thrown away. It was only
 * diagnosable because an UNRELATED service happened to log its bodies.
 *
 * A diagnostic that requires archaeology in a second service is not a diagnostic.
 *
 * SAFETY
 * ------
 * - `res.text()` is awaited in a `.catch(() => '')`: a body that cannot be read
 *   must not convert a clean HTTP error into an unhandled rejection. Losing the
 *   detail is acceptable; losing the error is not.
 * - Truncated to `MAX_BODY_CHARS`. Vendor errors are short; HTML error pages are
 *   not, and this string lands in `llm_call_log.error_message`.
 * - Call this ONLY on the non-ok terminal branch, after 401/403/429 have been
 *   classified — those carry their own typed errors and the router treats them
 *   differently. Reading the body here is safe because nothing else consumes it.
 *
 * This does NOT redact: provider error bodies echo request metadata, never the
 * API key (which travels in a header). If a vendor is ever observed reflecting a
 * credential, redact HERE, in the one place, rather than at eight call sites.
 */
const MAX_BODY_CHARS = 300;

export async function providerHttpError(
  providerLabel: string,
  res: { status: number; text?: () => Promise<string> },
): Promise<Error> {
  // `text` is OPTIONAL and the call is guarded. A fetch Response always has it, but
  // this must also survive a Response-LIKE object that does not — a test double, a
  // mocked fetch, a polyfill. The first version typed `text` as required and called
  // it unconditionally; the suite caught it immediately with
  // "res.text is not a function", turning a clean 503 into an unhandled rejection
  // inside the very error path meant to explain the 503.
  //
  // That is the same shape as the fail-open bug this repo already shipped: a helper
  // whose job is to REPORT a failure must never itself become one. Losing the body
  // degrades the message; throwing here loses the error entirely.
  let body = '';
  if (typeof res.text === 'function') {
    body = (await res.text().catch(() => '')).trim();
  }
  const detail = body ? `: ${body.slice(0, MAX_BODY_CHARS)}` : '';
  return new Error(`${providerLabel} HTTP ${res.status}${detail}`);
}

/** One observability line per provider per process — not once per request. */
const modelSourceLogged = new Set<string>();

/**
 * Resolve an adapter's default model, allowing an env override.
 *
 * WHY: vendors retire model ids on their own schedule, and when they do, every
 * request to that provider 404s until someone ships a deploy. On 2026-08-21 two
 * tier-0 providers were simultaneously dead this way — one model `model_not_found`,
 * another `model_archived_error` — and had been for at least three days. The
 * hardcoded literal made a vendor's routine deprecation into an outage that only a
 * code change could clear.
 *
 * With this, `GROQ_MODEL=<current-id>` on the service fixes it in a restart. The
 * literal stays in the source as the fallback, so nothing changes when the env is
 * unset, and `tests/routing-cost-class.test.ts`'s drift guard — which greps these
 * files for the quoted literal — still sees what it expects.
 *
 * THE NAME IS `<PROVIDER>_MODEL`, NOT `MODEL_<PROVIDER>`. That convention already
 * shipped on two adapters (`SAMBANOVA_MODEL`, `OPENROUTER_MODEL`) before this helper
 * existed; those two now route through here and keep working unchanged. Inventing a
 * second spelling would have silently orphaned any value already set in the
 * deployment — the same shape as the renamed key that crash-looped a service for
 * days. One convention, extended; not a new one alongside it.
 *
 * KNOWN AND DELIBERATE: when an override IS set, `ADAPTER_DEFAULT_MODELS` in
 * cost-class.ts no longer describes the model actually used, so a price lookup for
 * it will usually miss and the provider classifies as `unpriced`. That is the SAFE
 * direction and it is the three-state doctrine working as intended — an unpriced
 * provider sorts LAST and is never mistaken for free. An override trades exact cost
 * ordering for staying reachable at all. Do not "fix" that by defaulting an unknown
 * price to zero.
 */
export function defaultModelFor(provider: string, fallback: string): string {
  const envName = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MODEL`;
  const override = process.env[envName]?.trim();
  const model = override || fallback;

  if (!modelSourceLogged.has(envName)) {
    modelSourceLogged.add(envName);
    // Logged because `llm_call_log` once recorded `model: 'unknown'` for a failing
    // call, which made "is our config stale?" unanswerable from the logs alone.
    console.info(
      `[providers] ${provider} default model = '${model}' (${override ? `${envName} override` : `built-in; set ${envName} to override`})`,
    );
  }
  return model;
}
