/**
 * routing-refusals.test.ts — the three ways a provider says NO, and what the router does
 * with each.
 *
 * These are the cases that decide whether a flip degrades loudly or silently:
 *   1. A key that is PRESENT but DEAD (401/403) — the HuggingFace failure mode of
 *      2026-08-01, where every presence-based check said "fine" while the provider
 *      refused every call.
 *   2. A 429 with a Retry-After header — the provider telling us exactly how long to
 *      wait, which the health layer must honour rather than guess.
 *   3. An unpriced model — the call SUCCEEDS, so nothing refuses; the refusal is the
 *      cost ledger's, and it must refuse to invent a price rather than fabricate one.
 *
 * Adapters are exercised against a stubbed global.fetch — no network, no keys.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import { GroqAdapter } from '../src/providers/groq';
import { OpenRouterAdapter } from '../src/providers/openrouter';
import { AuthError, RateLimitError } from '../src/providers/types';
import * as health from '../src/providers/health';
import { calculateCost } from '../src/billing/pricing';
import { costClass } from '../src/providers/cost-class';

const realFetch = global.fetch;

/**
 * `textBody` is OPTIONAL and omitted by default, so the default double has NO `text()`.
 * That is deliberate: it is the shape a partial mock actually has in the wild, and it is
 * the shape that caught providerHttpError calling `res.text()` unconditionally.
 */
function stubFetch(
  status: number,
  headers: Record<string, string> = {},
  body: any = {},
  textBody?: string,
) {
  global.fetch = jest.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
    json: async () => body,
    ...(textBody === undefined ? {} : { text: async () => textBody }),
  }) as any;
}

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

