/**
 * Phase 5 (CC 2026-06-24) — durable GET /api/v1/llm-trust.
 *
 * Proves the route degrades FAST (503) when the leaderboard read fails/times out, instead of
 * hanging on an unbounded supabase-js/PostgREST call (the prod 000 symptom — RULE-8 violation).
 * The read now goes through pgQuery (timeout + circuit breaker). Happy path still returns the
 * aggregated provider leaderboard; an empty leaderboard returns 200 [].
 */

// Dummy creds so config.ts boots; the real supabase client is mocked below so these never connect.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

(global as any).__llmTrustRows = [];
(global as any).__llmTrustThrow = false;

// Control the bounded read. index.ts imports BOTH pgPing and pgQuery from this module.
jest.mock('../src/db/direct-pg', () => ({
  pgPing: async () => ({ ok: true, latencyMs: 1 }),
  pgQuery: async () => {
    if ((global as any).__llmTrustThrow) {
      throw new Error('[direct-pg] query timeout after 5000ms: llm-trust-leaderboard');
    }
    return (global as any).__llmTrustRows;
  },
}));

// index.ts constructs the supabase client via ../src/db; mock it so boot needs no real creds.
jest.mock('../src/db', () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    not: () => chain,
    order: () => chain,
    limit: () => chain,
    single: async () => ({ data: null, error: null }),
    insert: () => ({ then: (r: any) => r({ data: null, error: null }) }),
    upsert: () => ({ then: (r: any) => r({ data: null, error: null }) }),
    then: (r: any) => r({ data: [], error: null }),
  };
  return { db: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});

import request from 'supertest';
import app from '../src/index';

beforeEach(() => {
  (global as any).__llmTrustRows = [];
  (global as any).__llmTrustThrow = false;
});

describe('GET /api/v1/llm-trust — durable (RULE-8)', () => {
  it('503 FAST when the bounded read throws/times out (no hang)', async () => {
    (global as any).__llmTrustThrow = true;
    const res = await request(app).get('/api/v1/llm-trust');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporarily unavailable/i);
    expect(res.body.detail).toMatch(/timeout/i);
  });

  it('200 with aggregated provider leaderboard on success', async () => {
    (global as any).__llmTrustRows = [
      { llm_provider: 'groq', llm_model: 'llama', total_decisions: 10, hallucinations_caught: 2, trust_score_pct: 80, avg_certainty: 0.9, agents_using: 3, last_decision: '2026-06-20T00:00:00Z' },
      { llm_provider: 'OpenAI', llm_model: 'gpt', total_decisions: 5, hallucinations_caught: 1, trust_score_pct: 60, avg_certainty: 0.7, agents_using: 1, last_decision: '2026-06-21T00:00:00Z' },
    ];
    const res = await request(app).get('/api/v1/llm-trust');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // groq + OpenAI(→openai) are both canonical → 2 provider-level rows.
    const providers = res.body.map((r: any) => r.llm_provider).sort();
    expect(providers).toEqual(['groq', 'openai']);
    const groq = res.body.find((r: any) => r.llm_provider === 'groq');
    expect(groq.total_decisions).toBe(10);
    expect(groq.hallucination_rate_pct).toBe(20);
  });

  it('empty leaderboard → 200 []', async () => {
    (global as any).__llmTrustRows = [];
    const res = await request(app).get('/api/v1/llm-trust');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
