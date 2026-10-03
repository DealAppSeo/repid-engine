/**
 * src/orchestration/t12-attempt.ts — the real call behind t12Wave. Fake fetch only; no network.
 */
const dbFrom = jest.fn();
jest.mock('../src/db', () => ({ db: { from: dbFrom, rpc: jest.fn() } }));

import { PROVIDER_URLS } from '../src/egress/provider-hosts';
import { readAnswer, retryAfterMs, t12Ask, t12Target } from '../src/orchestration/t12-attempt';

const ON = {
  T12_FREE_WAVE: 'true',
  T12_LOCAL_BASE_URL: 'http://127.0.0.1:11434/v1',
  GROQ_API_KEY: 'gk-test',
  CEREBRAS_API_KEY: 'ck-test',
};
const ok = (content: string) => JSON.stringify({ choices: [{ message: { content } }] });

type Call = { url: string; headers: Record<string, string>; body: any };
function fakeFetch(replies: Record<string, { status: number; body?: string; retryAfter?: string } | 'throw'>) {
  const calls: Call[] = [];
  const impl = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const host = url.startsWith('http://127.0.0.1') ? 'local' : url.includes('groq') ? 'groq' : url.includes('cerebras') ? 'cerebras' : 'other';
    const r = replies[host];
    if (!r || r === 'throw') throw new Error('down');
    return {
      status: r.status,
      headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? r.retryAfter ?? null : null) },
      text: async () => r.body ?? '',
    };
  });
  return { calls, impl };
}

afterEach(() => expect(dbFrom).not.toHaveBeenCalled());

describe('where each step goes', () => {
  it('cloud steps use the registry URL, even when the process-wide LOCAL_LLM_BASE_URL is set', async () => {
    const env = { ...ON, T12_LOCAL_BASE_URL: undefined, LOCAL_LLM_BASE_URL: 'http://127.0.0.1:11434/v1' };
    expect(t12Target('groq', env)?.url).toBe(PROVIDER_URLS.groqChatCompletions);
    expect(t12Target('cerebras', env)?.url).toBe(PROVIDER_URLS.cerebrasChatCompletions);
    const { calls, impl } = fakeFetch({ groq: { status: 200, body: ok('hi') } });
    const out = await t12Ask('q', { env, fetchImpl: impl, boundaryOn: false });
    expect(out.host).toBe('groq');
    expect(calls.map((c) => c.url)).toEqual([PROVIDER_URLS.groqChatCompletions]);
  });

  it('the local step is sent no key; each key goes only to its own host', async () => {
    const { calls, impl } = fakeFetch({ local: { status: 500 }, groq: { status: 503 }, cerebras: { status: 200, body: ok('x') } });
    await t12Ask('q', { env: ON, fetchImpl: impl, boundaryOn: false });
    const [local, groq, cerebras] = calls;
    expect(local!.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(local!.headers.Authorization).toBeUndefined();
    expect(groq!.headers.Authorization).toBe('Bearer gk-test');
    expect(cerebras!.headers.Authorization).toBe('Bearer ck-test');
    expect(JSON.stringify(local)).not.toMatch(/gk-test|ck-test/);
  });

  it('a host with no key is skipped, not called', async () => {
    const { calls, impl } = fakeFetch({ cerebras: { status: 200, body: ok('y') } });
    const out = await t12Ask('q', { env: { ...ON, T12_LOCAL_BASE_URL: undefined, GROQ_API_KEY: '' }, fetchImpl: impl, boundaryOn: false });
    expect(out.host).toBe('cerebras');
    expect(calls.map((c) => c.url)).toEqual([PROVIDER_URLS.cerebrasChatCompletions]);
  });
});

describe('what counts as an answer', () => {
  it('local answers: the text comes back and no cloud host is called', async () => {
    const { calls, impl } = fakeFetch({ local: { status: 200, body: ok('42') } });
    expect(await t12Ask('q', { env: ON, fetchImpl: impl, boundaryOn: false })).toEqual({ outcome: 'answered', host: 'local', tried: ['local'], text: '42' });
    expect(calls).toHaveLength(1);
  });

  it('a 2xx with an empty or unparseable body is not an answer; the wave moves on', async () => {
    for (const body of ['', 'not json', '{}', ok('   '), JSON.stringify({ choices: [{ message: { content: 7 } }] })]) {
      const { impl } = fakeFetch({ local: { status: 200, body }, groq: { status: 200, body: ok('real') } });
      const out = await t12Ask('q', { env: ON, fetchImpl: impl, boundaryOn: false });
      expect(out).toMatchObject({ outcome: 'answered', host: 'groq', text: 'real' });
    }
  });

  it('every host failing is NOT_CHECKED with no text, never a pass', async () => {
    const { impl } = fakeFetch({ local: 'throw', groq: { status: 200, body: '' }, cerebras: { status: 500 } });
    expect(await t12Ask('q', { env: ON, fetchImpl: impl, boundaryOn: false })).toEqual({ outcome: 'NOT_CHECKED', host: null, tried: ['local', 'groq', 'cerebras'], text: null });
  });
});

describe('429 and the flag', () => {
  it('a 429 stops the wave and passes Retry-After back in ms', async () => {
    const { calls, impl } = fakeFetch({ local: 'throw', groq: { status: 429, retryAfter: '30' }, cerebras: { status: 200, body: ok('z') } });
    expect(await t12Ask('q', { env: ON, fetchImpl: impl, boundaryOn: false })).toEqual({ outcome: 'rate_limited', host: 'groq', tried: ['local', 'groq'], retryAfterMs: 30000, text: null });
    expect(calls).toHaveLength(2);
  });

  it('off makes no call at all', async () => {
    const { impl } = fakeFetch({ local: { status: 200, body: ok('a') } });
    expect((await t12Ask('q', { env: { ...ON, T12_FREE_WAVE: 'TRUE' }, fetchImpl: impl, boundaryOn: false })).outcome).toBe('NOT_CHECKED');
    expect(impl).not.toHaveBeenCalled();
  });

  it('under ONLY_ATTESTATIONS_LEAVE a cloud step is refused before any byte leaves; local still runs', async () => {
    const { calls, impl } = fakeFetch({ local: { status: 500 }, groq: { status: 200, body: ok('leak') }, cerebras: { status: 200, body: ok('leak') } });
    const out = await t12Ask('q', { env: ON, fetchImpl: impl, boundaryOn: true });
    expect(out.outcome).toBe('NOT_CHECKED');
    expect(calls.map((c) => c.url)).toEqual(['http://127.0.0.1:11434/v1/chat/completions']);
  });
});

describe('helpers', () => {
  it('retryAfterMs reads seconds and HTTP dates, and nothing else', () => {
    expect(retryAfterMs('5')).toBe(5000);
    expect(retryAfterMs(new Date(1_000_000 + 10_000).toUTCString(), 1_000_000)).toBe(10_000);
    expect(retryAfterMs('soon')).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });
  it('readAnswer takes only non-empty choices[0].message.content', () => {
    expect(readAnswer(ok('hi'))).toBe('hi');
    expect(readAnswer('')).toBeNull();
    expect(readAnswer('{"choices":[]}')).toBeNull();
  });
});
