/**
 * The seam between what fact-check COMPUTES and what a caller actually RECEIVES.
 *
 * THIS SUITE EXISTS BECAUSE A UNIT-TESTED FIELD SHIPPED AND NEVER ARRIVED.
 * `independent_hosts` was computed in fact-check.ts, declared on FactCheckResult, returned on
 * the internal object, and covered by passing tests — then dropped, because `service.ts`
 * rebuilds the response `signals` field by field and nobody added the new one to that list. It
 * merged, deployed, and was found only by probing the live endpoint: the field was simply
 * absent from the JSON.
 *
 * The lesson is about WHERE the test was, not whether one existed. Every assertion pointed at
 * the computation; none pointed at the crossing. A hand-copied projection is a seam, and a seam
 * needs a test that spans it — which is what this file is.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

const FC_RESULT = {
  hal_score: 0.1,
  decision: 'clean' as const,
  verdicts: [
    { provider: 'openrouter', model: 'qwen/q', verdict: 'TRUE', confidence: 0.9, latency_ms: 10 },
    { provider: 'openrouter-2', model: 'meta/l', verdict: 'TRUE', confidence: 0.9, latency_ms: 11 },
    { provider: 'groq', model: 'llama-3.1-8b-instant', verdict: 'TRUE', confidence: 0.9, latency_ms: 12 },
  ],
  providers_used: 3,
  families_used: 3,
  families: ['qwen', 'llama', 'mistral'],
  // The field under test: three families, but only TWO distinct hosts.
  independent_hosts: 2,
  agreement: 1,
  degraded: false,
  latency_ms: 33,
  quorum: { ok: true, attempted: 3, succeeded: 3 },
  provider_health: { attempted: 3, succeeded: 3, failed: [] },
};

jest.mock('../src/hal/fact-check', () => {
  const actual = jest.requireActual('../src/hal/fact-check');
  return {
    ...actual,
    buildFactCheckProviders: () => [
      { name: 'openrouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'k', model: 'qwen/q' },
      { name: 'openrouter-2', endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'k', model: 'meta/l' },
      { name: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: 'k', model: 'llama-3.1-8b-instant' },
    ],
    factCheck: jest.fn(async () => FC_RESULT),
  };
});

import { halService } from '../src/hal/service';

describe('signals crossing: fact-check result -> API response', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env = { ...saved };
    process.env.HAL_STRICTNESS = '2';
  });
  afterAll(() => { process.env = { ...saved }; });

  it('independent_hosts REACHES the caller — the thing that was missing in production', async () => {
    const res: any = await halService.evaluate({ text: 'The capital of France is Paris.' } as any);
    expect(res.signals).toBeDefined();
    expect(res.signals.independent_hosts).toBe(2);
  });

  it('it does not silently replace families_used — the two travel together', async () => {
    const res: any = await halService.evaluate({ text: 'The capital of France is Paris.' } as any);
    expect(res.signals.families_used).toBe(3);
    expect(res.signals.independent_hosts).toBe(2);
    // The whole point: more families than hosts is representable, and visible.
    expect(res.signals.independent_hosts).toBeLessThan(res.signals.families_used);
  });

  it('omits the field rather than inventing 0 when fact-check did not supply it', async () => {
    // An older/other path that returns no host count must not report "0 independent hosts",
    // which would read as a total outage rather than as "not measured here".
    const fc = jest.requireMock('../src/hal/fact-check');
    fc.factCheck.mockResolvedValueOnce({ ...FC_RESULT, independent_hosts: undefined });
    const res: any = await halService.evaluate({ text: 'The capital of France is Paris.' } as any);
    expect('independent_hosts' in res.signals).toBe(false);
  });
});
