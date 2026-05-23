/**
 * HAL Enrichment Phase 3 — payload.json hal_summary tests.
 *
 * GET /api/v1/agents/:id/reputation/payload.json should now include a
 * hal_summary built from repid_score_events (via mocked pgQuery), be
 * backward-compatible on every existing field, and degrade gracefully
 * (hal_summary: null) when the query throws.
 */
import express from 'express';
import request from 'supertest';

(global as any).__halRows = [];
(global as any).__pgThrow = false;

jest.mock('../src/db/direct-pg', () => ({
  pgQuery: async () => {
    if ((global as any).__pgThrow) throw new Error('[direct-pg] DATABASE_URL not set');
    return (global as any).__halRows;
  },
}));

import { createAgentsReputationRouter } from '../src/routes/agents-reputation';

const AGENT_ID = '11111111-2222-4333-8444-555555555555';

function makeApp(agentRow: any) {
  const supabase: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: agentRow, error: agentRow ? null : { message: 'not found' } }),
        }),
      }),
    }),
  };
  const app = express();
  app.use('/api/v1', createAgentsReputationRouter(supabase));
  return app;
}

const AGENT_ROW = {
  id: AGENT_ID,
  agent_name: 'trinity-test',
  current_repid: 2000,
  tier: 'ESTABLISHED',
  erc8004_token_id: '42',
  mint_chain_id: 84532,
  last_reputation_written_at: null,
};

beforeEach(() => {
  (global as any).__pgThrow = false;
  (global as any).__halRows = [
    { event_type: 'SERVICE_FULFILLED', hal_score: 0.2, hal_decision: 'clean', created_at: '2026-05-23T03:00:00Z' },
    { event_type: 'SERVICE_FULFILLED', hal_score: 0.6, hal_decision: 'flagged', created_at: '2026-05-23T02:00:00Z' },
    { event_type: 'VALIDATOR_REWARD', hal_score: null, hal_decision: 'clean', created_at: '2026-05-23T01:00:00Z' },
  ];
});

describe('payload.json — hal_summary', () => {
  test('1. includes hal_summary with recent_events + aggregate + counts', async () => {
    const res = await request(makeApp(AGENT_ROW)).get(`/api/v1/agents/${AGENT_ID}/reputation/payload.json`);
    expect(res.status).toBe(200);
    expect(res.body.hal_summary).toBeTruthy();
    expect(res.body.hal_summary.recent_events).toHaveLength(3);
    expect(res.body.hal_summary.sample_size).toBe(3);
    expect(res.body.hal_summary.flagged_count).toBe(1);
    expect(res.body.hal_summary.veto_count).toBe(0);
  });

  test('2. aggregate_hal_score averages only numeric scores (0.2,0.6 → 0.4)', async () => {
    const res = await request(makeApp(AGENT_ROW)).get(`/api/v1/agents/${AGENT_ID}/reputation/payload.json`);
    expect(res.body.hal_summary.aggregate_hal_score).toBeCloseTo(0.4, 5);
  });

  test('3. recent_events preserve DESC order + shape from the query', async () => {
    const res = await request(makeApp(AGENT_ROW)).get(`/api/v1/agents/${AGENT_ID}/reputation/payload.json`);
    const ev = res.body.hal_summary.recent_events;
    expect(ev[0].timestamp).toBe('2026-05-23T03:00:00Z');
    expect(ev[2].timestamp).toBe('2026-05-23T01:00:00Z');
    expect(ev[0]).toEqual({ type: 'SERVICE_FULFILLED', hal_score: 0.2, hal_decision: 'clean', timestamp: '2026-05-23T03:00:00Z' });
  });

  test('4. backward compat: existing fields unchanged', async () => {
    const res = await request(makeApp(AGENT_ROW)).get(`/api/v1/agents/${AGENT_ID}/reputation/payload.json`);
    expect(res.body.version).toBe('hyperdag-feedback-v1');
    expect(res.body.value).toBe(2000);
    expect(res.body.valueDecimals).toBe(0);
    expect(res.body.tags).toEqual({ hyperdag_repid: true, tier: 'ESTABLISHED' });
    expect(res.body.hyperdag.tier).toBe('ESTABLISHED');
    expect(res.body.agentId).toBe('42');
  });

  test('5. graceful degradation: pgQuery throws → hal_summary null, payload otherwise intact', async () => {
    (global as any).__pgThrow = true;
    const res = await request(makeApp(AGENT_ROW)).get(`/api/v1/agents/${AGENT_ID}/reputation/payload.json`);
    expect(res.status).toBe(200);
    expect(res.body.hal_summary).toBeNull();
    expect(res.body.value).toBe(2000); // rest of payload unaffected
  });

  test('6. 404 when agent not minted (token_id missing) — unchanged', async () => {
    const res = await request(makeApp({ ...AGENT_ROW, erc8004_token_id: null })).get(
      `/api/v1/agents/${AGENT_ID}/reputation/payload.json`
    );
    expect(res.status).toBe(404);
  });
});
