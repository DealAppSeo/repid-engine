/**
 * Sprint A7 — POST /api/v1/agents-external/:id/score-event tests.
 *
 * Mocks the pipeline so the route's parameter validation + response shape
 * is verified without touching Supabase or HAL.
 */

(global as any)._api_key_versions_table_checked = true;

jest.mock('../src/scoring/pipeline', () => {
  const actual = jest.requireActual('../src/scoring/pipeline');
  return {
    ...actual,
    runScoreEvent: jest.fn(async (input: any) => {
      if (input.agent_id === '00000000-0000-4000-8000-000000000000') {
        throw new actual.NotFoundError(`Agent not found: ${input.agent_id}`);
      }
      if (input.idempotency_key === 'replay-key') {
        return {
          score_event_id: 7777,
          hal_score: 0.1,
          hal_decision: 'clean',
          signals: {},
          repid_delta_calculated: 1,
          repid_delta_applied: 1,
          old_repid: 1000,
          new_repid: 1001,
          zk_proof_triggered: false,
          zk_proof_id: null,
          reason: 'idempotent replay',
          idempotent_replay: true,
        };
      }
      return {
        score_event_id: 4242,
        hal_score: 0.15,
        hal_decision: 'clean',
        signals: { harm_probability: 0.1 },
        repid_delta_calculated: 1,
        repid_delta_applied: 1,
        old_repid: 1000,
        new_repid: 1001,
        zk_proof_triggered: false,
        zk_proof_id: null,
        reason: 'HAL clean',
      };
    }),
  };
});

// Avoid any unmocked DB hits via the auth middleware.
jest.mock('../src/db', () => ({
  db: {
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
    }),
    rpc: async () => ({ data: null, error: null }),
  },
}));

import request from 'supertest';
import app from '../src/index';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const MISSING_UUID = '00000000-0000-4000-8000-000000000000';

describe('POST /api/v1/agents-external/:id/score-event', () => {
  it('400s on non-UUID id', async () => {
    const res = await request(app)
      .post('/api/v1/agents-external/not-a-uuid/score-event')
      .send({ prompt: 'p', answer: 'a' });
    expect(res.status).toBe(400);
  });

  it('400s on missing prompt or answer', async () => {
    const res = await request(app)
      .post(`/api/v1/agents-external/${VALID_UUID}/score-event`)
      .send({ prompt: 'p' });
    expect(res.status).toBe(400);
  });

  it('200s with valid body and returns delta + new_repid', async () => {
    const res = await request(app)
      .post(`/api/v1/agents-external/${VALID_UUID}/score-event`)
      .send({
        prompt: 'What is 2+2?',
        answer: '4',
        provider_used: 'manual',
        idempotency_key: 'fresh-1',
      });
    expect(res.status).toBe(200);
    expect(res.body.score_event_id).toBe(4242);
    expect(res.body.new_repid).toBe(1001);
    expect(res.body.hal_decision).toBe('clean');
    expect(res.body.idempotent_replay).toBe(false);
  });

  it('returns same event_id when same idempotency_key is replayed', async () => {
    const res = await request(app)
      .post(`/api/v1/agents-external/${VALID_UUID}/score-event`)
      .send({
        prompt: 'p',
        answer: 'a',
        idempotency_key: 'replay-key',
      });
    expect(res.status).toBe(200);
    expect(res.body.score_event_id).toBe(7777);
    expect(res.body.idempotent_replay).toBe(true);
  });

  it('404s when agent does not exist', async () => {
    const res = await request(app)
      .post(`/api/v1/agents-external/${MISSING_UUID}/score-event`)
      .send({ prompt: 'p', answer: 'a' });
    expect(res.status).toBe(404);
  });
});
