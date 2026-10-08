/**
 * [F-13, Sean 2026-10-07] "No keyless on-chain write. A daily cap still lets a stranger write. The demo
 * route may check. It may not mint, settle, or write reputation. If a demo write must exist, it takes
 * the operator key and a cap, and it is not keyless."
 *
 * What was open, read from the code on 2026-10-07:
 * - POST /demo/run-round-anonymous was bypassed by authMiddleware. Each call started a trading round,
 *   force-settled it, moved two agents' RepID, and fired two on-chain reputation writes.
 * - POST /bet/place was bypassed too, and placed a bet in ANY agent's name.
 * - The secrets behind the two remaining gates fell back to fixed strings in this public repo:
 *   SEAN_SIG_SECRET (start / force-resolve rounds) and ORACLE_HMAC_SECRET (sign any bet outcome,
 *   then settle it through the keyless POST /bet/resolve). Whether production set them was NOT
 *   CHECKED; the fix does not depend on it.
 */
import express from 'express';
import request from 'supertest';
import { createHmac } from 'crypto';
import { authMiddleware } from '../src/middleware/auth';

const mockRunRound = jest.fn(async () => ({ ok: true, round_id: 'r1', apm: null, veritas: null, audit_entries: [], is_simulated: true, notes: '' }));
const mockDbUpdates: unknown[] = [];
// The demo-round cap lives in hal_audit_chain: each attempt is appended, then today's attempts are
// counted. mockAttempts stands in for those rows, and survives anything the route module does, the
// way a database survives a restart.
const mockCap = { attempts: 0, appendFails: false, countFails: false };

