/**
 * Phase 4 unit tests for the cross-LLM consensus library.
 *
 * Mocks global fetch so each test can synthesize provider responses.
 * Three scenarios per the sprint: 1 / 2 / 3 provider cases plus
 * targeted Pythagorean Comma BFT severity tier coverage.
 *
 * The legacy src/hal/cross-llm-client.ts continues to handle env-var
 * config + HTTP-proxy mode for production trinity-ecosystem; this test
 * exercises the lib's pure-DI surface.
 */
import { checkCrossLLM, checkPythagoreanComma, jaccardSimilarity, cosineSimilarity } from '../src/hal/lib/cross-llm';
import type { HALProviderConfig } from '../src/hal/lib/types';

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let fetchSpy: jest.SpyInstance<Promise<Response>, [RequestInfo | URL, RequestInit | undefined]> | null = null;

function makeProvider(name: string, callType: 'openai-compat' | 'anthropic-native' = 'openai-compat'): HALProviderConfig {
  return {
    provider: name,
    squad: name === 'groq' ? 'alpha' : name === 'anthropic' ? 'beta' : 'gamma',
    model: `${name}-test-model`,
    endpoint: `https://api.${name}.test/v1/chat`,
    apiKey: `test-key-${name}`,
    callType,
    timeoutMs: 1000,
  };
}

function buildOpenAICompatResponse(text: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function buildAnthropicResponse(text: string): Response {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function installFetchMock(impl: FetchImpl) {
  fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(impl as any);
}

afterEach(() => {
  if (fetchSpy) { fetchSpy.mockRestore(); fetchSpy = null; }
});

describe('checkCrossLLM — 0/1 provider degenerate cases', () => {
  it('returns zero-signal when no providers respond', async () => {
    installFetchMock(async () => new Response('error', { status: 500 }));
    const result = await checkCrossLLM('Who wrote Hamlet?', {
      providers: [makeProvider('groq')],
    });
    expect(result.agreement_score).toBe(0);
    expect(result.comma_severity).toBe('none');
    expect(result.comma_veto).toBe(false);
    expect(result.beliefs).toEqual([]);
    expect(result.answers_per_provider).toHaveLength(1);
    expect(result.answers_per_provider[0]?.error).toBeTruthy();
  });

  it('returns zero-signal with 1 successful provider (need 2+ to compare)', async () => {
    installFetchMock(async () => buildOpenAICompatResponse('Shakespeare wrote Hamlet.'));
    const result = await checkCrossLLM('Who wrote Hamlet?', {
      providers: [makeProvider('groq')],
    });
    expect(result.agreement_score).toBe(0);
    expect(result.comma_severity).toBe('none');
    expect(result.comma_veto).toBe(false);
    expect(result.beliefs).toEqual([]);
  });
});

describe('checkCrossLLM — 2 providers (agreement, no BFT veto)', () => {
  it('computes Jaccard agreement on textual overlap when no embedding client', async () => {
    const responses: Record<string, string> = {
      groq: 'Shakespeare wrote Hamlet around 1600.',
      anthropic: 'Hamlet was written by William Shakespeare around 1600.',
    };
    installFetchMock(async (input, init) => {
      const url = String(input);
      const provider = url.includes('anthropic') ? 'anthropic' : 'groq';
      return provider === 'anthropic'
        ? buildAnthropicResponse(responses[provider]!)
        : buildOpenAICompatResponse(responses[provider]!);
    });

    const result = await checkCrossLLM('Who wrote Hamlet?', {
      providers: [makeProvider('groq'), makeProvider('anthropic', 'anthropic-native')],
    });

    expect(result.agreement_score).toBeGreaterThan(0);
    expect(result.agreement_score).toBeLessThanOrEqual(1);
    expect(result.beliefs).toHaveLength(2);
    // BFT is meaningless with 2 providers
    expect(result.comma_severity).toBe('none');
    expect(result.comma_veto).toBe(false);
    expect(result.comma_gap).toBeNull();
    expect(result.methodology).toBe('fallback-jaccard');
  });

  it('answers_per_provider preserves provider names + models even on failure', async () => {
    let callCount = 0;
    installFetchMock(async () => {
      callCount += 1;
      if (callCount === 1) return buildOpenAICompatResponse('Answer one.');
      return new Response('{"error":"rate limited"}', { status: 429 });
    });
    const result = await checkCrossLLM('Q?', {
      providers: [makeProvider('groq'), makeProvider('anthropic', 'anthropic-native')],
    });
    expect(result.answers_per_provider).toHaveLength(2);
    expect(result.answers_per_provider[0]?.provider).toBe('groq');
    expect(result.answers_per_provider[1]?.provider).toBe('anthropic');
    expect(result.answers_per_provider[1]?.error).toMatch(/429/);
  });
});

describe('checkCrossLLM — 3 providers, BFT veto active', () => {
  function mock3Providers(answers: { groq: string; anthropic: string; deepseek: string }) {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.includes('anthropic')) return buildAnthropicResponse(answers.anthropic);
      if (url.includes('deepseek')) return buildOpenAICompatResponse(answers.deepseek);
      return buildOpenAICompatResponse(answers.groq);
    });
  }

  it('produces a 3-belief vector and runs BFT', async () => {
    mock3Providers({
      groq: 'Shakespeare wrote Hamlet around 1600.',
      anthropic: 'Hamlet was written by Shakespeare around 1600.',
      deepseek: 'Shakespeare authored Hamlet in approximately 1600.',
    });
    const result = await checkCrossLLM('Who wrote Hamlet?', {
      providers: [
        makeProvider('groq'),
        makeProvider('anthropic', 'anthropic-native'),
        makeProvider('deepseek'),
      ],
    });
    expect(result.beliefs).toHaveLength(3);
    expect(result.comma_gap).not.toBeNull();
    expect(['none', 'minor', 'major', 'critical']).toContain(result.comma_severity);
  });

  it('triggers comma_veto when answers are suspiciously identical (critical severity)', async () => {
    // Identical answers ⇒ all pairwise sims ≈ 1 ⇒ all beliefs ≈ 1 ⇒ gap ≈ 0
    // ⇒ severity 'critical' (gap < 0.05 AND avg > 0.85)
    const sameAnswer = 'The Pythagorean Comma is exactly 531441 over 524288.';
    mock3Providers({ groq: sameAnswer, anthropic: sameAnswer, deepseek: sameAnswer });
    const result = await checkCrossLLM('What is the Pythagorean Comma?', {
      providers: [
        makeProvider('groq'),
        makeProvider('anthropic', 'anthropic-native'),
        makeProvider('deepseek'),
      ],
    });
    expect(result.beliefs).toHaveLength(3);
    expect(result.comma_severity).toBe('critical');
    expect(result.comma_veto).toBe(true);
    expect(result.comma_gap).not.toBeNull();
    expect(result.comma_gap!).toBeLessThan(0.05);
  });

  it('does not veto when 3 providers disagree completely (low avg, no critical signature)', async () => {
    mock3Providers({
      groq: 'Apples are red and round.',
      anthropic: 'The square root of negative one is i.',
      deepseek: 'Bicycles have two wheels usually.',
    });
    const result = await checkCrossLLM('Random query', {
      providers: [
        makeProvider('groq'),
        makeProvider('anthropic', 'anthropic-native'),
        makeProvider('deepseek'),
      ],
    });
    expect(result.beliefs).toHaveLength(3);
    // Disjoint Jaccard ⇒ all pairwise sims = 0 ⇒ beliefs = [0,0,0] ⇒ gap=0, avg=0.
    // gap<0.15 hits the 'minor' tier per BFT rule order. The KEY production
    // invariant is that comma_veto stays false (avg=0 ≪ vetoAvg=0.85), which
    // is the actual safety property. 'minor' here is a side-effect of identical
    // beliefs, not a coordinated-bias signature.
    expect(result.comma_veto).toBe(false);
    expect(result.agreement_score).toBe(0);
    expect(result.comma_gap).not.toBeNull();
  });
});

