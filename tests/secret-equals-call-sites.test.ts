/**
 * CLAUDE_RULES r32 "one verifier, constant-time" (follow-up to #1408 / D-108).
 *
 * #1408's architecture test allowlisted four operator/admin key compares as known debt (plain `===` /
 * `!==`). They now route through ONE compare, `secretEquals` in src/auth/api-keys.ts: both sides
 * zero-padded to a fixed width, then crypto.timingSafeEqual. So does the rate-limit bypass check in middleware/env-api-key.ts,
 * which used `keys.includes(presented)` (a `===` per element) and which the `===` grep could not see.
 *
 * Per site: the right key is accepted, and a wrong key, a key of a different length (a prefix of the
 * right one) and a non-string are rejected, exactly as before. The `timingSafeEqual` assertions are
 * what the old `===` code fails: they prove the compare ran in constant time over the same fixed
 * width, including when the lengths differ.
 */
import crypto from 'crypto';
import express, { Router } from 'express';
import request from 'supertest';
import { secretEquals, SECRET_COMPARE_BYTES } from '../src/auth/api-keys';
import { authMiddleware } from '../src/middleware/auth';
import { hasValidEnvApiKey } from '../src/middleware/env-api-key';
import { llmRouter } from '../src/routes/route';
import { adminCapsRouter } from '../src/routes/admin-caps';
import { adminFlagsRouter } from '../src/routes/admin-flags';

// No row for any lookup: a key that is not the env key fails the DB-issued-key path too.
jest.mock('../src/db', () => {
  const chain: any = new Proxy(
    {},
    {
      get: (_t, p) =>
        p === 'then'
          ? undefined
          : p === 'single' || p === 'maybeSingle'
            ? () => Promise.resolve({ data: null, error: { message: 'no row' } })
            : () => chain,
    },
  );
  return { db: chain };
});
jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn().mockResolvedValue(undefined) }));

const RIGHT = 'right-operator-key-0123456789abcdef';
const WRONG = 'wrong-operator-key-0123456789abcdef'; // same length, different bytes
const SHORT = RIGHT.slice(0, 18); // a prefix of the right key: different length
const NON_STRING = [RIGHT]; // a repeated header arrives as string[]
const AGENT = '0d6f1a52-6c43-4b8e-9d0a-2f7e5b1c9a11';

const prevEnv = { ...process.env };
let tse: jest.SpyInstance;

beforeEach(() => {
  process.env.REPID_API_KEYS = `other-key:free,${RIGHT}:ops`;
  process.env.ADMIN_KEY = RIGHT;
  process.env.AGENT_GATE_ENABLED = 'false';
  tse = jest.spyOn(crypto, 'timingSafeEqual');
});
afterEach(() => tse.mockRestore());
afterAll(() => {
  process.env = prevEnv;
});

/** Every compare ran through timingSafeEqual over the same fixed width: no length short-circuit. */
function expectConstantTimeCompare() {
  expect(tse).toHaveBeenCalled();
  for (const [a, b] of tse.mock.calls) {
    expect([(a as Buffer).length, (b as Buffer).length]).toEqual([SECRET_COMPARE_BYTES, SECRET_COMPARE_BYTES]);
  }
}

/** An app that plants a raw header value (strings via supertest cannot carry a string[]). */
function appWith(mount: (app: express.Express) => void, header: string, value: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req.headers as Record<string, unknown>)[header] = value;
    next();
  });
  mount(app);
  app.use((req, res) => res.status(200).json({ passed: true, apiKey: (req as any).apiKey ?? null }));
  return app;
}

describe('secretEquals', () => {
  it('is true only for two identical non-empty strings', () => {
    expect(secretEquals(RIGHT, RIGHT)).toBe(true);
    expect(secretEquals(RIGHT, WRONG)).toBe(false);
    expect(secretEquals(RIGHT, SHORT)).toBe(false);
    expect(secretEquals(SHORT, RIGHT)).toBe(false);
  });

  it('is false, never a throw, on a non-string or empty input', () => {
    for (const bad of [undefined, null, 0, 123, {}, NON_STRING, Buffer.from(RIGHT), '']) {
      expect(() => secretEquals(bad, RIGHT)).not.toThrow();
      expect(secretEquals(bad, RIGHT)).toBe(false);
      expect(secretEquals(RIGHT, bad)).toBe(false);
    }
    expect(secretEquals('', '')).toBe(false);
  });

  it('compares over the same fixed width even when the lengths differ', () => {
    secretEquals(RIGHT, SHORT);
    expectConstantTimeCompare();
  });

  it('zero padding cannot make a shorter key equal; an over-width secret fails closed', () => {
    expect(secretEquals(RIGHT, `${RIGHT}\0`)).toBe(false);
    const huge = 'k'.repeat(SECRET_COMPARE_BYTES + 1);
    expect(secretEquals(huge, huge)).toBe(false);
    expect(secretEquals('k'.repeat(SECRET_COMPARE_BYTES), 'k'.repeat(SECRET_COMPARE_BYTES))).toBe(true);
  });
});

