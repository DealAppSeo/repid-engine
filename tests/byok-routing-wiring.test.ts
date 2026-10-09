/**
 * byok-routing-wiring — the /v1/llm/complete handler actually USES the merged key
 * map, redacts the body, and leaks no key material.
 *
 * This drives the real router handler (supertest). `resolveOwnerStoredKeys` is
 * mocked to stand in for custody (its own gate is proven in
 * byok-key-resolution.test.ts); the REAL `mergeEffectiveKeys` runs inside the
 * handler, and we capture what the router receives.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'dummy';
process.env.AGENT_GATE_ENABLED = 'false'; // no free-tier metering in these tests
process.env.GROQ_API_KEY = 'groq-env-key'; // so the tier-0 adapter resolves a key
delete process.env.OPENAI_API_KEY; // keep openai keyless unless a key map supplies it
delete process.env.ANTHROPIC_API_KEY;

const AGENT = '00000000-0000-4000-8000-000000000001';

const mockResolveOwnerStoredKeys = jest.fn();

jest.mock('../src/services/byok-key-resolution', () => {
  const actual = jest.requireActual('../src/services/byok-key-resolution');
  return { ...actual, resolveOwnerStoredKeys: (...a: unknown[]) => mockResolveOwnerStoredKeys(...a) };
});

jest.mock('../src/auth/api-keys', () => {
  const actual = jest.requireActual('../src/auth/api-keys');
  return {
    ...actual,
    validateAgentApiKey: jest.fn(async () => ({ agent_id: AGENT, scopes: ['llm_complete'] })),
  };
});

// Keep DB + fire-and-forget loggers offline and silent so the only thing under
// test is the key wiring.
jest.mock('../src/db', () => ({
  db: {
    from: () => {
      const c: any = {
        select: () => c,
        eq: () => c,
        insert: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (r: any) => r({ data: null, error: null }),
      };
      return c;
    },
  },
}));
jest.mock('../src/billing/log-call', () => ({ logLlmCall: jest.fn() }));
jest.mock('../src/billing/caps', () => ({ incrementSpend: async () => undefined }));
jest.mock('../src/scoring/pipeline', () => {
  const actual = jest.requireActual('../src/scoring/pipeline');
  return { ...actual, runScoreEvent: async () => ({ score_event_id: 's', hal_score: 1, hal_decision: 'ok', repid_delta_applied: 0, new_repid: 200, zk_proof_triggered: false }) };
});

import express from 'express';
import request from 'supertest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/providers/router');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { llmRouter } = require('../src/routes/route');

function makeApp() {
  const app = express();
  app.use(express.json());
  const seen: { req?: any } = {};
  app.use((req, _res, next) => {
    seen.req = req;
    next();
  });
  app.use(llmRouter);
  return { app, seen };
}

const stubAdapter = () => ({
  name: 'groq',
  tier: 0,
  complete: jest.fn(async () => ({ answer: 'ok', tokensIn: 1, tokensOut: 1, latencyMs: 5, provider: 'groq', model: 'm' })),
});

const captured: any[] = [];
let routeSpy: jest.SpyInstance;

beforeEach(() => {
  captured.length = 0;
  mockResolveOwnerStoredKeys.mockReset();
  mockResolveOwnerStoredKeys.mockResolvedValue({}); // default: custody contributes nothing
  routeSpy = jest.spyOn(router, 'routeRequest').mockImplementation(async (rr: any) => {
    captured.push(rr);
    return {
      adapter: stubAdapter(),
      decision: { chosen_provider: 'groq', chosen_tier: '0a', reason: 'priority_healthy', tried: [] },
      staticProvider: 'groq', staticTier: '0a',
      anfisProvider: 'groq', anfisTier: '0a', anfisConfidence: 0.9,
      routingRecord: null,
    };
  });
});

afterEach(() => routeSpy.mockRestore());

const authed = (app: express.Express, body: Record<string, unknown>) =>
  request(app).post('/v1/llm/complete').set('Authorization', 'Bearer agent-token').send({ agent_id: AGENT, prompt: '2+2', ...body });

describe('the merged key map is what routing sees', () => {
  it('flag-off (custody returns nothing) is identical to body-only', async () => {
    mockResolveOwnerStoredKeys.mockResolvedValue({});
    const { app } = makeApp();
    const res = await authed(app, { user_paid_keys: { openai: 'BODY-OAI' } });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].user_paid_keys).toEqual({ openai: 'BODY-OAI' });
  });

  it('a stored key for the caller fills a provider the body omitted', async () => {
    mockResolveOwnerStoredKeys.mockResolvedValue({ openai: 'STORED-OAI' });
    const { app } = makeApp();
    const res = await authed(app, {}); // no body keys
    expect(res.status).toBe(200);
    expect(captured[0].user_paid_keys).toEqual({ openai: 'STORED-OAI' });
    expect(mockResolveOwnerStoredKeys).toHaveBeenCalledWith(AGENT);
  });

  it('a body key OVERRIDES a stored key for the same provider (precedence)', async () => {
    mockResolveOwnerStoredKeys.mockResolvedValue({ openai: 'STORED-OAI', anthropic: 'STORED-ANT' });
    const { app } = makeApp();
    await authed(app, { user_paid_keys: { openai: 'BODY-OAI' } });
    expect(captured[0].user_paid_keys).toEqual({ openai: 'BODY-OAI', anthropic: 'STORED-ANT' });
  });
});

describe('keyless pre-filter reflects the merged map', () => {
  it('a provider with no env key and no supplied key is keyless; a supplied key removes it', () => {
    expect(router.keylessProviders({})).toContain('openai');
    expect(router.keylessProviders({ openai: 'STORED-OAI' })).not.toContain('openai');
  });
});

describe('no key material leaks', () => {
  it('redacts the request body and never logs or returns a key', async () => {
    const BODY_SECRET = 'sk-BODY-SENTINEL-must-not-appear';
    const STORED_SECRET = 'sk-STORED-SENTINEL-must-not-appear';
    mockResolveOwnerStoredKeys.mockResolvedValue({ anthropic: STORED_SECRET });

    const logs: string[] = [];
    const sinks = ['log', 'warn', 'error', 'info', 'debug'] as const;
    const spies = sinks.map((m) =>
      jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }),
    );

    const { app, seen } = makeApp();
    const res = await authed(app, { user_paid_keys: { openai: BODY_SECRET } });

    spies.forEach((s) => s.mockRestore());

    expect(res.status).toBe(200);
    // the keys were genuinely USED (merged map reached the router)...
    expect(captured[0].user_paid_keys).toEqual({ openai: BODY_SECRET, anthropic: STORED_SECRET });
    // ...the body copy a downstream logger would serialise is redacted...
    expect(seen.req.body.user_paid_keys).toBe('[REDACTED]');
    // ...and neither secret appears in any log line or the HTTP response.
    const allLogs = logs.join('\n');
    expect(allLogs).not.toContain(BODY_SECRET);
    expect(allLogs).not.toContain(STORED_SECRET);
    const resText = JSON.stringify(res.body);
    expect(resText).not.toContain(BODY_SECRET);
    expect(resText).not.toContain(STORED_SECRET);
  });
});
