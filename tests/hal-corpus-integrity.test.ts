/**
 * Environment-vs-quality classification.
 *
 * The golden-math tripwire once went red because a provider key had died, and it read as a scoring
 * failure — sending someone after a bug that did not exist. These tests pin the property that a broken
 * instrument reports as a broken instrument, in the first line of the failure text.
 * Pure — no DB, no network, no provider keys.
 */
import {
  assertQualityMeasurable,
  assessRunIntegrity,
  classifyProviderError,
  EnvironmentFaultError,
  formatIntegrityFailure,
  isEnvironmentKind,
  observedFamilyWidth,
  ProviderAttempt,
} from '../src/hal/measurement-integrity';
import { ConfigurationWidth } from '../src/hal/measurement-ruler';

function width(over: Partial<ConfigurationWidth> = {}): ConfigurationWidth {
  return {
    familiesConfigured: 2,
    familiesMin: 2,
    familiesMax: 2,
    strictness: 2,
    decisionRequiresQuorum: true,
    penaltyRequiresQuorum: true,
    ...over,
  };
}

const ok = (provider: string, family: string): ProviderAttempt => ({ provider, family, ok: true });
const bad = (provider: string, family: string, error?: string, httpStatus?: number): ProviderAttempt => ({
  provider,
  family,
  ok: false,
  ...(error === undefined ? {} : { error }),
  ...(httpStatus === undefined ? {} : { httpStatus }),
});

describe('classifyProviderError', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [402, 'quota'],
    [429, 'rate-limit'],
    [500, 'provider-error'],
    [503, 'provider-error'],
  ])('maps HTTP %s to %s', (status, kind) => {
    expect(classifyProviderError(undefined, status as number)).toBe(kind);
  });

  it.each([
    ['Invalid API key provided', 'auth'],
    ['401 Unauthorized', 'auth'],
    ['Authentication failed', 'auth'],
    ['missing api key for provider', 'auth'],
    ['You exceeded your current quota', 'quota'],
    ['insufficient balance', 'quota'],
    ['Rate limit reached, please slow down', 'rate-limit'],
    ['429 Too Many Requests', 'rate-limit'],
    ['ETIMEDOUT connecting to host', 'network'],
    ['fetch failed', 'network'],
    ['socket hang up', 'network'],
    ['502 Bad Gateway', 'provider-error'],
    ['Unexpected token < in JSON at position 0', 'malformed-response'],
    ['empty completion returned', 'malformed-response'],
  ])('classifies %j as %s', (msg, kind) => {
    expect(classifyProviderError(msg as string)).toBe(kind);
  });

  it('status code wins over misleading error text', () => {
    expect(classifyProviderError('something about json parsing', 401)).toBe('auth');
  });

  it('defaults to unknown, and unknown counts as ENVIRONMENT', () => {
    // Guessing "quality" is the expensive mistake; guessing "environment" only withholds a number.
    expect(classifyProviderError('kaboom')).toBe('unknown');
    expect(isEnvironmentKind('unknown')).toBe(true);
  });

  it('malformed-response is NOT an environment fault — the provider answered', () => {
    expect(isEnvironmentKind('malformed-response')).toBe(false);
  });
});

