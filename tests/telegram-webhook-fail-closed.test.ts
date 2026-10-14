/**
 * Operator bot webhook (/api/v1/telegram): unset configuration must REFUSE, never allow.
 *
 *   - no TELEGRAM_WEBHOOK_SECRET  → every update (message or callback_query) is 401
 *   - wrong / missing secret header → 401
 *   - right secret, no admin chat configured → control commands refused, nothing written
 *   - right secret, matching admin chat → control commands work
 *   - read-only commands behave as before once the update is authenticated
 *   - /set-webhook is POST-only, needs the secret header, never registers without a secret_token,
 *     and returns only { ok, description }
 *   - callback_query (HITL decisions) also needs the admin chat
 *   - the secret compare hashes both sides, so a length mismatch still runs timingSafeEqual
 */
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

const mockSetAgentEnabled = jest.fn(async (agent: string, enabled: boolean) => ({
  agent_name: agent, enabled, updated_at: '2026-10-14T00:00:00Z',
}));
const mockListAgentControls = jest.fn(async () => [{ agent_name: 'mel', enabled: true }]);
const mockHandleHitlCallback = jest.fn(async (_req: any, res: any) => { res.sendStatus(200); });

jest.mock('../src/services/agent-controls', () => ({
  setAgentEnabled: (...a: any[]) => (mockSetAgentEnabled as any)(...a),
  listAgentControls: (...a: any[]) => (mockListAgentControls as any)(...a),
}));
jest.mock('../src/services/hitl-callback-handler', () => ({
  handleHitlCallback: (...a: any[]) => (mockHandleHitlCallback as any)(...a),
}));
jest.mock('../src/services/vertical-leaderboard', () => ({
  fetchVerticalLeaderboard: async () => ({ overall: [], by_vertical: {} }),
}));
jest.mock('../src/services/metrics-snapshot', () => ({ getMetricsSnapshot: async () => ({}) }));
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ select: async () => ({ data: [] }) }),
    rpc: async () => ({ data: [] }),
  }),
}));

const ENV_KEYS = ['TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_ADMIN_CHAT_ID', 'TELEGRAM_CHAT_ID', 'TELEGRAM_BOT_TOKEN'];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
// The router logs at import when the secret is unset; start from a clean slate.
for (const k of ENV_KEYS) delete process.env[k];
const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const telegram = require('../src/routes/telegram');

const SECRET = 'test-webhook-secret-not-real';
const ADMIN = '111222333';
const realFetch = globalThis.fetch;
let sent: Array<{ url: string; body: any }> = [];

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/telegram', telegram.default);
  return a;
}
const msg = (text: string, chatId: number | string = ADMIN) => ({ update_id: 1, message: { chat: { id: chatId }, text } });
const cb = () => ({ update_id: 2, callback_query: { id: 'x', data: 'v1:a:deadbeef:9999999999:00000000', message: { chat: { id: ADMIN }, message_id: 1 } } });

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.TELEGRAM_BOT_TOKEN = 'operator-bot-token-not-real';
  sent = [];
  mockSetAgentEnabled.mockClear();
  mockListAgentControls.mockClear();
  mockHandleHitlCallback.mockClear();
  globalThis.fetch = (async (url: any, init: any) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) } as any;
  }) as any;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  globalThis.fetch = realFetch;
  errorSpy.mockRestore();
});

