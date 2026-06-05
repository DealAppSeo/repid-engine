/**
 * Plonky3 prover bridge â€” proof_source flag tests.
 *
 * Mocks global.fetch and toggles PLONKY3_PROVER_URL to verify:
 *   - env var set + 200 OK with proof_bytes â‡’ proof_source: 'plonky3_real'
 *   - env var set + AbortError on first call, success on retry â‡’ 'plonky3_real'
 *   - env var set + AbortError on both attempts â‡’ 'hmac_fallback' (no throw)
 *   - env var set + 500 from prover â‡’ 'hmac_fallback'
 *   - env var set + malformed body â‡’ 'hmac_fallback'
 *   - env var unset â‡’ 'hmac_fallback' (no fetch call)
 */

const ORIG_URL = process.env.PLONKY3_PROVER_URL;
const ORIG_SECRET = process.env.PROOF_SECRET;

afterAll(() => {
  if (ORIG_URL === undefined) delete process.env.PLONKY3_PROVER_URL;
  else process.env.PLONKY3_PROVER_URL = ORIG_URL;
  if (ORIG_SECRET === undefined) delete process.env.PROOF_SECRET;
  else process.env.PROOF_SECRET = ORIG_SECRET;
});

beforeEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
  process.env.PROOF_SECRET = 'test-secret-' + Math.random().toString(36).slice(2);
});

afterEach(() => {
  delete (global as any).fetch;
});

function abortError(): Error {
  const e = new Error('aborted');
  (e as any).name = 'AbortError';
  return e;
}

describe('plonky3-real â€” generateProofReal', () => {
  it('returns proof_source=plonky3_real when env set and prover responds 200', async () => {
    process.env.PLONKY3_PROVER_URL = 'https://prover.example.com';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ proof_bytes: 'real_proof_bytes_abc123' }),
    });
    (global as any).fetch = fetchMock;

    const { generateProofReal } = require('../src/zkp/plonky3-real');
    const r = await generateProofReal('agent-1', 'pubkey-1', 'envelope', '2026-04-27T00:00:00Z');

    expect(r.proof_source).toBe('plonky3_real');
    expect(r.proof).toBe('real_proof_bytes_abc123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toBe('https://prover.example.com/prove/tier_range');
  });

  it('strips trailing slash from PLONKY3_PROVER_URL when building the path', async () => {
    process.env.PLONKY3_PROVER_URL = 'https://prover.example.com/';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ proof_bytes: 'p' }),
    });
    (global as any).fetch = fetchMock;
    const { generateProofReal } = require('../src/zkp/plonky3-real');
    await generateProofReal('a', 'b', 'c', 'd');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://prover.example.com/prove/tier_range');
  });

  it('retries once on AbortError and succeeds on the retry', async () => {
    process.env.PLONKY3_PROVER_URL = 'https://prover.example.com';
    const fetchMock = jest.fn()
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce({ ok: true, json: async () => ({ proof_bytes: 'retry_proof' }) });
    (global as any).fetch = fetchMock;

    const { generateProofReal } = require('../src/zkp/plonky3-real');
    const r = await generateProofReal('a', 'b', 'c', 'd');

    expect(r.proof_source).toBe('plonky3_real');
    expect(r.proof).toBe('retry_proof');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to HMAC when both attempts time out (no throw)', async () => {
    process.env.PLONKY3_PROVER_URL = 'https://prover.example.com';
    const fetchMock = jest.fn().mockRejectedValue(abortError());
    (global as any).fetch = fetchMock;

    const { generateProofReal } = require('../src/zkp/plonky3-real');
    const r = await generateProofReal('a', 'b', 'c', 'd');

    expect(r.proof_source).toBe('hmac_fallback');
    expect(r.proof).toMatch(/^[A-Za-z0-9+/=]+$/);  // base64
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to HMAC on non-2xx prover response (no retry)', async () => {
    process.env.PLONKY3_PROVER_URL = 'https://prover.example.com';
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    (global as any).fetch = fetchMock;

    const { generateProofReal } = require('../src/zkp/plonky3-real');
    const r = await generateProofReal('a', 'b', 'c', 'd');

    expect(r.proof_source).toBe('hmac_fallback');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to HMAC on malformed prover body (missing proof_bytes)', async () => {
    process.env.PLONKY3_PROVER_URL = 'https://prover.example.com';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ wrong_field: 'whatever' }),
    });
    (global as any).fetch = fetchMock;

    const { generateProofReal } = require('../src/zkp/plonky3-real');
    const r = await generateProofReal('a', 'b', 'c', 'd');

    expect(r.proof_source).toBe('hmac_fallback');
  });

  it('returns proof_source=hmac_fallback when PLONKY3_PROVER_URL is unset', async () => {
    delete process.env.PLONKY3_PROVER_URL;
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;

    const { generateProofReal } = require('../src/zkp/plonky3-real');
    const r = await generateProofReal('a', 'b', 'c', 'd');

    expect(r.proof_source).toBe('hmac_fallback');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('HMAC fallback is deterministic for the same inputs', async () => {
    delete process.env.PLONKY3_PROVER_URL;
    const { generateProofReal } = require('../src/zkp/plonky3-real');
    const a = await generateProofReal('agent-1', 'pubkey-1', 'envelope', '2026-04-27T00:00:00Z');
    const b = await generateProofReal('agent-1', 'pubkey-1', 'envelope', '2026-04-27T00:00:00Z');
    expect(a.proof).toBe(b.proof);
  });
});

describe('plonky3-real â€” generateProofRealSync (legacy)', () => {
  it('preserves the legacy sync HMAC API for callers that cannot await', async () => {
    delete process.env.PLONKY3_PROVER_URL;
    const { generateProofRealSync } = require('../src/zkp/plonky3-real');
    const proof = generateProofRealSync('a', 'b', 'c', 'd');
    expect(typeof proof).toBe('string');
    expect(proof).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