describe('REFUSAL 1 — a key that is PRESENT but DEAD (401/403)', () => {
  it('groq raises AuthError, not a generic HTTP error', async () => {
    stubFetch(401);
    await expect(
      new GroqAdapter().complete({ prompt: 'hi', apiKey: 'present-but-dead' }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('403 is treated as auth failure too', async () => {
    stubFetch(403);
    await expect(
      new OpenRouterAdapter().complete({ prompt: 'hi', apiKey: 'present-but-dead' }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('GAP: a dead key is indistinguishable from a live one at selection time', () => {
    // resolveAdapterKey / keylessProviders test for PRESENCE only. A dead key resolves
    // to a non-empty string, so the provider stays in the chain and burns an attempt on
    // every request until an operator names it in LLM_DISABLED_PROVIDERS.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/providers/router');
    process.env.GROQ_API_KEY = 'dead-but-present';
    try {
      expect(router.resolveAdapterKey('groq', 0)).toBe('dead-but-present');
      expect(router.keylessProviders()).not.toContain('groq');
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  });

  it('LLM_DISABLED_PROVIDERS is the operator-stated liveness override', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/providers/router');
    process.env.LLM_DISABLED_PROVIDERS = 'groq, CEREBRAS ,';
    try {
      // Case-insensitive, whitespace-tolerant, empty entries dropped.
      expect(router.disabledProviders()).toEqual(['groq', 'cerebras']);
      expect(router.keylessProviders()).toEqual(expect.arrayContaining(['groq', 'cerebras']));
    } finally {
      delete process.env.LLM_DISABLED_PROVIDERS;
    }
  });

  it('three auth failures trip the health breaker for 60s', () => {
    const p = 'auth-fail-probe';
    expect(health.isHealthy(p)).toBe(true);
    health.markFailure(p, new AuthError('dead key'));
    health.markFailure(p, new AuthError('dead key'));
    expect(health.isHealthy(p)).toBe(true); // 2 strikes is still healthy
    health.markFailure(p, new AuthError('dead key'));
    expect(health.isHealthy(p)).toBe(false); // 3rd trips it
  });
});

describe('REFUSAL 2 — 429 with Retry-After', () => {
  it('groq surfaces the header value as retryAfterMs, not a guess', async () => {
    stubFetch(429, { 'retry-after': '7' });
    try {
      await new GroqAdapter().complete({ prompt: 'hi', apiKey: 'k' });
      throw new Error('expected a RateLimitError');
    } catch (e: any) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).retryAfterMs).toBe(7000);
    }
  });

  it('falls back to 10s when the provider omits Retry-After', async () => {
    stubFetch(429, {});
    try {
      await new OpenRouterAdapter().complete({ prompt: 'hi', apiKey: 'k' });
      throw new Error('expected a RateLimitError');
    } catch (e: any) {
      expect((e as RateLimitError).retryAfterMs).toBe(10000);
    }
  });

  it('markRateLimit benches the provider for exactly the stated window', () => {
    const p = 'rate-limited-probe';
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    health.markRateLimit(p, 7000);
    expect(health.isHealthy(p)).toBe(false);

    // Still benched one millisecond before the window closes...
    (Date.now as jest.Mock).mockReturnValue(now + 6999);
    expect(health.isHealthy(p)).toBe(false);
    // ...and back in service after it.
    (Date.now as jest.Mock).mockReturnValue(now + 7001);
    expect(health.isHealthy(p)).toBe(true);
  });

  it('a rate-limited provider is skipped, and the record says WHY', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/providers/router');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildRoutingRecord } = require('../src/decisioning/routing-record');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { operationalCostClass } = require('../src/providers/cost-class');

    const record = buildRoutingRecord({
      chosen: 'cerebras',
      chosenTier: '0a',
      reason: 'fallback_after_failure',
      chain: router.routingChain(false),
      unhealthy: ['groq'], // 429-benched
      classify: operationalCostClass,
    });
    const groq = record.candidates.find((c: any) => c.provider === 'groq');
    expect(groq.outcome).toBe('unhealthy');
    // The fallback stayed free — no silent cost escalation.
    expect(record.chosenCostClass).toBe('free');
    expect(record.freeFirstViolated).toBe(false);
  });
});

describe('REFUSAL 3 — an unpriced model', () => {
  it('the call succeeds; it is the LEDGER that must refuse to guess', async () => {
    stubFetch(200, {}, {
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 1000 },
    });
    const res = await new OpenRouterAdapter().complete({ prompt: 'hi', apiKey: 'k' });
    expect(res.answer).toBe('ok');
    expect(res.model).toBe('qwen/qwen-2.5-72b-instruct');

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cost = calculateCost(res.provider, res.model, res.tokensIn, res.tokensOut);
    // 0 = "we did not price this". NOT "this was free". Unchanged, and it must stay that
    // way: inventing a rate here is the failure this whole module exists to prevent.
    expect(cost).toBe(0);
    // WHAT CHANGED: this 0 used to arrive SILENTLY, because openrouter has no pricing table
    // and `if (!providerPricing) return 0;` returned before the UNPRICED-MODEL warn. A real
    // 2M-token call was ledgered at $0 with nothing in the logs. The early return is gone,
    // so an unpriced call now says so — with the cold catalog here, nothing published a rate.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('UNPRICED MODEL');
    // The classification layer still refuses to call it free.
    expect(costClass(res.provider, res.model)).toBe('unpriced');
  });

  it('a provider that DOES have a table warns loudly on an unknown model', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(calculateCost('groq', 'unpriced-slug', 1000, 1000)).toBe(0);
    expect(String(warn.mock.calls[0]![0])).toContain('NOT "free"');
  });

  it('does NOT fabricate a price from another model in the same provider table', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // groq HAS a table; this model is not in it. The old behaviour inherited the first
    // entry's rate, which is how a $1.44 phantom charge reached /api/v1/costs.
    expect(calculateCost('groq', 'not-a-real-groq-model', 1_000_000, 1_000_000)).toBe(0);
    expect(calculateCost('groq', 'llama-3.1-8b-instant', 1_000_000, 1_000_000)).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(1); // only the unpriced one warned
  });

  it('a genuine free tier is priced EXPLICITLY at zero and stays silent', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(calculateCost('cerebras', 'zai-glm-4.7', 1_000_000, 1_000_000)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(costClass('cerebras', 'zai-glm-4.7')).toBe('free');
  });
});

describe('timeouts', () => {
  it('a fetch abort surfaces as a provider-named error, not a silent empty answer', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('The operation was aborted')) as any;
    await expect(new GroqAdapter().complete({ prompt: 'hi', apiKey: 'k', timeout: 5 })).rejects.toThrow(
      /Groq fetch error/,
    );
  });

  it('a non-401/429 HTTP error is a plain error carrying the status', async () => {
    stubFetch(503);
    await expect(new GroqAdapter().complete({ prompt: 'hi', apiKey: 'k' })).rejects.toThrow(
      /Groq HTTP 503/,
    );
  });

  // The status alone was all these errors used to carry, and it is not enough to tell
  // "our configured model id is retired" from any other 404. A user hit exactly that on
  // 2026-08-21: the log said `Groq HTTP error: 404` and the UI guessed "free tier
  // exhausted", which was false. The vendor had said why, in a body we discarded.
  it('carries the VENDOR BODY so a 404 can be told from a 404', async () => {
    stubFetch(404, {}, {}, JSON.stringify({
      error: { message: 'The model `some-retired-id` does not exist', code: 'model_not_found' },
    }));
    await expect(new GroqAdapter().complete({ prompt: 'hi', apiKey: 'k' })).rejects.toThrow(
      /model_not_found/,
    );
  });

  // A Response-LIKE object without `text()` must still yield a clean error. The default
  // stubFetch above is exactly that shape, and the first version of providerHttpError
  // called `res.text()` unconditionally — turning the error path into an unhandled
  // "res.text is not a function". A helper whose job is to report a failure must never
  // become one; losing the body is acceptable, losing the error is not.
  it('degrades to status-only when the response cannot produce a body', async () => {
    stubFetch(500); // no `text` on this double, by design
    const err = await new GroqAdapter()
      .complete({ prompt: 'hi', apiKey: 'k' })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Groq HTTP 500');
  });
});
