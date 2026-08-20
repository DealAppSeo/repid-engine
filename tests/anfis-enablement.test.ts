/**
 * ANFIS broker enablement — acceptance tests. STAGING artifact.
 *
 * These prove the broker's enablement-critical behaviors WITHOUT flipping any
 * live flag. They exercise the real llmRouter (src/routes/route.ts) and — for
 * the routing-reorder case — the real routeRequest (src/providers/router.ts),
 * with the provider chain + db + billing stubbed exactly as the existing suite
 * does (see tests/f2-authz-envkey.test.ts, tests/api-keys/issuance.test.ts).
 *
 * The 5 acceptance criteria:
 *  (a) no-leak            — a 200 completion + every log line is free of any
 *                           provider-key substring; user_paid_keys never echoed.
 *  (b) server-side inject — a request with NO caller key still completes (the
 *                           engine injects the provider key from its own env).
 *  (c) anfis-present      — the response carries router_decision AND a row is
 *                           written to anfis_routing_logs.
 *  (d) live-routing       — with ROUTER_STRICT_COST_ORDER=false a stubbed ANFIS
 *                           recommendation reorders the chosen provider (and with
 *                           strict-order=true it does NOT — the shadow invariant).
 *  (e) job-token-auth     — valid llm_complete-scoped key → 200; missing scope
 *                           → 403; shared env key targeting a specific agent → 403.
 */

// ---- module mocks (hoisted; all capture state lives INSIDE the factories) ----

jest.mock('../src/db', () => {
  const anfisInserts: any[] = [];
  let rpcResult: any = { data: null, error: null };
  const makeChain = (table: string) => {
    const chain: any = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      is: jest.fn(() => chain),
      limit: jest.fn(() => Promise.resolve({ data: [], error: null })),
      maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
      single: jest.fn(() => Promise.resolve({ data: { current_repid: 1000 }, error: null })),
      update: jest.fn(() => chain),
      insert: jest.fn((row: any) => {
        if (table === 'anfis_routing_logs') anfisInserts.push(row);
        return Promise.resolve({ error: null });
      }),
    };
    return chain;
  };
  return {
    db: {
      from: jest.fn((t: string) => makeChain(t)),
      rpc: jest.fn(() => Promise.resolve(rpcResult)),
      // test-only handles
      __anfisInserts: anfisInserts,
      __setRpc: (r: any) => { rpcResult = r; },
      __resetRpc: () => { rpcResult = { data: null, error: null }; },
    },
  };
});

// Router: keep the REAL implementation available (for the routing-reorder test),
// but replace the exported routeRequest with a jest.fn the app-level tests drive.
jest.mock('../src/providers/router', () => {
  const actual = jest.requireActual('../src/providers/router');
  return { __esModule: true, ...actual, routeRequest: jest.fn() };
});

jest.mock('../src/providers/health', () => ({
  isHealthy: jest.fn(() => true),
  markFailure: jest.fn(),
  markSuccess: jest.fn(),
  markRateLimit: jest.fn(),
  getAllHealthStates: jest.fn(() => ({})),
}));

jest.mock('../src/billing/caps', () => ({
  checkCap: jest.fn(() => Promise.resolve({ allowed: true })),
  incrementSpend: jest.fn(() => Promise.resolve()),
}));

jest.mock('../src/billing/pricing', () => ({
  calculateCost: jest.fn(() => 0.0001),
}));

jest.mock('../src/billing/log-call', () => ({
  logLlmCall: jest.fn(),
}));

jest.mock('../src/utils/tool-call-logger', () => ({
  logToolCall: jest.fn(),
}));

jest.mock('../src/services/anfis-shadow-persist', () => ({
  persistShadowDecision: jest.fn(),
}));

jest.mock('../src/services/email-otp', () => ({
  gateEnabled: jest.fn(() => false),
  meterRun: jest.fn(() => ({ allowed: true, remaining: 99, verified: true, limit: 100 })),
}));

jest.mock('../src/scoring/pipeline', () => ({
  runScoreEvent: jest.fn(() => Promise.resolve({
    score_event_id: 'se-1', hal_score: 0.9, hal_decision: 'pass',
    repid_delta_applied: 5, new_repid: 1005, zk_proof_triggered: false,
  })),
  NotFoundError: class NotFoundError extends Error {},
}));

jest.mock('../src/auth/api-keys', () => ({
  validateAgentApiKey: jest.fn(),
}));

