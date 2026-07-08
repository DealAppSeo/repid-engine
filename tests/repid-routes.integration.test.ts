/**
 * Sprint R-C Phase B4 — RepID HTTP routes integration test.
 *
 * Builds a focused express app with ONLY the RepID routers mounted (no
 * auth middleware to keep the test self-contained), exercises all 4
 * endpoints with mocked DB.
 *
 * Note: this test deliberately mounts both routers WITHOUT the global
 * authMiddleware. The auth-required path semantics are exercised via
 * the existing auth-middleware tests; here we verify route shape +
 * service wiring.
 */
jest.mock('../src/db', () => {
  const chain: any = {};
  return {
    db: {
      from: jest.fn().mockReturnValue(chain),
      __chain: chain,
    },
  };
});

import express from 'express';
import request from 'supertest';
import { db } from '../src/db';
import { repidPublicRouter, repidAdminRouter } from '../src/routes/repid';
import { signRepIDAttestation, _testHelpers } from '../src/repid/repid-attestation';

const mockedDb = db as any;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', repidPublicRouter);
  app.use('/api/v1', repidAdminRouter);
  return app;
}

function setMaybeSingle(data: any, error: any = null) {
  mockedDb.__chain.select = jest.fn().mockReturnThis();
  mockedDb.__chain.eq = jest.fn().mockReturnThis();
  mockedDb.__chain.maybeSingle = jest.fn().mockResolvedValue({ data, error });
}

function setHistory(rows: any[], error: any = null) {
  mockedDb.__chain.select = jest.fn().mockReturnThis();
  mockedDb.__chain.eq = jest.fn().mockReturnThis();
  mockedDb.__chain.order = jest.fn().mockReturnThis();
  mockedDb.__chain.gte = jest.fn().mockReturnThis();
  mockedDb.__chain.then = (resolve: any) => resolve({ data: rows, error });
}