describe('a dead key blocks the measurement and says so', () => {
  const attempts = [ok('groq', 'llama'), bad('cerebras', 'qwen', 'Invalid API key', 401)];

  it('is not quality-measurable', () => {
    expect(assessRunIntegrity({ attempts, width: width() }).measurable).toBe(false);
  });

  it('leads with ENVIRONMENT FAILURE and denies a quality regression in the first line', () => {
    const msg = formatIntegrityFailure(assessRunIntegrity({ attempts, width: width() }));
    const firstLine = msg.split('\n')[0]!;
    expect(firstLine).toContain('ENVIRONMENT FAILURE');
    expect(firstLine).toMatch(/NOT a HAL quality regression/);
  });

  it('names the provider whose credential died', () => {
    const msg = formatIntegrityFailure(assessRunIntegrity({ attempts, width: width() }));
    expect(msg).toContain('cerebras');
    expect(msg).toMatch(/key is dead, revoked, or absent/);
  });

  it('tells the reader NOT to investigate scoring', () => {
    const msg = formatIntegrityFailure(assessRunIntegrity({ attempts, width: width() }));
    expect(msg).toMatch(/Do NOT investigate HAL's scoring/);
  });

  it('warns that a key can be present and dead — probe, do not merely check', () => {
    const msg = formatIntegrityFailure(assessRunIntegrity({ attempts, width: width() }));
    expect(msg).toMatch(/PRESENT and DEAD/);
    expect(msg).toMatch(/Probe it with a real call/);
  });

  it('assertQualityMeasurable throws EnvironmentFaultError carrying the faults', () => {
    let err: unknown;
    try {
      assertQualityMeasurable({ attempts, width: width() }, 'golden-math tripwire');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnvironmentFaultError);
    const e = err as EnvironmentFaultError;
    expect(e.message).toContain('ENVIRONMENT FAILURE');
    expect(e.message).toContain('golden-math tripwire');
    expect(e.faults.some((f) => f.kind === 'auth')).toBe(true);
  });
});

describe('other environment classes also block', () => {
  it.each([
    ['quota exhausted', bad('deepseek', 'deepseek', 'insufficient balance', 402)],
    ['rate limit', bad('groq', 'llama', 'Rate limit reached', 429)],
    ['network', bad('fireworks', 'llama', 'ETIMEDOUT')],
    ['provider 5xx', bad('gemini', 'gemini', 'Service Unavailable', 503)],
    ['unclassified', bad('mistral', 'mistral', 'weird failure')],
  ])('%s blocks the measurement', (_label, attempt) => {
    const v = assessRunIntegrity({ attempts: [ok('groq', 'llama'), attempt as ProviderAttempt], width: width() });
    expect(v.measurable).toBe(false);
    expect(formatIntegrityFailure(v)).toContain('ENVIRONMENT FAILURE');
  });

  it('all providers failing is reported as no-providers-reached', () => {
    const v = assessRunIntegrity({
      attempts: [bad('groq', 'llama', 'ETIMEDOUT'), bad('cerebras', 'qwen', 'ETIMEDOUT')],
      width: width({ familiesMin: 0, familiesMax: 0 }),
    });
    expect(v.measurable).toBe(false);
    expect(v.faults.some((f) => f.kind === 'no-providers-reached')).toBe(true);
  });
});

describe('silent narrowing of the quorum blocks the measurement', () => {
  it('flags insufficient-families when observed width is below configured', () => {
    // The live case: run ga-internal-2026-06-09 judged 312 cases with 1 family, 9 with 2, 1 with 3,
    // while nominally configured wider. The number that came out belonged to a different ruler.
    const v = assessRunIntegrity({
      attempts: [ok('litellm', 'llama')],
      width: width({ familiesConfigured: 3, familiesMin: 1, familiesMax: 3 }),
    });
    expect(v.measurable).toBe(false);
    expect(v.faults.some((f) => f.kind === 'insufficient-families')).toBe(true);
    expect(formatIntegrityFailure(v)).toMatch(/quorum was narrower than the instrument described/);
  });

  it('an intact run at full configured width is measurable', () => {
    const v = assessRunIntegrity({ attempts: [ok('groq', 'llama'), ok('cerebras', 'qwen')], width: width() });
    expect(v.measurable).toBe(true);
    expect(v.summary).toContain('instrument intact');
  });

  it('a malformed response alone does not block, but is still reported', () => {
    const v = assessRunIntegrity({
      attempts: [ok('groq', 'llama'), ok('cerebras', 'qwen'), bad('x', 'llama', 'invalid json')],
      width: width(),
    });
    expect(v.measurable).toBe(true);
    expect(v.faults.some((f) => f.kind === 'malformed-response')).toBe(true);
    expect(v.summary).toContain('non-blocking fault');
  });
});

describe('observedFamilyWidth counts families, not providers', () => {
  it('two hosts serving the same family count once', () => {
    expect(observedFamilyWidth([ok('groq', 'llama'), ok('deepinfra', 'llama')])).toBe(1);
  });

  it('distinct families count separately', () => {
    expect(observedFamilyWidth([ok('groq', 'llama'), ok('cerebras', 'qwen')])).toBe(2);
  });

  it('failed attempts do not contribute width', () => {
    expect(observedFamilyWidth([ok('groq', 'llama'), bad('cerebras', 'qwen', 'Invalid API key', 401)])).toBe(1);
  });

  it('an empty provider list is width zero — matching the 43 rows recorded with no providers used', () => {
    expect(observedFamilyWidth([])).toBe(0);
  });
});
