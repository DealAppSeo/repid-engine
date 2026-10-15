/**
 * POST /peer-verify/respond rate limit — keyed on the authenticated principal, never on IP, and never
 * on the API key itself.
 *
 * The 12 T12 agents can share Railway egress IPs, so a per-IP bucket would let one agent throttle the
 * fleet's ballots. authMiddleware sets req.agent_id for a DB agent key and req.apiKey for every valid
 * key; for an env-allowlist key (REPID_API_KEYS) it also records WHICH entry matched (envIndex), and
 * that index is the bucket. XC1's review of #1368: the raw key as the bucket id was the MemoryStore
 * key and the enumerable req.rateLimit.key. Own file => fresh limiter store.
 */

jest.mock('../src/db/direct-pg', () => ({ pgQuery: jest.fn(async () => []), pgPing: jest.fn(async () => true) }));
jest.mock('../src/services/peer-verify-score', () => ({ emitPeerVerifyScoreEvents: jest.fn(async () => ({ emitted: false })) }));
jest.mock('../src/db', () => ({ db: { from: () => ({ select: () => ({}) }), rpc: async () => ({ data: null, error: null }) } }));
// authMiddleware's own collaborators: the DB key store (no DB keys here) and its audit logger.
jest.mock('../src/auth/api-keys', () => ({ ...jest.requireActual('../src/auth/api-keys'), validateAgentApiKey: jest.fn(async () => null) }));
jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn(async () => undefined) }));

import request from 'supertest';
import express from 'express';
import peerVerificationRouter, { RESPOND_LIMIT_PER_MIN, respondPrincipalKey } from '../src/routes/peer-verification';
import { authMiddleware } from '../src/middleware/auth';

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

// Fixture allowlist entries (not credentials): low-entropy on purpose, so secret scanners stay quiet.
const ENV_A = 'fixture-entry-one';
const ENV_B = 'fixture-entry-two';

describe('POST /api/v1/peer-verify/respond — per-principal rate limit', () => {
  test('principal key: agent id first, else the env-allowlist INDEX — never the key, never the IP', () => {
    expect(respondPrincipalKey({ agent_id: 'a1', apiKey: { key: 'k', envIndex: 0 } } as any)).toBe('agent:a1');
    const k = respondPrincipalKey({ apiKey: { key: ENV_A, tier: 'pro', envIndex: 2 }, ip: '1.2.3.4' } as any);
    expect(k).toBe('envkey:#2');
    expect(k).not.toContain(ENV_A);
    expect(k).not.toContain('1.2.3.4');
  });

  test('a key with no agent id and no allowlist index is one shared bucket, not a bucket named after it', () => {
    const k = respondPrincipalKey({ apiKey: { key: ENV_A } } as any);
    expect(k).toBe('unauthenticated');
    expect(k).not.toContain(ENV_A);
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

describe('through the REAL authMiddleware: an env key buckets by its allowlist index', () => {
  const SAVED = process.env.REPID_API_KEYS;
  beforeAll(() => { process.env.REPID_API_KEYS = `unused-first-key,${ENV_A}:pro, ${ENV_B}`; });
  afterAll(() => { if (SAVED === undefined) delete process.env.REPID_API_KEYS; else process.env.REPID_API_KEYS = SAVED; });

  /** The real auth in front of the router; the limiter's req.rateLimit is read when the response ends. */
  function authedApp(seen: string[]): express.Express {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      res.on('finish', () => seen.push(String((req as any).rateLimit?.key)));
      next();
    });
    app.use(authMiddleware);
    app.use('/api/v1/peer-verify', peerVerificationRouter);
    return app;
  }

  test('req.rateLimit.key is the index, and never equals or contains the key', async () => {
    const seen: string[] = [];
    const app = authedApp(seen);
    await hit(app, { authorization: `Bearer ${ENV_A}` });
    await hit(app, { 'x-api-key': ENV_B });
    // entries 1 and 2 of the allowlist (the tier suffix and the spaces are ignored, as auth parses them)
    expect(seen).toEqual(['envkey:#1', 'envkey:#2']);
    for (const id of seen) {
      for (const secret of [ENV_A, ENV_B]) {
        expect(id).not.toBe(secret);
        expect(id).not.toContain(secret);
      }
    }
  });

  test('two env keys on one IP are separate buckets: exhausting one does not throttle the other', async () => {
    // The limiter store is one per module, so use allowlist entry 0, which no other case touches.
    const app = authedApp([]);
    for (let i = 0; i < RESPOND_LIMIT_PER_MIN; i++) {
      expect((await hit(app, { authorization: 'Bearer unused-first-key' })).status).toBe(400);
    }
    expect((await hit(app, { authorization: 'Bearer unused-first-key' })).status).toBe(429);
    expect((await hit(app, { authorization: `Bearer ${ENV_A}` })).status).toBe(400);
  });
});