import request from 'supertest';
import express from 'express';
import { llmRouter } from '../src/routes/route';
import { routeRequest } from '../src/providers/router';
import { validateAgentApiKey } from '../src/auth/api-keys';
import { logLlmCall } from '../src/billing/log-call';
import { db } from '../src/db';

const app = express();
app.use(express.json());
app.use('/api', llmRouter);

// Deliberately NOT shaped like a real provider key (no sk-/ts_live_ prefix) so
// secret scanners don't flag this test's own sentinel; the assertions match the
// unique "SUPERSECRET" substring, which is all the no-leak check needs.
const KEY_CANARY = 'USER-PAID-SUPERSECRET-CANARY-token';
const SERVER_ENV_KEY = 'server-injected-groq-key';

// A fake tier-0 groq adapter whose key the engine resolves from GROQ_API_KEY.
function makeFakeAdapter() {
  return {
    name: 'groq',
    tier: 0,
    isHealthy: jest.fn().mockResolvedValue(true),
    complete: jest.fn().mockResolvedValue({
      answer: 'The capital of France is Paris.',
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      tokensIn: 12,
      tokensOut: 8,
      latencyMs: 42,
    }),
  };
}

function fakeRouteResult(adapter: any) {
  return {
    adapter,
    decision: { chosen_provider: 'groq', chosen_tier: '0a', reason: 'priority_healthy', tried: [] },
    staticProvider: 'groq',
    staticTier: '0a',
    anfisProvider: 'cerebras',
    anfisTier: '0a',
    anfisConfidence: 0.8,
  };
}

const savedEnv: Record<string, string | undefined> = {};
function saveEnv(...keys: string[]) { for (const k of keys) savedEnv[k] = process.env[k]; }
function restoreEnv() { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }

beforeEach(() => {
  jest.clearAllMocks();
  (db as any).__anfisInserts.length = 0;
  (db as any).__resetRpc();
  saveEnv('GROQ_API_KEY', 'REPID_API_KEYS', 'ROUTER_STRICT_COST_ORDER', 'DEEPSEEK_API_KEY', 'ROUTER_ANFIS_SHADOW');
  process.env.GROQ_API_KEY = SERVER_ENV_KEY;
  process.env.REPID_API_KEYS = 'envshared:pro';
});

afterEach(() => restoreEnv());

