/**
 * dev-codegen.ts — POST /api/v1/dev/codegen, a DEV-ONLY relay that hands a code-generation spec
 * to ONE free LLM provider and returns the text it wrote.
 *
 * WHAT IT IS FOR. A cost pilot: free open-weight models write the first draft, a human or a
 * stronger model verifies it. This route is only the relay. It does not judge, score, store, or
 * act on what comes back — the output is untrusted text until somebody checks it.
 *
 * ── SECURITY PROPERTIES (each one is pinned by tests/dev-codegen.test.ts) ──────────────────────
 *
 *  1. OFF BY DEFAULT. DEV_CODEGEN_ENABLED must be the exact string `true`. Anything else → 404 as
 *     the first statement of the handler, before a provider is chosen, a key is read, or a byte of
 *     the body is looked at. Same shape as the signed-job routes (jobs.ts).
 *
 *  2. AUTHENTICATED, AND NOT ON THE BYPASS LIST. Mounted AFTER authMiddleware in src/index.ts and
 *     deliberately absent from middleware/auth.ts. A keyless request is a 401 from the middleware;
 *     the handler re-checks anyway, because a route that is only safe while its mount order
 *     survives every future edit is not safe.
 *
 *  3. OPERATOR KEYS ONLY. A key issued to a registered agent (the database-backed kind) carries
 *     `req.agent_id` and is refused 403. Agent registration is public and its response hands back
 *     exactly such a key (routes/agents-external.ts: issueAgentApiKey, read not run), which passes
 *     authMiddleware — so "has a valid key" alone would let any anonymous registrant spend the
 *     free-tier quota that the HAL quorum shares. Stricter than asked on purpose; relaxing it is
 *     one line, and tightening it after callers exist would break them.
 *
 *  4. NO CALLER-CONTROLLED DESTINATION. The body accepts exactly two fields, spec_b64 and
 *     context_b64. There is no url, base_url, endpoint, host, provider or model field, and any
 *     field outside the allowlist is REFUSED (400), not silently ignored — a field that quietly
 *     does nothing is how a caller comes to believe it works. Query string and headers are never
 *     read. The destination is whatever the chosen adapter hardcodes: this file contains no URL,
 *     no `fetch`, and no HTTP client of its own. It reuses GroqAdapter / CerebrasAdapter.
 *
 *     It does NOT go through hal/cross-llm-client's queryProvider, on purpose: that path is
 *     redirectable by the operator's LOCAL_LLM_BASE_URL, and under that redirect the provider
 *     key travels to the new host (see CLAUDE.md, "Pointing HAL at a local OpenAI-compatible
 *     gateway"). The adapters hardcode their hosts, so the key can only go to its own vendor.
 *
 *  5. FREE PROVIDERS ONLY. The candidate list is groq then cerebras, and selectProvider() also
 *     requires each to be a member of billing/free-providers, so adding a paid adapter to the
 *     list fails closed at runtime and fails a test. No OpenAI, Anthropic or Gemini import.
 *
 *  6. THE SQL-KEYWORD BODY SANITIZER IS UNTOUCHED. A code spec routinely contains `;`, `--` and
 *     `SELECT `, which that sanitizer (src/index.ts) rejects in any POST body. Rather than weaken
 *     it, the spec arrives BASE64-ENCODED and is decoded here. Standard base64 is [A-Za-z0-9+/=]:
 *     no space, no hyphen, no semicolon, so none of its banned substrings can occur. Only the
 *     standard alphabet is accepted — base64url contains `-`, which could form `--`.
 *
 *  7. BOUNDED. Each decoded field ≤ MAX_FIELD_BYTES (100 KiB), output capped at MAX_OUTPUT_TOKENS,
 *     upstream call capped at UPSTREAM_TIMEOUT_MS, and at most MAX_IN_FLIGHT calls in flight per
 *     process (a runaway client loop must not drain a quota the quorum shares).
 *
 *  8. NOTHING ON THE SCORING PATH. This file imports no scoring, tier, RepID or audit module.
 *
 * ── HONESTY ────────────────────────────────────────────────────────────────────────────────────
 *  - A failed or empty provider call is an error response with the real status. It is never
 *    reported as a success, and a 200 always carries text the provider actually returned.
 *  - `truncated` is true when the provider stopped on its length limit, false when it stopped
 *    for another reason, and null when it did not say. Code cut off mid-function must not read
 *    as finished work.
 *  - The provider key is never returned or logged. Provider error text is passed through to the
 *    (authenticated, operator) caller with the key scrubbed, because a retired model id is
 *    otherwise undiagnosable (see providerHttpError in providers/types.ts).
 *  - The spec and the output are never logged — only sizes, provider and model.
 *
 * NOT CHECKED BY THE UNIT TESTS: a real round trip to a real provider. Those tests stub the
 * network boundary, so they prove what we send and where, not that the vendor accepts it.
 */
