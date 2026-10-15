/**
 * llm-cost-llm-complete.test.ts — keyless POST /api/v1/llm/complete (auth.ts bypasses it) can no
 * longer reach paid Tier-1 providers on OUR env keys, and a crowd of rotating IPs hits a shared
 * budget. 2026-10-14, public LLM-cost abuse.
 *
 * Before: tier_preference came from the body (default 'auto') and the router falls back to our env
 * key for every Tier-1 adapter, so a keyless caller could reach paid providers, bounded per IP only;
 * and `tier1_only` + any `user_paid_keys` skipped the meter while the router still used our key for the
 * providers the caller did not bring.
 */
jest.mock('../src/db', () => {
  const makeChain = () => {
    const chain: any = {
      select: jest.fn(() => chain), eq: jest.fn(() => chain), is: jest.fn(() => chain), update: jest.fn(() => chain),
      limit: jest.fn(() => Promise.resolve({ data: [], error: null })),
      maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
      single: jest.fn(() => Promise.resolve({ data: { current_repid: 1000 }, error: null })),
      insert: jest.fn(() => Promise.resolve({ error: null })),
    };
    return chain;
  };
  return { db: { from: jest.fn(() => makeChain()), rpc: jest.fn(() => Promise.resolve({ data: null, error: null })) } };
});
jest.mock('../src/providers/router', () => {
  const actual = jest.requireActual('../src/providers/router');
  return { __esModule: true, ...actual, routeRequest: jest.fn() };
});
jest.mock('../src/providers/health', () => ({
  isHealthy: jest.fn(() => true), markFailure: jest.fn(), markSuccess: jest.fn(), markRateLimit: jest.fn(), getAllHealthStates: jest.fn(() => ({})),
}));
jest.mock('../src/billing/caps', () => ({ checkCap: jest.fn(() => Promise.resolve({ allowed: true })), incrementSpend: jest.fn(() => Promise.resolve()) }));
jest.mock('../src/billing/pricing', () => ({
  calculateCost: jest.fn(() => 0.0001),
  PRICING_PER_1M_TOKENS: jest.requireActual('../src/billing/pricing').PRICING_PER_1M_TOKENS,
}));
jest.mock('../src/billing/log-call', () => ({ logLlmCall: jest.fn() }));
jest.mock('../src/utils/tool-call-logger', () => ({ logToolCall: jest.fn() }));
jest.mock('../src/services/anfis-shadow-persist', () => ({ persistShadowDecision: jest.fn() }));
jest.mock('../src/services/email-otp', () => ({
  gateEnabled: jest.fn(() => false),
  meterRun: jest.fn(() => ({ allowed: true, remaining: 99, verified: true, limit: 100 })),
}));
jest.mock('../src/scoring/pipeline', () => ({ runScoreEvent: jest.fn(), NotFoundError: class NotFoundError extends Error {} }));
jest.mock('../src/auth/api-keys', () => ({ ...jest.requireActual('../src/auth/api-keys'), validateAgentApiKey: jest.fn() }));

import request from 'supertest';
import express from 'express';
import { llmRouter, __resetAnonLlmBudget } from '../src/routes/route';
import { routeRequest, envKeyedTier1 } from '../src/providers/router';

const app = express();
app.use(express.json());
app.use('/api', llmRouter);

function fakeRoute() {
  const adapter = {
    name: 'groq', tier: 0, isHealthy: jest.fn().mockResolvedValue(true),
    complete: jest.fn().mockResolvedValue({ answer: 'ok', provider: 'groq', model: 'm', tokensIn: 1, tokensOut: 1, latencyMs: 1 }),
  };
  return {
    adapter, decision: { chosen_provider: 'groq', chosen_tier: '0a', reason: 'priority_healthy', tried: [] },
    staticProvider: 'groq', staticTier: '0a', anfisProvider: 'groq', anfisTier: '0a', anfisConfidence: 0.5,
  };
}
const routeReqOf = (i = 0) => (routeRequest as jest.Mock).mock.calls[i][0];
const excludedOf = (i = 0) => (routeRequest as jest.Mock).mock.calls[i][1] as string[];
const post = (body: Record<string, unknown>, ip = '198.51.100.1', headers: Record<string, string> = {}) =>
  request(app).post('/api/v1/llm/complete').set('X-Real-IP', ip).set(headers).send(body);

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  jest.clearAllMocks();
  __resetAnonLlmBudget();
  for (const k of ['REPID_API_KEYS', 'LLM_ANON_GLOBAL_PER_MIN', 'LLM_ANON_GLOBAL_DAILY', 'GROQ_API_KEY']) saved[k] = process.env[k];
  process.env.GROQ_API_KEY = 'test-groq-key-not-real'; // the mocked tier-0 adapter needs a key to resolve
  process.env.REPID_API_KEYS = 'envshared:pro';
  delete process.env.LLM_ANON_GLOBAL_PER_MIN;
  delete process.env.LLM_ANON_GLOBAL_DAILY;
  (routeRequest as jest.Mock).mockResolvedValue(fakeRoute());
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  jest.restoreAllMocks();
});

