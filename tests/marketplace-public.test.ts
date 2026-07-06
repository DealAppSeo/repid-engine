/**
 * Buy-loop last mile (2026-07-06) — GET /api/v1/marketplace/recent-transactions.
 *
 * Verifies the public read endpoint's response SHAPE and honesty rules:
 *   - each row exposes an explicit is_simulated flag,
 *   - tx_hash is null for simulated rows (never leaks a stray hash as "real"),
 *   - real rows carry their on-chain tx_hash,
 *   - limit is clamped to [1, 100],
 *   - a query error surfaces as 500 (fail-loud, not silent empty).
 *
 * db is mocked via a call-time global handle (no jest hoist/TDZ). No auth
 * middleware is mounted, matching the pre-auth public mount in src/index.ts.
 */
jest.mock('../src/db', () => ({
  get db() {
    return (global as any).__mpPublicDb;
  },
}));

import request from 'supertest';
import express from 'express';
import marketplacePublicRouter from '../src/routes/v1/marketplace-public';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/marketplace', marketplacePublicRouter);
  return app;
}

/**
 * Query-builder stub that records the applied limit and returns a fixed
 * result set. Terminal await resolves via the thenable `limit()`.
 */
function makeDb(result: { data: any[] | null; error: any }) {
  let capturedLimit: number | undefined;
  const builder: any = {
    select: () => builder,
    in: () => builder,
    not: () => builder,
    order: () => builder,
    limit: (n: number) => {
      capturedLimit = n;
      return Promise.resolve(result);
    },
  };
  return {
    _getLimit: () => capturedLimit,
    from: () => builder,
  };
}

const REAL_ROW = {
  id: 'contract-real',
  status: 'settled',
  agreed_price_usdc_raw: 500000,
  settled_at: '2026-07-06T10:00:00Z',
  fulfilled_at: '2026-07-06T09:59:00Z',
  created_at: '2026-07-06T09:00:00Z',
  provider_agent_id: 'prov-1',
  buyer_agent_id: 'buyer-1',
  metadata: {},
  x402_settlements: {
    id: 'settle-1',
    amount: 500000,
    asset: 'USDC',
    is_simulated: false,
    tx_hash: '0xrealhash',
    status: 'settled',
    created_at: '2026-07-06T10:00:00Z',
  },
  agent_services: { service_type: 'verification', service_name: 'Verify-a-claim' },
  provider: { agent_name: 'shofet' },
  buyer: { agent_name: 'nexus' },
};

const SIM_ROW = {
  id: 'contract-sim',
  status: 'settled',
  agreed_price_usdc_raw: 100000,
  settled_at: '2026-07-06T08:00:00Z',
  fulfilled_at: null,
  created_at: '2026-07-06T07:00:00Z',
  provider_agent_id: 'prov-2',
  buyer_agent_id: 'buyer-2',
  metadata: {},
  x402_settlements: {
    id: 'settle-2',
    amount: 100000,
    asset: 'USDC',
    is_simulated: true,
    tx_hash: '0xstrayhash', // should be redacted to null because simulated
    status: 'settled',
    created_at: '2026-07-06T08:00:00Z',
  },
  agent_services: { service_type: 'anfis_routing', service_name: 'Route-to-best-model' },
  provider: { agent_name: 'orch' },
  buyer: { agent_name: 'mel' },
};

describe('GET /api/v1/marketplace/recent-transactions', () => {
  test('returns rows with honest is_simulated flags and redacts tx_hash for simulated', async () => {
    (global as any).__mpPublicDb = makeDb({ data: [REAL_ROW, SIM_ROW], error: null });
    const res = await request(makeApp()).get('/api/v1/marketplace/recent-transactions');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(Array.isArray(res.body.transactions)).toBe(true);

    const real = res.body.transactions.find((t: any) => t.contract_id === 'contract-real');
    expect(real).toMatchObject({
      service_type: 'verification',
      amount: 500000,
      is_simulated: false,
      tx_hash: '0xrealhash',
      provider_agent_name: 'shofet',
      buyer_agent_name: 'nexus',
    });

    const sim = res.body.transactions.find((t: any) => t.contract_id === 'contract-sim');
    expect(sim.is_simulated).toBe(true);
    // Honesty rule: simulated rows NEVER report a tx_hash as if it were real.
    expect(sim.tx_hash).toBeNull();
    expect(sim.service_type).toBe('anfis_routing');
  });

  test('clamps limit to the [1,100] range', async () => {
    const db = makeDb({ data: [], error: null });
    (global as any).__mpPublicDb = db;
    await request(makeApp()).get('/api/v1/marketplace/recent-transactions?limit=9999');
    expect(db._getLimit()).toBe(100);

    const db2 = makeDb({ data: [], error: null });
    (global as any).__mpPublicDb = db2;
    await request(makeApp()).get('/api/v1/marketplace/recent-transactions?limit=0');
    expect(db2._getLimit()).toBe(1);
  });

  test('defaults limit when unspecified', async () => {
    const db = makeDb({ data: [], error: null });
    (global as any).__mpPublicDb = db;
    const res = await request(makeApp()).get('/api/v1/marketplace/recent-transactions');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(25);
    expect(db._getLimit()).toBe(25);
  });

  test('fails loud with 500 on a query error (not a silent empty list)', async () => {
    (global as any).__mpPublicDb = makeDb({ data: null, error: { message: 'boom' } });
    const res = await request(makeApp()).get('/api/v1/marketplace/recent-transactions');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('query_failed');
  });
});
