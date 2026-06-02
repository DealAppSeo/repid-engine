/**
 * CC2 2026-05-27 — peer-verify/respond endpoint tests.
 *
 * Covers the rewritten POST /respond:
 *   * body-shape validation (5 required fields, allowlist verdict, hex signature)
 *   * agent resolution failure → 404
 *   * HMAC validation against both secret schemes (PEER_VERIFY_HMAC_SECRET and
 *     the per-agent <NAME>_PRIVATE_KEY scheme)
 *   * idempotency: an UPDATE that matches 0 rows due to a prior `verified` row
 *     → 409 Conflict (not 400 as the pre-rewrite endpoint returned)
 *   * self-verification guard (verifier == source)
 *   * not-found probe (UPDATE matched 0, probe found nothing) → 404
 *   * matched_via metadata in the success body
 *   * non-verified verdicts (disputed) still go through
 */

import crypto from 'crypto';

// ------------------------------ mocks ---------------------------------------
// These globals are read inside the hoisted jest.mock factories below.
(global as any).__pvAgentRow = null;
(global as any).__pvAgentErr = null;
(global as any).__pvUpdateRows = [];
(global as any).__pvProbeRows = [];
(global as any).__pvTaskRows = [];

// pgQuery is destructured by the route handler; we replace it with a jest.fn
// that consults the test-controlled globals based on the `label` opt.
const pgQueryMock = jest.fn(async (_sql: string, _params: any[], opts?: any) => {
  const label = opts?.label ?? '';
  if (label === 'peer-verify-respond') return (global as any).__pvUpdateRows;
  if (label === 'peer-verify-probe') return (global as any).__pvProbeRows;
  return [];
});

jest.mock('../src/db/direct-pg', () => ({
  pgQuery: (...args: any[]) => pgQueryMock(...(args as [any, any, any])),
  pgPing: jest.fn(async () => true),
}));

jest.mock('../src/db', () => {
  return {
    db: {
      from: (tableName: string) => {
        if (tableName === 'repid_agents') {
          return {
            select: () => ({
              or: () => ({
                single: async () => ({
                  data: (global as any).__pvAgentRow,
                  error: (global as any).__pvAgentErr,
                }),
              }),
            }),
          };
        }
        if (tableName === 'trinity_tasks') {
          const chain: any = {
            select: () => chain,
            eq: () => chain,
            in: () => chain,
            update: () => ({ eq: async () => ({ data: null, error: null }) }),
            then: (resolve: any) => resolve({ data: (global as any).__pvTaskRows, error: null }),
          };
          return chain;
        }
        return { select: () => ({}) };
      },
      rpc: async () => ({ data: null, error: null }),
    },
  };
});

import request from 'supertest';
import express from 'express';
import peerVerificationRouter from '../src/routes/peer-verification';

