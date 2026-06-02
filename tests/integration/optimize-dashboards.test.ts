/**
 * S-OPTIMIZE — cost + efficiency dashboard integration (supertest). Live-DB assertions gated on creds.
 */
const HAVE_CREDS = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy-key-for-import';

import request from 'supertest';
import app from '../../src/index';

const live = HAVE_CREDS ? describe : describe.skip;

live('cost + efficiency dashboards (live llm_call_log)', () => {
  it('GET /costs/summary returns the 24h cost shape', async () => {
    const res = await request(app).get('/api/v1/costs/summary');
    expect(res.status).toBe(200);
    expect(res.body.last_24h).toBeDefined();
    expect(typeof res.body.last_24h.total_calls).toBe('number');
    expect(typeof res.body.last_24h.total_cost_usd).toBe('number');
    expect(typeof res.body.last_24h.free_tier_pct).toBe('number');
    expect(Array.isArray(res.body.last_24h.top_spenders)).toBe(true);
    expect(res.body.by_provider).toBeDefined();
    expect(res.body.by_task_type).toBeDefined();
  });

  it('GET /system/efficiency returns waste/cost/throughput/learning', async () => {
    const res = await request(app).get('/api/v1/system/efficiency');
    expect(res.status).toBe(200);
    expect(res.body.waste_rate).toBeDefined();
    expect(res.body.cost).toBeDefined();
    expect(res.body.throughput).toBeDefined();
    expect(res.body.learning).toBeDefined();
    // cache_hit_rate is honestly null (not implemented), not a fabricated number
    expect(res.body.learning.cache_hit_rate).toBeNull();
  });
});
