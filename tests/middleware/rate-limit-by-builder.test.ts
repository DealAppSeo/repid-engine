import express from 'express';
import request from 'supertest';
import { rateLimitByBuilder } from '../../src/middleware/rate-limit-by-builder';

function makeApp(handler: ReturnType<typeof rateLimitByBuilder>): express.Express {
  const app = express();
  app.use(express.json());
  app.post('/r', handler, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('rateLimitByBuilder', () => {
  it('allows requests up to maxRequests, rejects the next', async () => {
    const limiter = rateLimitByBuilder({ maxRequests: 3, windowMs: 5_000 });
    const app = makeApp(limiter);

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/r').send({ builder_id: 'b1' });
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('3');
      expect(res.headers['x-ratelimit-remaining']).toBe(String(2 - i));
    }
    const blocked = await request(app).post('/r').send({ builder_id: 'b1' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(
      expect.objectContaining({
        error: 'RATE_LIMITED',
        retry_after_ms: expect.any(Number),
      }),
    );
    expect(typeof blocked.headers['retry-after']).toBe('string');
    limiter._stopCleanup();
  });

  it('isolates buckets by builder_id', async () => {
    const limiter = rateLimitByBuilder({ maxRequests: 1, windowMs: 5_000 });
    const app = makeApp(limiter);

    const a1 = await request(app).post('/r').send({ builder_id: 'a' });
    const b1 = await request(app).post('/r').send({ builder_id: 'b' });
    const a2 = await request(app).post('/r').send({ builder_id: 'a' });
    expect(a1.status).toBe(200);
    expect(b1.status).toBe(200);
    expect(a2.status).toBe(429);
    limiter._stopCleanup();
  });

  it('exposes correct X-RateLimit-Reset header (unix seconds)', async () => {
    const limiter = rateLimitByBuilder({ maxRequests: 5, windowMs: 10_000 });
    const app = makeApp(limiter);
    const before = Math.floor(Date.now() / 1000);
    const res = await request(app).post('/r').send({ builder_id: 'x' });
    const after = Math.floor(Date.now() / 1000);
    expect(res.status).toBe(200);
    const reset = Number(res.headers['x-ratelimit-reset']);
    expect(reset).toBeGreaterThanOrEqual(before + 9);
    expect(reset).toBeLessThanOrEqual(after + 11);
    limiter._stopCleanup();
  });

  it('passes through requests with no builder identity', async () => {
    const limiter = rateLimitByBuilder({ maxRequests: 1, windowMs: 5_000 });
    const app = makeApp(limiter);
    const r1 = await request(app).post('/r').send({});
    const r2 = await request(app).post('/r').send({});
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    limiter._stopCleanup();
  });

  it('refills bucket after windowMs', async () => {
    const limiter = rateLimitByBuilder({ maxRequests: 1, windowMs: 50 });
    const app = makeApp(limiter);
    const ok = await request(app).post('/r').send({ builder_id: 'rf' });
    const blocked = await request(app).post('/r').send({ builder_id: 'rf' });
    expect(ok.status).toBe(200);
    expect(blocked.status).toBe(429);
    await new Promise((r) => setTimeout(r, 80));
    const refilled = await request(app).post('/r').send({ builder_id: 'rf' });
    expect(refilled.status).toBe(200);
    limiter._stopCleanup();
  });

  it('cleanup removes expired buckets from internal map', async () => {
    const limiter = rateLimitByBuilder({ maxRequests: 1, windowMs: 30 });
    const app = makeApp(limiter);
    await request(app).post('/r').send({ builder_id: 'cleanup-1' });
    await request(app).post('/r').send({ builder_id: 'cleanup-2' });
    expect(limiter._buckets.size).toBe(2);
    await new Promise((r) => setTimeout(r, 50));
    // Manually expire — verify next-request path replaces stale buckets
    await request(app).post('/r').send({ builder_id: 'cleanup-1' });
    const bucket = limiter._buckets.get('cleanup-1');
    expect(bucket).toBeDefined();
    expect(bucket!.count).toBe(1);
    limiter._stopCleanup();
  });

  it('supports custom getBuilderId', async () => {
    const limiter = rateLimitByBuilder({
      maxRequests: 1,
      windowMs: 5_000,
      getBuilderId: (req) => (req.headers['x-test-id'] as string) || undefined,
    });
    const app = makeApp(limiter);
    const r1 = await request(app).post('/r').set('x-test-id', 'tx').send({});
    const r2 = await request(app).post('/r').set('x-test-id', 'tx').send({});
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
    limiter._stopCleanup();
  });

  it('throws on invalid options', () => {
    expect(() => rateLimitByBuilder({ maxRequests: 0, windowMs: 1000 })).toThrow();
    expect(() => rateLimitByBuilder({ maxRequests: 5, windowMs: 0 })).toThrow();
  });
});
