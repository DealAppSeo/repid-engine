/**
 * V1-9 — Stripe Checkout for a catalog tier, inert until switched on. No test reaches Stripe or the
 * database: the catalog and fetch are injected.
 */
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const dbFrom = jest.fn();
jest.mock('../src/db', () => ({ db: { from: dbFrom, rpc: jest.fn() } }));

import { createPayRouter, payConfig, publicTiers, type CatalogTier } from '../src/routes/pay-checkout';

const CATALOG: CatalogTier[] = [
  { id: 1, tier_name: 'Free', stripe_price_id: 'price_free000', monthly_price_cents: 0 },
  { id: 2, tier_name: 'Starter', stripe_price_id: 'price_starter1', monthly_price_cents: 29900 },
  { id: 3, tier_name: 'Broken', stripe_price_id: 'not-a-price', monthly_price_cents: 100 },
];
const ON = { PAY_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: 'test-key-not-real', PAY_RETURN_ORIGIN: 'https://trustshell.dev' } as NodeJS.ProcessEnv;

function app(env: NodeJS.ProcessEnv, fetchImpl = jest.fn(), catalog: () => Promise<CatalogTier[] | null> = async () => CATALOG) {
  const a = express();
  a.use('/api/v1', createPayRouter({ env, fetchImpl, catalog, limit: 1000 }));
  return { a, fetchImpl };
}

function stripeOk(url = 'https://checkout.stripe.com/c/pay/cs_test_abc') {
  return jest.fn(async () => new Response(JSON.stringify({ id: 'cs_test_abc', url }), { status: 200 }));
}

describe('inert until both the switch and the key are set', () => {
  it.each([
    ['nothing set', {}],
    ['key only (a TrustTrader-era key on Railway must not turn this on)', { STRIPE_SECRET_KEY: 'k', PAY_RETURN_ORIGIN: 'https://trustshell.dev' }],
    ['switch only', { PAY_CHECKOUT_ENABLED: 'true', PAY_RETURN_ORIGIN: 'https://trustshell.dev' }],
    ['no return origin', { PAY_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: 'k' }],
    ['http return origin', { ...ON, PAY_RETURN_ORIGIN: 'http://trustshell.dev' }],
    ['origin with credentials', { ...ON, PAY_RETURN_ORIGIN: 'https://u:p@trustshell.dev' }],
  ])('%s → 503 NOT_CONFIGURED and no call', async (_n, env) => {
    const { a, fetchImpl } = app(env as NodeJS.ProcessEnv);
    const res = await request(a).post('/api/v1/pay/checkout').send({ tier_id: 2 });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('GET /pay/tiers says enabled:false and lists only priced tiers, with no Stripe ids', async () => {
    const { a } = app({});
    const res = await request(a).get('/api/v1/pay/tiers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, tiers: [{ id: 2, name: 'Starter', monthly_price_cents: 29900 }] });
    expect(JSON.stringify(res.body)).not.toContain('price_starter1');
  });
});

describe('when switched on', () => {
  it('creates a subscription Checkout Session for the catalog price and returns only the Stripe URL', async () => {
    const fetchImpl = stripeOk();
    const { a } = app(ON, fetchImpl);
    const res = await request(a).post('/api/v1/pay/checkout').send({ tier_id: 2, price: 'price_attacker', success_url: 'https://evil.example' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_abc' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key-not-real');
    const form = new URLSearchParams(String(init.body));
    expect(form.get('mode')).toBe('subscription');
    expect(form.get('line_items[0][price]')).toBe('price_starter1');
    expect(form.get('success_url')).toBe('https://trustshell.dev/pay/thanks?session_id={CHECKOUT_SESSION_ID}');
    expect(form.get('cancel_url')).toBe('https://trustshell.dev/pay/cancelled');
    expect(String(init.body)).not.toContain('evil.example');
    expect(String(init.body)).not.toContain('price_attacker');
  });

  it('does not sell a $0 tier, a malformed price id, or a tier not in the catalog (NOT_CHECKED, no call)', async () => {
    for (const tier_id of [1, 3, 99]) {
      const { a, fetchImpl } = app(ON);
      const res = await request(a).post('/api/v1/pay/checkout').send({ tier_id });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ tier_id, status: 'NOT_CHECKED' });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('rejects a tier_id that is not a positive integer', async () => {
    for (const tier_id of ['2', 2.5, -1, 0, null]) {
      const { a } = app(ON);
      const res = await request(a).post('/api/v1/pay/checkout').send({ tier_id });
      expect(res.status).toBe(400);
    }
  });

  it('an unreadable catalog is NOT_CHECKED, never an empty catalog', async () => {
    const { a, fetchImpl } = app(ON, jest.fn(), async () => null);
    expect((await request(a).post('/api/v1/pay/checkout').send({ tier_id: 2 })).body).toEqual({ status: 'NOT_CHECKED', reason: 'catalog_unreadable' });
    expect((await request(a).get('/api/v1/pay/tiers')).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a Stripe error, a non-Stripe URL or a network failure is 502 and echoes nothing from Stripe', async () => {
    const cases = [
      jest.fn(async () => new Response(JSON.stringify({ error: { message: 'No such price; a similar object exists in live mode' } }), { status: 400 })),
      stripeOk('https://evil.example/pay'),
      jest.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    ];
    for (const f of cases) {
      const { a } = app(ON, f);
      const res = await request(a).post('/api/v1/pay/checkout').send({ tier_id: 2 });
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ status: 'NOT_CHECKED', reason: 'checkout_unavailable' });
    }
  });
});

describe('pure helpers and source guard', () => {
  it('payConfig normalises the origin', () => {
    expect(payConfig({ ...ON, PAY_RETURN_ORIGIN: 'https://trustshell.dev/some/path?x=1' })?.returnOrigin).toBe('https://trustshell.dev');
    expect(publicTiers(CATALOG).map((t) => t.id)).toEqual([2]);
  });

  it('writes nothing and never logs or echoes the key', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'routes', 'pay-checkout.ts'), 'utf8');
    expect(src).not.toMatch(/\.insert\(|\.upsert\(|\.update\(|\.delete\(/);
    expect(src).not.toMatch(/console\.(log|info|warn|error)/);
    expect(src).not.toContain('REAL_STAKING');
    expect(dbFrom).not.toHaveBeenCalled();
  });
});
