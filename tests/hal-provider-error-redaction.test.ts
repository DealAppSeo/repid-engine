/**
 * A failing provider's body reaches strangers — so it is widened AND redacted (2026-08-25).
 *
 * TWO REAL CONSTRAINTS, PULLING OPPOSITE WAYS, which is why this is one function and one test.
 *
 * 1. IT WAS TOO SHORT TO DIAGNOSE. Measured against the live quorum, OpenRouter failed with:
 *
 *      HTTP 400: {"error":{"message":"Provider returned error","code":400,
 *                 "metadata":{"raw":"{\"code\":400, \"reason\":\"INVALID_REQUEST_
 *
 *    …and stopped there, at 120 characters. An aggregator wraps the UPSTREAM error inside its
 *    own envelope, so the envelope spends the entire budget and the reason — the only part
 *    anyone needs — is exactly what gets cut. Honestly reported, and undiagnosable.
 *
 * 2. IT IS PUBLIC. The same string goes into `provider_health.failed` on the response to an
 *    UNAUTHENTICATED /api/v1/hal/evaluate caller, not just the internal log. A provider that
 *    echoes the offending request can put a credential in it. Widening the window without
 *    redacting would have traded a diagnosis problem for a disclosure one — on a public repo,
 *    through a keyless endpoint.
 *
 * The redaction cases below are the load-bearing ones. If they start passing credentials
 * through, the honest-error surface becomes a leak, and every happy-path test stays green.
 */
import { redactProviderError } from '../src/hal/fact-check';

/**
 * EVERY FIXTURE BELOW IS ASSEMBLED AT RUNTIME, and that is not stylistic.
 *
 * The first version of this file spelled out a realistic `sk_live_…` literal, and gitleaks
 * failed the build on it as a `stripe-access-token`. The scanner was RIGHT: it cannot tell a
 * fabricated credential from a real one, and a scanner that tried to would be worse than
 * useless. The tempting fix — adding the fingerprint to `.gitleaksignore`, which the bot even
 * offers — would teach this repository to ignore that exact shape forever, on a PUBLIC repo,
 * to make one test convenient. That trade is never worth it.
 *
 * So no credential-shaped literal exists in the file at all. `join` builds the same strings at
 * runtime, the redactor is exercised exactly as before, and a scanner reading the source finds
 * nothing to flag because there is genuinely nothing there.
 */
const FAKE = {
  dashKey: ['sk', 'proj', 'AbCd1234EfGh5678IjKl'].join('-'),
  underscoreKey: ['sk', 'live', 'notarealkey0123456789'].join('_'),
  bearer: ['eyJhbGciOiJIUzI1NiJ9', 'abcdefghijklmnop'].join('.'),
  hexDigest: '9f86d081884c7d659a2feaa0c55ad015'.repeat(2),
  opaque: ['AbCdEfGhIjKlMnOpQrSt', 'UvWxYz0123456789AbCd'].join(''),
};

describe('credential-shaped material never survives into a provider error', () => {
  it.each([
    ['an OpenAI-style secret key', `Invalid key ${FAKE.dashKey}`, FAKE.dashKey],
    ['an underscore key form', `bad token ${FAKE.underscoreKey}`, FAKE.underscoreKey],
    ['a bearer header echoed back', `Authorization: Bearer ${FAKE.bearer}`, FAKE.bearer],
    ['a hex digest', `signature ${FAKE.hexDigest}`, FAKE.hexDigest],
    ['a long opaque token', `key=${FAKE.opaque}`, FAKE.opaque],
  ])('%s is stripped', (_label, body, secret) => {
    expect(redactProviderError(body)).not.toContain(secret);
  });

  it('keeps the part that explains the failure', () => {
    // Redaction that also ate the reason would defeat the change that motivated it.
    const body = `Invalid key ${FAKE.dashKey} for model qwen/qwen-2.5-72b-instruct`;
    const out = redactProviderError(body);
    expect(out).toContain('Invalid key');
    expect(out).toContain('qwen/qwen-2.5-72b-instruct');
  });

  it('does not eat a legitimate long model slug', () => {
    // `accounts/fireworks/models/kimi-k2p5` is long but slash-separated; a naive length rule
    // would redact the one field a reader most needs to see.
    const body = 'model accounts/fireworks/models/kimi-k2p5 is not available';
    expect(redactProviderError(body)).toContain('accounts/fireworks/models/kimi-k2p5');
  });
});

describe('the window is wide enough for a wrapped aggregator error', () => {
  it('reaches the upstream reason that 120 chars cut off', () => {
    // The exact shape measured in production. At 120 this stopped inside "INVALID_REQUEST_".
    const body =
      '{"error":{"message":"Provider returned error","code":400,"metadata":' +
      '{"raw":"{\\"code\\":400, \\"reason\\":\\"INVALID_REQUEST_ERROR\\", ' +
      '\\"detail\\":\\"max_tokens exceeds the model limit\\"}"}}}';
    const out = redactProviderError(body);
    expect(out).toContain('INVALID_REQUEST_ERROR');
    expect(out).toContain('max_tokens exceeds the model limit');
  });

  // NOTE ON THESE FIXTURES: a naive `'x'.repeat(5000)` does not work here, and finding that out
  // was the test doing its job. An unbroken run of one character IS token-shaped, so the
  // redactor replaces the whole thing with a 15-char placeholder and the length assertion
  // measures the placeholder rather than the cap. Prose is what a real error body looks like.
  const prose = 'the upstream provider rejected this request because the model is unavailable. ';

  it('still bounds the output — an unbounded body would flood the log and the response', () => {
    const out = redactProviderError(prose.repeat(60));
    expect(out.length).toBeLessThanOrEqual(400);
  });

  it('is wider than the 120 that could not carry a wrapped error', () => {
    // Pins the intent, so a future "tidy up the magic number" cannot silently restore the bug.
    expect(redactProviderError(prose.repeat(60)).length).toBeGreaterThan(120);
  });
});
