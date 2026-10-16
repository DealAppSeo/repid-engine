/**
 * Family switching F1 + F2 (E:\dev\sprints\2026-10-15\VISION_TO_E2E_LOOP.md).
 *
 * F1: a request names a registered model; the router uses it when healthy; an unservable
 *     pin falls back with the reason RECORDED (response, tool-call log, console), and an
 *     unknown or unroutable pin is REFUSED. Before this, `model_override` was declared on
 *     RouteRequest and never read: a pin was silently ignored.
 * F2: the model the vendor says served is what the call log, the tool-call log, the broker
 *     response and the OpenAI-compatible headers report. Before this, every one of them
 *     recorded the configured id, and the compat route read a field the broker never sent.
 *
 * Adapters are mocked at the vendor call (prototype `complete`); everything between the HTTP
 * request and that call is the real code: compat route -> HTTP -> broker -> router -> adapter.
 */
process.env.OPENAI_COMPAT_ENABLED = 'true'; // read at module load by openai-compat.ts

jest.mock('../src/db', () => {
  const makeChain = () => {
    const chain: any = {
      select: jest.fn(() => chain), eq: jest.fn(() => chain), is: jest.fn(() => chain), update: jest.fn(() => chain),
      limit: jest.fn(() => Promise.resolve({ data: [], error: null })),
      maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
      insert: jest.fn(() => Promise.resolve({ error: null })),
    };
    return chain;
  };
  return { db: { from: jest.fn(() => makeChain()), rpc: jest.fn(() => Promise.resolve({ data: null, error: null })) } };
});
jest.mock('../src/providers/health', () => ({
  isHealthy: jest.fn(() => true), markFailure: jest.fn(), markSuccess: jest.fn(), markRateLimit: jest.fn(), getAllHealthStates: jest.fn(() => ({})),
}));
jest.mock('../src/billing/caps', () => ({ checkCap: jest.fn(() => Promise.resolve({ allowed: true })), incrementSpend: jest.fn(() => Promise.resolve()) }));
jest.mock('../src/billing/pricing', () => ({ ...jest.requireActual('../src/billing/pricing'), calculateCost: jest.fn(() => 0) }));
jest.mock('../src/billing/log-call', () => ({ logLlmCall: jest.fn() }));
jest.mock('../src/utils/tool-call-logger', () => ({ logToolCall: jest.fn() }));
jest.mock('../src/services/anfis-shadow-persist', () => ({ persistShadowDecision: jest.fn() }));
jest.mock('../src/services/email-otp', () => ({ gateEnabled: jest.fn(() => false), meterRun: jest.fn() }));
jest.mock('../src/scoring/pipeline', () => ({ runScoreEvent: jest.fn(), NotFoundError: class NotFoundError extends Error {} }));

import request from 'supertest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const { llmRouter, __resetAnonLlmBudget } = require('../src/routes/route');
const { openaiCompatRouter } = require('../src/routes/v1/openai-compat');
const { routeRequest, resolvePin, PinRefusedError } = require('../src/providers/router');
const { GroqAdapter } = require('../src/providers/groq');
const { DeepSeekAdapter } = require('../src/providers/deepseek');
const { isHealthy } = require('../src/providers/health');
const { logLlmCall } = require('../src/billing/log-call');
const { logToolCall } = require('../src/utils/tool-call-logger');
const { calculateCost } = require('../src/billing/pricing');

const app = express();
app.use(express.json());
app.use('/api', llmRouter);
app.use('/v1', openaiCompatRouter);

// Registry ids (src/decisioning/family-registry.ts) so the family is provable, not 'unverified'.
const GROQ_CONFIGURED = 'openai/gpt-oss-20b'; // family openai
const GROQ_SERVED = 'llama-3.3-70b-versatile'; // family llama

const vendor = (provider: string, requested: string, served?: string) => ({
  answer: 'ok', tokensIn: 3, tokensOut: 2, latencyMs: 5, provider, model: requested,
  rawResponse: served ? { model: served } : {},
});
const toolLog = (toolName: string) =>
  (logToolCall as jest.Mock).mock.calls.map((c) => c[0]).filter((p) => p.toolName === toolName);

let groq: jest.SpyInstance;
let deepseek: jest.SpyInstance;
let server: Server;
const savedEnv: Record<string, string | undefined> = {};

