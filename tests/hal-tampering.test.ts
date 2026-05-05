/**
 * Wave 5 Phase 5 — tampering detection at strictness level 5.
 *
 * The HAL evaluator activates tampering_signal when:
 *   - strictness >= 5
 *   - cross-LLM consensus has been computed
 *   - agreement_zone === 'too-tight' (similarity > COMMA_BAND_TIGHT_THRESHOLD)
 *
 * At levels 1-4 the flag is null. The signal is INFORMATIONAL only —
 * it does NOT auto-veto in this version (left to downstream policy).
 */
import { evaluate } from '../src/hal/lib/evaluate';
import type { HALContext, HALProviderConfig } from '../src/hal/lib/types';

/**
 * Build a stub provider config that the smoke-test path won't actually
 * reach. We mock checkCrossLLM via direct evaluate() calls — actually
 * no: we'd need to inject a fake checkCrossLLM. Easier: bypass cross-LLM
 * by stubbing the providers.fetch in jest. Cleanest: construct a minimal
 * setup where providers + prompt are present, classifier is absent (so
 * gate auto-allows), and stub out network calls via jest mock of fetch.
 *
 * For deterministic unit testing, mock global fetch.
 */

function stubProvider(provider: string, model: string): HALProviderConfig {
  return {
    provider,
    model,
    endpoint: 'https://stub.example.invalid/v1/chat/completions',
    apiKey: 'stub-key',
    callType: 'openai-compat',
    timeoutMs: 1000,
  };
}

function buildContext(strictness: 1 | 2 | 3 | 4 | 5, identicalAnswer: string): HALContext {
  // Stub fetch to return the same answer from each provider — that
  // produces ultra-tight semantic agreement (similarity ≈ 1) →
  // zone='too-tight' → tampering flag at level 5.
  global.fetch = jest.fn(async (_url: any, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const isAnthropicNative = body?.system !== undefined && body?.messages !== undefined;
    if (isAnthropicNative) {
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: identicalAnswer }] }),
        text: async () => '',
      } as any;
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: identicalAnswer } }],
      }),
      text: async () => '',
    } as any;
  }) as any;

  return {
    domain: 'factual',
    certainty: 0.95,
    prompt: 'What is the capital of France?',
    providers: [
      stubProvider('groq', 'llama-3.3-70b'),
      stubProvider('cerebras', 'llama3.1-8b'),
      stubProvider('openai', 'gpt-4o-mini'),
    ],
    classifierProvider: null, // skip classifier so gate doesn't fire
    embeddingClient: null, // Jaccard; identical strings → similarity = 1
    strictness,
  };
}

describe('tampering detection (Wave 5 Phase 5)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('three identical responses at level 5 → tampering flag set', async () => {
    const ctx = buildContext(5, 'The capital of France is Paris.');
    const r = await evaluate('The capital of France is Paris.', '', ctx);
    expect(r.cross_llm).not.toBeNull();
    expect(r.agreement_zone).toBe('too-tight');
    expect(r.tampering_suspected).toBe(true);
    expect(r.tampering_signal).not.toBeNull();
    expect(r.tampering_signal!.similarity).toBeGreaterThan(0.99);
    expect(r.tampering_signal!.responses.length).toBe(3);
    expect(r.tampering_signal!.reason).toMatch(/tight/);
  });

  test('three identical responses at level 4 → NO tampering flag', async () => {
    const ctx = buildContext(4, 'The capital of France is Paris.');
    const r = await evaluate('The capital of France is Paris.', '', ctx);
    expect(r.tampering_suspected).toBeNull();
    expect(r.tampering_signal).toBeNull();
  });

  test('three identical responses at levels 1-3 → NO tampering flag, NO zone', async () => {
    for (const level of [1, 2, 3] as const) {
      const ctx = buildContext(level, 'The capital of France is Paris.');
      const r = await evaluate('The capital of France is Paris.', '', ctx);
      expect(r.tampering_suspected).toBeNull();
      expect(r.tampering_signal).toBeNull();
      // zone is null at levels 1-3 (only computed at level 4+)
      expect(r.agreement_zone).toBeNull();
    }
  });
});
