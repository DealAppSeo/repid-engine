/**
 * Escrow burn-trap guard + services falsy-zero fix (2026-07-30).
 *
 * Found by the live A2A x402 E2E:
 *  1. Wallet provisioning at registration silently fails in prod (all fresh
 *     agents have wallet_address NULL), and the escrow route fell back to
 *     payTo = the ZERO ADDRESS — issuing a payable x402 v2 challenge that
 *     would BURN the buyer's USDC. The route must refuse to issue a payment
 *     request without a real recipient (409 provider_wallet_missing).
 *  2. `min_repid_to_purchase: min_repid_to_purchase || 500` turned an
 *     explicit 0 (open to everyone) into 500 and 403'd fresh buyers.
 */
import request from 'supertest';
import express from 'express';

process.env.X402_ENFORCEMENT_ENABLED = 'true';

jest.mock('../src/db', () => ({
  get db() {
    return (global as any).__escrowDb;
  },
}));

// eslint-disable-next-line import/first
import contractsRouter from '../src/routes/v1/contracts';
// eslint-disable-next-line import/first
import servicesRouter from '../src/routes/v1/services';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/contracts', contractsRouter);
  app.use('/api/v1/services', servicesRouter);
  return app;
}

/** Chainable thenable mock routed by table name; per-table result queues. */
function makeDb(script: Record<string, any[]>) {
  const queues: Record<string, any[]> = Object.fromEntries(
    Object.entries(script).map(([k, v]) => [k, [...v]])
  );
  return {
    from: (table: string) => {
      const q = queues[table];
      if (!q || q.length === 0) throw new Error(`unexpected query on ${table}`);
      const result = q.shift();
      const chain: any = {};
      for (const m of ['select', 'eq', 'insert', 'update', 'gte', 'lte', 'order', 'limit', 'or', 'not']) {
        chain[m] = () => chain;
      }
      chain.maybeSingle = () => Promise.resolve(result);
      chain.single = () => Promise.resolve(result);
      chain.then = (onF: any, onR: any) => Promise.resolve(result).then(onF, onR);
      return chain;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as any;
}

const CONTRACT = {
  id: 'cccccccc-1111-2222-3333-444444444444',
  status: 'pending',
  buyer_agent_id: 'buyer-1',
  provider_agent_id: 'provider-1',
  agreed_price_usdc_raw: 10000,
};

describe('POST /api/v1/contracts/:id/escrow — provider wallet guard', () => {
  test('NULL provider wallet → 409 provider_wallet_missing, never a zero-address challenge', async () => {
    (global as any).__escrowDb = makeDb({
      service_contracts: [{ data: CONTRACT, error: null }],
      x402_settlements: [
        { data: null, error: null },          // idempotency check
        { data: [], error: null },            // daily volume (thenable list)
        { count: 0, error: null },            // per-agent daily tx count
      ],
      repid_agents: [{ data: { wallet_address: null }, error: null }],
    });
    const res = await request(makeApp())
      .post(`/api/v1/contracts/${CONTRACT.id}/escrow`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('provider_wallet_missing');
    expect(JSON.stringify(res.body)).not.toContain('0x0000000000000000000000000000000000000000');
  });

  test('zero-address provider wallet is also refused', async () => {
    (global as any).__escrowDb = makeDb({
      service_contracts: [{ data: CONTRACT, error: null }],
      x402_settlements: [
        { data: null, error: null },
        { data: [], error: null },
        { count: 0, error: null },
      ],
      repid_agents: [
        { data: { wallet_address: '0x0000000000000000000000000000000000000000' }, error: null },
      ],
    });
    const res = await request(makeApp())
      .post(`/api/v1/contracts/${CONTRACT.id}/escrow`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('provider_wallet_missing');
  });

  test('valid provider wallet → the x402 402 challenge carries it as payTo', async () => {
    const WALLET = '0xdf6b8215D193b11B4903d223729c3CF7A6de271d';
    (global as any).__escrowDb = makeDb({
      service_contracts: [{ data: CONTRACT, error: null }],
      x402_settlements: [
        { data: null, error: null },
        { data: [], error: null },
        { count: 0, error: null },
      ],
      repid_agents: [{ data: { wallet_address: WALLET }, error: null }],
    });
    const res = await request(makeApp())
      .post(`/api/v1/contracts/${CONTRACT.id}/escrow`)
      .send({});
    expect(res.status).toBe(402); // no X-PAYMENT header → challenge
    const flat = JSON.stringify(res.body).toLowerCase();
    expect(flat).toContain(WALLET.toLowerCase());
    expect(flat).not.toContain('0x0000000000000000000000000000000000000000');
  });
});

describe('POST /api/v1/services — falsy-zero min_repid_to_purchase', () => {
  test('an explicit 0 floor is stored as 0, not 500', async () => {
    let captured: any = null;
    (global as any).__escrowDb = {
      from: () => ({
        insert: (row: any) => {
          captured = row;
          const chain: any = {
            select: () => chain,
            single: () => Promise.resolve({ data: { id: 'svc-1', ...row }, error: null }),
          };
          return chain;
        },
      }),
    };
    const res = await request(makeApp()).post('/api/v1/services').send({
      provider_agent_id: 'provider-1',
      service_type: 'verification',
      service_name: 'zero-floor svc',
      base_price_usdc_raw: 10000,
      min_repid_to_purchase: 0,
    });
    expect(res.status).toBe(201);
    expect(captured.min_repid_to_purchase).toBe(0);
  });

  test('omitted floor still defaults to 500', async () => {
    let captured: any = null;
    (global as any).__escrowDb = {
      from: () => ({
        insert: (row: any) => {
          captured = row;
          const chain: any = {
            select: () => chain,
            single: () => Promise.resolve({ data: { id: 'svc-2', ...row }, error: null }),
          };
          return chain;
        },
      }),
    };
    const res = await request(makeApp()).post('/api/v1/services').send({
      provider_agent_id: 'provider-1',
      service_type: 'verification',
      service_name: 'default-floor svc',
      base_price_usdc_raw: 10000,
    });
    expect(res.status).toBe(201);
    expect(captured.min_repid_to_purchase).toBe(500);
  });
});
