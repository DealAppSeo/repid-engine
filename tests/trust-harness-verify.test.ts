/**
 * Proves the two audit-item-#6 fixes for scripts/demo/trust-harness-e2e.mjs:
 *
 *   (1) Step 3 "VERIFY LOCALLY" now does a REAL local verification via
 *       @hyperdag/proof-verifier's verify(proofBytes, statement) and fail-closes.
 *       Before, it only checked a byte count and set proofVerified from
 *       state === 'REAL' — so a proof that never verified still passed the gate.
 *
 *   (2) The HAL call is authenticated with REPID_API_KEY (Bearer) when present so
 *       an authenticated run bypasses the public per-IP cap; keyless otherwise.
 *
 * Plus the server-side half of (2): the public /hal/evaluate IP cap now skips
 * requests bearing a valid REPID_API_KEYS key, so the Bearer key genuinely
 * bypasses instead of being ignored.
 */
import {
  verifyProofLocally,
  halRequestHeaders,
  type VerifyFn,
} from '../src/services/trust-harness-verify';
import { hasValidEnvApiKey, presentedApiKey } from '../src/middleware/env-api-key';

const STATEMENT = { agent_id: 'uuid-1', repid_score: 1200, threshold: 999, tier: 'ESTABLISHED' };
const BYTES = 'AAECAwQFBgc='; // any non-empty base64

describe('verifyProofLocally — fail-closed local proof verification', () => {
  it('passes ONLY when the real verifier returns verified===true', async () => {
    const verifyFn: VerifyFn = async () => ({
      verified: true,
      error: null,
      proof_size_bytes: 8,
      verifier_version: '0.2.0',
    });
    const r = await verifyProofLocally({ proofBytes: BYTES, statement: STATEMENT, verifyFn });
    expect(r.verified).toBe(true);
    expect(r.verifierVersion).toBe('0.2.0');
    expect(r.proofSizeBytes).toBe(8);
  });

  it('REJECTS when the verifier returns verified===false (a bad proof)', async () => {
    const verifyFn: VerifyFn = async () => ({
      verified: false,
      error: 'range check failed',
    });
    const r = await verifyProofLocally({ proofBytes: BYTES, statement: STATEMENT, verifyFn });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/REJECTED/i);
    expect(r.reason).toMatch(/range check failed/);
  });

  it('fail-closes when the verifier is UNAVAILABLE (null) — never a pass', async () => {
    const r = await verifyProofLocally({ proofBytes: BYTES, statement: STATEMENT, verifyFn: null });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/unavailable/i);
  });

  it('fail-closes on empty proof bytes (legacy sha256 stub) — a byte count is not a proof', async () => {
    const verifyFn: VerifyFn = async () => ({ verified: true });
    const r = await verifyProofLocally({ proofBytes: '', statement: STATEMENT, verifyFn });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/no proof bytes/i);
  });

  it('fail-closes when verified is a truthy NON-boolean (the fake-pass shape)', async () => {
    // `!!result` on this object is true; a naive check would let it through.
    const verifyFn: VerifyFn = async () => ({ verified: 'yes' as unknown as boolean });
    const r = await verifyProofLocally({ proofBytes: BYTES, statement: STATEMENT, verifyFn });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/unexpected shape/i);
  });

  it('fail-closes when the verifier THROWS', async () => {
    const verifyFn: VerifyFn = async () => {
      throw new Error('wasm init failed');
    };
    const r = await verifyProofLocally({ proofBytes: BYTES, statement: STATEMENT, verifyFn });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/threw/i);
    expect(r.reason).toMatch(/wasm init failed/);
  });

  it('fail-closes with no statement to verify against', async () => {
    const verifyFn: VerifyFn = async () => ({ verified: true });
    const r = await verifyProofLocally({ proofBytes: BYTES, statement: null, verifyFn });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/no statement/i);
  });
});

describe('halRequestHeaders — authenticated HAL call bypasses the public cap', () => {
  it('adds a Bearer Authorization header when REPID_API_KEY is set', () => {
    const r = halRequestHeaders({ REPID_API_KEY: 'secret123' } as NodeJS.ProcessEnv);
    expect(r.authenticated).toBe(true);
    expect(r.headers['Authorization']).toBe('Bearer secret123');
    expect(r.headers['content-type']).toBe('application/json');
  });

  it('stays keyless (honest UNKNOWN path) when REPID_API_KEY is absent or blank', () => {
    for (const env of [{}, { REPID_API_KEY: '' }, { REPID_API_KEY: '   ' }]) {
      const r = halRequestHeaders(env as NodeJS.ProcessEnv);
      expect(r.authenticated).toBe(false);
      expect(r.headers['Authorization']).toBeUndefined();
    }
  });
});

describe('env-api-key — server-side bypass predicate', () => {
  const env = { REPID_API_KEYS: 'k1:pro, k2:enterprise, plain' } as NodeJS.ProcessEnv;

  it('extracts the key from Bearer and x-api-key headers', () => {
    expect(presentedApiKey({ authorization: 'Bearer k1' })).toBe('k1');
    expect(presentedApiKey({ 'x-api-key': 'k2' })).toBe('k2');
    expect(presentedApiKey({})).toBeNull();
  });

  it('recognises a valid env-allowlist key (Bearer or x-api-key), tier-stripped', () => {
    expect(hasValidEnvApiKey({ authorization: 'Bearer k1' }, env)).toBe(true);
    expect(hasValidEnvApiKey({ 'x-api-key': 'k2' }, env)).toBe(true);
    expect(hasValidEnvApiKey({ authorization: 'Bearer plain' }, env)).toBe(true);
  });

  it('rejects an unknown key and a missing key', () => {
    expect(hasValidEnvApiKey({ authorization: 'Bearer nope' }, env)).toBe(false);
    expect(hasValidEnvApiKey({}, env)).toBe(false);
    expect(hasValidEnvApiKey({ authorization: 'Bearer k1' }, {} as NodeJS.ProcessEnv)).toBe(false);
  });
});