// ------------------------------ helpers -------------------------------------
function sign(secret: string, queueId: string | number, responseId: string, verdict: string): string {
  const data = `${queueId}:${responseId}:${verdict}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function freshApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/peer-verify', peerVerificationRouter);
  return app;
}

const AGENT_NAME = 'trinity-shofet';
const AGENT_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SOURCE_UUID = '11111111-2222-4333-8444-555555555555';
const RESPONSE_UUID = '99999999-8888-4777-8666-555555555555';
const QUEUE_ID = 42;

// ------------------------------ tests ---------------------------------------
describe('POST /api/v1/peer-verify/respond — body-shape validation', () => {
  beforeEach(() => {
    (global as any).__pvAgentRow = null;
    (global as any).__pvAgentErr = null;
    pgQueryMock.mockClear();
    delete process.env.PEER_VERIFY_HMAC_SECRET;
    delete process.env.SHOFET_PRIVATE_KEY;
    delete process.env.TRUSTRAILS_HMAC_SECRET;
  });

  test('missing field → 400', async () => {
    const app = freshApp();
    const res = await request(app).post('/api/v1/peer-verify/respond').send({
      queue_id: QUEUE_ID,
      verifier_agent_id: AGENT_NAME,
      // verifier_response_id intentionally missing
      verdict: 'verified',
      signature: 'deadbeef',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  test('verdict not in allowlist → 400', async () => {
    const app = freshApp();
    const res = await request(app).post('/api/v1/peer-verify/respond').send({
      queue_id: QUEUE_ID,
      verifier_agent_id: AGENT_NAME,
      verifier_response_id: RESPONSE_UUID,
      verdict: 'approved', // not in ['verified','disputed','timeout']
      signature: 'deadbeef',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid verdict/);
  });

  test('non-hex signature → 400', async () => {
    const app = freshApp();
    const res = await request(app).post('/api/v1/peer-verify/respond').send({
      queue_id: QUEUE_ID,
      verifier_agent_id: AGENT_NAME,
      verifier_response_id: RESPONSE_UUID,
      verdict: 'verified',
      signature: 'not-hex-at-all!',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hex/);
  });
});

describe('POST /api/v1/peer-verify/respond — agent resolution', () => {
  beforeEach(() => {
    pgQueryMock.mockClear();
    process.env.PEER_VERIFY_HMAC_SECRET = 'test-global-secret';
  });
  afterEach(() => {
    delete process.env.PEER_VERIFY_HMAC_SECRET;
  });

  test('unknown verifier_agent_id → 404 (no HMAC work performed)', async () => {
    (global as any).__pvAgentRow = null;
    (global as any).__pvAgentErr = { message: 'not found' };
    const app = freshApp();
    const res = await request(app).post('/api/v1/peer-verify/respond').send({
      queue_id: QUEUE_ID,
      verifier_agent_id: 'trinity-ghost',
      verifier_response_id: RESPONSE_UUID,
      verdict: 'verified',
      signature: 'a'.repeat(64),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/);
    expect(pgQueryMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/peer-verify/respond — HMAC validation', () => {
  beforeEach(() => {
    (global as any).__pvAgentRow = { id: AGENT_UUID, agent_name: AGENT_NAME };
    (global as any).__pvAgentErr = null;
    (global as any).__pvUpdateRows = [];
    (global as any).__pvProbeRows = [];
    (global as any).__pvTaskRows = [];
    pgQueryMock.mockClear();
    delete process.env.PEER_VERIFY_HMAC_SECRET;
    delete process.env.SHOFET_PRIVATE_KEY;
    delete process.env.TRUSTRAILS_HMAC_SECRET;
  });

  test('bad HMAC (correctly-formed hex but wrong digest) → 401, no UPDATE issued', async () => {
    process.env.PEER_VERIFY_HMAC_SECRET = 'test-global-secret';
    const app = freshApp();
    const res = await request(app).post('/api/v1/peer-verify/respond').send({
      queue_id: QUEUE_ID,
      verifier_agent_id: AGENT_NAME,
      verifier_response_id: RESPONSE_UUID,
      verdict: 'verified',
      signature: 'a'.repeat(64), // valid hex, wrong digest
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid verifier signature/);
    // Importantly: HMAC failure short-circuits BEFORE any DB write
    expect(pgQueryMock).not.toHaveBeenCalled();
  });

  test('good HMAC via PEER_VERIFY_HMAC_SECRET (sprint-spec primary) → 200', async () => {
    process.env.PEER_VERIFY_HMAC_SECRET = 'test-global-secret';
    const sig = sign('test-global-secret', QUEUE_ID, RESPONSE_UUID, 'verified');
    (global as any).__pvUpdateRows = [
      {
        id: QUEUE_ID,
        source_agent_id: SOURCE_UUID,
        verifier_agent_id: AGENT_UUID,
        verifier_response_id: RESPONSE_UUID,
        verifier_signature: sig,
        verification_status: 'verified',
        completed_at: '2026-05-27T03:00:00Z',
        claim_text: 'TEST CLAIM',
        certainty_at_claim: 0.8,
        threshold_used: 0.85,
      },
    ];
    const app = freshApp();
    const res = await request(app).post('/api/v1/peer-verify/respond').send({
      queue_id: QUEUE_ID,
      verifier_agent_id: AGENT_NAME,
      verifier_response_id: RESPONSE_UUID,
      verdict: 'verified',
      signature: sig,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.verdict).toBe('verified');
    expect(res.body.agreement_score).toBe(1.0);
    expect(res.body.matched_via).toBe('global');
    expect(pgQueryMock).toHaveBeenCalledTimes(1); // happy path = single UPDATE, no probe
  });

  test('good HMAC via per-agent SHOFET_PRIVATE_KEY (back-compat path) → 200', async () => {
    // No global secret set; verifier-name-derived per-agent secret must work.
    process.env.SHOFET_PRIVATE_KEY = 'shofet-only-secret';
    const sig = sign('shofet-only-secret', QUEUE_ID, RESPONSE_UUID, 'disputed');
    (global as any).__pvUpdateRows = [
      {
        id: QUEUE_ID,
        source_agent_id: SOURCE_UUID,
        verifier_agent_id: AGENT_UUID,
        verifier_response_id: RESPONSE_UUID,
        verifier_signature: sig,
        verification_status: 'disputed',
        completed_at: '2026-05-27T03:01:00Z',
        claim_text: 'TEST CLAIM',
        certainty_at_claim: 0.8,
        threshold_used: 0.85,
      },
    ];
    const app = freshApp();
    const res = await request(app).post('/api/v1/peer-verify/respond').send({
      queue_id: QUEUE_ID,
      verifier_agent_id: AGENT_NAME,
      verifier_response_id: RESPONSE_UUID,
      verdict: 'disputed',
      signature: sig,
    });
    expect(res.status).toBe(200);
    expect(res.body.matched_via).toBe('per_agent');
    expect(res.body.verdict).toBe('disputed');
    expect(res.body.agreement_score).toBe(0.0); // disputed = 0
  });

  test('global secret set but signed with wrong secret → 401 (no silent fall-through to plain ==)', async () => {
    process.env.PEER_VERIFY_HMAC_SECRET = 'test-global-secret';
    // sign with a DIFFERENT secret; correct format but wrong digest
    const sig = sign('attacker-knows-format-not-secret', QUEUE_ID, RESPONSE_UUID, 'verified');
    const app = freshApp();
    const res = await request(app).post('/api/v1/peer-verify/respond').send({
      queue_id: QUEUE_ID,
      verifier_agent_id: AGENT_NAME,
      verifier_response_id: RESPONSE_UUID,
      verdict: 'verified',
      signature: sig,
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/peer-verify/respond — atomic UPDATE outcomes', () => {
  beforeEach(() => {
    (global as any).__pvAgentRow = { id: AGENT_UUID, agent_name: AGENT_NAME };
    (global as any).__pvAgentErr = null;
    (global as any).__pvUpdateRows = [];
    (global as any).__pvProbeRows = [];
    (global as any).__pvTaskRows = [];
    pgQueryMock.mockClear();
    process.env.PEER_VERIFY_HMAC_SECRET = 'test-global-secret';
  });
  afterEach(() => {
    delete process.env.PEER_VERIFY_HMAC_SECRET;
  });

  test('idempotency: row already verified → 409 Conflict (not 200, not 400)', async () => {
    const sig = sign('test-global-secret', QUEUE_ID, RESPONSE_UUID, 'verified');
    (global as any).__pvUpdateRows = []; // UPDATE matched 0 rows
    (global as any).__pvProbeRows = [
      { verification_status: 'verified', source_agent_id: SOURCE_UUID },
    ];
    const app = freshApp();
    const res = await request(app).post('/api/v1/peer-verify/respond').send({
      queue_id: QUEUE_ID,
      verifier_agent_id: AGENT_NAME,
      verifier_response_id: RESPONSE_UUID,
      verdict: 'verified',
      signature: sig,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already processed/);
    expect(res.body.current_status).toBe('verified');
    // Probe issued exactly once after the 0-row UPDATE
    expect(pgQueryMock).toHaveBeenCalledTimes(2);
  });

  test('self-verify: verifier == source → 400 (UPDATE matched 0; probe disambiguates)', async () => {
    const sig = sign('test-global-secret', QUEUE_ID, RESPONSE_UUID, 'verified');
    (global as any).__pvUpdateRows = []; // self-verify excluded by WHERE
    (global as any).__pvProbeRows = [
      { verification_status: 'in_review', source_agent_id: AGENT_UUID }, // source == verifier
    ];
    const app = freshApp();
    const res = await request(app).post('/api/v1/peer-verify/respond').send({
      queue_id: QUEUE_ID,
      verifier_agent_id: AGENT_NAME,
      verifier_response_id: RESPONSE_UUID,
      verdict: 'verified',
      signature: sig,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Self-verification/);
  });

  test('queue entry not found → 404 (UPDATE matched 0; probe also returns empty)', async () => {
    const sig = sign('test-global-secret', 99999, RESPONSE_UUID, 'verified');
    (global as any).__pvUpdateRows = []; // no row with that id
    (global as any).__pvProbeRows = []; // probe also empty
    const app = freshApp();
    const res = await request(app).post('/api/v1/peer-verify/respond').send({
      queue_id: 99999,
      verifier_agent_id: AGENT_NAME,
      verifier_response_id: RESPONSE_UUID,
      verdict: 'verified',
      signature: sig,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/);
  });

  test('timeout verdict is accepted (3rd allowed value)', async () => {
    const sig = sign('test-global-secret', QUEUE_ID, RESPONSE_UUID, 'timeout');
    (global as any).__pvUpdateRows = [
      {
        id: QUEUE_ID,
        source_agent_id: SOURCE_UUID,
        verifier_agent_id: AGENT_UUID,
        verifier_response_id: RESPONSE_UUID,
        verifier_signature: sig,
        verification_status: 'timeout',
        completed_at: '2026-05-27T03:02:00Z',
        claim_text: 'TIMED OUT',
        certainty_at_claim: 0.8,
        threshold_used: 0.85,
      },
    ];
    const app = freshApp();
    const res = await request(app).post('/api/v1/peer-verify/respond').send({
      queue_id: QUEUE_ID,
      verifier_agent_id: AGENT_NAME,
      verifier_response_id: RESPONSE_UUID,
      verdict: 'timeout',
      signature: sig,
    });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('timeout');
    expect(res.body.agreement_score).toBe(0.0);
  });
});
