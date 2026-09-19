/**
 * HYP-11 — the four wrapped files honour LOCAL_LLM_BASE_URL for openai-compat.
 * Anthropic-native / Gemini generateContent are NOT pretended openai-compat.
 */
const fetchSpy = jest.fn(async (url: string) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: '{"rules":[],"validity":0.9,"confidence":0.9}' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }),
  text: async () => '',
}));

jest.mock('../src/egress/provider-fetch', () => ({
  providerFetch: (...args: any[]) => fetchSpy(...args),
}));

import { checkCompleteness } from '../src/hal/completeness';
import { suggestConstitutionalRules } from '../src/engine/badges';
import { PROVIDER_URLS } from '../src/egress/provider-hosts';

const LOCAL = 'http://127.0.0.1:11434/v1';
const LOCAL_CHAT = 'http://127.0.0.1:11434/v1/chat/completions';

describe('HYP-11 LOCAL_LLM_BASE_URL on type-B openai-compat', () => {
  const prevLocal = process.env.LOCAL_LLM_BASE_URL;
  const prevGroq = process.env.GROQ_API_KEY;
  const prevCerebras = process.env.CEREBRAS_API_KEY;

  beforeEach(() => {
    fetchSpy.mockClear();
    process.env.LOCAL_LLM_BASE_URL = LOCAL;
    process.env.GROQ_API_KEY = 'test-groq';
    process.env.CEREBRAS_API_KEY = 'test-cerebras';
  });

  afterAll(() => {
    process.env.LOCAL_LLM_BASE_URL = prevLocal;
    process.env.GROQ_API_KEY = prevGroq;
    process.env.CEREBRAS_API_KEY = prevCerebras;
  });

  it('completeness groq call does not hit the cloud host', async () => {
    await checkCompleteness('q', 'a');
    expect(fetchSpy).toHaveBeenCalled();
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toBe(LOCAL_CHAT);
    expect(url).not.toContain('api.groq.com');
  });

  it('badges cerebras call does not hit the cloud host', async () => {
    await suggestConstitutionalRules({ role: 'x', domain: 'y' });
    expect(fetchSpy).toHaveBeenCalled();
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toBe(LOCAL_CHAT);
    expect(url).not.toContain('api.cerebras.ai');
  });

  it('hosted defaults are unchanged when LOCAL_LLM_BASE_URL is unset', async () => {
    delete process.env.LOCAL_LLM_BASE_URL;
    await checkCompleteness('q', 'a');
    expect(String(fetchSpy.mock.calls[0][0])).toBe(PROVIDER_URLS.groqChatCompletions);
  });
});
