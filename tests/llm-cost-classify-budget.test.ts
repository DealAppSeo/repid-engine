/**
 * llm-cost-classify-budget.test.ts — the public /classify door (and the phone bot behind the same
 * classifier) cannot be turned into an unbounded provider bill by a crowd of rotating IPs.
 *
 * 2026-10-14, public LLM-cost abuse. The per-IP minute limit and daily cap bound one caller; the
 * SHARED budget (src/middleware/shared-budget.ts, CLASSIFY_GLOBAL_PER_MIN / CLASSIFY_GLOBAL_DAILY)
 * bounds all of them. Spent is fail-closed: not-checked by 'skipped' with a named reason, never a
 * pass, never a 500, logged loudly once per window.
 *
 * The classifier here is the REAL classifyTextWithPath with an env that holds the budget knobs and
 * no provider keys, so every voter abstains `no_key` before any request: nothing leaves the box, and
 * the budget (taken just before the votes) is exercised exactly as in production.
 */
import express from 'express';
import request from 'supertest';
import {
  createClassifyRouter,
  classifyTextWithPath,
  __resetClassifyGlobalBudget,
} from '../src/routes/classify';
import { budgetLimitFrom, createSharedBudget } from '../src/middleware/shared-budget';

const PROSE = 'The Eiffel Tower is in Berlin.';

function appWith(env: NodeJS.ProcessEnv, options: Record<string, unknown> = {}) {
  const app = express();
  app.use('/api/v1', createClassifyRouter({
    limit: 1000,
    dailyLimit: 0,
    classifier: (text) => classifyTextWithPath(text, 2000, env),
    ...options,
  }));
  return app;
}
const post = (app: express.Express, ip: string, text = PROSE) =>
  request(app).post('/api/v1/classify').set('X-Real-IP', ip).send({ text });

let err: jest.SpyInstance;
beforeEach(() => {
  __resetClassifyGlobalBudget();
  err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('/classify — per-IP and shared budgets', () => {
  it('a burst from ONE IP is limited per IP (429, not-checked)', async () => {
    const app = appWith({}, { limit: 3 });
    for (let i = 0; i < 3; i++) expect((await post(app, '203.0.113.7')).status).toBe(200);
    const res = await post(app, '203.0.113.7');
    expect(res.status).toBe(429);
    expect(res.body.label).toBe('not-checked');
  });

  it('a burst across ROTATING IPs trips the shared minute budget: not-checked with a named reason, logged once', async () => {
    const app = appWith({ CLASSIFY_GLOBAL_PER_MIN: '3' });
    const bodies = [];
    for (let i = 1; i <= 6; i++) bodies.push((await post(app, `198.51.100.${i}`)).body);
    // under the budget: an honest not-checked (no voter keys here), and no reason
    for (const b of bodies.slice(0, 3)) expect(b).toMatchObject({ label: 'not-checked', by: 'skipped' });
    for (const b of bodies.slice(0, 3)) expect(b.reason).toBeUndefined();
    // over it: still a 200 not-checked (never a pass, never a 500), now saying why
    for (const b of bodies.slice(3)) expect(b).toMatchObject({ label: 'not-checked', by: 'skipped', reason: 'global_minute_budget_spent' });
    const loud = err.mock.calls.filter((c) => /SHARED BUDGET SPENT \(global_minute_budget_spent\)/.test(String(c[0])));
    expect(loud).toHaveLength(1);
  });

  it('the shared DAILY budget trips too, with its own reason', async () => {
    const app = appWith({ CLASSIFY_GLOBAL_PER_MIN: 'off', CLASSIFY_GLOBAL_DAILY: '2' });
    await post(app, '198.51.100.1');
    await post(app, '198.51.100.2');
    expect((await post(app, '198.51.100.3')).body).toMatchObject({ label: 'not-checked', reason: 'global_daily_budget_spent' });
  });

  it('normal traffic is unaffected: under the defaults no reason ever appears', async () => {
    const app = appWith({});
    for (let i = 1; i <= 10; i++) expect((await post(app, `192.0.2.${i}`)).body.reason).toBeUndefined();
  });

  it('a check that sends nothing (the arithmetic path) spends nothing', async () => {
    const app = appWith({ CLASSIFY_GLOBAL_PER_MIN: '1' });
    expect((await post(app, '192.0.2.1', '2 + 2 = 4')).body.by).toMatch(/^arithmetic/);
    expect((await post(app, '192.0.2.2', '2 + 3 = 5')).body.by).toMatch(/^arithmetic/);
    // the one unit is still there for the first prose check
    expect((await post(app, '192.0.2.3')).body.reason).toBeUndefined();
    expect((await post(app, '192.0.2.4')).body.reason).toBe('global_minute_budget_spent');
  });

  it('a reason the classifier did not earn is dropped (only the two budget reasons pass through)', async () => {
    const app = appWith({}, { classifier: () => ({ label: 'not-checked', by: 'skipped', reason: 'made_up' } as never) });
    expect((await post(app, '192.0.2.9')).body.reason).toBeUndefined();
  });
});

describe('shared-budget', () => {
  it('a minute budget refuses within the minute and resets at the next one; refusals spend nothing', () => {
    const b = createSharedBudget('t');
    const t0 = Date.parse('2026-10-14T12:00:00.000Z');
    expect(b.take(2, 10, t0)).toBeNull();
    expect(b.take(2, 10, t0 + 1000)).toBeNull();
    expect(b.take(2, 10, t0 + 2000)).toBe('global_minute_budget_spent');
    expect(b.take(2, 10, t0 + 60_000)).toBeNull(); // next minute
    expect(b.take(2, 10, t0 + 61_000)).toBeNull();
    // 4 taken today (the refusal spent nothing), so the day allows 6 more across later minutes
    for (let m = 2; m < 5; m++) {
      expect(b.take(2, 10, t0 + m * 60_000)).toBeNull();
      expect(b.take(2, 10, t0 + m * 60_000 + 1)).toBeNull();
    }
    expect(b.take(2, 10, t0 + 5 * 60_000)).toBe('global_daily_budget_spent');
  });

  it('a new UTC day restores the daily budget', () => {
    const b = createSharedBudget('t');
    const day1 = Date.parse('2026-10-14T10:00:00.000Z');
    expect(b.take(0, 1, day1)).toBeNull();
    expect(b.take(0, 1, day1 + 1)).toBe('global_daily_budget_spent');
    expect(b.take(0, 1, Date.parse('2026-10-15T00:00:01.000Z'))).toBeNull();
  });

  it("'off' and 0 disable a window; junk falls back to the default", () => {
    expect([budgetLimitFrom('off', 9), budgetLimitFrom('0', 9), budgetLimitFrom('x', 9), budgetLimitFrom('5', 9), budgetLimitFrom(undefined, 9)]).toEqual([0, 0, 9, 5, 9]);
  });
});
