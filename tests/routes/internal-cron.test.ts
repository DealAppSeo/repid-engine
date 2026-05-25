/**
 * internal-cron route tests (CC1, 2026-05-25) — token gate + run path.
 * DB is mocked permissively so the runners complete without a live DB.
 */
import request from 'supertest';

jest.mock('../../src/db', () => {
  const make = () => {
    const chain: any = {};
    for (const m of ['from', 'select', 'eq', 'not', 'is', 'gte', 'order', 'limit', 'insert']) chain[m] = jest.fn(() => chain);
    chain.then = (resolve: any) => resolve({ data: [], count: 0, error: null });
    chain.maybeSingle = jest.fn(() => Promise.resolve({ data: null, error: null }));
    chain.single = jest.fn(() => Promise.resolve({ data: null, error: null }));
    return chain;
  };
  return { db: make() };
});

const ENDPOINTS = ['/api/v1/internal/cron/capture-telemetry', '/api/v1/internal/cron/health-24h', '/api/v1/internal/cron/audit-probe'];
const TOKEN = 'test-cron-token-xyz';

describe('internal cron triggers', () => {
  const orig = process.env.CRON_TRIGGER_TOKEN;
  let app: any;
  beforeAll(() => { process.env.CRON_TRIGGER_TOKEN = TOKEN; app = require('../../src/index').default; });
  afterAll(() => { process.env.CRON_TRIGGER_TOKEN = orig; });

  for (const ep of ENDPOINTS) {
    it(`${ep} → 401 with no token`, async () => {
      const r = await request(app).post(ep).send({});
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('invalid_or_missing_cron_token');
    });
    it(`${ep} → 401 with wrong token`, async () => {
      const r = await request(app).post(ep).set('X-Cron-Token', 'nope').send({});
      expect(r.status).toBe(401);
    });
    it(`${ep} → 200 with correct token (returns trigger + last_run)`, async () => {
      const r = await request(app).post(ep).set('X-Cron-Token', TOKEN).send({});
      expect(r.status).toBe(200);
      expect(['ran', 'skipped_idempotent']).toContain(r.body.status);
      expect(typeof r.body.trigger).toBe('string');
      expect(r.body.last_run).toBeTruthy();
    });
    it(`${ep} → GET is rejected (POST only)`, async () => {
      // No GET handler on the cron router; an unmatched GET under /api/v1 falls
      // through to authMiddleware → 401. Either way it must NOT succeed.
      const r = await request(app).get(ep);
      expect(r.status).not.toBe(200);
    });
  }
});
