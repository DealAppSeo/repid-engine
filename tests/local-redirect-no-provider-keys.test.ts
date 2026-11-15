/**
 * With LOCAL_LLM_BASE_URL set, no provider's own key may reach the redirect host.
 * Before 2026-11-15 every redirected provider sent its real key there (measured 2026-09-09:
 * 10 distinct keys to one host). providerFetch now presents only LOCAL_LLM_API_KEY, or nothing.
 */
import { providerFetch } from '../src/egress/provider-fetch';
import { buildFactCheckProviders, factCheck } from '../src/hal/fact-check';
import { OpenAIEmbeddingClient } from '../src/hal/lib/cross-llm/embedding-client';

const BASE = 'http://localhost:11434/v1';
const FAKE = { GROQ_API_KEY: 'FAKE-groq-key-0001', DEEPSEEK_API_KEY: 'FAKE-deepseek-key-0002' };
const saved = { ...process.env };
type Sent = { url: string; headers: Headers };
let sent: Sent[];

beforeEach(() => {
  sent = [];
  for (const k of ['LOCAL_LLM_BASE_URL', 'OPENAI_BASE_URL', 'LOCAL_LLM_API_KEY']) delete process.env[k];
  jest.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    sent.push({ url: typeof input === 'string' ? input : String(input.url ?? input), headers: new Headers(init?.headers) });
    const body = { choices: [{ message: { content: '{"verdict":"SUPPORTED","confidence":0.9}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...saved };
});

const allHeaderText = (s: Sent) => [...s.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');

describe('providerFetch credential presentation', () => {
  it('passes headers through unchanged when no redirect is set', async () => {
    await providerFetch(`${BASE}/chat/completions`, { headers: { Authorization: 'Bearer FAKE-real-key' } });
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer FAKE-real-key');
  });

  it('strips Authorization and x-api-key on requests to the redirect host', async () => {
    process.env.LOCAL_LLM_BASE_URL = BASE;
    await providerFetch(`${BASE}/chat/completions`, { headers: { Authorization: 'Bearer FAKE-real-key', 'x-api-key': 'FAKE-anthropic-key', 'Content-Type': 'application/json' } });
    expect(allHeaderText(sent[0]!)).not.toMatch(/FAKE-real-key|FAKE-anthropic-key/);
    expect(sent[0]!.headers.get('content-type')).toBe('application/json');
  });

  it('presents LOCAL_LLM_API_KEY, and only that, when it is set', async () => {
    process.env.LOCAL_LLM_BASE_URL = BASE;
    process.env.LOCAL_LLM_API_KEY = 'local-gateway-key';
    await providerFetch(`${BASE}/chat/completions`, { headers: { Authorization: 'Bearer FAKE-real-key' } });
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer local-gateway-key');
  });

  it('leaves requests to any other host untouched while a redirect is set', async () => {
    process.env.LOCAL_LLM_BASE_URL = BASE;
    await providerFetch('https://api.groq.com/openai/v1/chat/completions', { headers: { Authorization: 'Bearer FAKE-real-key' } });
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer FAKE-real-key');
  });
});

describe('embeddings under LOCAL_LLM_BASE_URL', () => {
  it('sends the embedding client\'s key nowhere near the redirect host', async () => {
    process.env.LOCAL_LLM_BASE_URL = BASE;
    await new OpenAIEmbeddingClient(`${BASE}/embeddings`, 'FAKE-openai-key-0003').embedMany(['a']).catch(() => undefined);
    expect(sent.filter((s) => s.url.startsWith(BASE)).length).toBe(1); // the instrument saw the request
    expect(allHeaderText(sent[0]!)).not.toContain('FAKE-openai-key-0003');
  });
});

describe('HAL fact-check end to end under LOCAL_LLM_BASE_URL', () => {
  it('reaches the local host and sends it none of the provider keys', async () => {
    Object.assign(process.env, FAKE, { LOCAL_LLM_BASE_URL: BASE, HAL_S2_ENABLE_DEEPSEEK: 'true' });
    const providers = buildFactCheckProviders();
    expect(providers.length).toBeGreaterThanOrEqual(2);
    expect(providers.every((p) => p.endpoint.startsWith(BASE))).toBe(true);
    // The configs still hold the real keys; the guard is at send time, not build time.
    expect(providers.map((p) => p.apiKey)).toEqual(expect.arrayContaining(Object.values(FAKE)));

    await factCheck('The capital of France is Paris.', providers);

    const local = sent.filter((s) => s.url.startsWith(BASE));
    expect(local.length).toBeGreaterThanOrEqual(providers.length); // the instrument saw real requests
    for (const s of local) for (const key of Object.values(FAKE)) expect(allHeaderText(s)).not.toContain(key);
  });
});
