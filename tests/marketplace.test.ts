/**
 * RepID marketplace substrate — unit tests (PR-4, V2 substrate, settlement DISABLED).
 * - validateCreateListing: pure, no IO (happy/sad paths).
 * - POST /listings creates + returns id; POST /rentals returns a settlement-disabled note and
 *   moves NO money. db is mocked via a call-time global handle (no jest hoist/TDZ).
 *
 * Live write paths need the agent_listings / rental_records tables (migration 20260526130000)
 * and are exercised end-to-end after the orchestrator applies it.
 */

jest.mock('../src/db', () => ({
  get db() {
    return (global as any).__mktDb;
  },
}));

import request from 'supertest';
import express from 'express';
import marketplaceRouter, {
  validateCreateListing,
  MARKETPLACE_SETTLEMENT_ENABLED,
} from '../src/routes/v1/marketplace';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/marketplace', marketplaceRouter);
  return app;
}

describe('settlement flag', () => {
  test('MARKETPLACE_SETTLEMENT_ENABLED is hard-off for V2', () => {
    expect(MARKETPLACE_SETTLEMENT_ENABLED).toBe(false);
  });
});

describe('validateCreateListing', () => {
  test('accepts a valid rent listing', () => {
    const r = validateCreateListing({
      agent_id: VALID_UUID,
      owner_sbt_id: 'sbt-1',
      listing_type: 'rent',
      price_usdc: 9.5,
      rep_id_at_listing: 1200,
      rental_duration_hours: 24,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.listing_type).toBe('rent');
      expect(r.price_usdc).toBe(9.5);
      expect(r.rental_duration_hours).toBe(24);
    }
  });

  test('accepts a sell listing with null duration', () => {
    const r = validateCreateListing({
      agent_id: VALID_UUID,
      owner_sbt_id: 'sbt-1',
      listing_type: 'sell',
      price_usdc: 100,
      rep_id_at_listing: 5000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rental_duration_hours).toBeNull();
  });

  test('rejects bad agent_id (not uuid)', () => {
    expect(
      validateCreateListing({ agent_id: 'nope', owner_sbt_id: 'sbt-1', listing_type: 'sell', price_usdc: 1, rep_id_at_listing: 1 }).ok,
    ).toBe(false);
  });

  test('rejects invalid listing_type', () => {
    expect(
      validateCreateListing({ agent_id: VALID_UUID, owner_sbt_id: 'sbt-1', listing_type: 'lease', price_usdc: 1, rep_id_at_listing: 1 }).ok,
    ).toBe(false);
  });

  test('rejects negative price', () => {
    expect(
      validateCreateListing({ agent_id: VALID_UUID, owner_sbt_id: 'sbt-1', listing_type: 'sell', price_usdc: -5, rep_id_at_listing: 1 }).ok,
    ).toBe(false);
  });

  test('rejects missing owner_sbt_id', () => {
    expect(
      validateCreateListing({ agent_id: VALID_UUID, listing_type: 'sell', price_usdc: 1, rep_id_at_listing: 1 }).ok,
    ).toBe(false);
  });
});

describe('POST /listings', () => {
  afterEach(() => {
    delete (global as any).__mktDb;
  });

  test('201 returns listing_id', async () => {
    (global as any).__mktDb = {
      from: () => ({
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: 5 }, error: null }) }) }),
      }),
    };
    const res = await request(makeApp())
      .post('/api/v1/marketplace/listings')
      .send({ agent_id: VALID_UUID, owner_sbt_id: 'sbt-1', listing_type: 'rent', price_usdc: 10, rep_id_at_listing: 1200, rental_duration_hours: 24 });
    expect(res.status).toBe(201);
    expect(res.body.listing_id).toBe(5);
    expect(res.body.status).toBe('active');
  });

  test('400 on invalid body', async () => {
    const res = await request(makeApp())
      .post('/api/v1/marketplace/listings')
      .send({ agent_id: 'bad', owner_sbt_id: 'sbt-1', listing_type: 'rent', price_usdc: 10, rep_id_at_listing: 1200 });
    expect(res.status).toBe(400);
  });
});