describe('Pythagorean Comma BFT — direct unit', () => {
  it('returns none with <3 beliefs', () => {
    expect(checkPythagoreanComma([]).severity).toBe('none');
    expect(checkPythagoreanComma([0.9]).severity).toBe('none');
    expect(checkPythagoreanComma([0.9, 0.91]).severity).toBe('none');
    expect(checkPythagoreanComma([0.9, 0.91]).comma_gap).toBeNull();
  });

  it('critical when gap<0.05 and avg>0.85', () => {
    const r = checkPythagoreanComma([0.92, 0.93, 0.94]);
    expect(r.severity).toBe('critical');
    expect(r.comma_veto).toBe(true);
    expect(r.comma_gap).toBeCloseTo(0.02, 6);
  });

  it('major when gap<0.10 and avg>0.75 but not critical', () => {
    const r = checkPythagoreanComma([0.78, 0.82, 0.85]);
    expect(r.severity).toBe('major');
    expect(r.comma_veto).toBe(false);
  });

  it('minor when gap<0.15', () => {
    const r = checkPythagoreanComma([0.40, 0.45, 0.50]);
    expect(r.severity).toBe('minor');
    expect(r.comma_veto).toBe(false);
  });

  it('none when gap>=0.15', () => {
    const r = checkPythagoreanComma([0.10, 0.50, 0.90]);
    expect(r.severity).toBe('none');
    expect(r.comma_veto).toBe(false);
  });
});

describe('similarity primitives', () => {
  it('cosine identical = 1', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 12);
  });
  it('cosine orthogonal = 0', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 12);
  });
  it('cosine zero vector = 0', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
  });
  it('jaccard identical = 1', () => {
    expect(jaccardSimilarity('hello world', 'hello world')).toBeCloseTo(1, 12);
  });
  it('jaccard disjoint = 0', () => {
    expect(jaccardSimilarity('alpha beta', 'gamma delta')).toBe(0);
  });
  it('jaccard partial overlap', () => {
    expect(jaccardSimilarity('cap rate compressed', 'industrial cap rate')).toBeCloseTo(2 / 4, 6);
  });
});
