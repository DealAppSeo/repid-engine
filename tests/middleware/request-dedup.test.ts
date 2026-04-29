import express from 'express';
import request from 'supertest';
import { requestDedup } from '../../src/middleware/request-dedup';

function makeApp(handler: ReturnType<typeof requestDedup>): {
  app: express.Express;
  hits: { count: number };
} {
  const app = express();
  const hits = { count: 0 };
  app.use(express.json());
  app.post('/r', handler, (_req, res) => {
    hits.count += 1;
    res.status(201).json({ ok: true, n: hits.count });
  });
  return { app, hits };
}

describe('requestDedup', () => {
  it('returns cached response for repeated Idempotency-Key', async () => {
    const dedup = requestDedup({ windowMs: 5_000 });
    const { app, hits } = makeApp(dedup);

    const r1 = await request(app)
      .post('/r')
      .set('Idempotency-Key', 'k-1')
      .send({});
    const r2 = await request(app)
      .post('/r')
      .set('Idempotency-Key', 'k-1')
      .send({});

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body).toEqual({ ok: true, n: 1 });
    expect(r2.body).toEqual({ ok: true, n: 1 });
    expect(hits.count).toBe(1);
    expect(r2.headers['x-idempotent-replay']).toBe('true');
    expect(r1.headers['x-idempotent-replay']).toBeUndefined();
    dedup._stopCleanup();
  });

  it('different keys do not collide', async () => {
    const dedup = requestDedup();
    const { app, hits } = makeApp(dedup);
    const a = await request(app).post('/r').set('Idempotency-Key', 'k-a').send({});
    const b = await request(app).post('/r').set('Idempotency-Key', 'k-b').send({});
    expect(a.body).toEqual({ ok: true, n: 1 });
    expect(b.body).toEqual({ ok: true, n: 2 });
    expect(hits.count).toBe(2);
    dedup._stopCleanup();
  });

  it('different paths with same key do not collide', async () => {
    const dedup = requestDedup();
    const app = express();
    const hits = { a: 0, b: 0 };
    app.use(express.json());
    app.post('/a', dedup, (_req, res) => {
      hits.a += 1;
      res.json({ on: 'a', n: hits.a });
    });
    app.post('/b', dedup, (_req, res) => {
      hits.b += 1;
      res.json({ on: 'b', n: hits.b });
    });
    const ra = await request(app).post('/a').set('Idempotency-Key', 'shared').send({});
    const rb = await request(app).post('/b').set('Idempotency-Key', 'shared').send({});
    expect(ra.body.on).toBe('a');
    expect(rb.body.on).toBe('b');
    expect(hits.a).toBe(1);
    expect(hits.b).toBe(1);
    dedup._stopCleanup();
  });

  it('cache entries expire after windowMs', async () => {
    const dedup = requestDedup({ windowMs: 40 });
    const { app, hits } = makeApp(dedup);
    await request(app).post('/r').set('Idempotency-Key', 'exp').send({});
    expect(hits.count).toBe(1);
    await new Promise((r) => setTimeout(r, 70));
    const r2 = await request(app).post('/r').set('Idempotency-Key', 'exp').send({});
    expect(r2.body.n).toBe(2);
    expect(hits.count).toBe(2);
    dedup._stopCleanup();
  });

  it('passes through when Idempotency-Key header is absent', async () => {
    const dedup = requestDedup();
    const { app, hits } = makeApp(dedup);
    await request(app).post('/r').send({});
    await request(app).post('/r').send({});
    expect(hits.count).toBe(2);
    dedup._stopCleanup();
  });

  it('passes through when Idempotency-Key header is empty', async () => {
    const dedup = requestDedup();
    const { app, hits } = makeApp(dedup);
    await request(app).post('/r').set('Idempotency-Key', '').send({});
    await request(app).post('/r').set('Idempotency-Key', '').send({});
    expect(hits.count).toBe(2);
    dedup._stopCleanup();
  });

  it('replays original status code and body for non-2xx response', async () => {
    const dedup = requestDedup({ windowMs: 5_000 });
    const app = express();
    const hits = { count: 0 };
    app.use(express.json());
    app.post('/fail', dedup, (_req, res) => {
      hits.count += 1;
      res.status(422).json({ error: 'bad-thing' });
    });
    const r1 = await request(app).post('/fail').set('Idempotency-Key', 'k').send({});
    const r2 = await request(app).post('/fail').set('Idempotency-Key', 'k').send({});
    expect(r1.status).toBe(422);
    expect(r2.status).toBe(422);
    expect(r2.body).toEqual({ error: 'bad-thing' });
    expect(hits.count).toBe(1);
    dedup._stopCleanup();
  });

  it('honors a custom header name', async () => {
    const dedup = requestDedup({ headerName: 'X-Request-Id' });
    const { app, hits } = makeApp(dedup);
    await request(app).post('/r').set('X-Request-Id', 'rid-1').send({});
    await request(app).post('/r').set('X-Request-Id', 'rid-1').send({});
    expect(hits.count).toBe(1);
    dedup._stopCleanup();
  });
});
