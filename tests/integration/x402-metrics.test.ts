import request from 'supertest';
import app from '../../src/index';
import { db } from '../../src/db';
import { x402Metrics } from '../../src/observability/x402-metrics';

describe('x402 Metrics Observability', () => {
  beforeEach(() => {
    // Reset/clear mock states if any, but since it's an in-memory singleton, we don't strictly need to clear it, just assert increments
  });

  test('GET /api/v1/observability/x402-metrics gating', async () => {
    // 1. Without auth header -> 401
    const resNoAuth = await request(app).get('/api/v1/observability/x402-metrics');
    expect(resNoAuth.status).toBe(401);

    // 2. With non-ops tier (e.g., premium/free) -> 403
    // We can set process.env.REPID_API_KEYS to include some keys with different tiers
    const originalKeys = process.env.REPID_API_KEYS;
    process.env.REPID_API_KEYS = 'test-key-premium:premium,test-key-ops:ops';

    const resPremium = await request(app)
      .get('/api/v1/observability/x402-metrics')
      .set('Authorization', 'Bearer test-key-premium');
    expect(resPremium.status).toBe(403);

    // 3. With ops tier -> 200 and returns metrics snapshot
    const resOps = await request(app)
      .get('/api/v1/observability/x402-metrics')
      .set('Authorization', 'Bearer test-key-ops');
    expect(resOps.status).toBe(200);
    expect(resOps.body.timestamp).toBeDefined();
    expect(resOps.body.counters).toBeDefined();
    expect(resOps.body.latencies).toBeDefined();

    process.env.REPID_API_KEYS = originalKeys;
  });

  test('escrow settlement increments metrics counters', async () => {
    // We can trigger an escrow action (legacy or simulated) and check if metrics counters changed
    const originalKeys = process.env.REPID_API_KEYS;
    process.env.REPID_API_KEYS = 'test-key-ops:ops';

    // Get current value
    const initialRes = await request(app)
      .get('/api/v1/observability/x402-metrics')
      .set('Authorization', 'Bearer test-key-ops');
    const initialAttempt = initialRes.body.counters['escrow.attempt'] || 0;

    // Run escrow in legacy mode (which is easiest to run without mocked databases in a basic endpoint call)
    // Legacy mode runs if X402_ENFORCEMENT_ENABLED !== 'true'
    const originalEnforce = process.env.X402_ENFORCEMENT_ENABLED;
    process.env.X402_ENFORCEMENT_ENABLED = 'false';

    // Hit escrow endpoint (it will return 404 for a fake contract but still increment attempts if it starts processing)
    // Wait, the handler fetches contract first: if (getErr || !contract) -> return 404 and increment escrow.error.400.
    await request(app)
      .post('/api/v1/contracts/non-existent-id/escrow')
      .set('Authorization', 'Bearer test-key-ops');

    const finalRes = await request(app)
      .get('/api/v1/observability/x402-metrics')
      .set('Authorization', 'Bearer test-key-ops');
    
    const finalAttempt = finalRes.body.counters['escrow.attempt'];
    expect(finalAttempt).toBe(initialAttempt + 1);

    const finalErr400 = finalRes.body.counters['escrow.error.400'];
    expect(finalErr400).toBeGreaterThan(0);

    process.env.REPID_API_KEYS = originalKeys;
    process.env.X402_ENFORCEMENT_ENABLED = originalEnforce;
  });
});