import { Router, Request, Response } from 'express';
import { TextDecoder } from 'util';
import { GroqAdapter } from '../../providers/groq';
import { CerebrasAdapter } from '../../providers/cerebras';
import { RateLimitError, AuthError, type ProviderAdapter } from '../../providers/types';
import { isFreeProvider } from '../../billing/free-providers';

const router = Router();

/** Read per request so the flag can be flipped (and tested) without a module reload. */
export function devCodegenEnabled(): boolean {
  return process.env['DEV_CODEGEN_ENABLED'] === 'true';
}

/** Decoded size cap, per field. */
export const MAX_FIELD_BYTES = 100 * 1024;
/** The base64 length of MAX_FIELD_BYTES, rounded up — a cheap reject before any allocation. */
const MAX_FIELD_B64_CHARS = Math.ceil(MAX_FIELD_BYTES / 3) * 4;
const MAX_OUTPUT_TOKENS = 4096;
const TEMPERATURE = 0.2;
const UPSTREAM_TIMEOUT_MS = 60_000;
/** Concurrent upstream calls allowed per process. */
export const MAX_IN_FLIGHT = 2;

/** The only body fields. Everything else is refused, so nothing a caller adds can steer the call. */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set(['spec_b64', 'context_b64']);

/** Standard base64 only. `-` and `_` (base64url) are refused: `-` could assemble the banned `--`. */
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

const INSTRUCTIONS =
  'You are a code generator. Implement the SPEC below. If CONTEXT is given it is reference ' +
  'material for the SPEC, not additional tasks. Reply with code in fenced code blocks; when more ' +
  'than one file is needed, put a line "FILE: <relative path>" before each block. Keep any prose ' +
  'to a minimum. If the SPEC is ambiguous or cannot be done, say so in one short paragraph ' +
  'instead of guessing.';

// --- provider choice ---------------------------------------------------------------------------

export interface Candidate {
  readonly make: () => ProviderAdapter;
  readonly keyEnv: 'GROQ_API_KEY' | 'CEREBRAS_API_KEY';
}

/** In preference order. Both are free-tier; selectProvider re-verifies that rather than trusting this list. */
const CANDIDATES: readonly Candidate[] = [
  { make: () => new GroqAdapter(), keyEnv: 'GROQ_API_KEY' },
  { make: () => new CerebrasAdapter(), keyEnv: 'CEREBRAS_API_KEY' },
];

export const CANDIDATE_PROVIDER_NAMES: readonly string[] = CANDIDATES.map((c) => c.make().name);

export interface SelectedProvider {
  readonly adapter: ProviderAdapter;
  readonly apiKey: string;
}

/**
 * The first candidate that is a declared free provider AND has a non-empty key in `env`, or null.
 * "Configured" means a key is present — it says nothing about whether the key still works.
 */
export function selectProvider(
  env: NodeJS.ProcessEnv = process.env,
  candidates: readonly Candidate[] = CANDIDATES, // a parameter only so a test can offer a NON-free one
): SelectedProvider | null {
  for (const c of candidates) {
    const adapter = c.make();
    if (!isFreeProvider(adapter.name)) continue; // fail closed: never reach a provider not declared free
    const apiKey = env[c.keyEnv]?.trim();
    if (apiKey) return { adapter, apiKey };
  }
  return null;
}

