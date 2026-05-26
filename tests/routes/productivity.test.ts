/**
 * productivity-stack route test (CC1, 2026-05-26) — auth gate + response shape.
 * db mocked permissively so computeProductivityStack returns empty-but-valid metrics.
 */
import request from 'supertest';

jest.mock('../../src/db', () => {
  const make = () => {
    const chain: any = {};
    for (const m of ['from', 'select', 'eq', 'not', 'is', 'gte', 'ilike', 'order', 'limit', 'insert', 'upsert', 'update']) chain[m] = jest.fn(() => chain);
    chain.then = (resolve: any) => resolve({ data: [], count: 0, error: null });
    chain.single = jest.fn(() => Promise.resolve({ data: null, error: null }));
    chain.maybeSingle = jest.fn(() => Promise.resolve({ data: null, error: null }));
    // versioningMiddleware calls db.rpc('run_sql') on every /api/v1 request — must exist
    // or the request 500s before reaching the route (documented test-infra gotcha).
    chain.rpc = jest.fn(() => Promise.resolve({ data: null, error: null }));
    return chain;
  };
  return { db: make() };
});

const EP = '/api/v1/observability/productivity-stack';
const KEY = 'test-prod-key-abc';

describe('productivity-stack endpoint', () => {
  const orig = process.env.REPID_API_KEYS;
  let app: any;
  beforeAll(() => { process.env.REPID_API_KEYS = `${KEY}:pro`; app = require('../../src/index').default; });
  afterAll(() => { process.env.REPID_API_KEYS = orig; });

  it('requires auth → 401 without a key', async () => {
    const r = await request(app).get(EP);
    expect(r.status).toBe(401);
  });

  it('returns the productivity stack shape with a valid key', async () => {
    const r = await request(app).get(EP).set('Authorization', `Bearer ${KEY}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('anfis_routing_distribution');
    expect(r.body).toHaveProperty('slm_tier');
    expect(r.body).toHaveProperty('firecrawl');
    expect(r.body).toHaveProperty('total_external_spend_usd');
    expect(r.body).toHaveProperty('per_agent_productivity');
  });
});
