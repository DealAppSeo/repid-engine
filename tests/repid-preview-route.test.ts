/**
 * The keyless preview endpoints, driven through the real Express router.
 *
 * `src/routes/repid.ts` imports `../db`, so this suite exercises the router with
 * the same env dummies the rest of the repo uses. The preview handlers
 * themselves touch no database — which is the point, and is why these two routes
 * can answer with no credential and no row.
 *
 * The route-shadowing test is the one that earns its place. `/repid/preview`
 * would have been matched by `/repid/:agentId`, so it would work only while it
 * happened to be registered first, and would silently shadow any agent slugged
 * "preview". The two-segment paths make that impossible; this pins it so a later
 * "tidy up the URLs" change has to notice.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import express from 'express';
import request from 'supertest';
import { repidPublicRouter } from '../src/routes/repid';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', repidPublicRouter);
  return app;
}

describe('GET /api/v1/repid/preview/actions', () => {
  it('answers with no credential at all', async () => {
    const res = await request(makeApp()).get('/api/v1/repid/preview/actions');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('labels the whole payload APPROXIMATE and unpersisted', async () => {
    const res = await request(makeApp()).get('/api/v1/repid/preview/actions');
    expect(res.body.measurement).toBe('APPROXIMATE');
    expect(res.body.persisted).toBe(false);
  });

  it('lists the actions it cannot price rather than hiding them', async () => {
    const res = await request(makeApp()).get('/api/v1/repid/preview/actions');
    const verdicts = new Set(res.body.actions.map((a: { verdict: string }) => a.verdict));
    expect(verdicts.has('APPROXIMATE')).toBe(true);
    expect(verdicts.has('NOT_CHECKED')).toBe(true);
    const stake = res.body.actions.find((a: { eventType: string }) => a.eventType === 'STAKE');
    expect(stake.verdict).toBe('NOT_CHECKED');
    expect(stake.delta).toBeNull();
  });
});

describe('GET /api/v1/repid/preview/project', () => {
  it('projects from the default baseline with no query at all', async () => {
    const res = await request(makeApp()).get('/api/v1/repid/preview/project');
    expect(res.status).toBe(200);
    expect(res.body.baseRepId).toBe(200);
    expect(res.body.projectedRepId).toBe(200);
    expect(res.body.events).toEqual([]);
  });

  it('prices a sequence of actions', async () => {
    const res = await request(makeApp())
      .get('/api/v1/repid/preview/project')
      .query({ events: 'CODE_CONTRIBUTION,REFERRAL' });
    expect(res.status).toBe(200);
    expect(res.body.projectedRepId).toBe(200 + 25 + 20);
    expect(res.body.projectedTier).toBe('PROBATIONARY');
    expect(res.body.tierCaveat).toMatch(/counterparties/);
  });

  it('rejects an out-of-range base instead of quietly clamping it', async () => {
    const res = await request(makeApp())
      .get('/api/v1/repid/preview/project')
      .query({ base: '999999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_base');
  });

  it('rejects a non-numeric base', async () => {
    const res = await request(makeApp())
      .get('/api/v1/repid/preview/project')
      .query({ base: 'ESTABLISHED' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_base');
  });

  it('bounds the number of events per request', async () => {
    const res = await request(makeApp())
      .get('/api/v1/repid/preview/project')
      .query({ events: Array(51).fill('REFERRAL').join(',') });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('too_many_events');
  });

  it('returns FAILED for an unknown action without failing the request', async () => {
    const res = await request(makeApp())
      .get('/api/v1/repid/preview/project')
      .query({ events: 'REFERRAL,FREE_REPUTATION_PLEASE' });
    expect(res.status).toBe(200);
    expect(res.body.events[1].verdict).toBe('FAILED');
    // The unknown action contributes nothing to the projection.
    expect(res.body.projectedRepId).toBe(200 + 20);
  });
});

describe('the preview paths do not shadow an agent lookup', () => {
  it('leaves /repid/:agentId free to match a slug of "preview"', () => {
    // Route patterns, read off the router itself: no registered path is the
    // single segment `/repid/preview`, so an agent slugged "preview" still
    // resolves through `/repid/:agentId`.
    const paths = (repidPublicRouter as unknown as { stack: Array<{ route?: { path: string } }> })
      .stack.map((layer) => layer.route?.path).filter(Boolean);
    expect(paths).toContain('/repid/preview/actions');
    expect(paths).toContain('/repid/preview/project');
    expect(paths).not.toContain('/repid/preview');
    expect(paths).toContain('/repid/:agentId');
  });
});