describe('src/middleware/auth.ts: REPID_API_KEYS env key', () => {
  const app = (key: unknown) => appWith((a) => a.use(authMiddleware), 'x-api-key', key);
  const probe = (key: unknown) => request(app(key)).get('/api/v1/ct-probe');

  it('accepts the right key, with the same tier and allowlist index as before', async () => {
    const res = await probe(RIGHT);
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toEqual({ key: RIGHT, tier: 'ops', envIndex: 1 });
    expectConstantTimeCompare();
  });

  it('rejects a wrong key, comparing in constant time', async () => {
    expect((await probe(WRONG)).status).toBe(403);
    expectConstantTimeCompare();
  });

  it('rejects a key of a different length (still a constant-time compare) and a non-string', async () => {
    expect((await probe(SHORT)).status).toBe(403);
    expectConstantTimeCompare();
    expect((await probe(NON_STRING)).status).toBe(403);
  });
});

describe('src/routes/route.ts: /llm/complete env-key classification', () => {
  // With an agent_id, the right env key is RECOGNISED as the shared env key and refused for
  // impersonation (F2); any other key falls to the agent-key path and is refused as invalid.
  const ENV_KEY_RECOGNISED = 'Shared env key cannot target a specific agent_id';
  const app = (auth: unknown) =>
    appWith((a) => a.use('/api', llmRouter), 'authorization', typeof auth === 'string' ? `Bearer ${auth}` : auth);
  const complete = (auth: unknown) => request(app(auth)).post('/api/v1/llm/complete').send({ prompt: 'p', agent_id: AGENT });

  it('recognises the right key as the env key', async () => {
    const res = await complete(RIGHT);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(ENV_KEY_RECOGNISED);
    expectConstantTimeCompare();
  });

  it('does not recognise a wrong key, comparing in constant time', async () => {
    const res = await complete(WRONG);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or revoked API key');
    expectConstantTimeCompare();
  });

  it('does not recognise a key of a different length (still a constant-time compare) or a non-string', async () => {
    const short = await complete(SHORT);
    expect(short.status).toBe(401);
    expect(short.body.error).toBe('Invalid or revoked API key');
    expectConstantTimeCompare();
    const nonString = await complete(NON_STRING);
    expect(nonString.status).toBe(401);
    expect(nonString.body.error).not.toBe(ENV_KEY_RECOGNISED);
  });
});

describe.each<[string, Router]>([
  ['src/routes/admin-caps.ts', adminCapsRouter],
  ['src/routes/admin-flags.ts', adminFlagsRouter],
])('%s: x-admin-key', (_file, router) => {
  const probe = (key: unknown) => request(appWith((a) => a.use('/admin', router), 'x-admin-key', key)).get('/admin/ct-probe');

  it('accepts the right key', async () => {
    const res = await probe(RIGHT);
    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(true);
    expectConstantTimeCompare();
  });

  it('rejects a wrong key, comparing in constant time', async () => {
    expect((await probe(WRONG)).status).toBe(401);
    expectConstantTimeCompare();
  });

  it('rejects a key of a different length (still a constant-time compare), a non-string, and no key', async () => {
    expect((await probe(SHORT)).status).toBe(401);
    expectConstantTimeCompare();
    expect((await probe(NON_STRING)).status).toBe(401);
    expect((await probe(undefined)).status).toBe(401);
  });
});

describe('src/middleware/env-api-key.ts: hasValidEnvApiKey (rate-limit bypass)', () => {
  const env = { REPID_API_KEYS: `other-key:free, ${RIGHT}:ops` } as NodeJS.ProcessEnv;

  it('accepts the right key', () => {
    expect(hasValidEnvApiKey({ authorization: `Bearer ${RIGHT}` }, env)).toBe(true);
    expectConstantTimeCompare();
  });

  it('rejects a wrong key, comparing in constant time', () => {
    expect(hasValidEnvApiKey({ 'x-api-key': WRONG }, env)).toBe(false);
    expectConstantTimeCompare();
  });

  it('rejects a key of a different length (still a constant-time compare) and a non-string', () => {
    expect(hasValidEnvApiKey({ authorization: `Bearer ${SHORT}` }, env)).toBe(false);
    expectConstantTimeCompare();
    expect(hasValidEnvApiKey({ 'x-api-key': 12345 as unknown as string }, env)).toBe(false);
  });
});
