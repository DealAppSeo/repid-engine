/**
 * API key issuance V0 — unit tests.
 * - validateApiKeyRequestBody: pure, no IO.
 * - authMiddleware DB fallback: env-var miss → DB-issued key accepted; invalid → 403. (db + api-keys mocked.)
 * The live intake/provisioning paths need the api_key_requests table (migration 20260524120000) and are
 * exercised end-to-end after Sean applies it.
 */
jest.mock('../../src/db', () => ({ db: { from: () => ({ insert: async () => ({ error: null }) }) } }));
jest.mock('../../src/auth/api-keys', () => ({ validateAgentApiKey: jest.fn() }));

import { validateApiKeyRequestBody, RATE_LIMIT_WINDOW_MS } from '../../src/routes/v1/api-key-requests';
import { authMiddleware } from '../../src/middleware/auth';
import { validateAgentApiKey } from '../../src/auth/api-keys';

const mockValidate = validateAgentApiKey as jest.Mock;

describe('validateApiKeyRequestBody', () => {
  test('accepts a valid request + normalizes email', () => {
    const r = validateApiKeyRequestBody({ email: '  Dev@Example.COM ', use_case: 'Building an agent that verifies trades', organization: 'Acme' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.email).toBe('dev@example.com');
      expect(r.organization).toBe('Acme');
    }
  });
  test('rejects bad email', () => {
    expect(validateApiKeyRequestBody({ email: 'nope', use_case: 'a'.repeat(20) }).ok).toBe(false);
  });
  test('rejects short use_case', () => {
    expect(validateApiKeyRequestBody({ email: 'a@b.co', use_case: 'too short' }).ok).toBe(false);
  });
  test('rejects oversized use_case', () => {
    expect(validateApiKeyRequestBody({ email: 'a@b.co', use_case: 'x'.repeat(2001) }).ok).toBe(false);
  });
  test('rate-limit window is one hour', () => {
    expect(RATE_LIMIT_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});

describe('authMiddleware — DB-issued key fallback (backward compatible)', () => {
  const makeRes = () => {
    const res: any = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };
  beforeEach(() => {
    mockValidate.mockReset();
    process.env.REPID_API_KEYS = ''; // force env-var miss → exercise DB fallback
  });

  test('valid DB key → next() + agent_id attached + tier testnet', async () => {
    mockValidate.mockResolvedValueOnce({ agent_id: 'agent-uuid-1', scopes: ['hal:evaluate'] });
    const req: any = { path: '/api/v1/score', method: 'POST', headers: { authorization: 'Bearer ts_live_abc' }, ip: '127.0.0.1' };
    const res = makeRes();
    const next = jest.fn();
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.agent_id).toBe('agent-uuid-1');
    expect(req.apiKey.tier).toBe('testnet');
  });

  test('invalid key (env miss + DB null) → 403', async () => {
    mockValidate.mockResolvedValueOnce(null);
    const req: any = { path: '/api/v1/score', method: 'POST', headers: { authorization: 'Bearer ts_live_bad' }, ip: '127.0.0.1' };
    const res = makeRes();
    const next = jest.fn();
    await authMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('missing key → 401 (DB never consulted)', async () => {
    const req: any = { path: '/api/v1/score', method: 'POST', headers: {}, ip: '127.0.0.1' };
    const res = makeRes();
    const next = jest.fn();
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockValidate).not.toHaveBeenCalled();
  });
});
