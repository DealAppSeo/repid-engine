/**
 * Tests for the Plonky3 prover bridge's /health pre-flight cache.
 *
 * Mocks global.fetch — never touches the network. Each test resets
 * the in-process cache via _resetProverHealthCacheForTest() so the
 * 60s TTL doesn't leak across cases.
 */

const ORIG_PROVER_URL = process.env.PLONKY3_PROVER_URL;

beforeAll(() => {
  // The module reads PLONKY3_PROVER_URL once at import time; set it
  // BEFORE the require so checkProverHealth() actually attempts the fetch.
  process.env.PLONKY3_PROVER_URL = 'https://prover.test.local';
});

afterAll(() => {
  if (ORIG_PROVER_URL === undefined) delete process.env.PLONKY3_PROVER_URL;
  else process.env.PLONKY3_PROVER_URL = ORIG_PROVER_URL;
});

import { checkProverHealth, _resetProverHealthCacheForTest } from '../src/zkp/plonky3-real';

const realFetch = global.fetch;

function mockFetch(impl: (url: string, init?: any) => Promise<Response> | Response) {
  (global as any).fetch = jest.fn((url: any, init?: any) => Promise.resolve(impl(String(url), init)));
}

beforeEach(() => {
  _resetProverHealthCacheForTest();
});

afterEach(() => {
  (global as any).fetch = realFetch;
  jest.useRealTimers();
});

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('checkProverHealth', () => {
  it('returns true when /health responds 200 with { status: "ok" }', async () => {
    mockFetch(() => jsonResponse(200, {
      status: 'ok',
      uptime_seconds: 12,
      proofs_generated_total: 3,
      proofs_failed_total: 0,
      version: '0.1.0',
    }));
    const r = await checkProverHealth();
    expect(r).toBe(true);
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
    const [calledUrl] = (global.fetch as jest.Mock).mock.calls[0];
    expect(calledUrl).toBe('https://prover.test.local/health');
  });

  it('returns false when /health responds 500', async () => {
    mockFetch(() => new Response('internal error', { status: 500 }));
    const r = await checkProverHealth();
    expect(r).toBe(false);
  });

  it('returns false when /health 200 but body has no status:ok', async () => {
    mockFetch(() => jsonResponse(200, { state: 'maybe' }));
    expect(await checkProverHealth()).toBe(false);
  });

  it('returns false on transport timeout (AbortError)', async () => {
    mockFetch(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    expect(await checkProverHealth()).toBe(false);
  });

  it('returns false on plain network error', async () => {
    mockFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(await checkProverHealth()).toBe(false);
  });

  it('caches the result for 60 seconds — second call inside window does NOT re-fetch', async () => {
    mockFetch(() => jsonResponse(200, { status: 'ok' }));
    expect(await checkProverHealth()).toBe(true);
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);

    // Second call within TTL — should NOT call fetch again.
    expect(await checkProverHealth()).toBe(true);
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });

  it('cache expires after 60s — third call re-fetches', async () => {
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockFetch(() => jsonResponse(200, { status: 'ok' }));

    await checkProverHealth();
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
    now += 30_000;
    await checkProverHealth();
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1); // still cached
    now += 31_000; // total 61s elapsed since first check
    await checkProverHealth();
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(2); // re-fetched
  });

  it('caches "down" responses too — does NOT hammer when prover is sick', async () => {
    mockFetch(() => new Response('', { status: 503 }));
    expect(await checkProverHealth()).toBe(false);
    expect(await checkProverHealth()).toBe(false);
    expect(await checkProverHealth()).toBe(false);
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });
});
