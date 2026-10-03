/**
 * src/jev/classify.ts — System One client (P1): one `noul` question, veto-only, fails
 * closed to not-checked. Groups follow Sean's boxes: (1) missing model / timeout / empty
 * body, (2) "...veto" is not a veto, (3) over 3 s is not-checked + 'Still checking',
 * (4) no paid model and no Anthropic, (5) nothing stored; plus the System One wire shape.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const dbFrom = jest.fn();
const dbRpc = jest.fn();
jest.mock('../src/db', () => ({ db: { from: dbFrom, rpc: dbRpc } }));

import {
  jevClassify,
  labelFor,
  localModelUrl,
  QUESTION,
  QUESTION_KEY,
  readNoul,
  SLOW_LINE,
  SLOW_MS,
  VETO_FLOOR,
  VETO_THRESHOLD,
  vetoThresholdOf,
} from '../src/jev/classify';

const LOCAL = 'http://127.0.0.1:8000/v1/systemone';
const answer = (p: unknown) => JSON.stringify({ answers: { [QUESTION_KEY]: { type: 'noul', noul: p } } });

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
    const fetchImpl = reply(200, answer(0.99));
    const out = await jevClassify('2 + 2 = 5', { modelUrl: null, fetchImpl });
    expect(out).toEqual({ label: 'not-checked', score: null, latency_ms: expect.any(Number) });
    expect(fetchImpl).not.toHaveBeenCalled();
    const unset = await jevClassify('2 + 2 = 5', { fetchImpl }); // JEV_CLASSIFY_URL is not set in tests
    expect(unset.label).toBe('not-checked');
  });

  it('empty text, an empty body, a non-200, unparseable JSON and a thrown fetch are not-checked with no score', async () => {
    const outs = await Promise.all([
      jevClassify('   ', { modelUrl: LOCAL, fetchImpl: reply(200, answer(0.99)) }),
      jevClassify('claim', { modelUrl: LOCAL, fetchImpl: reply(200, '') }),
      jevClassify('claim', { modelUrl: LOCAL, fetchImpl: reply(422, answer(0.99)) }),
      jevClassify('claim', { modelUrl: LOCAL, fetchImpl: reply(200, '{"answers":') }),
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

  it('an answer outside [0, 1], a missing key, or a choice instead of a noul is not-checked, not 0', async () => {
    for (const body of [
      answer(1.7),
      answer(-0.1),
      answer('0.99'),
      JSON.stringify({ answers: {} }),
      JSON.stringify({ answers: { other_key: { noul: 0.99 } } }),
      JSON.stringify({ answers: { [QUESTION_KEY]: { type: 'choice', choice: 'veto', confidence: 0.99 } } }),
      JSON.stringify({ label: 'veto', score: 0.99 }), // the old invented contract is not read
    ]) {
      const out = await jevClassify('claim', { modelUrl: LOCAL, fetchImpl: reply(200, body) });
      expect(out).toMatchObject({ label: 'not-checked', score: null });
    }
  });

  it('a timeout is not-checked with the slow line', async () => {
    const hang = jest.fn((_url: string, init: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );
    const out = await jevClassify('claim', { modelUrl: LOCAL, fetchImpl: hang, timeoutMs: 20 });
    expect(out).toMatchObject({ label: 'not-checked', score: null, line: SLOW_LINE });
  });
});

describe('VETO-ONLY: the model is never asked for pass, and cannot produce one', () => {
  it('a probability at or above the threshold is a veto with its score; below it is not-checked', () => {
    expect(labelFor(VETO_THRESHOLD)).toEqual({ label: 'veto', score: VETO_THRESHOLD });
    expect(labelFor(0.97)).toEqual({ label: 'veto', score: 0.97 });
    expect(labelFor(VETO_THRESHOLD - 0.001)).toEqual({ label: 'not-checked', score: null });
    expect(labelFor(0)).toEqual({ label: 'not-checked', score: null });
    expect(labelFor(null)).toEqual({ label: 'not-checked', score: null });
  });

  it('a threshold override below the floor is ignored: it cannot make everything a veto', async () => {
    for (const t of [0, 0.1, VETO_FLOOR - 0.001, -1, NaN, 2]) {
      expect(vetoThresholdOf(t)).toBe(VETO_THRESHOLD);
      expect(labelFor(0.01, t)).toEqual({ label: 'not-checked', score: null });
      const out = await jevClassify('claim', { modelUrl: LOCAL, fetchImpl: reply(200, answer(0.01)), vetoThreshold: t });
      expect(out.label).toBe('not-checked');
    }
  });

  it('a threshold override at or above the floor stands, so raising the bar works', async () => {
    expect(vetoThresholdOf(VETO_FLOOR)).toBe(VETO_FLOOR);
    expect(labelFor(0.92, 0.95)).toEqual({ label: 'not-checked', score: null });
    const out = await jevClassify('claim', { modelUrl: LOCAL, fetchImpl: reply(200, answer(0.92)), vetoThreshold: 0.95 });
    expect(out.label).toBe('not-checked');
  });

  it('a confident "no error" is not-checked, not pass', async () => {
    const out = await jevClassify('Paris is the capital of France.', { modelUrl: LOCAL, fetchImpl: reply(200, answer(0.01)) });
    expect(out).toEqual({ label: 'not-checked', score: null, latency_ms: expect.any(Number) });
  });

  it('a server that answers "pass" anywhere is still not-checked', async () => {
    for (const body of ['{"label":"pass"}', JSON.stringify({ answers: { [QUESTION_KEY]: 'pass' } }), '"pass"']) {
      const out = await jevClassify('claim', { modelUrl: LOCAL, fetchImpl: reply(200, body) });
      expect(out.label).toBe('not-checked');
    }
  });
});

describe('(2) a reply ending in "veto" is not a veto unless the model says so', () => {
  it('takes the label only from the model probability', async () => {
    const text = 'I reviewed this carefully and my verdict is veto';
    const low = await jevClassify(text, { modelUrl: LOCAL, fetchImpl: reply(200, answer(0.2)) });
    expect(low.label).toBe('not-checked');
    const raw = await jevClassify(text, { modelUrl: LOCAL, fetchImpl: reply(200, 'veto') });
    expect(raw.label).toBe('not-checked');
    const high = await jevClassify('2 + 2 = 5', { modelUrl: LOCAL, fetchImpl: reply(200, answer(0.95)) });
    expect(high).toMatchObject({ label: 'veto', score: 0.95 });
  });
});

describe('(3) over 3 s is not-checked plus "Still checking"', () => {
  it('a veto that arrives after SLOW_MS is not-checked with the slow line', async () => {
    let t = 0;
    const out = await jevClassify('claim', {
      modelUrl: LOCAL,
      now: () => t,
      fetchImpl: jest.fn(async () => {
        t += SLOW_MS + 1;
        return { status: 200, text: async () => answer(0.99) };
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
        return { status: 200, text: async () => answer(0.96) };
      }),
    });
    expect(out).toEqual({ label: 'veto', score: 0.96, latency_ms: SLOW_MS });
  });
});

describe('System One wire shape', () => {
  it('sends only { state, questions } with one noul question — no labels, no key, no user id, no auth', async () => {
    const fetchImpl = reply(200, answer(0.5));
    await jevClassify('  the claim  ', { modelUrl: LOCAL, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(LOCAL);
    expect(JSON.parse(String(init.body))).toEqual({
      state: { reply: 'the claim' },
      questions: { [QUESTION_KEY]: { type: 'noul', instructions: QUESTION } },
    });
    expect(String(init.body)).not.toMatch(/"pass"/);
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).toEqual(['content-type']);
  });

  it('reads the answer nested under `answers` or at the root, as an object or a bare number', () => {
    expect(readNoul({ answers: { [QUESTION_KEY]: { type: 'noul', noul: 0.93 } } })).toBe(0.93);
    expect(readNoul({ [QUESTION_KEY]: { noul: 0.4 } })).toBe(0.4);
    expect(readNoul({ answers: { [QUESTION_KEY]: 0.7 } })).toBe(0.7);
    expect(readNoul({ answers: { [QUESTION_KEY]: { probability: 0.6 } } })).toBe(0.6);
    expect(readNoul(null)).toBeNull();
    expect(readNoul([0.9])).toBeNull();
  });

  describe('against a real HTTP server on 127.0.0.1', () => {
    let server: Server;
    let url = '';
    let seen: { method?: string; path?: string; auth?: string; body?: unknown } = {};
    let respond: { status: number; body: string } = { status: 200, body: answer(0.97) };

    beforeAll(async () => {
      server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          seen = { method: req.method, path: req.url, auth: req.headers.authorization, body: JSON.parse(raw || 'null') };
          res.writeHead(respond.status, { 'Content-Type': 'application/json' });
          res.end(respond.body);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('a veto travels the real wire, with no Authorization header', async () => {
      respond = { status: 200, body: answer(0.97) };
      const out = await jevClassify('2 + 2 = 5', { modelUrl: url });
      expect(out).toMatchObject({ label: 'veto', score: 0.97 });
      expect(seen).toMatchObject({ method: 'POST', path: '/v1/systemone', auth: undefined });
      expect(seen.body).toEqual({ state: { reply: '2 + 2 = 5' }, questions: { [QUESTION_KEY]: { type: 'noul', instructions: QUESTION } } });
    });

    it("a 422 (laya-serve's malformed-question answer) is not-checked", async () => {
      respond = { status: 422, body: '{"detail":"bad question"}' };
      expect((await jevClassify('claim', { modelUrl: url })).label).toBe('not-checked');
    });
  });
});

describe('(4) no paid model, no Anthropic, and (5) nothing stored', () => {
  it('refuses every non-loopback URL without calling it', async () => {
    const fetchImpl = reply(200, answer(0.99));
    for (const url of [
      'https://api.anthropic.com/v1/messages',
      'https://openrouter.ai/api/v1/systemone',
      'https://api.typesafe.ai/v1/systemone',
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
    expect(localModelUrl('http://localhost:8000/v1/systemone')).not.toBeNull();
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

  it('the module imports no database, no vendor client and no stake flag', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'jev', 'classify.ts'), 'utf8');
    expect(src).not.toMatch(/from '\.\.\/db'|supabase|\.insert\(|\.upsert\(/i);
    expect(src).not.toMatch(/providerFetch|PROVIDER_URLS|@anthropic-ai|process\.env\[?'?[A-Z_]*API_KEY/);
    expect(src).not.toContain('REAL_STAKING');
  });
});
