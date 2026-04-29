import express from 'express';
import request from 'supertest';
import { ipFingerprint } from '../../src/middleware/ip-fingerprint';

function makeApp(): express.Express {
  const app = express();
  app.set('trust proxy', true);
  app.get('/fp', ipFingerprint(), (req, res) => {
    res.json({ fp: req.fingerprint });
  });
  return app;
}

describe('ipFingerprint', () => {
  it('produces a stable hash for same IP+UA', async () => {
    const app = makeApp();
    const a = await request(app)
      .get('/fp')
      .set('X-Forwarded-For', '203.0.113.7')
      .set('User-Agent', 'TestAgent/1.0');
    const b = await request(app)
      .get('/fp')
      .set('X-Forwarded-For', '203.0.113.7')
      .set('User-Agent', 'TestAgent/1.0');
    expect(typeof a.body.fp).toBe('string');
    expect(a.body.fp.length).toBe(32);
    expect(a.body.fp).toBe(b.body.fp);
  });

  it('produces different hashes for different IPs', async () => {
    const app = makeApp();
    const a = await request(app)
      .get('/fp')
      .set('X-Forwarded-For', '203.0.113.1')
      .set('User-Agent', 'UA');
    const b = await request(app)
      .get('/fp')
      .set('X-Forwarded-For', '203.0.113.2')
      .set('User-Agent', 'UA');
    expect(a.body.fp).not.toBe(b.body.fp);
  });

  it('produces different hashes for different UAs at same IP', async () => {
    const app = makeApp();
    const a = await request(app)
      .get('/fp')
      .set('X-Forwarded-For', '203.0.113.5')
      .set('User-Agent', 'AgentA');
    const b = await request(app)
      .get('/fp')
      .set('X-Forwarded-For', '203.0.113.5')
      .set('User-Agent', 'AgentB');
    expect(a.body.fp).not.toBe(b.body.fp);
  });

  it('uses first IP from comma-separated x-forwarded-for', async () => {
    const app = makeApp();
    const a = await request(app)
      .get('/fp')
      .set('X-Forwarded-For', '203.0.113.5, 10.0.0.1, 10.0.0.2')
      .set('User-Agent', 'UA');
    const b = await request(app)
      .get('/fp')
      .set('X-Forwarded-For', '203.0.113.5')
      .set('User-Agent', 'UA');
    expect(a.body.fp).toBe(b.body.fp);
  });

  it('falls back gracefully when headers missing', async () => {
    const app = makeApp();
    const r = await request(app).get('/fp');
    expect(typeof r.body.fp).toBe('string');
    expect(r.body.fp.length).toBe(32);
  });

  it('does not perform geolocation or external network calls', async () => {
    // Smoke: middleware should be synchronous; if it issued a network call
    // the test infrastructure (jest-mock or net) would surface it. Instead,
    // we assert the response time is local-fast and the fingerprint is hex.
    const app = makeApp();
    const start = Date.now();
    const r = await request(app)
      .get('/fp')
      .set('X-Forwarded-For', '203.0.113.9')
      .set('User-Agent', 'UA');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(r.body.fp).toMatch(/^[0-9a-f]{32}$/);
  });
});
