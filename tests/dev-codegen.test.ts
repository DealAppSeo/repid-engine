/**
 * POST /api/v1/dev/codegen — the dev-only relay from a code spec to ONE free LLM provider.
 *
 * Every test here drives the REAL app (src/index.ts) through supertest, so the real middleware
 * chain runs — the real SQL-keyword body sanitizer, the real authMiddleware, the real router. A
 * suite that mounted the router on a bare express() would prove the handler and say nothing about
 * the two things the route's safety actually depends on: that the sanitizer lets a base64 spec
 * through, and that auth sits in front.
 *
 * WHAT IS STUBBED, AND WHAT THAT MEANS. Only the network boundary (`globalThis.fetch`) and the
 * database module. The REAL GroqAdapter / CerebrasAdapter run, so the URL and Authorization header
 * asserted below are the ones production would send — what is NOT proven is that the vendor accepts
 * them. No call here ever leaves the process.
 *
 *   VERIFIED    flag-off 404 · no-key 401 · agent-key 403 · `;` `--` `SELECT ` round trip · SSRF
 *               surface closed · free-only provider choice · size cap · error mapping · no
 *               fabricated success · static import/URL allowlist.
 *   NOT_CHECKED a real round trip to a real provider (needs a real key; see the it.todo at the end).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// src/config.ts throws without these and importing the real app pulls it in. Placeholders only —
// the db module is mocked below, so nothing here reaches a network.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

const AGENT_UUID = '11111111-2222-4333-8444-555555555555';

// The db module records every table it is asked for, so "no DB touch" is an assertion, not a hope.
jest.mock('../src/db', () => {
  const touched: string[] = [];
  (globalThis as any).__DEVCG_DB__ = touched;
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    ilike: () => chain,
    in: () => chain,
    is: () => chain,
    order: () => chain,
    limit: async () => ({ data: [], error: null }),
    insert: async () => ({ data: null, error: null }),
    upsert: async () => ({ data: null, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
  };
  return {
    db: {
      from: (table: string) => {
        touched.push(table);
        return chain;
      },
      rpc: async (fn: string) => {
        touched.push(`rpc:${fn}`);
        return { data: null, error: null };
      },
    },
  };
});

// A key that resolves to a registered AGENT (the database-backed kind), and nothing else.
jest.mock('../src/auth/api-keys', () => ({
  ...jest.requireActual('../src/auth/api-keys'),
  validateAgentApiKey: jest.fn(async (key: string) =>
    key === 'agent-bound-key' ? { agent_id: '11111111-2222-4333-8444-555555555555', scopes: [] } : null,
  ),
}));

import express from 'express';
import request from 'supertest';
import app from '../src/index';
import devCodegenRouter, {
  CANDIDATE_PROVIDER_NAMES,
  MAX_FIELD_BYTES,
  MAX_IN_FLIGHT,
  selectProvider,
  type Candidate,
} from '../src/routes/v1/dev-codegen';
import { isFreeProvider } from '../src/billing/free-providers';
import { bucketStore } from '../src/middleware/rate-limit';

const PATH = '/api/v1/dev/codegen';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';

const ENV_KEYS = [
  'DEV_CODEGEN_ENABLED', 'REPID_API_KEYS', 'AGENT_LOG_MIN_LEVEL', 'GROQ_API_KEY', 'CEREBRAS_API_KEY',
  'GROQ_MODEL', 'CEREBRAS_MODEL', 'LOCAL_LLM_BASE_URL', 'OPENAI_BASE_URL',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'COHERE_API_KEY',
] as const;
const ENV_SNAPSHOT: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ENV_SNAPSHOT[k] = process.env[k];

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

// The production sanitizer's banned substrings (src/index.ts), used only to assert about INPUTS.
const FORBIDDEN = ['SELECT ', 'DROP ', 'INSERT ', 'UPDATE ', 'DELETE ', '--', ';'];

// A spec that the sanitizer would reject if it travelled raw: `;`, `--`, and every banned keyword.
const NASTY_SPEC = [
  '-- migration: backfill active users',
  'SELECT id, name FROM users WHERE active = 1;',
  'DROP TABLE tmp; INSERT INTO t VALUES (1); UPDATE t SET y = 2; DELETE FROM z;',
  'export function f(): number { return 1; } // ; --',
].join('\n');

function groqOk(content = 'export const answer = 42;', finish: string | null = 'stop'): Response {
  const choice: Record<string, unknown> = { message: { content } };
  if (finish !== null) choice['finish_reason'] = finish;
  return new Response(
    JSON.stringify({ choices: [choice], usage: { prompt_tokens: 12, completion_tokens: 8 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

let fetchSpy: jest.SpyInstance;
const calls = (): Array<{ url: string; init: any }> =>
  fetchSpy.mock.calls.map((c) => ({ url: String(c[0]), init: c[1] }));
const sentPrompt = (i = 0): string => JSON.parse(calls()[i]!.init.body).messages[0].content;
const dbTouches = (): string[] =>
  // `trinity_system_config` is the emergency-halt poller's own timer (src/services/emergency-halt.ts),
  // not something a request causes. Every other table is a request's doing.
  ((globalThis as any).__DEVCG_DB__ as string[]).filter((t) => t !== 'trinity_system_config');

function post(body: unknown, key: string | null = 'op-key') {
  let r = request(app).post(PATH);
  if (key !== null) r = r.set('Authorization', `Bearer ${key}`);
  return r.send(body as object);
}

beforeAll(() => {
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

beforeEach(() => {
  process.env.DEV_CODEGEN_ENABLED = 'true';
  process.env.REPID_API_KEYS = 'op-key:pro';
  // A valid key logs 'info' to trinity_agent_logs; raising the floor keeps that write out of the
  // way so a request that touches NO table can be asserted as such.
  process.env.AGENT_LOG_MIN_LEVEL = 'error';
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.CEREBRAS_API_KEY = 'test-cerebras-key';
  for (const k of ['GROQ_MODEL', 'CEREBRAS_MODEL', 'LOCAL_LLM_BASE_URL', 'OPENAI_BASE_URL',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'COHERE_API_KEY']) {
    delete process.env[k];
  }
  (globalThis as any).__DEVCG_DB__.length = 0;
  // The app's global per-IP limiter (60/min) would otherwise start answering 429 `rate_limited`
  // part-way through this file's ~100 requests, and a test would then pass or fail on the wrong thing.
  bucketStore.__reset();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => groqOk());
});

afterEach(() => {
  fetchSpy.mockRestore();
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (ENV_SNAPSHOT[k] === undefined) delete process.env[k];
    else process.env[k] = ENV_SNAPSHOT[k];
  }
  jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('the flag: off by default, exact string only', () => {
  it('unset → 404, and nothing downstream runs (no provider call, no table touched)', async () => {
    delete process.env.DEV_CODEGEN_ENABLED;
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
    expect(r.body).not.toHaveProperty('output');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dbTouches()).toEqual([]);
  });

  it.each(['false', 'TRUE', 'True', '1', 'yes', ' true', 'true ', ''])(
    'DEV_CODEGEN_ENABLED=%j is NOT "true" → 404, no provider call',
    async (value) => {
      process.env.DEV_CODEGEN_ENABLED = value;
      const r = await post({ spec_b64: b64('make a thing') });
      expect(r.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('flag off + NO key → 401, not 404: a keyless prober cannot tell whether the flag is on', async () => {
    delete process.env.DEV_CODEGEN_ENABLED;
    const r = await post({ spec_b64: b64('make a thing') }, null);
    expect(r.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('authentication: after authMiddleware, not on the bypass list', () => {
  it('flag on + NO key → 401, and the provider is never called', async () => {
    const r = await post({ spec_b64: b64('make a thing') }, null);
    expect(r.status).toBe(401);
    expect(r.body).not.toHaveProperty('output');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dbTouches()).toEqual([]);
  });

  it('an empty x-api-key is no key → 401', async () => {
    const r = await request(app).post(PATH).set('x-api-key', '').send({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an unknown key → 403 from the middleware, provider never called', async () => {
    const r = await post({ spec_b64: b64('make a thing') }, 'not-a-real-key');
    expect(r.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a key issued to a registered AGENT → 403 operator_key_required, provider never called', async () => {
    const r = await post({ spec_b64: b64('make a thing') }, 'agent-bound-key');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('operator_key_required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED if the mount order is ever broken: mounted with NO authMiddleware, the handler itself refuses', async () => {
    const bare = express();
    bare.use(express.json());
    bare.use('/api/v1', devCodegenRouter);
    const r = await request(bare).post(PATH).send({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an operator key passes through to the handler', async () => {
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(200);
  });

  it('accepts the x-api-key header form as well as Bearer', async () => {
    const r = await request(app).post(PATH).set('x-api-key', 'op-key').send({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(200);
  });
});

describe('the SQL-keyword sanitizer is untouched, and a base64 spec still round-trips through it', () => {
  it('the base64 form of the nasty spec contains none of the banned substrings', () => {
    const enc = b64(NASTY_SPEC).toUpperCase();
    for (const kw of FORBIDDEN) expect(enc.includes(kw)).toBe(false);
    // and the raw form really does contain them all, so the next test is a real contrast
    for (const kw of FORBIDDEN) expect(NASTY_SPEC.toUpperCase().includes(kw)).toBe(true);
  });

  it('a spec containing ";", "--" and "SELECT " is decoded and REACHES the provider call intact', async () => {
    const r = await post({ spec_b64: b64(NASTY_SPEC) });
    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // exact text, not a lookalike: the handler decoded what the caller encoded
    expect(sentPrompt()).toContain(NASTY_SPEC);
  });

  it('NEGATIVE CONTROL: the same spec sent RAW is stopped by the real sanitizer (400 Validation failed)', async () => {
    // This is what makes the test above mean something. If the sanitizer were not in this pipeline,
    // the raw form would reach the handler and answer invalid_base64 instead.
    const r = await post({ spec_b64: NASTY_SPEC });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Validation failed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('context_b64 carries banned characters the same way', async () => {
    const r = await post({ spec_b64: b64('add a column'), context_b64: b64('CREATE TABLE a (id int); -- comment') });
    expect(r.status).toBe(200);
    expect(sentPrompt()).toContain('CREATE TABLE a (id int); -- comment');
    expect(sentPrompt()).toContain('add a column');
  });
});

describe('zero caller-controlled destination (no SSRF surface)', () => {
  const FORBIDDEN_FIELDS = [
    'url', 'base_url', 'baseUrl', 'endpoint', 'host', 'hostname', 'provider', 'model', 'api_key', 'apiKey',
    'headers', 'proxy', 'callback_url', 'webhook', 'target',
  ];

  it.each(FORBIDDEN_FIELDS)('a body field named "%s" is REFUSED (400 unsupported_field) and nothing is called', async (field) => {
    const r = await post({ spec_b64: b64('make a thing'), [field]: 'http://169.254.169.254/latest/meta-data/' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('unsupported_field');
    expect(r.body.fields).toContain(field);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a "__proto__" key is refused as well', async () => {
    const r = await request(app)
      .post(PATH)
      .set('Authorization', 'Bearer op-key')
      .set('Content-Type', 'application/json')
      .send(`{"spec_b64":"${b64('make a thing')}","__proto__":{"endpoint":"http://evil.test"}}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('unsupported_field');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('query-string and header attempts are never read: the call still goes to the one hardcoded host', async () => {
    const r = await request(app)
      .post(`${PATH}?url=http://evil.test/&provider=openai&model=gpt-4o&base_url=http://evil.test&endpoint=http://evil.test`)
      .set('Authorization', 'Bearer op-key')
      .set('X-Provider', 'openai')
      .set('X-Base-Url', 'http://evil.test')
      .set('X-Forwarded-Host', 'evil.test')
      .send({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(200);
    expect(calls().map((c) => c.url)).toEqual([GROQ_URL]);
  });

  it('the operator-side redirect variables cannot move the provider key off its own vendor', async () => {
    // LOCAL_LLM_BASE_URL / OPENAI_BASE_URL redirect HAL's quorum client, and under that redirect the
    // provider key travels to the new host. This route uses the hardcoded-host adapters instead.
    process.env.LOCAL_LLM_BASE_URL = 'http://evil.test/v1';
    process.env.OPENAI_BASE_URL = 'http://evil.test/v1';
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(200);
    expect(calls().map((c) => c.url)).toEqual([GROQ_URL]);
  });

  it('the upstream credential is the SERVER-side provider key, and the caller key never leaves', async () => {
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(200);
    const sent = calls()[0]!;
    expect(sent.init.headers.Authorization).toBe('Bearer test-groq-key');
    expect(JSON.stringify(sent)).not.toContain('op-key');
  });

  it('no provider key and no caller key appears in the response', async () => {
    const r = await post({ spec_b64: b64('make a thing') });
    const text = JSON.stringify(r.body) + JSON.stringify(r.headers);
    expect(text).not.toContain('test-groq-key');
    expect(text).not.toContain('test-cerebras-key');
    expect(text).not.toContain('op-key');
  });

  it('the model is chosen by the server and echoed back, never taken from the caller', async () => {
    const r = await post({ spec_b64: b64('make a thing') });
    const sentModel = JSON.parse(calls()[0]!.init.body).model;
    expect(typeof sentModel).toBe('string');
    expect(sentModel.length).toBeGreaterThan(0);
    expect(r.body.model).toBe(sentModel);
  });
});

describe('free providers only', () => {
  it('prefers groq when both free providers are configured', async () => {
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(200);
    expect(r.body.provider).toBe('groq');
    expect(calls().map((c) => c.url)).toEqual([GROQ_URL]);
  });

  it('falls back to cerebras when groq has no key', async () => {
    delete process.env.GROQ_API_KEY;
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(200);
    expect(r.body.provider).toBe('cerebras');
    expect(calls().map((c) => c.url)).toEqual([CEREBRAS_URL]);
    expect(calls()[0]!.init.headers.Authorization).toBe('Bearer test-cerebras-key');
  });

  it('a whitespace-only groq key counts as NOT configured', async () => {
    process.env.GROQ_API_KEY = '   ';
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.body.provider).toBe('cerebras');
  });

  it('with neither free key set → 503 no_free_provider_configured, even when PAID keys exist', async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.CEREBRAS_API_KEY;
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'COHERE_API_KEY']) {
      process.env[k] = `paid-${k}`;
    }
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('no_free_provider_configured');
    expect(r.body).not.toHaveProperty('output');
    expect(fetchSpy).not.toHaveBeenCalled(); // a paid provider is never a fallback
  });

  it('every candidate is a declared free provider, and the list is exactly groq then cerebras', () => {
    expect([...CANDIDATE_PROVIDER_NAMES]).toEqual(['groq', 'cerebras']);
    for (const name of CANDIDATE_PROVIDER_NAMES) expect(isFreeProvider(name)).toBe(true);
  });

  it('selectProvider REFUSES a candidate that is not a declared free provider, even with its key present', () => {
    const fake = (name: string): Candidate => ({
      make: () => ({ name, tier: 1, free: false, isHealthy: async () => true, complete: jest.fn() }),
      keyEnv: 'GROQ_API_KEY',
    });
    const env = { GROQ_API_KEY: 'a-real-looking-key' };
    // control: the SAME candidate and key under a free provider's name is selected — so the null
    // below is the free-provider check working, not a missing key
    expect(selectProvider(env, [fake('groq')])?.adapter.name).toBe('groq');
    expect(selectProvider(env, [fake('openai')])).toBeNull();
    expect(selectProvider(env, [fake('anthropic')])).toBeNull();
    // and a paid candidate does not block a free one behind it
    expect(selectProvider(env, [fake('openai'), fake('cerebras')])?.adapter.name).toBe('cerebras');
  });

  it('selectProvider returns null for an empty environment rather than guessing', () => {
    expect(selectProvider({})).toBeNull();
    expect(selectProvider({ OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' })).toBeNull();
  });
});

describe('input validation and the size cap', () => {
  it('missing spec_b64 → 400 missing_field', async () => {
    const r = await post({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('missing_field');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a non-object body → 400 invalid_body', async () => {
    const r = await post([b64('x')]);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_body');
  });

  it('a non-string spec_b64 → 400 invalid_field', async () => {
    const r = await post({ spec_b64: 12345 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_field');
  });

  it.each([
    ['not base64 at all', 'not base64!!!'],
    ['base64url hyphen (could assemble a banned "--")', 'ab-d'],
    ['base64url underscore', 'ab_d'],
    ['length not a multiple of 4', 'abc'],
    ['padding in the middle', 'ab==cd=='],
  ])('rejects %s → 400 invalid_base64', async (_label, value) => {
    const r = await post({ spec_b64: value });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_base64');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('valid base64 of invalid UTF-8 → 400 invalid_utf8', async () => {
    const r = await post({ spec_b64: Buffer.from([0xff, 0xfe, 0xfd]).toString('base64') });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_utf8');
  });

  it.each([['empty string', ''], ['whitespace only', b64('   \n\t ')]])('%s spec → 400 empty_spec', async (_l, value) => {
    const r = await post({ spec_b64: value });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('empty_spec');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a spec of exactly the cap is accepted', async () => {
    const r = await post({ spec_b64: Buffer.alloc(MAX_FIELD_BYTES, 0x61).toString('base64') });
    expect(r.status).toBe(200);
  });

  it('a spec one byte over the cap → 413 payload_too_large', async () => {
    const r = await post({ spec_b64: Buffer.alloc(MAX_FIELD_BYTES + 1, 0x61).toString('base64') });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('payload_too_large');
    expect(r.body.field).toBe('spec_b64');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a spec far over the cap (but under the 1 MB body limit) → 413', async () => {
    const r = await post({ spec_b64: Buffer.alloc(MAX_FIELD_BYTES * 3, 0x61).toString('base64') });
    expect(r.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the cap applies to context_b64 too, and names the field', async () => {
    const r = await post({ spec_b64: b64('ok'), context_b64: Buffer.alloc(MAX_FIELD_BYTES + 1, 0x61).toString('base64') });
    expect(r.status).toBe(413);
    expect(r.body.field).toBe('context_b64');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an empty context_b64 is treated as no context; a malformed one is refused', async () => {
    const ok = await post({ spec_b64: b64('make a thing'), context_b64: '' });
    expect(ok.status).toBe(200);
    expect(sentPrompt()).not.toContain('=== CONTEXT ===');
    fetchSpy.mockClear();
    const bad = await post({ spec_b64: b64('make a thing'), context_b64: 'ab-d' });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('context_b64');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('UTF-8 survives the round trip', async () => {
    const spec = 'const greeting = "héllo wörld — 你好 🚀";';
    const r = await post({ spec_b64: b64(spec) });
    expect(r.status).toBe(200);
    expect(sentPrompt()).toContain(spec);
  });
});

describe('the success response is honest', () => {
  it('returns provider, model, output, usage — and the output is what the provider returned', async () => {
    fetchSpy.mockImplementation(async () => groqOk('export const x = 1;\n'));
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enabled: true,
      provider: 'groq',
      output: 'export const x = 1;\n',
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    });
    expect(typeof r.body.usage.latency_ms).toBe('number');
    expect(r.body).not.toHaveProperty('rawResponse');
  });

  it('is never cached', async () => {
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['length', true],
    ['stop', false],
    [null, null],
  ])('finish_reason %j → truncated %j', async (finish, expected) => {
    fetchSpy.mockImplementation(async () => groqOk('partial code', finish));
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(expected);
  });

  it('the request to the provider is one user message, bounded, with low temperature', async () => {
    await post({ spec_b64: b64('make a thing') });
    const body = JSON.parse(calls()[0]!.init.body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.max_tokens).toBeLessThanOrEqual(8192);
    expect(body.temperature).toBeLessThanOrEqual(0.5);
  });

  it('touches no table at all (no scoring, no logging, no version pin)', async () => {
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(200);
    expect(dbTouches()).toEqual([]);
  });
});

describe('provider failure is reported as failure, never as a fabricated success', () => {
  const NOT_A_SUCCESS = (body: Record<string, unknown>): void => {
    expect(body).not.toHaveProperty('enabled');
    expect(body).not.toHaveProperty('output');
    expect(typeof body['error']).toBe('string');
  };

  it('upstream 429 → 429 with Retry-After', async () => {
    fetchSpy.mockImplementation(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }));
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('provider_rate_limited');
    expect(r.headers['retry-after']).toBe('7');
    NOT_A_SUCCESS(r.body);
  });

  it('upstream 401 (OUR credential was rejected) → 502, not 401/403, so it cannot read as the caller failing auth', async () => {
    fetchSpy.mockImplementation(async () => new Response('bad key', { status: 401 }));
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('provider_auth_failed');
    NOT_A_SUCCESS(r.body);
  });

  it('upstream 404 model_not_found → 502 and the vendor reason is passed through (a retired model is diagnosable)', async () => {
    fetchSpy.mockImplementation(async () => new Response('{"error":{"code":"model_not_found"}}', { status: 404 }));
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('provider_error');
    expect(r.body.message).toContain('model_not_found');
    NOT_A_SUCCESS(r.body);
  });

  it('a vendor error body that ECHOES the provider key has it scrubbed', async () => {
    fetchSpy.mockImplementation(async () => new Response('invalid request for key test-groq-key', { status: 500 }));
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain('test-groq-key');
    expect(r.body.message).toContain('[redacted]');
  });

  it('a network failure → 502 provider_error', async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('provider_error');
    NOT_A_SUCCESS(r.body);
  });

  it('an aborted (timed-out) call → 504 provider_timeout', async () => {
    fetchSpy.mockImplementation(async () => {
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    });
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(504);
    expect(r.body.error).toBe('provider_timeout');
    NOT_A_SUCCESS(r.body);
  });

  it.each([
    ['empty content', JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })],
    ['whitespace content', JSON.stringify({ choices: [{ message: { content: '  \n ' } }] })],
    ['no choices', JSON.stringify({ choices: [] })],
    ['an unrelated JSON body', JSON.stringify({ hello: 'world' })],
  ])('a 200 from the provider with %s → 502 empty_completion, not an empty "success"', async (_l, payload) => {
    fetchSpy.mockImplementation(async () => new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await post({ spec_b64: b64('make a thing') });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('empty_completion');
    NOT_A_SUCCESS(r.body);
  });
});

describe('bounded concurrency', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function waitForCalls(n: number): Promise<void> {
    for (let i = 0; i < 200 && fetchSpy.mock.calls.length < n; i += 1) await sleep(10);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(n);
  }

  it(`call number ${MAX_IN_FLIGHT + 1} while ${MAX_IN_FLIGHT} are in flight → 429 busy, and the slots free up afterwards`, async () => {
    const releases: Array<() => void> = [];
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(groqOk()));
        }),
    );

    const held = Array.from({ length: MAX_IN_FLIGHT }, () => post({ spec_b64: b64('make a thing') }).then((r) => r));
    await waitForCalls(MAX_IN_FLIGHT);

    const refused = await post({ spec_b64: b64('make a thing') });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('busy');
    expect(refused.headers['retry-after']).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(MAX_IN_FLIGHT); // the refused call never reached the provider

    releases.forEach((release) => release());
    const done = await Promise.all(held);
    for (const r of done) expect(r.status).toBe(200);

    fetchSpy.mockImplementation(async () => groqOk());
    const after = await post({ spec_b64: b64('make a thing') });
    expect(after.status).toBe(200);
  });

  it('a failing provider does not leak slots', async () => {
    fetchSpy.mockImplementation(async () => new Response('boom', { status: 500 }));
    for (let i = 0; i < MAX_IN_FLIGHT + 3; i += 1) {
      const r = await post({ spec_b64: b64('make a thing') });
      expect(r.status).toBe(502); // never 429 busy
    }
    fetchSpy.mockImplementation(async () => groqOk());
    expect((await post({ spec_b64: b64('make a thing') })).status).toBe(200);
  });
});

describe('static guards on the route file itself', () => {
  const FILE = join(__dirname, '..', 'src', 'routes', 'v1', 'dev-codegen.ts');
  const source = readFileSync(FILE, 'utf8');
  // Comments explain the design and legitimately mention hosts and module names; only code is scanned.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('has no HTTP client of its own: no fetch, no URL literal, no node http(s)', () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/https?:\/\//);
    expect(code).not.toMatch(/['"]node:https?['"]|['"]https?['"]|axios|undici|node-fetch|got\(/);
  });

  it('imports exactly the allowlisted modules — adding one (a paid adapter, a scoring module) fails here', () => {
    const specifiers = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).sort();
    expect(specifiers).toEqual(
      [
        'express',
        'util',
        '../../providers/groq',
        '../../providers/cerebras',
        '../../providers/types',
        '../../billing/free-providers',
      ].sort(),
    );
  });

  it('touches nothing on the scoring path', () => {
    for (const forbidden of ['repid-update', 'scoring', 'tier', 'constitutional', '/layers/', '/engine/', '../../db', 'supabase']) {
      expect(code.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('names no provider host', () => {
    for (const host of ['api.groq.com', 'api.cerebras.ai', 'api.openai.com', 'api.anthropic.com', 'openrouter.ai', 'googleapis.com']) {
      expect(source).not.toContain(host);
    }
  });

  it('is mounted after authMiddleware in src/index.ts', () => {
    const index = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const authAt = index.indexOf('app.use(authMiddleware);');
    const mountAt = index.indexOf("app.use('/api/v1', devCodegenRouter);");
    expect(authAt).toBeGreaterThan(-1);
    expect(mountAt).toBeGreaterThan(authAt);
  });

  it('is not on the authMiddleware bypass list', () => {
    const auth = readFileSync(join(__dirname, '..', 'src', 'middleware', 'auth.ts'), 'utf8');
    expect(auth).not.toContain('dev/codegen');
  });
});

describe('NOT CHECKED', () => {
  it.todo(
    'NOT_CHECKED: a live round trip to a real free provider. Needs a real provider key and DEV_CODEGEN_ENABLED=true on a ' +
      'running deployment; every test above stubs the network boundary, so none of them proves the vendor accepts this request.',
  );
});
