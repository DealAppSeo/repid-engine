/**
 * resilience-route.test.ts — B0 + B5 contract: GET /resilience/health and POST /resilience/route
 * round-trip. Mounts only the resilience router (auth bypassed by default flags) — no full index boot.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
// Make POST /route auth a pass-through for the test by allowing a known key.
process.env.REPID_API_KEYS = 'test-key-123:enterprise';

jest.mock('../src/db', () => ({
  db: { from: () => ({ insert: () => Promise.resolve({ data: null, error: null }) }) },
}));

import express from 'express';
import request from 'supertest';
import resilienceRouter from '../src/routes/v1/resilience';
import { publishHealth, __resetHealthBus } from '../src/resilience/health-bus';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', resilienceRouter);
  return app;
}

beforeEach(() => __resetHealthBus());

describe('B0/B5 resilience routes', () => {
  it('GET /resilience/health returns the SurfaceHealth array (with live wrapper snapshots)', async () => {
    publishHealth({ surface: 'db', endpoint: 'pooler:6543', healthy: true, state: 'closed', latencyMsEwma: 12, errorRate: 0 });
    const res = await request(makeApp()).get('/api/v1/resilience/health');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.surfaces)).toBe(true);
    const surfaces = res.body.data.surfaces.map((s: any) => s.surface);
    expect(surfaces).toContain('db');
    // rpc + llm + x402 come from the live wrapper snapshots even before any call.
    expect(surfaces).toContain('rpc');
    expect(res.body.data.enabled).toBeDefined();
  });

  it('POST /resilience/route stores a decision and reports willActuate=false in shadow default', async () => {
    const app = makeApp();
    const post = await request(app)
      .post('/api/v1/resilience/route')
      .set('Authorization', 'Bearer test-key-123')
      .send({ surface: 'rpc', decision: { preferredEndpoint: 'https://sepolia.base.org', forceFallback: true } });
    expect(post.status).toBe(200);
    expect(post.body.data.stored.preferredEndpoint).toBe('https://sepolia.base.org');
    expect(post.body.data.willActuate).toBe(false); // RESILIENCE_ANFIS_ENABLE_RPC unset → shadow

    // Read it back via the decisions map on GET.
    const get = await request(app).get('/api/v1/resilience/health');
    expect(get.body.data.decisions.rpc.preferredEndpoint).toBe('https://sepolia.base.org');
  });

  it('POST /resilience/route rejects an unknown surface', async () => {
    const res = await request(makeApp())
      .post('/api/v1/resilience/route')
      .set('Authorization', 'Bearer test-key-123')
      .send({ surface: 'bogus', decision: {} });
    expect(res.status).toBe(400);
  });

  it('POST /resilience/route requires auth', async () => {
    const res = await request(makeApp())
      .post('/api/v1/resilience/route')
      .send({ surface: 'rpc', decision: {} });
    expect(res.status).toBe(401);
  });
});
