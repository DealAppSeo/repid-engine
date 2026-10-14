/**
 * POST /peer-verify/respond rate limit — keyed on the authenticated principal, never on IP.
 *
 * The 12 T12 agents can share Railway egress IPs, so a per-IP bucket would let one agent
 * throttle the fleet's ballots. authMiddleware sets req.agent_id (DB agent key) and
 * req.apiKey (any valid key); the limiter keys on those. Own file => fresh limiter store.
 */

jest.mock('../src/db/direct-pg', () => ({ pgQuery: jest.fn(async () => []), pgPing: jest.fn(async () => true) }));
jest.mock('../src/services/peer-verify-score', () => ({ emitPeerVerifyScoreEvents: jest.fn(async () => ({ emitted: false })) }));
jest.mock('../src/db', () => ({ db: { from: () => ({ select: () => ({}) }), rpc: async () => ({ data: null, error: null }) } }));

import request from 'supertest';
import express from 'express';
import peerVerificationRouter, { RESPOND_LIMIT_PER_MIN, respondPrincipalKey } from '../src/routes/peer-verification';

/** Stand-in for authMiddleware: the principal comes from test headers, the IP is shared. */
function appAs(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const agent = req.headers['x-test-agent'];
    const key = req.headers['x-test-key'];
    if (key) (req as any).apiKey = { key, tier: 'testnet' };
    if (agent) (req as any).agent_id = agent;
    next();
  });
  app.use('/api/v1/peer-verify', peerVerificationRouter);
  return app;
}

// An empty body is rejected 400 by the handler, AFTER the limiter has counted it.
const hit = (app: express.Express, headers: Record<string, string>) => {
  let r = request(app).post('/api/v1/peer-verify/respond');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send({});
};

describe('POST /api/v1/peer-verify/respond — per-principal rate limit', () => {
  test('principal key: agent id first, else the API key — never the IP', () => {
    expect(respondPrincipalKey({ agent_id: 'a1', apiKey: { key: 'k' } } as any)).toBe('agent:a1');
    const k = respondPrincipalKey({ apiKey: { key: 'secret-key' }, ip: '1.2.3.4' } as any);
    expect(k).toBe('key:secret-key');
    expect(k).not.toContain('1.2.3.4');
  });

  test(`agent over ${RESPOND_LIMIT_PER_MIN}/min → 429 with Retry-After; a second agent on the same IP is unaffected`, async () => {
    const app = appAs();
    const a = { 'x-test-agent': 'agent-a', 'x-test-key': 'key-a' };
    for (let i = 0; i < RESPOND_LIMIT_PER_MIN; i++) {
      const res = await hit(app, a);
      expect(res.status).toBe(400);
    }
    const limited = await hit(app, a);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    const other = await hit(app, { 'x-test-agent': 'agent-b', 'x-test-key': 'key-b' });
    expect(other.status).toBe(400);
  });
});
