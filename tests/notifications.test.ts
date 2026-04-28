/**
 * notify.ts — Telegram + webhook delivery via Promise.allSettled.
 *
 * Mocks global.fetch and exercises both paths independently.
 */

const ORIG_TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ORIG_TG_CHAT = process.env.TELEGRAM_OWNER_CHAT_ID;

afterAll(() => {
  if (ORIG_TG_TOKEN === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = ORIG_TG_TOKEN;
  if (ORIG_TG_CHAT === undefined) delete process.env.TELEGRAM_OWNER_CHAT_ID;
  else process.env.TELEGRAM_OWNER_CHAT_ID = ORIG_TG_CHAT;
});

beforeEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
  process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
  process.env.TELEGRAM_OWNER_CHAT_ID = '123456789';
});

afterEach(() => {
  delete (global as any).fetch;
});

// db mock — webhook lookup returns a configured row by default; tests
// can override via the _setWebhookRow helper.
let webhookRow: any = { webhook_url: 'https://hooks.example.com/abc', webhook_secret: 'secret123' };

jest.mock('../src/db', () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    not: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: webhookRow, error: null }),
    insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'a' }, error: null }) }) }),
  };
  return {
    db: { from: () => builder, rpc: async () => ({ data: { id: 1 }, error: null }) },
    _setWebhookRow: (r: any) => { webhookRow = r; },
  };
});

function mockFetch(impl: jest.Mock) {
  (global as any).fetch = impl;
}

describe('notify — Telegram path', () => {
  it('POSTs to api.telegram.org with bot token, chat_id, Markdown parse_mode', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    mockFetch(fetchMock);
    const { sendNotification } = require('../src/services/notify');
    const r = await sendNotification('builder-1', 'hello world', {});
    expect(r.telegram.ok).toBe(true);
    expect(r.telegram.status).toBe(200);
    const tgCall = fetchMock.mock.calls.find((c: any) => String(c[0]).includes('telegram.org'));
    expect(tgCall).toBeDefined();
    expect(tgCall![0]).toMatch(/^https:\/\/api\.telegram\.org\/bottest-bot-token\/sendMessage$/);
    const body = JSON.parse(tgCall![1].body);
    expect(body.chat_id).toBe('123456789');
    expect(body.text).toBe('hello world');
    expect(body.parse_mode).toBe('Markdown');
  });

  it('returns ok=false with env_unset when TELEGRAM_BOT_TOKEN is missing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    mockFetch(jest.fn());
    const { sendNotification } = require('../src/services/notify');
    const r = await sendNotification('b', 'm', {});
    expect(r.telegram.ok).toBe(false);
    expect(r.telegram.error).toBe('env_unset');
  });

  it('fails soft on Telegram timeout (no throw, ok=false)', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes('telegram.org')) return Promise.reject(abortErr);
      return Promise.resolve({ ok: true, status: 200 });
    });
    mockFetch(fetchMock);
    const { sendNotification } = require('../src/services/notify');
    const r = await sendNotification('builder-1', 'm', {});
    expect(r.telegram.ok).toBe(false);
    expect(r.telegram.error).toBe('timeout');
  });
});

describe('notify — webhook path', () => {
  it('POSTs to webhook_url with X-Webhook-Signature header (HMAC-SHA256)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    mockFetch(fetchMock);
    const { sendNotification } = require('../src/services/notify');
    await sendNotification('builder-1', 'tip delivered', { round_id: 'r1' });

    const wbCall = fetchMock.mock.calls.find((c: any) => String(c[0]).includes('hooks.example.com'));
    expect(wbCall).toBeDefined();
    const headers = wbCall![1].headers as Record<string, string>;
    expect(headers['X-Webhook-Signature']).toMatch(/^[0-9a-f]{64}$/);
    const body = JSON.parse(wbCall![1].body);
    expect(body.builder_id).toBe('builder-1');
    expect(body.message).toBe('tip delivered');
    expect(body.metadata.round_id).toBe('r1');
  });

  it('skips with error=no_webhook_configured when builder has no webhook_url', async () => {
    const dbMod: any = require('../src/db');
    dbMod._setWebhookRow(null);
    mockFetch(jest.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { sendNotification } = require('../src/services/notify');
    const r = await sendNotification('builder-no-hook', 'm', {});
    expect(r.webhook.ok).toBe(false);
    expect(r.webhook.skipped).toBe(true);
    expect(r.webhook.error).toBe('no_webhook_configured');
    // Restore for subsequent tests.
    dbMod._setWebhookRow({ webhook_url: 'https://hooks.example.com/abc', webhook_secret: 'secret123' });
  });

  it('fails soft on webhook timeout (no throw, ok=false)', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes('hooks.example.com')) return Promise.reject(abortErr);
      return Promise.resolve({ ok: true, status: 200 });
    });
    mockFetch(fetchMock);
    const { sendNotification } = require('../src/services/notify');
    const r = await sendNotification('b', 'm', {});
    expect(r.webhook.ok).toBe(false);
    expect(r.webhook.error).toBe('timeout');
  });
});

describe('notify — both-paths-independent', () => {
  it('telegram failure does not block webhook delivery', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes('telegram.org')) return Promise.reject(abortErr);
      return Promise.resolve({ ok: true, status: 200 });
    });
    mockFetch(fetchMock);
    const { sendNotification } = require('../src/services/notify');
    const r = await sendNotification('builder-1', 'm', {});
    expect(r.telegram.ok).toBe(false);
    expect(r.webhook.ok).toBe(true);
  });

  it('webhook failure does not block telegram delivery', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes('hooks.example.com')) return Promise.reject(abortErr);
      return Promise.resolve({ ok: true, status: 200 });
    });
    mockFetch(fetchMock);
    const { sendNotification } = require('../src/services/notify');
    const r = await sendNotification('builder-1', 'm', {});
    expect(r.telegram.ok).toBe(true);
    expect(r.webhook.ok).toBe(false);
  });
});
