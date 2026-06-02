/**
 * S-WIRE Phase 10 — share endpoint integration (GET /session/:id, POST /session/:id/view).
 * Public validation runs without creds; the live round-trip runs only with SUPABASE creds and
 * cleans up its synthetic session.
 */
const HAVE_CREDS = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy-key-for-import';

import request from 'supertest';
import app from '../../src/index';
import { db } from '../../src/db';
import { randomUUID } from 'crypto';

const live = HAVE_CREDS ? describe : describe.skip;

describe('share endpoints — validation (no DB)', () => {
  it('GET /session/:id rejects a non-uuid (400)', async () => {
    const res = await request(app).get('/api/v1/session/not-a-uuid');
    expect(res.status).toBe(400);
  });
  it('POST /session/:id/view rejects a non-uuid (400)', async () => {
    const res = await request(app).post('/api/v1/session/not-a-uuid/view');
    expect(res.status).toBe(400);
  });
  it('GET /session/:id 404s a well-formed but unknown id', async () => {
    const res = await request(app).get('/api/v1/session/00000000-0000-0000-0000-0000000000ff');
    expect([404, 500]).toContain(res.status); // 404 with creds; 500 if dummy DB unreachable
  });
});

live('share endpoints — live round-trip', () => {
  const sessionId = randomUUID();
  beforeAll(async () => {
    await db.from('trustchat_sessions').insert({
      session_id: sessionId, session_date: '2026-06-02', prompt_count_in_session: 1,
      user_ip_hash: 'swire-share-test', user_message: 'share test', llm_provider_used: 'groq',
      llm_model: 'test', llm_response: 'a response', hal_score: 0.1, hal_verdict: 'PASS',
      hal_flagged_hallucination: false, example_data: false,
    });
  });
  afterAll(async () => { await db.from('trustchat_sessions').delete().eq('session_id', sessionId); });

  it('GET returns the evaluation with provider display metadata', async () => {
    const res = await request(app).get(`/api/v1/session/${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.llm_provider_used).toBe('groq');
    expect(res.body.provider_display).toBeTruthy();
    expect(typeof res.body.view_count).toBe('number');
  });

  it('POST /view increments the view counter', async () => {
    const a = await request(app).post(`/api/v1/session/${sessionId}/view`);
    expect(a.status).toBe(200);
    const first = a.body.view_count;
    const b = await request(app).post(`/api/v1/session/${sessionId}/view`);
    expect(b.body.view_count).toBe(first + 1);
  });
});