describe('keyless callers stay on the free tier', () => {
  it.each(['auto', 'tier0_first', 'tier1_only', undefined])('tier_preference %s with no key and no own keys is routed tier0_only', async (pref) => {
    const res = await post({ prompt: 'hi', ...(pref ? { tier_preference: pref } : {}) });
    expect(res.status).toBe(200);
    expect(routeReqOf().tier_preference).toBe('tier0_only');
  });

  it('a keyless BYOK run (tier1_only + its own openai key) cannot reach a Tier-1 provider on OUR key', async () => {
    await post({ prompt: 'hi', tier_preference: 'tier1_only', user_paid_keys: { openai: 'caller-own-key' } });
    expect(routeReqOf().tier_preference).toBe('tier1_only');
    const excluded = excludedOf();
    for (const name of envKeyedTier1({ openai: 'caller-own-key' })) expect(excluded).toContain(name);
    expect(envKeyedTier1({ openai: 'caller-own-key' })).not.toContain('openai');
  });

  it('a caller with a valid env key keeps its tier preference (unchanged behaviour)', async () => {
    await post({ prompt: 'hi', tier_preference: 'auto' }, '198.51.100.1', { Authorization: 'Bearer envshared' });
    expect(routeReqOf().tier_preference).toBe('auto');
  });
});

describe('the shared keyless budget (rotating IPs)', () => {
  it('trips across IPs: 429 with a named reason, before any routing; logged once', async () => {
    process.env.LLM_ANON_GLOBAL_PER_MIN = '2';
    const codes = [];
    for (let i = 1; i <= 4; i++) codes.push((await post({ prompt: 'hi' }, `203.0.113.${i}`)));
    expect(codes.slice(0, 2).map((r) => r.status)).toEqual([200, 200]);
    for (const r of codes.slice(2)) {
      expect(r.status).toBe(429);
      expect(r.body).toMatchObject({ error: 'free_tier_busy', reason: 'global_minute_budget_spent' });
    }
    expect((routeRequest as jest.Mock).mock.calls).toHaveLength(2);
    const loud = (console.error as jest.Mock).mock.calls.filter((c) => /\[llm\/complete\] SHARED BUDGET SPENT/.test(String(c[0])));
    expect(loud).toHaveLength(1);
  });

  it('the daily budget has its own reason', async () => {
    process.env.LLM_ANON_GLOBAL_PER_MIN = 'off';
    process.env.LLM_ANON_GLOBAL_DAILY = '1';
    await post({ prompt: 'hi' }, '203.0.113.9');
    const res = await post({ prompt: 'hi' }, '203.0.113.10');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'free_tier_exhausted', reason: 'global_daily_budget_spent' });
  });

  it('keyed callers and keyless BYOK runs do not spend it; normal traffic is unaffected', async () => {
    process.env.LLM_ANON_GLOBAL_PER_MIN = '1';
    expect((await post({ prompt: 'hi' }, '203.0.113.20', { Authorization: 'Bearer envshared' })).status).toBe(200);
    expect((await post({ prompt: 'hi', tier_preference: 'tier1_only', user_paid_keys: { openai: 'own' } }, '203.0.113.21')).status).toBe(200);
    expect((await post({ prompt: 'hi' }, '203.0.113.22')).status).toBe(200); // the one keyless unit
    expect((await post({ prompt: 'hi' }, '203.0.113.23')).status).toBe(429);
  });
});