describe('RepID HTTP routes (Sprint R-C Phase B3 integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _testHelpers().resetCache();
  });

  test('GET /api/v1/repid/:agentId — 200 with cached source', async () => {
    setMaybeSingle({
      id: 'agent-int-1',
      current_repid: 4500,
      tier: 'ESTABLISHED',
      updated_at: '2026-05-05T10:00:00.000Z',
    });
    const r = await request(buildApp()).get('/api/v1/repid/agent-int-1');
    expect(r.status).toBe(200);
    expect(r.body.agent_id).toBe('agent-int-1');
    expect(r.body.repid_score).toBe(4500);
    expect(r.body.tier).toBe('ESTABLISHED');
    expect(r.body.source).toBe('cached');
  });

  test('GET /api/v1/repid/:agentId — 404 when not found', async () => {
    setMaybeSingle(null);
    const r = await request(buildApp()).get('/api/v1/repid/ghost');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('AGENT_NOT_FOUND');
  });

  test('GET /api/v1/repid/:agentId/history — 200 with events array', async () => {
    setHistory([
      { repid_after: 4500, repid_before: 4400, created_at: '2026-05-05T12:00:00Z', event_type: 'STAKE' },
      { repid_after: 4400, repid_before: 4380, created_at: '2026-05-04T08:00:00Z', event_type: 'PEACEMAKER' },
    ]);
    const r = await request(buildApp()).get('/api/v1/repid/agent-int-2/history');
    expect(r.status).toBe(200);
    expect(r.body.agent_id).toBe('agent-int-2');
    expect(r.body.count).toBe(2);
    expect(r.body.events[0].repid_score).toBe(4500);
    expect(r.body.events[0].delta_from_previous).toBe(100);
  });

  test('GET /api/v1/repid/:agentId/history with ?since=', async () => {
    setHistory([]);
    const r = await request(buildApp())
      .get('/api/v1/repid/agent-int-3/history')
      .query({ since: '2026-05-01' });
    expect(r.status).toBe(200);
    expect(r.body.events).toEqual([]);
    expect(mockedDb.__chain.gte).toHaveBeenCalledWith('created_at', '2026-05-01');
  });

  test('POST /api/v1/repid/:agentId/attest — 200 with valid attestation', async () => {
    setMaybeSingle({
      id: 'agent-int-4',
      current_repid: 5000,
      tier: 'AUTONOMOUS',
      updated_at: '2026-05-05T10:00:00.000Z',
    });
    const r = await request(buildApp()).post('/api/v1/repid/agent-int-4/attest');
    expect(r.status).toBe(200);
    expect(r.body.payload.agent_id).toBe('agent-int-4');
    expect(r.body.payload.repid_score).toBe(5000);
    expect(r.body.signature).toBeTruthy();
    expect(r.body.signing_pubkey).toBeTruthy();
    expect(r.body.source).toBeDefined();
  });

  test('POST /api/v1/repid/:agentId/attest — 404 when agent missing', async () => {
    setMaybeSingle(null);
    const r = await request(buildApp()).post('/api/v1/repid/ghost/attest');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('AGENT_NOT_FOUND');
  });

  test('POST /api/v1/repid/:agentId/attest — 409 when no current_repid', async () => {
    setMaybeSingle({
      id: 'agent-int-5',
      current_repid: null,
      tier: null,
    });
    const r = await request(buildApp()).post('/api/v1/repid/agent-int-5/attest');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('NO_SCORE');
  });

  test('POST /api/v1/repid/verify — 200 with valid attestation', async () => {
    const att = await signRepIDAttestation({
      agent_id: 'agent-int-6',
      repid_score: 1234,
      timestamp_iso: '2026-05-05T12:00:00.000Z',
    });
    const r = await request(buildApp()).post('/api/v1/repid/verify').send(att);
    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(true);
    expect(r.body.payload.agent_id).toBe('agent-int-6');
  });

  test('POST /api/v1/repid/verify — 400 when payload tampered', async () => {
    const att = await signRepIDAttestation({
      agent_id: 'agent-int-7',
      repid_score: 100,
      timestamp_iso: '2026-05-05T12:00:00.000Z',
    });
    const tampered = { ...att, payload: { ...att.payload, repid_score: 9999 } };
    const r = await request(buildApp()).post('/api/v1/repid/verify').send(tampered);
    expect(r.status).toBe(400);
    expect(r.body.valid).toBe(false);
    expect(r.body.reason).toBeTruthy();
  });

  test('POST /api/v1/repid/verify — 400 when missing fields', async () => {
    const r = await request(buildApp()).post('/api/v1/repid/verify').send({});
    expect(r.status).toBe(400);
    expect(r.body.valid).toBe(false);
  });

  // --- GET /repid/:agentId/proof slug→UUID resolution (500-fix regression) ---

  const UUID = '32e0e809-c1c4-4405-913f-135c8a2d6626';

  // Fully-chainable mock so the proof route's .eq().not().order().limit()
  // .maybeSingle() and the resolver's .eq().maybeSingle() both work. `route`
  // decides which .maybeSingle() payload comes back per from() target.
  function setupProofMock(opts: {
    resolveTo: any; // repid_agents lookup { id } | null
    proofRow: any; // repid_zkp_proofs row | null
  }) {
    mockedDb.from = jest.fn().mockImplementation((table: string) => {
      const chain: any = {};
      chain.select = jest.fn().mockReturnValue(chain);
      chain.eq = jest.fn().mockReturnValue(chain);
      chain.not = jest.fn().mockReturnValue(chain);
      chain.order = jest.fn().mockReturnValue(chain);
      chain.limit = jest.fn().mockReturnValue(chain);
      chain.maybeSingle = jest.fn().mockImplementation(() => {
        if (table === 'repid_agents') {
          return Promise.resolve({ data: opts.resolveTo, error: null });
        }
        return Promise.resolve({ data: opts.proofRow, error: null });
      });
      return chain;
    });
  }

  test('GET /repid/:agentId/proof — slug resolves to UUID and returns 200', async () => {
    setupProofMock({
      resolveTo: { id: UUID },
      proofRow: {
        agent_id: UUID,
        scheme: 'plonky3_range_check',
        proof_type: 'range',
        proof_bytes: 'AAAA',
        statement: { repid_score: 1000, threshold: 500 },
        tier_proven: 'ESTABLISHED',
        eas_attestation_uid: null,
        eas_schema: null,
        created_at: '2026-07-01T00:00:00Z',
      },
    });
    const r = await request(buildApp()).get('/api/v1/repid/trinity-shofet/proof');
    expect(r.status).toBe(200);
    expect(r.body.agent_id).toBe(UUID);
    expect(r.body.cryptographically_verifiable).toBe(true);
    // Resolver queried repid_agents by trinity-prefixed name.
    expect(mockedDb.from).toHaveBeenCalledWith('repid_agents');
  });

  test('GET /repid/:agentId/proof — bare slug gets trinity- prefix and resolves', async () => {
    setupProofMock({
      resolveTo: { id: UUID },
      proofRow: {
        agent_id: UUID,
        scheme: 'plonky3_range_check',
        proof_type: 'range',
        proof_bytes: 'AAAA',
        statement: {},
        tier_proven: 'ESTABLISHED',
        eas_attestation_uid: null,
        eas_schema: null,
        created_at: '2026-07-01T00:00:00Z',
      },
    });
    const r = await request(buildApp()).get('/api/v1/repid/shofet/proof');
    expect(r.status).toBe(200);
    expect(r.body.agent_id).toBe(UUID);
  });

  test('GET /repid/:agentId/proof — bogus slug returns 404 (not 500)', async () => {
    setupProofMock({ resolveTo: null, proofRow: null });
    const r = await request(buildApp()).get('/api/v1/repid/not-a-real-agent/proof');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('No proof found for agent');
    expect(r.body.agent_id).toBe('not-a-real-agent');
  });

  test('GET /repid/:agentId/proof — raw UUID passes through unchanged', async () => {
    setupProofMock({
      resolveTo: null, // must NOT be consulted for a raw UUID
      proofRow: {
        agent_id: UUID,
        scheme: 'plonky3_range_check',
        proof_type: 'range',
        proof_bytes: 'AAAA',
        statement: {},
        tier_proven: 'ESTABLISHED',
        eas_attestation_uid: null,
        eas_schema: null,
        created_at: '2026-07-01T00:00:00Z',
      },
    });
    const r = await request(buildApp()).get(`/api/v1/repid/${UUID}/proof`);
    expect(r.status).toBe(200);
    expect(r.body.agent_id).toBe(UUID);
    // No repid_agents lookup for a raw UUID — only the proofs table is queried.
    expect(mockedDb.from).not.toHaveBeenCalledWith('repid_agents');
  });
});
