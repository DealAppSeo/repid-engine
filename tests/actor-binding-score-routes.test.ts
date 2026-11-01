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
/** Names someone else has also registered (agent_name is not unique). */
const duplicateNames = new Set<string>();
function A_ID() { return '11111111-1111-4111-8111-111111111111'; }
function B_ID() { return '22222222-2222-4222-8222-222222222222'; }

jest.mock('../src/db', () => {
  const chain = (table: string): any => {
    let name: string | null = null;
    let id: string | null = null;
    const c: any = {
      select: () => c,
      eq: (col: string, v: string) => { if (col === 'agent_name') name = v; if (col === 'id') id = v; return c; },
      maybeSingle: async () => {
        if (table !== 'repid_agents') return { data: null, error: null };
        if (id) {
          const n = Object.keys(agentsByName).find((k) => agentsByName[k] === id);
          return n ? { data: { agent_name: n }, error: null } : { data: null, error: null };
        }
        // A global name lookup: ambiguous when two rows share the name, as Postgres would report.
        if (name && duplicateNames.has(name)) return { data: null, error: { message: 'multiple rows' } };
        return name && agentsByName[name] ? { data: { id: agentsByName[name] }, error: null } : { data: null, error: null };
      },
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

describe('POST /challenge — operator-only: an agent key cannot penalise a defender it picks', () => {
  const body = { challengerId: B_ID(), defenderId: A_ID(), claim: 'the defender cited a retracted paper' };

  it('refuses agent A filing as agent B, before any database access', async () => {
    const res = await request(app(challengeRouter)).post('/challenge').set('x-test-agent', A_ID()).send(body);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('operator_only');
    expect(dbCalls).toEqual([]);
  });

  it('refuses agent B filing as itself too: the defender is still the caller\'s pick', async () => {
    const res = await request(app(challengeRouter)).post('/challenge').set('x-test-agent', B_ID()).send(body);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('operator_only');
    expect(dbCalls).toEqual([]);
  });

  it('refuses a self-challenge written in upper case (operator key)', async () => {
    const res = await request(app(challengeRouter)).post('/challenge')
      .send({ ...body, challengerId: A_ID(), defenderId: A_ID().toUpperCase() });
    expect(res.status).toBe(400);
    expect(dbCalls).toEqual([]);
  });

  it('an operator key gets past the gate', async () => {
    const res = await request(app(challengeRouter)).post('/challenge').send(body);
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

  it('refuses a padded copy of its own name: the writer would act on the padded row', async () => {
    const res = await request(app(substanceGateRouter, '/api/v1')).post('/api/v1/substance-gate/events')
      .set('x-test-agent', A_ID()).send(event(' agent-a'));
    expect(res.status).toBe(403);
    expect(recordGateEvent).not.toHaveBeenCalled();
  });

  it('a duplicate registration of its name does not lock the real agent out', async () => {
    duplicateNames.add('agent-a');
    try {
      await request(app(substanceGateRouter, '/api/v1')).post('/api/v1/substance-gate/events')
        .set('x-test-agent', A_ID()).send(event('agent-a'));
      expect(recordGateEvent).toHaveBeenCalledTimes(1);
    } finally {
      duplicateNames.clear();
    }
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

describe('POST /api/v1/challenge/create — operator-only: the arena moves both agents by a caller-set stake', () => {
  const body = (challenger: string) => ({ challenger_agent: challenger, defender_agent: 'agent-a', claim: 'a claim', stake_repid: 1_000_000 });
  beforeEach(() => arena.mockClear());

  it('refuses agent A challenging as agent B: no arena run, no RepID moved', async () => {
    const res = await request(app(v1Router, '/api/v1')).post('/api/v1/challenge/create')
      .set('x-test-agent', A_ID()).send(body('agent-b'));
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('operator_only');
    expect(arena).not.toHaveBeenCalled();
  });

  it('refuses agent B challenging as itself with a huge stake against a defender it picks', async () => {
    const res = await request(app(v1Router, '/api/v1')).post('/api/v1/challenge/create')
      .set('x-test-agent', B_ID()).send(body('agent-b'));
    expect(res.status).toBe(403);
    expect(arena).not.toHaveBeenCalled();
  });

  it('refuses a self-challenge that differs only in case (operator key)', async () => {
    const res = await request(app(v1Router, '/api/v1')).post('/api/v1/challenge/create').send({ ...body('AGENT-A') });
    expect(res.status).toBe(400);
    expect(arena).not.toHaveBeenCalled();
  });

  it('an operator key still runs the arena', async () => {
    const op = await request(app(v1Router, '/api/v1')).post('/api/v1/challenge/create').send(body('agent-b'));
    expect(op.status).toBe(200);
    expect(arena).toHaveBeenCalledTimes(1);
  });
});
