/**
 * [F1] Nobody buys or sells without someone who answers for them.
 *
 * Escrow is where money commits, so both parties of a contract need an accountable root
 * (src/services/accountable-root.ts) — a bound owner or the operator's custodian. The payment
 * gate's own route asks the same question first. These tests drive the real app and set the
 * answer to "who answers?" directly; tests/accountable-root.test.ts covers how it is worked out.
 *
 * Each refusal must change nothing: no contract row is written.
 */
import request from 'supertest';
import app from '../src/index';
import { db } from '../src/db';

jest.mock('../src/db', () => ({
  db: {
    from: jest.fn(),
    rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

jest.mock('../src/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.apiKey = { key: 'bound-key', tier: 'pro' };
    req.agent_id = (global as any).__callerAgentId;
    next();
  },
}));

// Who answers, per agent id: 'owner' | 'none' | 'not_checked'. Carried on `global` because a
// jest.mock factory is hoisted above the file body.
jest.mock('../src/services/accountable-root', () => ({
  ...jest.requireActual('../src/services/accountable-root'),
  resolveAccountableRoot: jest.fn(async (ref: string) => {
    const state = ((global as any).__roots ?? {})[ref] ?? 'none';
    if (state === 'owner') {
      return {
        ok: true,
        root: { kind: 'owner', agentId: ref, subjectId: ref, wallet: '0x00000000000000000000000000000000000000a1', assurance: 'wallet-proven', via: 'own-binding', grantPath: [] },
      };
    }
    if (state === 'not_checked') return { ok: false, code: 'not_checked', message: 'db down' };
    return { ok: false, code: 'no_root', message: `nobody has claimed ${ref}` };
  }),
}));

const BUYER = 'buyer-aaaa-1111';
const PROVIDER = 'provider-bbbb-2222';
const CONTRACT_ID = '11111111-2222-3333-4444-555555555555';
const CONTRACT = { id: CONTRACT_ID, status: 'pending', buyer_agent_id: BUYER, provider_agent_id: PROVIDER, agreed_price_usdc_raw: 10000 };

let contractWrites: unknown[] = [];

function mockDb() {
  (db.from as jest.Mock).mockImplementation((table: string) => {
    const chain: any = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      in: jest.fn(() => chain),
      gte: jest.fn(() => chain),
      not: jest.fn(() => chain),
      order: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      upsert: jest.fn(async () => ({ data: null, error: null })),
      update: jest.fn((patch: unknown) => {
        if (table === 'service_contracts') contractWrites.push(patch);
        return chain;
      }),
      insert: jest.fn(() => chain),
      single: jest.fn(async () => ({ data: table === 'service_contracts' ? { ...CONTRACT, status: 'escrowed' } : null, error: null })),
      maybeSingle: jest.fn(async () => ({ data: table === 'service_contracts' ? CONTRACT : null, error: null })),
      then: (r: any) => r({ data: [], error: null }),
    };
    return chain;
  });
}

function roots(map: Record<string, 'owner' | 'none' | 'not_checked'>) {
  (global as any).__roots = map;
}

beforeEach(() => {
  jest.clearAllMocks();
  contractWrites = [];
  (global as any).__callerAgentId = BUYER;
  mockDb();
  delete process.env.X402_ENFORCEMENT_ENABLED;
  process.env.X402_GATE_SHADOW = 'false';
});

afterAll(() => {
  delete (global as any).__callerAgentId;
  delete (global as any).__roots;
  delete process.env.X402_GATE_SHADOW;
});

describe('POST /api/v1/contracts/:id/escrow', () => {
  it('a buyer nobody answers for cannot buy: 403, nothing escrowed', async () => {
    roots({ [PROVIDER]: 'owner' });
    const res = await request(app).post(`/api/v1/contracts/${CONTRACT_ID}/escrow`).send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'no_accountable_root', party: 'buyer', code: 'no_root' });
    expect(contractWrites).toHaveLength(0);
  });

  it('a provider nobody answers for cannot sell: 403, nothing escrowed', async () => {
    roots({ [BUYER]: 'owner' });
    const res = await request(app).post(`/api/v1/contracts/${CONTRACT_ID}/escrow`).send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'no_accountable_root', party: 'provider' });
    expect(contractWrites).toHaveLength(0);
  });

  it('who answers could not be read: 503 NOT CHECKED, nothing escrowed', async () => {
    roots({ [BUYER]: 'not_checked', [PROVIDER]: 'owner' });
    const res = await request(app).post(`/api/v1/contracts/${CONTRACT_ID}/escrow`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('root_not_checked');
    expect(contractWrites).toHaveLength(0);
  });

  it('both parties answered for: escrow proceeds', async () => {
    roots({ [BUYER]: 'owner', [PROVIDER]: 'owner' });
    const res = await request(app).post(`/api/v1/contracts/${CONTRACT_ID}/escrow`).send({});
    expect(res.status).toBe(200);
    expect(contractWrites).toContainEqual(expect.objectContaining({ status: 'escrowed' }));
  });
});

describe('POST /api/v1/x402-gate/authorize', () => {
  it('an agent nobody answers for is not authorized to pay, and the reason says why', async () => {
    roots({});
    const res = await request(app).post('/api/v1/x402-gate/authorize').send({ agent: 'stranger-agent', amount: 1 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ authorized: false, denial_reason: 'no_accountable_root', root_code: 'no_root' });
  });

  it('who answers could not be read: 503, not authorized', async () => {
    roots({ 'some-agent': 'not_checked' });
    const res = await request(app).post('/api/v1/x402-gate/authorize').send({ agent: 'some-agent', amount: 1 });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ authorized: false, denial_reason: 'root_not_checked' });
  });
});
