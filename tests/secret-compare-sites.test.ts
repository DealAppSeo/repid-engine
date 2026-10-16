/**
 * r32 per site: the three secret compares the identifier-only architecture scan could not see now go
 * through the one verifier (src/auth/api-keys.ts). Each site still accepts the right secret and refuses
 * a wrong one, a same-length wrong one, and none.
 */
import express from 'express';
import request from 'supertest';
import type { Request } from 'express';

jest.mock('../src/db', () => ({
  db: {
    from: () => {
      throw new Error('offline');
    },
  },
}));
jest.mock('../src/auth/api-keys', () => {
  const actual = jest.requireActual('../src/auth/api-keys');
  return {
    ...actual,
    secretEquals: jest.fn(actual.secretEquals),
    matchEnvOperatorKey: jest.fn(actual.matchEnvOperatorKey),
    validateAgentApiKey: jest.fn(async () => null),
  };
});
jest.mock('../src/observability/cron-runners', () => ({
  captureTelemetry: jest.fn(async () => ({ ok: true })),
  healthSummary24h: jest.fn(),
  runAuditProbe: jest.fn(),
}));
jest.mock('../src/services/status-digest', () => ({ runStatusDigest: jest.fn() }));
jest.mock('../src/services/anfis-retune', () => ({ retuneAnfisRoutingRunner: jest.fn() }));

import { secretEquals, matchEnvOperatorKey } from '../src/auth/api-keys';
import internalCronRouter from '../src/routes/v1/internal-cron';
import { createTelegramPublicRouter, webhookSecret } from '../src/routes/telegram-public';
import { resolvePosterIdentity } from '../src/routes/marketplace';

const verifier = secretEquals as jest.MockedFunction<typeof secretEquals>;
const envMatcher = matchEnvOperatorKey as jest.MockedFunction<typeof matchEnvOperatorKey>;

const saved: Record<string, string | undefined> = {};
const ENV = ['CRON_TRIGGER_TOKEN', 'TELEGRAM_PUBLIC_BOT_TOKEN', 'REPID_API_KEYS'];
beforeAll(() => ENV.forEach((k) => (saved[k] = process.env[k])));
afterAll(() => ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));
beforeEach(() => {
  verifier.mockClear();
  envMatcher.mockClear();
});

/** Same length as the real one, different bytes: a `===` and a constant-time compare must both refuse it. */
const sameLengthWrong = (s: string) => s.slice(0, -1) + (s.endsWith('x') ? 'y' : 'x');

describe('internal-cron X-Cron-Token (src/routes/v1/internal-cron.ts)', () => {
  const TOKEN = 'cron-test-token-not-real';
  const app = express().use('/cron', internalCronRouter);
  const post = (token?: string) => {
    const r = request(app).post('/cron/capture-telemetry');
    return (token === undefined ? r : r.set('X-Cron-Token', token)).send({});
  };

  it('compares through secretEquals; the right token passes, a wrong, same-length wrong or missing one is 401', async () => {
    process.env.CRON_TRIGGER_TOKEN = TOKEN;
    expect((await post(TOKEN)).status).toBe(200);
    expect(verifier).toHaveBeenCalledWith(TOKEN, TOKEN);
    expect((await post('nope')).status).toBe(401);
    expect((await post(sameLengthWrong(TOKEN))).status).toBe(401);
    expect((await post()).status).toBe(401);
  });

  it('an unset CRON_TRIGGER_TOKEN refuses every call, including an empty header', async () => {
    delete process.env.CRON_TRIGGER_TOKEN;
    expect((await post('')).status).toBe(401);
    expect((await post(TOKEN)).status).toBe(401);
    expect(verifier).toHaveBeenCalled();
  });
});

describe('telegram-public webhook secret (src/routes/telegram-public.ts)', () => {
  const TOKEN = 'public-test-token-not-real';
  const app = express().use('/tg', createTelegramPublicRouter());
  const post = (secret?: string) => {
    const r = request(app).post('/tg/webhook');
    return (secret === undefined ? r : r.set('X-Telegram-Bot-Api-Secret-Token', secret)).send({ update_id: 1 });
  };

  it('compares through secretEquals; the derived secret passes, a wrong, same-length wrong or missing one is 403', async () => {
    process.env.TELEGRAM_PUBLIC_BOT_TOKEN = TOKEN;
    const secret = webhookSecret(TOKEN);
    expect((await post(secret)).status).toBe(200);
    expect(verifier).toHaveBeenCalledWith(secret, secret);
    expect((await post('wrong')).status).toBe(403);
    expect((await post(sameLengthWrong(secret))).status).toBe(403);
    expect((await post()).status).toBe(403);
  });
});

describe('marketplace REPID_API_KEYS poster identity (src/routes/marketplace.ts)', () => {
  const asReq = (key: string | undefined, body: Record<string, unknown> = { poster_id: 'agent-7' }) =>
    ({ headers: key === undefined ? {} : { 'x-api-key': key }, body }) as unknown as Request;

  it('checks the env key through matchEnvOperatorKey; the right key (bare or key:tier) resolves, a wrong one does not', async () => {
    process.env.REPID_API_KEYS = 'env-key-one:pro, env-key-two';
    await expect(resolvePosterIdentity(asReq('env-key-one'))).resolves.toEqual({ poster_type: 'agent', poster_id: 'agent-7' });
    expect(envMatcher).toHaveBeenCalledWith('env-key-one');
    await expect(resolvePosterIdentity(asReq('env-key-two'))).resolves.toEqual({ poster_type: 'agent', poster_id: 'agent-7' });
    await expect(resolvePosterIdentity(asReq('env-key-one:pro'))).resolves.toBeNull();
    await expect(resolvePosterIdentity(asReq(sameLengthWrong('env-key-one')))).resolves.toBeNull();
    await expect(resolvePosterIdentity(asReq(undefined))).resolves.toBeNull();
  });

  it('a right env key with no declared poster_id is still null (the caller answers 400)', async () => {
    process.env.REPID_API_KEYS = 'env-key-one';
    await expect(resolvePosterIdentity(asReq('env-key-one', {}))).resolves.toBeNull();
    expect(envMatcher).toHaveBeenCalledWith('env-key-one');
  });
});
