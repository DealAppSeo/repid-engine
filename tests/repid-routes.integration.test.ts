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
});
