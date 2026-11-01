/**
 * Who moves whose score: an agent-bound API key may only act as itself.
 *
 * POST /challenge (challenger +25, defender penalised) and POST /api/v1/substance-gate/events
 * (a failed gate slashes `agentName`) both took the actor from the body. Behind authMiddleware
 * the caller is authenticated, but nothing tied the body name to the key, so agent A's key
 * could file a challenge as B, or report a failed gate for B and slash it.
 *
 * Operator keys (no bound agent) keep their existing behaviour, the same rule as score.ts.
 */
import express from 'express';
import request from 'supertest';

const dbCalls: string[] = [];
const agentsByName: Record<string, string> = { 'agent-a': A_ID(), 'agent-b': B_ID() };
function A_ID() { return '11111111-1111-4111-8111-111111111111'; }
function B_ID() { return '22222222-2222-4222-8222-222222222222'; }

jest.mock('../src/db', () => {
  const chain = (table: string): any => {
    let name: string | null = null;
    const c: any = {
      select: () => c,
      eq: (col: string, v: string) => { if (col === 'agent_name') name = v; return c; },
      maybeSingle: async () => (table === 'repid_agents' && name && agentsByName[name] ? { data: { id: agentsByName[name] }, error: null } : { data: null, error: null }),
      single: async () => ({ data: null, error: { message: 'nf' } }),
      insert: () => { dbCalls.push(`insert:${table}`); return c; },
      update: () => { dbCalls.push(`update:${table}`); return c; },
    };
    return c;
  };
  return { db: { from: (t: string) => { dbCalls.push(`from:${t}`); return chain(t); } } };
});

const recordGateEvent = jest.fn(async () => null);
jest.mock('../src/services/substance-gate-writer', () => ({
  recordGateEvent: (...a: unknown[]) => recordGateEvent(...(a as [])),
  slashRepIDForGateFail: jest.fn(),
  appendGateAuditChain: jest.fn(),
}));

const arena = jest.fn(async () => ({ resolved: true }));
jest.mock('../src/testing/red-team', () => ({
  ...jest.requireActual('../src/testing/red-team'),
  createAndResolveArenaChallenge: (...a: unknown[]) => arena(...(a as [])),
}));

import challengeRouter from '../src/routes/challenge';
import v1Router from '../src/routes/v1';
import substanceGateRouter from '../src/routes/v1/substance-gate';

/** Stand-in for authMiddleware: x-test-agent sets the bound agent; absent = operator key. */
function app(router: express.Router, prefix = '') {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    const bound = req.header('x-test-agent');
    if (bound) (req as any).agent_id = bound;
    next();
  });
  a.use(prefix, router);
  return a;
}

beforeEach(() => {
  dbCalls.length = 0;
  recordGateEvent.mockClear();
});

describe('POST /challenge — the challenger is the key, not the body', () => {
  const body = { challengerId: B_ID(), defenderId: A_ID(), claim: 'the defender cited a retracted paper' };

  it('refuses agent A filing as agent B, before any database access', async () => {
    const res = await request(app(challengeRouter)).post('/challenge').set('x-test-agent', A_ID()).send(body);
    expect(res.status).toBe(403);
    expect(res.body.field).toBe('body.challengerId');
    expect(dbCalls).toEqual([]);
  });

  it('refuses a self-challenge written in upper case', async () => {
    const res = await request(app(challengeRouter)).post('/challenge').set('x-test-agent', A_ID())
      .send({ ...body, challengerId: A_ID(), defenderId: A_ID().toUpperCase() });
    expect(res.status).toBe(400);
    expect(dbCalls).toEqual([]);
  });

  it('lets a bound key file as itself (gets past the binding check)', async () => {
    const res = await request(app(challengeRouter)).post('/challenge').set('x-test-agent', B_ID().toUpperCase()).send(body);
    expect(res.status).not.toBe(403);
  });
});

describe('POST /api/v1/substance-gate/events — an agent can only report its own gate', () => {
  const event = (agentName: string) => ({
    task: { id: 1, metadata: {} },
    fastResult: { passed: false },
    agentName,
    contentHash: 'h',
  });

  it('refuses agent A reporting a failed gate for agent B: nothing written, nothing slashed', async () => {
    const res = await request(app(substanceGateRouter, '/api/v1')).post('/api/v1/substance-gate/events')
      .set('x-test-agent', A_ID()).send(event('agent-b'));
    expect(res.status).toBe(403);
    expect(recordGateEvent).not.toHaveBeenCalled();
  });

  it('refuses a name that resolves to no agent', async () => {
    const res = await request(app(substanceGateRouter, '/api/v1')).post('/api/v1/substance-gate/events')
      .set('x-test-agent', A_ID()).send(event('nobody'));
    expect(res.status).toBe(403);
    expect(recordGateEvent).not.toHaveBeenCalled();
  });

  it('accepts an agent reporting its own gate', async () => {
    await request(app(substanceGateRouter, '/api/v1')).post('/api/v1/substance-gate/events')
      .set('x-test-agent', A_ID()).send(event('agent-a'));
    expect(recordGateEvent).toHaveBeenCalledTimes(1);
  });

  it('leaves operator keys (no bound agent) unchanged', async () => {
    await request(app(substanceGateRouter, '/api/v1')).post('/api/v1/substance-gate/events').send(event('agent-b'));
    expect(recordGateEvent).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/v1/challenge/create — the same rule on the second challenge door', () => {
  const body = (challenger: string) => ({ challenger_agent: challenger, defender_agent: 'agent-a', claim: 'a claim', stake_repid: 5 });
  beforeEach(() => arena.mockClear());

  it('refuses agent A challenging as agent B: no arena run, no RepID moved', async () => {
    const res = await request(app(v1Router, '/api/v1')).post('/api/v1/challenge/create')
      .set('x-test-agent', A_ID()).send(body('agent-b'));
    expect(res.status).toBe(403);
    expect(arena).not.toHaveBeenCalled();
  });

  it('refuses a self-challenge that differs only in case', async () => {
    const res = await request(app(v1Router, '/api/v1')).post('/api/v1/challenge/create')
      .set('x-test-agent', A_ID()).send({ ...body('AGENT-A') });
    expect(res.status).toBe(400);
    expect(arena).not.toHaveBeenCalled();
  });

  it('lets a bound key challenge as itself, and leaves operator keys unchanged', async () => {
    const own = await request(app(v1Router, '/api/v1')).post('/api/v1/challenge/create')
      .set('x-test-agent', B_ID()).send(body('agent-b'));
    const op = await request(app(v1Router, '/api/v1')).post('/api/v1/challenge/create').send(body('agent-b'));
    expect(own.status).toBe(200);
    expect(op.status).toBe(200);
    expect(arena).toHaveBeenCalledTimes(2);
  });
});