describe('POST /rentals — settlement disabled', () => {
  afterEach(() => {
    delete (global as any).__mktDb;
  });

  test('200 returns settlement-disabled note + moves no money', async () => {
    (global as any).__mktDb = {
      from: () => ({
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: 88 }, error: null }) }) }),
      }),
    };
    const res = await request(makeApp())
      .post('/api/v1/marketplace/rentals')
      .send({ listing_id: 5, renter_sbt_id: 'renter-sbt', target_squad_id: 'squad-9' });
    expect(res.status).toBe(200);
    expect(res.body.rental_id).toBe(88);
    expect(res.body.settlement).toBe('disabled');
    expect(res.body.settlement_enabled).toBe(false);
    expect(res.body.note).toMatch(/SETTLEMENT IS DISABLED/);
    expect(res.body.note).toMatch(/attributes to the AGENT, not the renter/);
  });

  test('400 when renter_sbt_id missing', async () => {
    const res = await request(makeApp())
      .post('/api/v1/marketplace/rentals')
      .send({ listing_id: 5 });
    expect(res.status).toBe(400);
  });
});

// ----------------------------------------------------------------------------
// GET /recent-transactions — sanitized public feed of completed service_contracts.
// Verifies the join+shape (not full DB plumbing). Uses the same call-time
// global handle pattern as the other tests so jest does not hoist the mock.
// ----------------------------------------------------------------------------
describe('GET /recent-transactions', () => {
  afterEach(() => {
    delete (global as any).__mktDb;
  });

  function makeDb(handlers: {
    contracts: any[];
    services?: any[];
    agents?: any[];
    settlements?: any[];
    events?: any[];
    categories?: any[];
  }) {
    const tables: Record<string, any[]> = {
      service_contracts: handlers.contracts ?? [],
      agent_services: handlers.services ?? [],
      repid_agents: handlers.agents ?? [],
      x402_settlements: handlers.settlements ?? [],
      repid_score_events: handlers.events ?? [],
      service_categories: handlers.categories ?? [],
    };
    return {
      from: (table: string) => {
        const data = tables[table] ?? [];
        const chain: any = {
          _data: data,
          select: function () { return this; },
          in: function () { return this; },
          eq: function () { return this; },
          order: function () { return this; },
          limit: async function () { return { data: this._data, error: null }; },
          then: function (resolve: any) { resolve({ data: this._data, error: null }); },
        };
        return chain;
      },
    };
  }

  test('200 returns transactions + coming_soon shape', async () => {
    (global as any).__mktDb = makeDb({
      contracts: [
        {
          id: 'c1', service_id: 'svc1', buyer_agent_id: 'b1', provider_agent_id: 'p1',
          agreed_price_usdc_raw: 100000, status: 'fulfilled',
          fulfilled_at: '2026-05-27T23:00:00Z', satisfied_at: null, settled_at: null,
          buyer_satisfaction_score: null, x402_payment_id: 's1',
          metadata: { is_simulated: true, demo_tag: 'test' },
        },
      ],
      services: [{ id: 'svc1', service_type: 'verification' }],
      agents: [
        { id: 'b1', agent_name: 'trinity-sophia' },
        { id: 'p1', agent_name: 'trinity-veritas' },
      ],
      settlements: [{ id: 's1', is_simulated: true, status: 'settled', tx_hash: null }],
      events: [
        { agent_id: 'p1', event_type: 'SERVICE_FULFILLED', delta: 0, metadata: { contract_id: 'c1' } },
        { agent_id: 'b1', event_type: 'SERVICE_FULFILLED', delta: 0, metadata: { contract_id: 'c1' } },
      ],
      categories: [
        { category_name: 'fact_check', display_name: 'Fact Check', description: 'Roadmap — handler not yet implemented.' },
      ],
    });

    const res = await request(makeApp()).get('/api/v1/marketplace/recent-transactions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.transactions)).toBe(true);
    expect(res.body.transactions).toHaveLength(1);

    const tx = res.body.transactions[0];
    expect(tx.contract_id).toBe('c1');
    expect(tx.service_type).toBe('verification');
    expect(tx.service_display_name).toBe('Verification-as-a-Service');
    expect(tx.price_usdc).toBe('0.100000');
    expect(tx.buyer_agent).toBe('trinity-sophia');
    expect(tx.provider_agent).toBe('trinity-veritas');
    expect(tx.settlement_type).toBe('sim');
    expect(tx.is_simulated).toBe(true);
    expect(tx.provider_repid_delta).toBe(0);
    expect(tx.buyer_repid_delta).toBe(0);

    expect(Array.isArray(res.body.coming_soon)).toBe(true);
    expect(res.body.coming_soon[0]).toMatchObject({
      service_type: 'fact_check',
      display_name: 'Fact Check',
    });
    expect(res.body.meta.live_handler_types).toContain('verification');
    expect(res.body.meta.live_handler_types).toContain('reputation_audit');
  });

  test('200 with empty transactions when no contracts exist', async () => {
    (global as any).__mktDb = makeDb({
      contracts: [],
      categories: [{ category_name: 'llm_arbitrage', display_name: 'LLM Provider Arbitrage', description: null }],
    });
    const res = await request(makeApp()).get('/api/v1/marketplace/recent-transactions');
    expect(res.status).toBe(200);
    expect(res.body.transactions).toEqual([]);
    expect(res.body.coming_soon[0].service_type).toBe('llm_arbitrage');
  });

  test('settlement_type=real when is_simulated=false on linked settlement', async () => {
    (global as any).__mktDb = makeDb({
      contracts: [
        {
          id: 'c2', service_id: 'svc1', buyer_agent_id: 'b1', provider_agent_id: 'p1',
          agreed_price_usdc_raw: 50000, status: 'satisfied',
          fulfilled_at: '2026-05-27T23:00:00Z', satisfied_at: '2026-05-27T23:01:00Z',
          settled_at: '2026-05-27T23:01:01Z',
          buyer_satisfaction_score: 0.85, x402_payment_id: 's2',
          metadata: {},
        },
      ],
      services: [{ id: 'svc1', service_type: 'anfis_routing' }],
      agents: [
        { id: 'b1', agent_name: 'trinity-sophia' },
        { id: 'p1', agent_name: 'trinity-mel' },
      ],
      settlements: [{ id: 's2', is_simulated: false, status: 'settled', tx_hash: '0xabc123' }],
      events: [],
    });
    const res = await request(makeApp()).get('/api/v1/marketplace/recent-transactions');
    expect(res.status).toBe(200);
    const tx = res.body.transactions[0];
    expect(tx.settlement_type).toBe('real');
    expect(tx.settlement_tx_hash).toBe('0xabc123');
    expect(tx.is_simulated).toBe(false);
    expect(tx.buyer_satisfaction_score).toBe(0.85);
  });

  test('settlement_type=none when no x402_payment_id', async () => {
    (global as any).__mktDb = makeDb({
      contracts: [
        {
          id: 'c3', service_id: 'svc1', buyer_agent_id: 'b1', provider_agent_id: 'p1',
          agreed_price_usdc_raw: 100, status: 'fulfilled',
          fulfilled_at: '2026-05-27T23:00:00Z', satisfied_at: null, settled_at: null,
          buyer_satisfaction_score: null, x402_payment_id: null,
          metadata: { is_simulated: 'true' },
        },
      ],
      services: [{ id: 'svc1', service_type: 'verification' }],
      agents: [
        { id: 'b1', agent_name: 'trinity-orch' },
        { id: 'p1', agent_name: 'trinity-veritas' },
      ],
      settlements: [],
      events: [],
    });
    const res = await request(makeApp()).get('/api/v1/marketplace/recent-transactions');
    expect(res.status).toBe(200);
    const tx = res.body.transactions[0];
    expect(tx.settlement_type).toBe('none');
    expect(tx.settlement_tx_hash).toBeNull();
    expect(tx.is_simulated).toBe(true); // truthy 'true' via F-series normalize
  });
});