beforeAll((done) => {
  server = app.listen(0, '127.0.0.1', () => {
    process.env.INTERNAL_SELF_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});
afterAll((done) => {
  delete process.env.INTERNAL_SELF_URL;
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  __resetAnonLlmBudget();
  for (const k of ['GROQ_API_KEY', 'DEEPSEEK_API_KEY']) savedEnv[k] = process.env[k];
  process.env.GROQ_API_KEY = 'test-groq-key-not-real';
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-key-not-real';
  (isHealthy as jest.Mock).mockImplementation(() => true);
  groq = jest.spyOn(GroqAdapter.prototype, 'complete').mockResolvedValue(vendor('groq', GROQ_CONFIGURED, GROQ_SERVED));
  deepseek = jest.spyOn(DeepSeekAdapter.prototype, 'complete').mockResolvedValue(vendor('deepseek', 'deepseek-chat', 'deepseek-chat'));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
});

describe('resolvePin: registry-only, refuses rather than guesses', () => {
  it('resolves a registered model to the providers in this chain that serve it', () => {
    expect(resolvePin('deepseek-chat')).toEqual({ model: 'deepseek-chat', family: 'deepseek', providers: ['deepseek'] });
  });

  it('refuses a model the registry does not know', () => {
    expect(() => resolvePin('gpt-9-imaginary')).toThrow(PinRefusedError);
    expect(() => resolvePin('gpt-9-imaginary')).toThrow(/not in the family registry/);
  });

  it('refuses a registered model no provider in this chain serves (mistral has no engine adapter)', () => {
    expect(() => resolvePin('mistral-small-latest')).toThrow(/none of those providers is in this deployment's routing chain/);
  });

  it('refuses an ambiguous seed row rather than first-matching a family', () => {
    expect(() => resolvePin('hf/deepseek-r1-qwen-32b')).toThrow(PinRefusedError);
  });
});

describe('routeRequest with a pin (two mocked adapters: pinned deepseek, fallback groq)', () => {
  const req = { prompt: 'test', tier_preference: 'tier0_first' as const };

  it('pinned and healthy: the pinned model is chosen and named', async () => {
    const r = await routeRequest({ ...req, model_override: 'deepseek-chat' });
    expect(r.adapter?.name).toBe('deepseek');
    expect(r.model).toBe('deepseek-chat');
    expect(r.decision.reason).toBe('pinned');
    expect(r.decision.pin).toEqual({ model_requested: 'deepseek-chat', family: 'deepseek', outcome: 'honoured' });
  });

  it('pinned and unhealthy: falls back, and the fallback is recorded, never silent', async () => {
    (isHealthy as jest.Mock).mockImplementation((name: string) => name !== 'deepseek');
    const r = await routeRequest({ ...req, model_override: 'deepseek-chat' });
    expect(r.adapter?.name).toBe('groq');
    expect(r.model).toBeUndefined(); // the fallback provider uses its own default
    expect(r.decision.pin).toEqual({
      model_requested: 'deepseek-chat', family: 'deepseek', outcome: 'fallback', fallback_reason: 'deepseek: unhealthy',
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('PIN FALLBACK model=deepseek-chat'));
  });

  it('a pin never bypasses tier_preference: a tier0_only caller cannot pin a paid tier-1 model', async () => {
    const r = await routeRequest({
      prompt: 'test', tier_preference: 'tier0_only', model_override: 'claude-haiku-4-5-20251001', user_paid_keys: { anthropic: 'k' },
    });
    expect(r.adapter?.tier).toBe(0);
    expect(r.decision.pin?.outcome).toBe('fallback');
    expect(r.decision.pin?.fallback_reason).toBe('anthropic: tier_preference tier0_only');
  });

  it('an unregistered pin is refused, not routed', async () => {
    await expect(routeRequest({ ...req, model_override: 'gpt-9-imaginary' })).rejects.toThrow(PinRefusedError);
  });

  it('no pin: the decision carries no pin and the result names no model', async () => {
    const r = await routeRequest(req);
    expect(r.decision).toStrictEqual({ chosen_provider: 'groq', chosen_tier: '0a', reason: 'priority_healthy', tried: [] });
    expect('model' in r).toBe(false);
  });
});

describe('POST /api/v1/llm/complete: pin end to end', () => {
  const post = (body: Record<string, unknown>) => request(app).post('/api/v1/llm/complete').send({ prompt: '2+2', ...body });

  it('honours a healthy pin and reports model, family and decision', async () => {
    const res = await post({ model: 'deepseek-chat' });
    expect(res.status).toBe(200);
    expect(deepseek).toHaveBeenCalledWith(expect.objectContaining({ model: 'deepseek-chat' }));
    expect(groq).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      model_requested: 'deepseek-chat', model_served: 'deepseek-chat', family: 'deepseek', decision: 'pinned',
      router_decision: { reason: 'pinned', pin: { outcome: 'honoured' } },
    });
  });

  it('records the fallback in the response and the tool-call log when the pin is unhealthy', async () => {
    (isHealthy as jest.Mock).mockImplementation((name: string) => name !== 'deepseek');
    const res = await post({ model: 'deepseek-chat' });
    expect(res.status).toBe(200);
    expect(deepseek).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      model_requested: 'deepseek-chat', model_served: GROQ_SERVED, family: 'llama', decision: 'pin_fallback',
      router_decision: { pin: { outcome: 'fallback', fallback_reason: 'deepseek: unhealthy' } },
    });
    // The log carries model asked, model served, family and reason.
    expect(toolLog('provider-call')[0].toolInput).toMatchObject({
      provider: 'groq', model_requested: 'deepseek-chat', model_served: GROQ_SERVED, family: 'llama',
      decision: 'pin_fallback', fallback_reason: 'deepseek: unhealthy',
    });
    expect(toolLog('provider-selection')[0].toolInput.pin).toMatchObject({ outcome: 'fallback' });
  });

  it('a pinned call that fails at the vendor is retried as a recorded fallback, and its failure row names the pin', async () => {
    deepseek.mockRejectedValue(new Error('DeepSeek HTTP 404: model not found'));
    const res = await post({ model: 'deepseek-chat' });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('pin_fallback');
    expect(res.body.router_decision.pin.fallback_reason).toMatch(/^deepseek: excluded/);
    expect(logLlmCall).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deepseek', model: 'deepseek-chat', status: 'failed' }));
  });

  it('refuses an unregistered model with 400 and calls no provider', async () => {
    const res = await post({ model: 'gpt-9-imaginary' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('model_not_pinnable');
    expect(res.body.message).toMatch(/not in the family registry/);
    expect(groq).not.toHaveBeenCalled();
    expect(deepseek).not.toHaveBeenCalled();
  });

  it('refuses a non-string model with 400', async () => {
    const res = await post({ model: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('model_not_pinnable');
  });
});

describe('served-model truth (F2): provider answers X when configured Y', () => {
  it('the call log, the tool-call log and the response say X; cost stays on Y', async () => {
    const res = await request(app).post('/api/v1/llm/complete').send({ prompt: '2+2' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model_requested: GROQ_CONFIGURED, model_served: GROQ_SERVED, family: 'llama', decision: 'routed' });
    expect(logLlmCall).toHaveBeenCalledWith(expect.objectContaining({ provider: 'groq', model: GROQ_SERVED, status: 'success' }));
    expect(toolLog('provider-call')[0].toolInput).toMatchObject({ model_served: GROQ_SERVED, family: 'llama' });
    expect(calculateCost).toHaveBeenCalledWith('groq', GROQ_CONFIGURED, 3, 2);
  });

  it('the OpenAI-compatible route exposes X in X-HyperDAG-Model and its registry family in X-HyperDAG-Family', async () => {
    const res = await request(app).post('/v1/chat/completions').send({ model: 'hyperdag-auto', messages: [{ role: 'user', content: '2+2' }] });
    expect(res.status).toBe(200);
    expect(res.headers['x-hyperdag-model']).toBe(GROQ_SERVED);
    expect(res.headers['x-hyperdag-family']).toBe('llama');
    expect(res.headers['access-control-expose-headers']).toContain('X-HyperDAG-Model');
  });

  it('falls back to the requested id when the vendor names no model', async () => {
    groq.mockResolvedValue(vendor('groq', GROQ_CONFIGURED));
    const res = await request(app).post('/api/v1/llm/complete').send({ prompt: '2+2' });
    expect(res.body.model_served).toBe(GROQ_CONFIGURED);
    expect(res.body.family).toBe('openai');
  });
});

describe('no pin: behaves as before', () => {
  it('the adapter call, the router decision and the selection log are exactly the pre-pin shape', async () => {
    const res = await request(app).post('/api/v1/llm/complete').send({ prompt: '2+2' });
    expect(res.status).toBe(200);
    // No `model` key at all: the adapter picks its own default, as before.
    expect(groq).toHaveBeenCalledTimes(1);
    expect(groq.mock.calls[0][0]).toStrictEqual({ prompt: '2+2', maxTokens: undefined, temperature: undefined, apiKey: 'test-groq-key-not-real' });
    // Exactly the pre-pin decision keys, no `pin`. (`reason` reads fallback_after_failure here,
    // as it did before: route.ts seeds `tried` with the keyless providers it excluded.)
    expect(Object.keys(res.body.router_decision).sort()).toEqual(['chosen_provider', 'chosen_tier', 'reason', 'tried']);
    expect(res.body.router_decision).toMatchObject({ chosen_provider: 'groq', chosen_tier: '0a' });
    expect(toolLog('provider-selection')[0].toolInput).toStrictEqual({ tier_preference: 'auto' });
    // Every pre-existing field is still there with the same meaning; the four model fields are additive.
    expect(Object.keys(res.body).sort()).toEqual([
      'answer', 'cost_estimate_usd', 'decision', 'family', 'hal_evaluation', 'latency_ms', 'model_requested', 'model_served',
      'provider', 'router_decision', 'tier', 'tier_used', 'tokens_in', 'tokens_out',
    ]);
    expect(res.body).toMatchObject({ answer: 'ok', provider: 'groq', tier: 0, tier_used: '0a', tokens_in: 3, tokens_out: 2, latency_ms: 5, cost_estimate_usd: 0, hal_evaluation: null });
  });
});
