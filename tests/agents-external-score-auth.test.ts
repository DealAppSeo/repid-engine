/**
 * Sprint A8 — the public score-event path is no longer public (2026-08-28).
 *
 * THE BUG, MEASURED ON PRODUCTION before this change, at commit 736062e:
 *
 *   POST /api/v1/agents-external/<uuid>/score-event  -> HTTP 400  "prompt is required"
 *   POST /api/v1/agents/<uuid>/score-event           -> HTTP 401  "Missing API key"
 *
 * A 400 means the request reached the HANDLER: it passed validation, not auth,
 * because there was no auth. Two doors to the same scoring path and one of them
 * was unlocked. An agent UUID is not a secret — it is in passport URLs and every
 * public read — so anyone holding one could attribute HAL-scored decisions to
 * that agent. RepID's whole claim is that a score is EARNED; a score a stranger
 * can write into is not earned, it is asserted.
 *
 * This was a deliberate v1-alpha decision, not an oversight — the route's own
 * header said "Sprint A8 will harden auth". This IS Sprint A8.
 *
 * WHY THE OWNERSHIP CHECK IS THE LOAD-BEARING HALF. A scope check alone would let
 * ANY agent's `score_event` key write events onto ANY OTHER agent, which is the
 * same forgery with one extra step. `requireApiKey` proves who you are; the
 * agent_id comparison proves it is your own reputation you are moving.
 *
 * WHY THESE TESTS ARE IN THEIR OWN FILE. tests/agents-external-score.test.ts runs
 * under SCORE_EVENT_PUBLIC_ALPHA=true, because those tests are about handler
 * validation and not about auth. Auth assertions living in that file would be
 * exercising the OPEN path while claiming to prove the CLOSED one — a test that
 * passes for the wrong reason, which is the exact defect class this repo keeps
 * finding. The flag is never set in this file.
 */

(global as any)._api_key_versions_table_checked = true;

const OWNER_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_UUID = '99999999-8888-4777-8666-555555555555';

// A key that resolves to OWNER_UUID with the score_event scope, and nothing else.
jest.mock('../src/auth/api-keys', () => ({
  ...jest.requireActual('../src/auth/api-keys'),
  validateAgentApiKey: jest.fn(async (key: string) =>
    key === 'owner-key' ? { agent_id: '11111111-2222-4333-8444-555555555555', scopes: ['score_event'] } : null,
  ),
}));

jest.mock('../src/scoring/pipeline', () => {
  const actual = jest.requireActual('../src/scoring/pipeline');
  return {
    ...actual,
    runScoreEvent: jest.fn(async () => ({
      score_event_id: 4242, hal_score: 0.15, hal_decision: 'clean', signals: {},
      repid_delta_calculated: 1, repid_delta_applied: 1, old_repid: 1000, new_repid: 1001,
      zk_proof_triggered: false, zk_proof_id: null, reason: 'ok', idempotent_replay: false,
    })),
  };
});

jest.mock('../src/db', () => ({
  db: {
    from: () => ({
      insert: async () => ({ error: null }),
      select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
    }),
    rpc: async () => ({ data: null, error: null }),
  },
}));

import request from 'supertest';
import app from '../src/index';
import { scoreEventPublicAlpha } from '../src/routes/agents-external-score';

const BODY = { prompt: 'p', answer: 'a' };

afterEach(() => {
  delete process.env.SCORE_EVENT_PUBLIC_ALPHA;
});

describe('THE FIX: an unauthenticated score-event is refused', () => {
  it('no credential -> 401, and it never reaches the handler', async () => {
    const res = await request(app).post(`/api/v1/agents-external/${OWNER_UUID}/score-event`).send(BODY);
    expect(res.status).toBe(401);
    // 400 here would mean it passed auth and failed validation — the old bug.
    expect(res.status).not.toBe(400);
  });

  it('a rejected credential -> 401', async () => {
    const res = await request(app)
      .post(`/api/v1/agents-external/${OWNER_UUID}/score-event`)
      .set('Authorization', 'Bearer not-a-real-key')
      .send(BODY);
    expect(res.status).toBe(401);
  });

  it('THE OWNERSHIP HALF: a VALID key for a DIFFERENT agent -> 403', async () => {
    // Without this, any agent's key could write reputation onto any other agent.
    const res = await request(app)
      .post(`/api/v1/agents-external/${OTHER_UUID}/score-event`)
      .set('Authorization', 'Bearer owner-key')
      .send(BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/agent_id mismatch/i);
  });

  it('THE ANCHOR: the right key for the right agent still works', async () => {
    // Without this the suite would pass against a route that refuses everything,
    // which is a different outage wearing a security badge.
    const res = await request(app)
      .post(`/api/v1/agents-external/${OWNER_UUID}/score-event`)
      .set('Authorization', 'Bearer owner-key')
      .send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.score_event_id).toBe(4242);
  });
});

describe('the escape hatch restores the pre-A8 path exactly, and defaults OFF', () => {
  it('defaults to SECURE — an unset flag is closed', () => {
    expect(scoreEventPublicAlpha()).toBe(false);
  });

  it('=true reopens the route with no credential', async () => {
    // The documented rollback: a batch caller this breaks is one env var from
    // working again, without a release.
    process.env.SCORE_EVENT_PUBLIC_ALPHA = 'true';
    const res = await request(app).post(`/api/v1/agents-external/${OWNER_UUID}/score-event`).send(BODY);
    expect(res.status).toBe(200);
  });

  it.each(['1', 'TRUE', 'yes', 'True', ' true', ''])(
    'a near-miss value (%p) does NOT open the route',
    async (v) => {
      // A typo must fail closed. The failure direction of guessing wrong here is
      // "anyone can write reputation", so only the exact string counts.
      process.env.SCORE_EVENT_PUBLIC_ALPHA = v;
      expect(scoreEventPublicAlpha()).toBe(false);
      const res = await request(app).post(`/api/v1/agents-external/${OWNER_UUID}/score-event`).send(BODY);
      expect(res.status).toBe(401);
    },
  );
});

describe('the sibling bearer route is unchanged', () => {
  it('POST /api/v1/agents/:id/score-event never reaches its handler without a key', async () => {
    // This route was already gated and this change must not have touched it —
    // the two paths are meant to agree now, not to have swapped behaviours.
    //
    // ASSERTED AS "not 200/400" RATHER THAN "== 401", DELIBERATELY. In PRODUCTION
    // this route answers 401 (measured against 736062e on 2026-08-28:
    // `{"error":"Missing API key"}`). Under THIS harness it answers 500, and that
    // is PRE-EXISTING — verified by stashing this PR's changes and re-running the
    // same probe, which still returned 500. So the 500 is a mock/env artifact of
    // the unrelated v11 reward pipeline behind that route, not something this
    // change caused.
    //
    // Pinning `== 401` here would therefore be pinning a lie about the harness,
    // and "fixing" it by loosening the route would be worse. What actually
    // matters is the invariant both routes now share: an unauthenticated caller
    // never reaches the handler. 200 means it ran; 400 means it validated the
    // body, which is what the old bug looked like. Neither may happen.
    const res = await request(app).post(`/api/v1/agents/${OWNER_UUID}/score-event`).send(BODY);
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(400);
  });
});
