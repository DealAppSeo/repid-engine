/**
 * POST /api/v1/laya/classify returns route and latency_ms from the local classifier.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import layaClassifyRouter from '../src/routes/laya-classify';

describe('POST /api/v1/laya/classify', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', layaClassifyRouter);

  async function post(text: string) {
    return request(app).post('/api/v1/laya/classify').send({ text });
  }

  it('returns cheap, escalate, or ask with latency_ms and nothing else', async () => {
    const cheap = await post('hello');
    const ask = await post('what is this?');
    const escalate = await post('attest this claim');
    expect(cheap.status).toBe(200);
    expect(cheap.body).toEqual({ route: 'cheap', latency_ms: expect.any(Number) });
    expect(ask.body.route).toBe('ask');
    expect(escalate.body.route).toBe('escalate');
    for (const res of [cheap, ask, escalate]) {
      expect(Object.keys(res.body).sort()).toEqual(['latency_ms', 'route']);
      expect(res.body.latency_ms).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(res.body)).not.toMatch(/groq|openai|anthropic|cerebras|vendor/i);
    }
  });

  it('GET with no body returns ask and latency_ms', async () => {
    const res = await request(app).get('/api/v1/laya/classify');
    expect(res.status).toBe(200);
    expect(res.body.route).toBe('ask');
    expect(res.body.latency_ms).toEqual(expect.any(Number));
    expect(res.body.latency_ms).toBeGreaterThanOrEqual(0);
    expect(Object.keys(res.body).sort()).toEqual(['latency_ms', 'route']);
  });

  it('is mounted before auth and does not call a quorum or a vendor', () => {
    const root = path.join(__dirname, '..');
    const indexSrc = readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
    const routeSrc = readFileSync(path.join(root, 'src', 'routes', 'laya-classify.ts'), 'utf8');
    const mountAt = indexSrc.indexOf("app.use('/api/v1', layaClassifyRouter)");
    const authAt = indexSrc.indexOf('app.use(authMiddleware)');
    expect(mountAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(mountAt);
    expect(routeSrc).not.toContain('process.env');
    expect(routeSrc).not.toContain('fetch(');
    expect(routeSrc).not.toContain('../hal');
    expect(routeSrc).not.toContain('groq');
    expect(routeSrc).not.toContain('openai');
    expect(routeSrc).not.toContain('anthropic');
    expect(routeSrc).not.toContain('REAL_STAKING');
    expect(routeSrc).not.toContain('trinity-shofet');
  });
});
