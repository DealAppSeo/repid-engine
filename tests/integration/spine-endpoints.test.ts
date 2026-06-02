/**
 * S-SPINE Phase 8 — endpoint integration tests (supertest against the real app).
 *
 * Public endpoints are exercised end-to-end. Live-DB write paths (subscribe/track/vote) run only
 * when SUPABASE creds are present (the repo's integration posture) and clean up after themselves.
 *
 * Source creds first:
 *   set -a; source <(grep -E '^(SUPABASE_URL|SUPABASE_SERVICE_KEY)=' ../repid-engine-cc-crosscheck/.env); set +a
 *   npm run test:integration
 */

// Must be set BEFORE importing app (config.ts throws at import without these).
const HAVE_CREDS = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy-key-for-import';

import request from 'supertest';
import app from '../../src/index';
import { db } from '../../src/db';

const live = HAVE_CREDS ? describe : describe.skip;
const uniq = `spine-test-${process.pid}-${Math.floor(process.hrtime()[1] / 1000)}`;

describe('S-SPINE public endpoints (no DB needed)', () => {
  it('GET /providers lists providers with availability booleans', async () => {
    const res = await request(app).get('/api/v1/providers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.providers)).toBe(true);
    expect(res.body.providers.length).toBeGreaterThanOrEqual(8);
    for (const p of res.body.providers) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.available).toBe('boolean');
    }
    expect(typeof res.body.available_count).toBe('number');
  });

  it('POST /subscribe rejects an invalid email (400)', async () => {
    const res = await request(app).post('/api/v1/subscribe').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_email');
  });

  it('POST /comparison/vote rejects an invalid winner (400)', async () => {
    const res = await request(app).post('/api/v1/comparison/vote')
      .send({ session_id_left: 'a', session_id_right: 'b', winner: 'nope' });
    expect(res.status).toBe(400);
  });

  it('GET /unsubscribe rejects a malformed token (400)', async () => {
    const res = await request(app).get('/api/v1/unsubscribe?token=not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('POST /track rejects a missing ref_code (400)', async () => {
    const res = await request(app).post('/api/v1/track').send({ source_type: 'qr_code' });
    expect(res.status).toBe(400);
  });
});

live('S-SPINE live-DB endpoints', () => {
  const createdEmails: string[] = [];
  const createdRefIds: number[] = [];
  const createdVoteIds: number[] = [];

  afterAll(async () => {
    if (createdEmails.length) await db.from('email_subscribers').delete().in('email', createdEmails);
    if (createdRefIds.length) await db.from('referral_tracking').delete().in('id', createdRefIds);
    if (createdVoteIds.length) await db.from('comparison_votes').delete().in('id', createdVoteIds);
  });

  it('GET /leaderboard returns providers + integrity', async () => {
    const res = await request(app).get('/api/v1/leaderboard');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.providers)).toBe(true);
    expect(typeof res.body.total_evaluations).toBe('number');
    expect(['VALID', 'CHAIN_BREAK', 'UNVERIFIED']).toContain(res.body.integrity);
    // ranked ascending by avg risk among scored providers
    const scored = res.body.providers.filter((p: any) => p.total_evaluations > 0);
    for (let i = 1; i < scored.length; i++) expect(scored[i].avg_score).toBeGreaterThanOrEqual(scored[i - 1].avg_score);
  });

  it('GET /leaderboard/:provider 404s an unknown provider', async () => {
    const res = await request(app).get('/api/v1/leaderboard/this-provider-does-not-exist');
    expect(res.status).toBe(404);
  });

  it('POST /subscribe creates then 409s on duplicate', async () => {
    const email = `${uniq}@example.com`;
    createdEmails.push(email);
    const first = await request(app).post('/api/v1/subscribe').send({ email, source: 'trustchat', ref_code: 'qr_test' });
    expect([201, 200]).toContain(first.status);
    const dup = await request(app).post('/api/v1/subscribe').send({ email, source: 'trustchat' });
    expect(dup.status).toBe(409);
  });

  it('POST /track records a referral', async () => {
    const res = await request(app).post('/api/v1/track')
      .send({ ref_code: `${uniq}-ref`, source_type: 'qr_code', user_agent: 'jest' });
    expect(res.status).toBe(201);
    if (res.body.id) createdRefIds.push(res.body.id);
  });

  it('POST /comparison/vote stores a vote', async () => {
    const res = await request(app).post('/api/v1/comparison/vote').send({
      session_id_left: '00000000-0000-0000-0000-000000000001',
      session_id_right: '00000000-0000-0000-0000-000000000002',
      winner: 'left', prompt: 'which is more trustworthy',
    });
    expect(res.status).toBe(201);
    if (res.body.id) createdVoteIds.push(res.body.id);
  });

  it('PATCH /session/:id/rate 404s an unknown session', async () => {
    const res = await request(app).patch('/api/v1/session/00000000-0000-0000-0000-0000000000ff/rate')
      .send({ rating: 4, rating_feedback: 'thumbs_up' });
    expect(res.status).toBe(404);
  });

  it('GET /security/status returns posture with live RLS + audit fields', async () => {
    const res = await request(app).get('/api/v1/security/status');
    expect(res.status).toBe(200);
    expect(res.body.rls_status).toBeDefined();
    expect(res.body.audit_trail).toBeDefined();
    expect(res.body.authentication).toBeDefined();
    expect(res.body.tests.tsc_errors).toBe(0);
  });
});
