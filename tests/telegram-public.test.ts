/**
 * B8 — the public phone door. Separate from the operator bot, inert without its own token,
 * calls only the classify function, says the privacy line first, stores nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const dbFrom = jest.fn();
jest.mock('../src/db', () => ({ db: { from: dbFrom, rpc: jest.fn() } }));

import {
  __resetPublicDoorLimits,
  createTelegramPublicRouter,
  PRIVACY_LINE,
  registerPublicWebhook,
  replyFor,
  webhookSecret,
} from '../src/routes/telegram-public';
import { __resetVoteCooldowns } from '../src/classify/free-votes';

const TOKEN = 'public-test-token-not-real';
const realFetch = globalThis.fetch;
let sent: Array<{ url: string; body: Record<string, unknown> }> = [];
let voterAnswer = 'TRUE';

function app() {
  const a = express();
  a.use('/api/v1/telegram-public', createTelegramPublicRouter());
  return a;
}

function update(text: string, type = 'private', id = 42) {
  return { update_id: 1, message: { chat: { id, type }, text } };
}

async function waitForSends(n: number) {
  for (let i = 0; i < 50 && sent.length < n; i += 1) await new Promise((r) => setTimeout(r, 10));
}

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['TELEGRAM_PUBLIC_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'GROQ_API_KEY']) saved[k] = process.env[k];
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  sent = [];
  voterAnswer = 'TRUE';
  __resetPublicDoorLimits();
  __resetVoteCooldowns();
  dbFrom.mockClear();
  process.env.TELEGRAM_PUBLIC_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'operator-token-must-never-be-used';
  process.env.GROQ_API_KEY = 'groq-test-key-not-real';
  globalThis.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.includes('api.telegram.org')) {
      sent.push({ url, body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: voterAnswer } }] }), { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => expect(dbFrom).not.toHaveBeenCalled());

const post = (body: unknown, secret: string | null = webhookSecret(TOKEN)) => {
  const r = request(app()).post('/api/v1/telegram-public/webhook');
  return (secret === null ? r : r.set('X-Telegram-Bot-Api-Secret-Token', secret)).send(body as object);
};

describe('inert until its own token is set', () => {
  it('no TELEGRAM_PUBLIC_BOT_TOKEN: 200, no call of any kind', async () => {
    delete process.env.TELEGRAM_PUBLIC_BOT_TOKEN;
    const res = await post(update('Paris is in France.'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inert: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('boot registration is inert without the token and never touches the operator token', async () => {
    delete process.env.TELEGRAM_PUBLIC_BOT_TOKEN;
    expect(await registerPublicWebhook()).toBe('inert');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('registration uses the public token, the public path and a secret', async () => {
    expect(await registerPublicWebhook()).toBe('ok');
    expect(sent[0]!.url).toContain(`/bot${TOKEN}/setWebhook`);
    expect(sent[0]!.body.url).toBe('https://repid-engine-production.up.railway.app/api/v1/telegram-public/webhook');
    expect(sent[0]!.body.secret_token).toBe(webhookSecret(TOKEN));
  });
});

describe('only Telegram can post updates', () => {
  it('a missing or wrong secret is 403 and makes no call', async () => {
    expect((await post(update('x'), null)).status).toBe(403);
    expect((await post(update('x'), 'wrong')).status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('one box, three labels', () => {
  it('/start shows the welcome with the privacy line', async () => {
    await post(update('/start'));
    await waitForSends(1);
    expect(String(sent[0]!.body.text)).toContain(PRIVACY_LINE);
    expect(sent[0]!.url).toContain(`/bot${TOKEN}/sendMessage`);
  });

  it('a true claim gets PASS, a false one VETO, arithmetic needs no model', async () => {
    await post(update('Paris is the capital of France.'));
    await waitForSends(1);
    expect(sent[0]!.body.text).toBe(replyFor('pass'));
    voterAnswer = 'FALSE';
    await post(update('The Moon is made of cheese.'));
    await waitForSends(2);
    expect(sent[1]!.body.text).toBe(replyFor('veto'));
    await post(update('2 + 2 = 5'));
    await waitForSends(3);
    expect(sent[2]!.body.text).toBe(replyFor('veto'));
  });

  it('a split or a dead checker is NOT CHECKED, never PASS', async () => {
    voterAnswer = 'UNSURE';
    await post(update('Pizza is the best food.'));
    await waitForSends(1);
    expect(sent[0]!.body.text).toBe(replyFor('not-checked'));
  });

  it('text with ; and -- (which the global sanitizer would 400) still gets an answer', async () => {
    await post(update('Water is wet; ice is cold -- right?'));
    await waitForSends(1);
    expect(sent).toHaveLength(1);
  });

  it('an oversized claim is NOT CHECKED without being sent to a checker', async () => {
    await post(update('a'.repeat(1501)));
    await waitForSends(1);
    expect(String(sent[0]!.body.text)).toContain('NOT CHECKED');
    const calls = (globalThis.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(calls.every((u) => u.includes('api.telegram.org'))).toBe(true);
  });

  it('groups are ignored; the door is one person, one chat', async () => {
    await post(update('Paris is in France.', 'group'));
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toHaveLength(0);
  });

  it('the 11th claim in a minute from one chat is refused without a check', async () => {
    for (let i = 0; i < 11; i += 1) await post(update(`Claim number ${i} is true.`));
    await waitForSends(11);
    expect(String(sent[10]!.body.text)).toMatch(/Slow down/);
  });
});

describe('source guard', () => {
  const src = readFileSync(path.join(__dirname, '..', 'src', 'routes', 'telegram-public.ts'), 'utf8');
  it('never reads the operator token and writes nothing', () => {
    expect(src).not.toMatch(/env\.TELEGRAM_BOT_TOKEN|\['TELEGRAM_BOT_TOKEN'\]/);
    expect(src).not.toMatch(/from '\.\.\/db'|\.insert\(|\.upsert\(|REAL_STAKING/);
  });
});