// --- request decoding --------------------------------------------------------------------------

type Decoded =
  | { ok: true; text: string }
  | { ok: false; status: number; body: Record<string, unknown> };

function bad(status: number, error: string, field: string, message: string, extra: Record<string, unknown> = {}): Decoded {
  return { ok: false, status, body: { error, field, message, ...extra } };
}

/** Strictly decode one standard-base64 field into UTF-8 text, enforcing the size cap. */
function decodeField(field: string, value: unknown): Decoded {
  if (typeof value !== 'string') return bad(400, 'invalid_field', field, `${field} must be a base64 string.`);
  if (value.length > MAX_FIELD_B64_CHARS) {
    return bad(413, 'payload_too_large', field, `${field} decodes to more than ${MAX_FIELD_BYTES} bytes.`, { max_bytes: MAX_FIELD_BYTES });
  }
  if (value.length % 4 !== 0 || !B64_RE.test(value)) {
    return bad(400, 'invalid_base64', field, `${field} must be standard base64 (A-Z a-z 0-9 + / and = padding).`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_FIELD_BYTES) {
    return bad(413, 'payload_too_large', field, `${field} decodes to more than ${MAX_FIELD_BYTES} bytes.`, { max_bytes: MAX_FIELD_BYTES });
  }
  try {
    return { ok: true, text: UTF8_STRICT.decode(bytes) };
  } catch {
    return bad(400, 'invalid_utf8', field, `${field} must decode to valid UTF-8 text.`);
  }
}

function buildPrompt(spec: string, context: string | null): string {
  const parts = [INSTRUCTIONS, '', '=== SPEC ===', spec];
  if (context !== null) parts.push('', '=== CONTEXT ===', context);
  parts.push('', '=== END ===');
  return parts.join('\n');
}

// --- upstream failure mapping ------------------------------------------------------------------

/** Remove the provider key from text before it can reach a response, even if a vendor echoed it. */
function scrub(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join('[redacted]') : text;
}

function mapUpstreamError(err: unknown, apiKey: string): { status: number; body: Record<string, unknown>; retryAfterSec?: number } {
  if (err instanceof RateLimitError) {
    const sec = Math.min(300, Math.max(1, Math.ceil((err.retryAfterMs ?? 10_000) / 1000)));
    return { status: 429, retryAfterSec: sec, body: { error: 'provider_rate_limited', message: 'The free provider rate-limited this request.' } };
  }
  if (err instanceof AuthError) {
    // The caller authenticated fine; OUR credential for the vendor was rejected. 502, not 401/403,
    // so it cannot be mistaken for the caller's own auth failing.
    return { status: 502, body: { error: 'provider_auth_failed', message: 'The free provider rejected the server-side credential.' } };
  }
  const message = scrub(err instanceof Error ? err.message : String(err), apiKey).slice(0, 400);
  if (/abort|timed?[ -]?out/i.test(message)) {
    return { status: 504, body: { error: 'provider_timeout', message } };
  }
  return { status: 502, body: { error: 'provider_error', message } };
}

let inFlight = 0;

// --- the route ---------------------------------------------------------------------------------

router.post('/dev/codegen', async (req: Request, res: Response) => {
  // 1. Flag gate — FIRST. Off is a 404 indistinguishable in kind from a route that does not exist.
  if (!devCodegenEnabled()) {
    return res.status(404).json({ error: 'not_found', message: 'Dev codegen is not enabled on this deployment.' });
  }
  res.setHeader('Cache-Control', 'no-store');

  // 2. Authenticated. authMiddleware sets req.apiKey on success and ends the request otherwise;
  //    this only matters if the mount order is ever broken, and then it fails closed.
  if (!(req as any).apiKey) {
    return res.status(401).json({ error: 'unauthorized', message: 'API key required.' });
  }
  // 3. Operator (env-allowlisted) keys only — see the header. `agent_id` is set only for keys
  //    issued to a registered agent.
  if ((req as any).agent_id) {
    return res.status(403).json({ error: 'operator_key_required', message: 'This route accepts operator API keys only.' });
  }

  // 4. Body: an allowlist of exactly two fields.
  const body: unknown = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'invalid_body', message: 'Send a JSON object with spec_b64 (and optionally context_b64).' });
  }
  const record = body as Record<string, unknown>;
  const unsupported = Object.keys(record).filter((k) => !ALLOWED_FIELDS.has(k));
  if (unsupported.length > 0) {
    return res.status(400).json({
      error: 'unsupported_field',
      message: 'Only spec_b64 and context_b64 are accepted; the destination and model are fixed server-side.',
      fields: unsupported.slice(0, 10).map((k) => k.slice(0, 64)),
    });
  }

  if (record['spec_b64'] === undefined) {
    return res.status(400).json({ error: 'missing_field', field: 'spec_b64', message: 'spec_b64 is required.' });
  }
  const spec = decodeField('spec_b64', record['spec_b64']);
  if (!spec.ok) return res.status(spec.status).json(spec.body);
  if (spec.text.trim() === '') {
    return res.status(400).json({ error: 'empty_spec', field: 'spec_b64', message: 'The decoded spec is empty.' });
  }

  let context: string | null = null;
  if (record['context_b64'] !== undefined) {
    const ctx = decodeField('context_b64', record['context_b64']);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);
    context = ctx.text.trim() === '' ? null : ctx.text;
  }

  // 5. Provider: free only, chosen from what this deployment already has configured.
  const selected = selectProvider();
  if (!selected) {
    return res.status(503).json({
      error: 'no_free_provider_configured',
      message: 'Neither of the free providers this route can use has a key on this deployment.',
    });
  }

  // 6. Bounded concurrency.
  if (inFlight >= MAX_IN_FLIGHT) {
    res.setHeader('Retry-After', '5');
    return res.status(429).json({ error: 'busy', message: 'Too many dev codegen calls in flight; retry shortly.' });
  }

  inFlight += 1;
  try {
    const result = await selected.adapter.complete({
      prompt: buildPrompt(spec.text, context),
      apiKey: selected.apiKey,
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
      timeout: UPSTREAM_TIMEOUT_MS,
      // `model` is deliberately not set: the adapter's own default (operator-overridable by its
      // own env var) decides, never the caller.
    });

    if (typeof result.answer !== 'string' || result.answer.trim() === '') {
      console.warn(`[dev-codegen] provider=${selected.adapter.name} returned an empty completion`);
      return res.status(502).json({
        error: 'empty_completion',
        provider: selected.adapter.name,
        model: result.model,
        message: 'The provider returned no text. Nothing was generated.',
      });
    }

    const finish: unknown = result.rawResponse?.choices?.[0]?.finish_reason;
    console.info(
      `[dev-codegen] ok provider=${selected.adapter.name} model=${result.model} ` +
        `spec_bytes=${Buffer.byteLength(spec.text, 'utf8')} tokens_in=${result.tokensIn} tokens_out=${result.tokensOut}`,
    );
    return res.status(200).json({
      enabled: true,
      provider: selected.adapter.name,
      model: result.model,
      output: result.answer,
      truncated: typeof finish === 'string' ? finish === 'length' : null,
      usage: {
        prompt_tokens: result.tokensIn,
        completion_tokens: result.tokensOut,
        latency_ms: result.latencyMs,
      },
    });
  } catch (err) {
    const mapped = mapUpstreamError(err, selected.apiKey);
    console.warn(`[dev-codegen] provider=${selected.adapter.name} failed: ${String(mapped.body['error'])}`);
    if (mapped.retryAfterSec !== undefined) res.setHeader('Retry-After', String(mapped.retryAfterSec));
    return res.status(mapped.status).json({ ...mapped.body, provider: selected.adapter.name });
  } finally {
    inFlight -= 1;
  }
});

export default router;
