/**
 * src/jev/classify.ts — label + score, never `reject`, fails closed to not-checked.
 * Four groups cover Sean's five boxes: (1) missing model / timeout / empty body,
 * (2) "...veto" is not a veto, (3) over 3 s is not-checked + 'Still checking',
 * (4) no paid model and no Anthropic, and (5) nothing stored.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const dbFrom = jest.fn();
const dbRpc = jest.fn();
jest.mock('../src/db', () => ({ db: { from: dbFrom, rpc: dbRpc } }));

import { jevClassify, localModelUrl, readJevAnswer, SLOW_LINE, SLOW_MS } from '../src/jev/classify';

const LOCAL = 'http://127.0.0.1:8088/classify';

function reply(status: number, body: string) {
  return jest.fn(async (_url: string, _init: RequestInit) => ({ status, text: async () => body }));
}

afterEach(() => {
  expect(dbFrom).not.toHaveBeenCalled();
  expect(dbRpc).not.toHaveBeenCalled();
  dbFrom.mockClear();
  dbRpc.mockClear();
});

describe('(1) a missing model, a timeout or an empty body is not-checked — never 0, never pass', () => {
  it('no model URL is not-checked and makes no call', async () => {
    const fetchImpl = reply(200, '{"label":"pass","score":1}');
    const out = await jevClassify('2 + 2 = 4', { modelUrl: null, fetchImpl });
    expect(out).toEqual({ label: 'not-checked', score: null, latency_ms: expect.any(Number) });
    expect(fetchImpl).not.toHaveBeenCalled();
    const unset = await jevClassify('2 + 2 = 4', { fetchImpl }); // JEV_CLASSIFY_URL is not set in tests
    expect(unset.label).toBe('not-checked');
  });

  it('empty text, an empty body, a non-200 and unparseable JSON are not-checked with no score', async () => {
    const outs = await Promise.all([
      jevClassify('   ', { modelUrl: LOCAL, fetchImpl: reply(200, '{"label":"pass","score":0.9}') }),
      jevClassify('claim', { modelUrl: LOCAL, fetchImpl: reply(200, '') }),
      jevClassify('claim', { modelUrl: LOCAL, fetchImpl: reply(500, '{"label":"pass"}') }),
      jevClassify('claim', { modelUrl: LOCAL, fetchImpl: reply(200, '{"label":') }),
      jevClassify('claim', {
        modelUrl: LOCAL,
        fetchImpl: jest.fn(async () => {
          throw new Error('ECONNREFUSED');
        }),
      }),
    ]);
    for (const out of outs) {
      expect(out.label).toBe('not-checked');
      expect(out.score).toBeNull();
    }
  });

  it('never returns reject, and a score with no label is not-checked, not 0', async () => {
    const rejected = await jevClassify('claim', { modelUrl: LOCAL, fetchImpl: reply(200, '{"label":"reject","score":0.97}') });
    expect(rejected).toMatchObject({ label: 'not-checked', score: null });
    const scoreOnly = await jevClassify('claim', { modelUrl: LOCAL, fetchImpl: reply(200, '{"score":0}') });
    expect(scoreOnly).toMatchObject({ label: 'not-checked', score: null });
    expect(readJevAnswer({ label: 'pass', score: 7 })).toEqual({ label: 'pass', score: null });
    expect(readJevAnswer({ label: 'veto', score: 0.8 })).toEqual({ label: 'veto', score: 0.8 });
  });

  it('a timeout is not-checked', async () => {
    const hang = jest.fn((_url: string, init: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );
    const out = await jevClassify('claim', { modelUrl: LOCAL, fetchImpl: hang, timeoutMs: 20 });
    expect(out).toMatchObject({ label: 'not-checked', score: null, line: SLOW_LINE });
  });
});

describe('(2) a reply ending in "veto" is not a veto unless the classifier says so', () => {
  it('takes the label only from the model answer', async () => {
    const text = 'I reviewed this carefully and my verdict is veto';
    const pass = await jevClassify(text, { modelUrl: LOCAL, fetchImpl: reply(200, '{"label":"pass","score":0.7}') });
    expect(pass).toMatchObject({ label: 'pass', score: 0.7 });
    const unsure = await jevClassify(text, { modelUrl: LOCAL, fetchImpl: reply(200, '{"label":"not-checked"}') });
    expect(unsure.label).toBe('not-checked');
    const prose = await jevClassify(text, { modelUrl: LOCAL, fetchImpl: reply(200, 'veto') });
    expect(prose.label).toBe('not-checked');
    const veto = await jevClassify('fine', { modelUrl: LOCAL, fetchImpl: reply(200, '{"label":"veto","score":0.9}') });
    expect(veto).toMatchObject({ label: 'veto', score: 0.9 });
  });
});

describe('(3) over 3 s is not-checked plus "Still checking"', () => {
  it('a pass that arrives after SLOW_MS is not-checked with the slow line', async () => {
    let t = 0;
    const out = await jevClassify('claim', {
      modelUrl: LOCAL,
      now: () => t,
      fetchImpl: jest.fn(async () => {
        t += SLOW_MS + 1;
        return { status: 200, text: async () => '{"label":"pass","score":0.99}' };
      }),
    });
    expect(out).toEqual({ label: 'not-checked', score: null, latency_ms: SLOW_MS + 1, line: 'Still checking' });
  });

  it('an answer at exactly SLOW_MS still counts', async () => {
    let t = 0;
    const out = await jevClassify('claim', {
      modelUrl: LOCAL,
      now: () => t,
      fetchImpl: jest.fn(async () => {
        t += SLOW_MS;
        return { status: 200, text: async () => '{"label":"veto","score":0.6}' };
      }),
    });
    expect(out).toEqual({ label: 'veto', score: 0.6, latency_ms: SLOW_MS });
  });
});

describe('(4) no paid model, no Anthropic, and (5) nothing stored', () => {
  it('refuses every non-loopback URL without calling it', async () => {
    const fetchImpl = reply(200, '{"label":"pass","score":1}');
    for (const url of [
      'https://api.anthropic.com/v1/messages',
      'https://openrouter.ai/api/v1/systemone',
      'https://api.openai.com/v1/chat/completions',
      'http://localhost.evil.com/x',
      'http://127.0.0.1.nip.io/x',
      'http://user:pw@127.0.0.1/x',
      'file:///etc/passwd',
    ]) {
      expect(localModelUrl(url)).toBeNull();
      expect((await jevClassify('claim', { modelUrl: url, fetchImpl })).label).toBe('not-checked');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(localModelUrl('http://localhost:11434/jev')).not.toBeNull();
  });

  it('pins the bypass inputs raised in cross-review: each is refused', () => {
    for (const url of [
      'http://127.0.0.1.nip.io/x',
      'http://user:pw@127.0.0.1/x',
      'http://127.0.0.1@evil.com/x',
      'http://evil.com@127.0.0.1/x',
      'http://[::ffff:127.0.0.1]/x',
      'http://0.0.0.0/x',
      'http://localhost./x',
    ]) {
      expect(localModelUrl(url)).toBeNull();
    }
    // Decimal and octal IPv4 are normalised by the URL parser to the real loopback address.
    expect(localModelUrl('http://2130706433/x')).toBe('http://127.0.0.1/x');
    expect(localModelUrl('http://0177.0.0.1/x')).toBe('http://127.0.0.1/x');
  });

  it('sends only { state, labels } — no key, no user id, no auth header', async () => {
    const fetchImpl = reply(200, '{"label":"pass","score":0.5}');
    await jevClassify('  the claim  ', { modelUrl: LOCAL, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({ state: 'the claim', labels: ['pass', 'veto', 'not-checked'] });
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).toEqual(['content-type']);
  });

  it('the module imports no database, no vendor client and no stake flag', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'jev', 'classify.ts'), 'utf8');
    expect(src).not.toMatch(/from '\.\.\/db'|supabase|\.insert\(|\.upsert\(/i);
    expect(src).not.toMatch(/providerFetch|PROVIDER_URLS|@anthropic-ai|process\.env\[?'?[A-Z_]*API_KEY/);
    expect(src).not.toContain('REAL_STAKING');
  });
});