jest.mock('../src/db', () => {
  const chain: any = {
    select: () => chain, eq: () => chain, lte: () => chain, order: () => chain, limit: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    update: (row: unknown) => { mockDbUpdates.push(row); return chain; },
    then: (r: any) => r({ data: [{ id: 'round-1', apm_bet_id: 'a', veritas_bet_id: 'v' }], error: null }),
  };
  const audit: any = {
    select: () => audit, eq: () => audit, gte: () => audit,
    then: (r: any) => r(mockCap.countFails
      ? { count: null, error: { message: 'count failed' } }
      : { count: mockCap.attempts, error: null }),
  };
  return { db: { from: (t: string) => (t === 'hal_audit_chain' ? audit : chain) } };
});
jest.mock('../src/services/audit-emit', () => ({
  emitAuditEvent: jest.fn(async () => {
    if (mockCap.appendFails) return { ok: false, audit_chain_id: null, error: 'append failed' };
    mockCap.attempts += 1;
    return { ok: true, audit_chain_id: mockCap.attempts };
  }),
}));
jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn() }));
jest.mock('../src/services/anonymous-round-runner', () => ({ runRoundAnonymous: (...a: unknown[]) => (mockRunRound as any)(...a) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { signOracleOutcome, verifyOracleSignature, oracleSecretConfigured } = require('../src/services/linked-bet-resolver');

const OLD_SEAN_DEFAULT = 'reponomics-default-sean-secret';
const OLD_ORACLE_DEFAULT = 'reponomics-default-oracle-secret';
const hmac = (secret: string, msg: string) => createHmac('sha256', secret).update(msg).digest('hex');

const saved = { ...process.env };
beforeEach(() => {
  process.env = { ...saved };
  delete process.env.ORACLE_HMAC_SECRET;
  delete process.env.SEAN_SIG_SECRET;
  delete process.env.DEMO_ROUND_DAILY_CAP;
  process.env.REPID_API_KEYS = 'operator-key:pro';
  mockRunRound.mockClear();
  mockDbUpdates.length = 0;
});
afterAll(() => { process.env = saved; });

async function passesKeyless(method: string, path: string): Promise<boolean> {
  const req: any = { method, path, headers: {}, query: {}, body: {} };
  const res: any = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
  const next = jest.fn();
  await authMiddleware(req, res, next);
  return next.mock.calls.length === 1 && res.statusCode === 0;
}

describe('authMiddleware no longer lets a stranger reach the writers', () => {
  it('the demo round is not keyless any more', async () => {
    expect(await passesKeyless('POST', '/api/v1/demo/run-round-anonymous')).toBe(false);
  });

  it('placing a bet is not keyless any more', async () => {
    expect(await passesKeyless('POST', '/api/v1/bet/place')).toBe(false);
  });

  it('the read-only demo snapshot a visitor is pointed to still answers without a key', async () => {
    expect(await passesKeyless('GET', '/api/v1/demo/two-builder/snapshot')).toBe(true);
  });
});

describe('POST /demo/run-round-anonymous: the operator key and a daily cap', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const v1 = require('../src/routes/v1');
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use('/api/v1', v1.default ?? v1.router ?? v1);
    return a;
  };
  beforeEach(() => { mockCap.attempts = 0; mockCap.appendFails = false; mockCap.countFails = false; });

  it('any key that is not the operator key: 403, nothing runs', async () => {
    const res = await request(app()).post('/api/v1/demo/run-round-anonymous').set('x-api-key', 'some-agent-key').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('demo_round_needs_operator');
    expect(mockRunRound).not.toHaveBeenCalled();
  });

  it('no key at all: 403, nothing runs', async () => {
    const res = await request(app()).post('/api/v1/demo/run-round-anonymous').send({});
    expect(res.status).toBe(403);
    expect(mockRunRound).not.toHaveBeenCalled();
  });

  it('the operator key runs it, up to the daily cap, then 429', async () => {
    process.env.DEMO_ROUND_DAILY_CAP = '2';
    const go = () => request(app()).post('/api/v1/demo/run-round-anonymous').set('x-api-key', 'operator-key').send({});
    expect((await go()).status).toBe(200);
    expect((await go()).status).toBe(200);
    const third = await go();
    expect(third.status).toBe(429);
    expect(third.body.error).toBe('demo_round_daily_cap');
    expect(mockRunRound).toHaveBeenCalledTimes(2);
  });

  it('the cap is counted in the database: attempts already recorded today still count after a restart', async () => {
    // Strix on #1251: an in-process counter reset on restart and was not shared across replicas.
    process.env.DEMO_ROUND_DAILY_CAP = '2';
    mockCap.attempts = 2; // two rounds already ran today, recorded before this process started
    // A freshly loaded route module is a restart: any counter held in process memory starts at zero.
    let fresh: any;
    jest.isolateModules(() => { fresh = require('../src/routes/v1'); });
    const restarted = express();
    restarted.use(express.json());
    restarted.use('/api/v1', fresh.default ?? fresh.router ?? fresh);
    const res = await request(restarted).post('/api/v1/demo/run-round-anonymous').set('x-api-key', 'operator-key').send({});
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('demo_round_daily_cap');
    expect(mockRunRound).not.toHaveBeenCalled();
  });

  it('an attempt that cannot be recorded does not run: 503, NOT CHECKED', async () => {
    mockCap.appendFails = true;
    const res = await request(app()).post('/api/v1/demo/run-round-anonymous').set('x-api-key', 'operator-key').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('demo_round_cap_not_checked');
    expect(mockRunRound).not.toHaveBeenCalled();
  });

  it('a count that fails does not run either: 503, NOT CHECKED', async () => {
    mockCap.countFails = true;
    const res = await request(app()).post('/api/v1/demo/run-round-anonymous').set('x-api-key', 'operator-key').send({});
    expect(res.status).toBe(503);
    expect(mockRunRound).not.toHaveBeenCalled();
  });

  it('a cap of 0 means no demo writes at all', async () => {
    process.env.DEMO_ROUND_DAILY_CAP = '0';
    const res = await request(app()).post('/api/v1/demo/run-round-anonymous').set('x-api-key', 'operator-key').send({});
    expect(res.status).toBe(429);
    expect(mockRunRound).not.toHaveBeenCalled();
  });

  it('the Sean-signed round routes refuse a header computed from the old public default', async () => {
    const sig = hmac(OLD_SEAN_DEFAULT, 'start-trading-round');
    const start = await request(app()).post('/api/v1/trader/round/start').set('x-sean-signature', sig).send({});
    const resolve = await request(app()).post('/api/v1/trader/round/resolve-open').set('x-sean-signature', sig).send({ force: true });
    expect(start.status).toBe(401);
    expect(resolve.status).toBe(401);
  });
});

describe('the oracle secret has no public default', () => {
  it('unset: nothing is signed, and a signature made with the old default is refused', () => {
    expect(oracleSecretConfigured()).toBe(false);
    expect(() => signOracleOutcome('bet-1', true)).toThrow(/ORACLE_HMAC_SECRET is not set/);
    expect(verifyOracleSignature('bet-1', true, hmac(OLD_ORACLE_DEFAULT, 'bet-1|1'))).toBe(false);
  });

  it('set: the right signature verifies; a wrong, short or foreign one does not', () => {
    process.env.ORACLE_HMAC_SECRET = 'test-only-oracle-secret';
    const good = signOracleOutcome('bet-1', true);
    expect(verifyOracleSignature('bet-1', true, good)).toBe(true);
    expect(verifyOracleSignature('bet-1', false, good)).toBe(false);
    expect(verifyOracleSignature('bet-1', true, good.slice(0, 10))).toBe(false);
    expect(verifyOracleSignature('bet-1', true, hmac(OLD_ORACLE_DEFAULT, 'bet-1|1'))).toBe(false);
  });

  it('rounds are not settled without it, and the result says NOT CHECKED instead of zero work', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveOpenRounds } = require('../src/services/agent-trader');
    const r = await resolveOpenRounds({ force: true });
    expect(r.resolved).toBe(0);
    expect(r.not_checked).toMatch(/ORACLE_HMAC_SECRET is not set/);
    expect(mockDbUpdates).toHaveLength(0);
  });

  it('the on-chain oracle HMAC fallback has no public default either', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'onchain-oracle.ts'), 'utf8');
    expect(src).not.toContain(OLD_ORACLE_DEFAULT);
    expect(src).toMatch(/ORACLE_HMAC_SECRET is not set/);
  });
});
