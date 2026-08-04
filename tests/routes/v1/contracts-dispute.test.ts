import request from 'supertest';
import app from '../../../src/index';

jest.mock('../../../src/db', () => {
  const mockSelect = jest.fn().mockReturnThis();
  const mockEq = jest.fn().mockReturnThis();
  // buyer_agent_id added 2026-08-04 — /dispute and /resolve now check the caller
  // against the contract's parties, and `resolve` reads the row via maybeSingle.
  const mockMaybeSingle = jest.fn().mockResolvedValue({ data: { id: 'test-id', active: true, buyer_agent_id: 'buyer-123', provider_agent_id: 'provider-123', min_repid_to_purchase: 100, current_repid: 200 }, error: null });

  return {
    db: {
      from: jest.fn().mockReturnThis(),
      select: mockSelect,
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      eq: mockEq,
      // `dispute` fetches the contract with .single(), so this row needs the
      // party ids too.
      single: jest.fn().mockResolvedValue({ data: { id: 'contract-id', buyer_agent_id: 'buyer-123', provider_agent_id: 'provider-123' }, error: null }),
      maybeSingle: mockMaybeSingle,
      range: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
      upsert: jest.fn().mockReturnThis(),
    }
  };
});

// Mock authentication.
//
// CHANGED 2026-08-04: previously set `apiKey` only — the shared-env-key shape, with
// no bound agent. Both tests below therefore asserted that an unidentified caller
// could dispute and resolve a contract it had nothing to do with. A bound party
// identity is now supplied; the refusal path is covered in
// tests/contracts-party-routes.test.ts.
jest.mock('../../../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.apiKey = { key: 'test-key', tier: 'premium' };
    req.agent_id = 'buyer-123';
    next();
  }
}));

describe('Contracts Dispute Routes', () => {
  it('disputes a contract', async () => {
    const res = await request(app).post('/api/v1/contracts/test-id/dispute').send({
      reason: 'provider failed to deliver',
      evidence: {}
    });
    if (res.status === 500) console.error('DISPUTE 500 ERROR:', res.text || res.body);
    expect(res.status).toBe(200);
  });

  it('resolves a contract', async () => {
    const res = await request(app).post('/api/v1/contracts/test-id/resolve').send({
      dispute_verdict: 'provider_at_fault'
    });
    expect(res.status).toBe(200);
  });
});