describe('webhook secret — fail closed', () => {
  it('logs loudly at import when the secret is unset', () => {
    expect(errorSpy).toHaveBeenCalledWith(telegram.WEBHOOK_SECRET_MISSING);
  });

  it('unset secret → 401 for a control command; nothing written, nothing sent', async () => {
    process.env.TELEGRAM_ADMIN_CHAT_ID = ADMIN;
    const r = await request(app()).post('/api/v1/telegram/webhook').send(msg('/sleep mel'));
    expect(r.status).toBe(401);
    expect(mockSetAgentEnabled).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('unset secret → 401 even when a header is presented', async () => {
    const r = await request(app()).post('/api/v1/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', 'anything').send(msg('/status'));
    expect(r.status).toBe(401);
    expect(mockListAgentControls).not.toHaveBeenCalled();
  });

  it('unset secret → 401 for callback_query; the HITL handler never runs', async () => {
    const r = await request(app()).post('/api/v1/telegram/webhook').send(cb());
    expect(r.status).toBe(401);
    expect(mockHandleHitlCallback).not.toHaveBeenCalled();
  });

  it('wrong secret → 401', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    process.env.TELEGRAM_ADMIN_CHAT_ID = ADMIN;
    const r = await request(app()).post('/api/v1/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', SECRET + 'x').send(msg('/wake mel'));
    expect(r.status).toBe(401);
    expect(mockSetAgentEnabled).not.toHaveBeenCalled();
  });

  it('missing header with a configured secret → 401', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const r = await request(app()).post('/api/v1/telegram/webhook').send(cb());
    expect(r.status).toBe(401);
    expect(mockHandleHitlCallback).not.toHaveBeenCalled();
  });

  it('right secret + admin chat → callback_query reaches the HITL handler', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    process.env.TELEGRAM_ADMIN_CHAT_ID = ADMIN;
    const r = await request(app()).post('/api/v1/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', SECRET).send(cb());
    expect(r.status).toBe(200);
    expect(mockHandleHitlCallback).toHaveBeenCalledTimes(1);
  });

  it('right secret + no admin chat configured → callback_query is NOT handled', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const r = await request(app()).post('/api/v1/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', SECRET).send(cb());
    expect(r.status).toBe(200);
    expect(mockHandleHitlCallback).not.toHaveBeenCalled();
  });

  it('right secret + a different chat → callback_query is NOT handled', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    process.env.TELEGRAM_ADMIN_CHAT_ID = '444555666';
    const r = await request(app()).post('/api/v1/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', SECRET).send(cb());
    expect(r.status).toBe(200);
    expect(mockHandleHitlCallback).not.toHaveBeenCalled();
  });

  it('secret compare runs timingSafeEqual on fixed-size digests, even when lengths differ', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      expect(telegram.webhookSecretMatches('x')).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      const [a, b] = spy.mock.calls[0]! as [Buffer, Buffer];
      expect(a.length).toBe(32);
      expect(b.length).toBe(32);
      expect(telegram.webhookSecretMatches(SECRET)).toBe(true);
      expect(telegram.webhookSecretMatches(SECRET + ' ')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('admin chat — fail closed', () => {
  const post = (text: string, chatId: number | string = ADMIN) =>
    request(app()).post('/api/v1/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', SECRET).send(msg(text, chatId));

  beforeEach(() => { process.env.TELEGRAM_WEBHOOK_SECRET = SECRET; });

  it('right secret + no admin chat configured → /sleep and /wake refused, nothing written', async () => {
    for (const cmd of ['/sleep mel', '/wake mel']) {
      const r = await post(cmd);
      expect(r.status).toBe(200);
    }
    expect(mockSetAgentEnabled).not.toHaveBeenCalled();
    expect(sent.map((s) => s.body.text)).toEqual([telegram.ADMIN_CHAT_MISSING, telegram.ADMIN_CHAT_MISSING]);
  });

  it('right secret + a different chat → refused', async () => {
    process.env.TELEGRAM_ADMIN_CHAT_ID = ADMIN;
    await post('/sleep mel', 999);
    expect(mockSetAgentEnabled).not.toHaveBeenCalled();
    expect(sent[0]!.body.text).toContain('restricted to admin chat');
  });

  it('right secret + matching TELEGRAM_ADMIN_CHAT_ID → /sleep works', async () => {
    process.env.TELEGRAM_ADMIN_CHAT_ID = ADMIN;
    await post('/sleep mel');
    expect(mockSetAgentEnabled).toHaveBeenCalledWith('mel', false, 'telegram', 'telegram /sleep');
  });

  it('TELEGRAM_CHAT_ID still works as the admin chat fallback', async () => {
    process.env.TELEGRAM_CHAT_ID = ADMIN;
    await post('/wake mel');
    expect(mockSetAgentEnabled).toHaveBeenCalledWith('mel', true, 'telegram', 'telegram /wake');
  });

  it('read-only /status is unchanged once authenticated, with or without an admin chat', async () => {
    const r = await post('/status', 999);
    expect(r.status).toBe(200);
    expect(mockListAgentControls).toHaveBeenCalledTimes(1);
    expect(sent[0]!.body.text).toContain('TRINITY SYMPHONY');
    expect(mockSetAgentEnabled).not.toHaveBeenCalled();
  });

  it('isAdminChat is false whenever no admin chat is configured', () => {
    expect(telegram.isAdminChat(ADMIN)).toBe(false);
    expect(telegram.isAdminChat(undefined)).toBe(false);
    process.env.TELEGRAM_ADMIN_CHAT_ID = '   ';
    expect(telegram.isAdminChat('')).toBe(false);
  });
});

describe('/set-webhook: POST only, secret-gated, minimal reply', () => {
  const hook = () => request(app()).post('/api/v1/telegram/set-webhook');

  it('GET no longer reaches Telegram', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const r = await request(app()).get('/api/v1/telegram/set-webhook').set('X-Telegram-Bot-Api-Secret-Token', SECRET);
    expect(r.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it('unset secret → 409 and Telegram is not called', async () => {
    const r = await hook();
    expect(r.status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it('missing or wrong secret header → 401 and Telegram is not called', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    expect((await hook()).status).toBe(401);
    expect((await hook().set('X-Telegram-Bot-Api-Secret-Token', SECRET + 'x')).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('right header → registers with secret_token and returns only { ok, description }', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const r = await hook().set('X-Telegram-Bot-Api-Secret-Token', SECRET);
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain('/setWebhook');
    expect(sent[0]!.body.secret_token).toBe(SECRET);
    expect(Object.keys(r.body).sort()).toEqual(['description', 'ok']);
    expect(r.body.ok).toBe(true);
  });
});
