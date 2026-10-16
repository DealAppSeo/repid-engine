/**
 * [S2-4, 2026-10-16] Outbound webhooks: operator-registered, public https only, HMAC-signed with a
 * required secret.
 *
 * Before: any API key could register any URL; fireWebhook POSTed engine events there with the
 * caller's chosen value in an x-api-key header; the score_event and notify paths signed with
 * `secret || ''`; nothing checked the scheme, the address or a redirect.
 */
import { createHmac } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const lookup = jest.fn();
jest.mock('node:dns/promises', () => ({ lookup: (...a: unknown[]) => lookup(...a) }));
jest.mock('../src/services/stake-vault', () => ({ snapshotAuthority: jest.fn(), getCurrentStake: jest.fn() }));

const inserted: Array<Record<string, unknown>> = [];
let webhookRows: Array<{ url: string; api_key: string | null }> = [];
jest.mock('../src/db', () => {
  const chain: any = {};
  for (const m of ['select', 'eq', 'contains']) chain[m] = () => chain;
  chain.then = (res: any, rej: any) => Promise.resolve({ data: webhookRows, error: null }).then(res, rej);
  chain.insert = (row: Record<string, unknown>) => {
    inserted.push(row);
    return { select: () => ({ single: async () => ({ data: { id: 'w1', url: row.url, events: row.events, active: true }, error: null }) }) };
  };
  return { db: { from: () => chain, rpc: jest.fn() } };
});

import express from 'express';
import request from 'supertest';
import v1Router from '../src/routes/v1';
import { deliverSignedWebhook } from '../src/services/webhook-delivery';
import { fireWebhook } from '../src/services/webhook';

const SECRET = 'a'.repeat(32);
const PUBLIC = [{ address: '93.184.215.14', family: 4 }];
let fetchMock: jest.Mock;

beforeEach(() => {
  inserted.length = 0;
  webhookRows = [];
  lookup.mockReset().mockResolvedValue(PUBLIC);
  fetchMock = jest.fn(async () => ({ ok: true, status: 200, headers: new Headers() }));
  (global as any).fetch = fetchMock;
});
afterAll(() => { delete (global as any).fetch; });

describe('deliverSignedWebhook', () => {
  it.each([[''], [null], [undefined]])('refuses an empty secret %p and sends nothing', async (secret) => {
    const r = await deliverSignedWebhook('https://hooks.example.com/x', secret as any, '{}');
    expect(r).toEqual({ ok: false, error: 'no_webhook_secret' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'http://hooks.example.com/x',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/x',
    'https://[::1]/x',
    'https://user:pw@hooks.example.com/x',
  ])('refuses %s', async (url) => {
    const r = await deliverSignedWebhook(url, SECRET, '{}');
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a public-looking name that resolves to a private address', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.7', family: 4 }]);
    const r = await deliverSignedWebhook('https://rebind.example.com/x', SECRET, '{}');
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-checks a redirect: a hop to a private address is not followed', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 307, headers: new Headers({ location: 'https://10.0.0.7/steal' }) });
    const r = await deliverSignedWebhook('https://hooks.example.com/x', SECRET, '{}');
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('signs the body with HMAC-SHA256 and never sends the secret', async () => {
    const body = '{"event":"e"}';
    const r = await deliverSignedWebhook('https://hooks.example.com/x', SECRET, body);
    expect(r).toEqual({ ok: true, status: 200 });
    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(init.headers['X-Webhook-Signature']).toBe(createHmac('sha256', SECRET).update(body).digest('hex'));
    expect(init.redirect).toBe('manual');
    expect(JSON.stringify(init)).not.toContain(SECRET);
  });
});

describe('fireWebhook (repid_webhooks)', () => {
  it('a row with no secret gets nothing; a row with one gets a signed POST and no x-api-key', async () => {
    webhookRows = [{ url: 'https://a.example.com/h', api_key: '' }, { url: 'https://b.example.com/h', api_key: SECRET }];
    await fireWebhook('proof.verified', { x: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe('https://b.example.com/h');
    expect(init.headers['x-api-key']).toBeUndefined();
    expect(init.headers['X-Webhook-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('POST /api/v1/webhooks/register', () => {
  const app = express();
  app.use(express.json());
  // Stands in for authMiddleware: an operator key is an env key with tier 'ops' and no agent binding.
  app.use((req, _res, next) => {
    const who = req.header('x-test-caller');
    if (who === 'operator') (req as any).apiKey = { key: 'k', tier: 'ops', envIndex: 0 };
    if (who === 'agent') { (req as any).apiKey = { key: 'k', tier: 'testnet' }; (req as any).agent_id = 'aaaaaaaa-1111-2222-3333-444444444444'; }
    next();
  });
  app.use('/api/v1', v1Router);
  const ok = { url: 'https://hooks.example.com/h', events: ['proof.verified'], secret: SECRET };

  it.each(['agent', 'none'])('a %s caller → 403, nothing stored', async (who) => {
    const res = await request(app).post('/api/v1/webhooks/register').set('x-test-caller', who).send(ok);
    expect(res.status).toBe(403);
    expect(inserted).toEqual([]);
  });

  it.each([
    ['no secret', { ...ok, secret: undefined }],
    ['a short secret', { ...ok, secret: 'short' }],
    ['an http url', { ...ok, url: 'http://hooks.example.com/h' }],
    ['a metadata url', { ...ok, url: 'https://169.254.169.254/' }],
  ])('operator with %s → 400, nothing stored', async (_why, body) => {
    const res = await request(app).post('/api/v1/webhooks/register').set('x-test-caller', 'operator').send(body);
    expect(res.status).toBe(400);
    expect(inserted).toEqual([]);
  });

  it('operator with a public https url and a secret → stored, and the secret is not echoed', async () => {
    const res = await request(app).post('/api/v1/webhooks/register').set('x-test-caller', 'operator').send(ok);
    expect(res.status).toBe(200);
    expect(inserted[0]).toEqual({ url: ok.url, events: ok.events, api_key: SECRET });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});

describe('no outbound webhook fetch bypasses deliverSignedWebhook', () => {
  it('src/ has no direct fetch of a stored webhook URL', () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(f) && /\b(fetch|fetchWithTimeout)\(\s*(\(agent as any\)\.webhook_url|wh\.url|cfg\.url)/.test(readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(join(__dirname, '../src'));
    expect(hits).toEqual([]);
  });
});