describe('ANFIS enablement — broker acceptance', () => {
  // (a) --------------------------------------------------------------------
  it('(a) no-leak: 200 completion + logs never echo a provider key / user_paid_keys', async () => {
    const adapter = makeFakeAdapter();
    (routeRequest as jest.Mock).mockResolvedValue(fakeRouteResult(adapter));

    const res = await request(app)
      .post('/api/v1/llm/complete')
      .send({ prompt: 'What is the capital of France?', user_paid_keys: { anthropic: KEY_CANARY } });

    expect(res.status).toBe(200);
    expect(res.body.answer).toContain('Paris');

    // The canary must not appear in the response body...
    expect(JSON.stringify(res.body)).not.toContain('SUPERSECRET');
    // ...nor in any billing log line...
    const loggedLines = (logLlmCall as jest.Mock).mock.calls.map((c) => JSON.stringify(c[0]));
    for (const line of loggedLines) expect(line).not.toContain('SUPERSECRET');
    // ...nor in any anfis_routing_logs row...
    for (const row of (db as any).__anfisInserts) expect(JSON.stringify(row)).not.toContain('SUPERSECRET');
    // ...and the server env key must never leak into the response either.
    expect(JSON.stringify(res.body)).not.toContain(SERVER_ENV_KEY);
  });

  // (b) --------------------------------------------------------------------
  it('(b) server-side injection: no caller key still completes (engine injects the provider key)', async () => {
    const adapter = makeFakeAdapter();
    (routeRequest as jest.Mock).mockResolvedValue(fakeRouteResult(adapter));

    const res = await request(app)
      .post('/api/v1/llm/complete')
      .send({ prompt: 'What is the capital of France?' }); // NO Authorization, NO user_paid_keys

    expect(res.status).toBe(200);
    expect(res.body.answer).toContain('Paris');
    // Proof of server-side injection: the adapter was invoked with the engine's own env key.
    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(adapter.complete.mock.calls[0][0].apiKey).toBe(SERVER_ENV_KEY);
  });

  // (c) --------------------------------------------------------------------
  it('(c) anfis-decision-present: response carries router_decision + a row hits anfis_routing_logs', async () => {
    const adapter = makeFakeAdapter();
    (routeRequest as jest.Mock).mockResolvedValue(fakeRouteResult(adapter));

    const res = await request(app)
      .post('/api/v1/llm/complete')
      .send({ prompt: 'What is the capital of France?', task_hint: 'factual' });

    expect(res.status).toBe(200);
    expect(res.body.router_decision).toBeDefined();
    expect(res.body.router_decision.chosen_provider).toBe('groq');

    const inserts = (db as any).__anfisInserts;
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    const row = inserts[0];
    expect(row.static_provider).toBe('groq');
    expect(row.anfis_provider).toBe('cerebras');
    expect(Array.isArray(row.verified_by)).toBe(true);
    expect(row.verified_by.length).toBeGreaterThanOrEqual(2);
  });

  // (d) --------------------------------------------------------------------
  describe('(d) live-routing: ROUTER_STRICT_COST_ORDER gates ANFIS reorder', () => {
    // Use the REAL routeRequest here (health/caps/db are the mocked deps).
    const actualRouter = jest.requireActual('../src/providers/router');
    // >200 chars, no low-complexity keywords → avoids the SLM fast-path so ANFIS reorder applies.
    const longPrompt =
      'Provide a thorough architectural comparison of recursive STARK aggregation ' +
      'versus per-action Groth16 leaves for an on-chain reputation rollup, and explain ' +
      'the trade-offs in prover time, verifier cost, and anchoring latency for each design choice here.';

    beforeEach(() => {
      // ANFIS performance-lookup RPC recommends deepseek (fast, cheap, high hit-rate).
      (db as any).__setRpc({
        data: [{ provider: 'deepseek', avg_latency_ms: 100, avg_cost_usdc: 10, hit_rate: 0.95 }],
        error: null,
      });
    });

    it('strict-order=false → ANFIS recommendation reorders the chosen provider (deepseek over static groq)', async () => {
      process.env.ROUTER_STRICT_COST_ORDER = 'false';
      const out = await actualRouter.routeRequest({ prompt: longPrompt, tier_preference: 'auto' }, []);
      expect(out.staticProvider).toBe('groq');          // cost-ordered static pick is groq
      expect(out.decision.chosen_provider).toBe('deepseek'); // ANFIS reordered it to the front
    });

    it('strict-order=true (default) → ANFIS does NOT reorder; the cost-ordered pick stands (groq)', async () => {
      process.env.ROUTER_STRICT_COST_ORDER = 'true';
      const out = await actualRouter.routeRequest({ prompt: longPrompt, tier_preference: 'auto' }, []);
      expect(out.decision.chosen_provider).toBe('groq');
    });
  });

  // (e) --------------------------------------------------------------------
  describe('(e) job-token-auth: scope + agent binding enforced', () => {
    beforeEach(() => {
      const adapter = makeFakeAdapter();
      (routeRequest as jest.Mock).mockResolvedValue(fakeRouteResult(adapter));
    });

    it('valid llm_complete-scoped key bound to the target agent → 200', async () => {
      (validateAgentApiKey as jest.Mock).mockResolvedValue({ agent_id: 'agent-1', scopes: ['llm_complete'] });
      const res = await request(app)
        .post('/api/v1/llm/complete')
        .set('Authorization', 'Bearer ts_live_agentkey')
        .send({ prompt: 'What is the capital of France?', agent_id: 'agent-1' });
      expect(res.status).toBe(200);
      expect(res.body.answer).toContain('Paris');
    });

    it("scoped key WITHOUT 'llm_complete' scope → 403", async () => {
      (validateAgentApiKey as jest.Mock).mockResolvedValue({ agent_id: 'agent-1', scopes: ['contracts:read'] });
      const res = await request(app)
        .post('/api/v1/llm/complete')
        .set('Authorization', 'Bearer ts_live_agentkey')
        .send({ prompt: 'hi', agent_id: 'agent-1' });
      expect(res.status).toBe(403);
    });

    it('shared REPID_API_KEYS env key targeting a specific agent_id → 403 (no impersonation)', async () => {
      const res = await request(app)
        .post('/api/v1/llm/complete')
        .set('Authorization', 'Bearer envshared')
        .send({ prompt: 'hi', agent_id: 'agent-1' });
      expect(res.status).toBe(403);
    });
  });
});
