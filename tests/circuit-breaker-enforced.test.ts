/**
 * The kill switches in src/middleware/circuit-breaker.ts stop the writes they name.
 *
 * Until 2026-11-14 four of the six switches stopped nothing: the `breaker()` middleware was
 * mounted nowhere and only the on-chain and x402 switches had a caller, while the header said
 * every switch "blocks" its surface. So this file proves two things:
 *
 *   1. BEHAVIOUR. For each wired switch: tripped, the write is refused and nothing is written;
 *      unreadable, the same (fail closed); closed, the write proceeds. The config read is
 *      replaced through `__setBreakerRead`; no test here reaches a network.
 *   2. IT CANNOT ROT. Every BreakerKey has an enforcement point or a NOT ENFORCED marker in
 *      the header (never both, never neither), and every file under src/ that can move a score
 *      or call the prover checks the matching switch. A discovery rule, not a list: a new
 *      writer fails this file until it is guarded or exempted here with a reason.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

// ── a recording db: every table touched and every write, nothing real ──────────────────────
const mockCalls: string[] = [];
const mockInserted: Array<{ table: string; row: unknown }> = [];
const mockRows: Record<string, unknown> = {};

function mockBuilder(table: string): any {
  const settle = () =>
    table in mockRows
      ? { data: mockRows[table], error: null }
      : { data: null, error: { message: `mock: no ${table} row` } };
  const p: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (ok: any, bad: any) => Promise.resolve(settle()).then(ok, bad);
      return (...args: unknown[]) => {
        mockCalls.push(`${table}.${String(prop)}`);
        if (prop === 'insert') mockInserted.push({ table, row: args[0] });
        return p;
      };
    },
  });
  return p;
}

const mockDb = {
  from: (t: string) => {
    mockCalls.push(`from:${t}`);
    return mockBuilder(t);
  },
  rpc: (fn: string) => {
    mockCalls.push(`rpc:${fn}`);
    return mockBuilder(`rpc:${fn}`);
  },
};

jest.mock('../src/db', () => ({ db: mockDb }));
jest.mock('../scripts/liveness-probes/_shared', () => ({ getDb: () => mockDb }));

import { __setBreakerRead, breaker, isTripped, BREAKER_KEYS, type BreakerKey, type BreakerRead } from '../src/middleware/circuit-breaker';
import { insertScoreEvent } from '../src/scoring/score-event-writer';
import { updateRepId } from '../src/engine/repid-update';
import { runScoreEvent, applyValidationEvent } from '../src/scoring/pipeline';
import { resolveBet, signOracleOutcome } from '../src/services/linked-bet-resolver';
import { slashRepIDForGateFail, clearAgentUuidCache } from '../src/services/substance-gate-writer';
import { createProofDrainService } from '../src/services/proof-drain-service';
import { generateProofReal, ProverUnavailableError } from '../src/zkp/plonky3-real';
import { runOnce as refreshOnce, type RefreshDeps } from '../src/workers/proof-refresh-worker';
import { MockAgent } from '../scripts/mock-harness/mock-agent';
import challengeRouter from '../src/routes/challenge';

// ── the config read, three ways ─────────────────────────────────────────────────────────────
const CLOSED: BreakerRead = async () => ({ data: { value: 'false' }, error: null });
const trip = (key: BreakerKey): BreakerRead => async (k) => ({ data: { value: k === key ? 'true' : 'false' }, error: null });
const unreadable = (key: BreakerKey): BreakerRead => async (k) =>
  k === key ? { data: null, error: { message: 'mock: db down' } } : { data: { value: 'false' }, error: null };

beforeEach(() => {
  mockCalls.length = 0;
  mockInserted.length = 0;
  for (const k of Object.keys(mockRows)) delete mockRows[k];
  __setBreakerRead(CLOSED);
});
afterAll(() => __setBreakerRead(CLOSED)); // leave the offline default the setup file installed

const quiet = () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
};
afterEach(() => jest.restoreAllMocks());

// ── 1. cb_disable_score_writes ──────────────────────────────────────────────────────────────
describe('cb_disable_score_writes', () => {
  beforeEach(quiet);
  const MOVING = { applier: 'trigger' as const, agent_id: 'a1', event_type: 'STAKE', delta: 5 };

  it('insertScoreEvent: tripped → throws, nothing inserted', async () => {
    __setBreakerRead(trip('cb_disable_score_writes'));
    await expect(insertScoreEvent(MOVING)).rejects.toThrow(/circuit_breaker_open: cb_disable_score_writes/);
    expect(mockInserted).toEqual([]);
  });

  it('a fail-open status read (isTripped) does not let a later write through', async () => {
    __setBreakerRead(unreadable('cb_disable_score_writes'));
    expect(await isTripped('cb_disable_score_writes')).toBe(false); // status read fails open
    await expect(insertScoreEvent(MOVING)).rejects.toThrow(/circuit_breaker_unreadable/);
    expect(mockInserted).toEqual([]);
  });

  it('insertScoreEvent: unreadable → throws (fail closed), nothing inserted', async () => {
    __setBreakerRead(unreadable('cb_disable_score_writes'));
    await expect(insertScoreEvent(MOVING)).rejects.toThrow(/circuit_breaker_unreadable/);
    expect(mockInserted).toEqual([]);
  });

  it('insertScoreEvent: closed → the row is inserted', async () => {
    mockRows.repid_score_events = { id: 'evt-1' };
    const r = await insertScoreEvent(MOVING);
    expect(r.ok).toBe(true);
    expect(mockInserted.map((i) => i.table)).toEqual(['repid_score_events']);
  });

  it('insertScoreEvent: tripped, but a zero-delta audit row moves nothing, so it still lands', async () => {
    __setBreakerRead(trip('cb_disable_score_writes'));
    mockRows.repid_score_events = { id: 'evt-0' };
    const r = await insertScoreEvent({
      applier: 'caller', agent_id: 'a1', event_type: 'GENESIS', delta: 0,
      repid_before: 200, repid_after: 200, repid_delta_applied: 0,
    });
    expect(r.ok).toBe(true);
    expect(mockInserted).toHaveLength(1);
  });

  // The three pipelines refuse before touching the db at all; closed, they reach the agent read
  // (the mock has no agent, so they then throw "not found", which is past the guard).
  const pipelines: Array<[string, () => Promise<unknown>]> = [
    ['updateRepId', () => updateRepId({ agentId: 'a1', eventType: 'STAKE' } as any)],
    ['runScoreEvent', () => runScoreEvent({ agent_id: 'a1', prompt: 'p', answer: 'a', task_domain: 'general', certainty: 0.5 } as any)],
    ['applyValidationEvent', () => applyValidationEvent('a1', 'VALIDATION_PASSED', 5)],
  ];
  it.each(pipelines)('%s: tripped → refused before any db read or write', async (_name, call) => {
    __setBreakerRead(trip('cb_disable_score_writes'));
    await expect(call()).rejects.toThrow(/circuit_breaker_open: cb_disable_score_writes/);
    expect(mockCalls).toEqual([]);
  });
  it.each(pipelines)('%s: closed → proceeds to the agent read', async (_name, call) => {
    await expect(call()).rejects.toThrow(/not found/i);
    expect(mockCalls).toContain('from:repid_agents');
  });

  it('POST /challenge: tripped → 503 and the handler never runs', async () => {
    __setBreakerRead(trip('cb_disable_score_writes'));
    const app = express().use(express.json()).use(challengeRouter);
    const res = await request(app).post('/challenge').send({});
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'circuit_breaker_open', breaker: 'cb_disable_score_writes' });
    expect(mockCalls).toEqual([]);
  });
  it('POST /challenge: closed → reaches the handler (400 on an empty body)', async () => {
    const app = express().use(express.json()).use(challengeRouter);
    const res = await request(app).post('/challenge').send({});
    expect(res.status).toBe(400);
  });

  it('breaker(): unreadable → 503 circuit_breaker_unknown, next() not called', async () => {
    __setBreakerRead(unreadable('cb_disable_score_writes'));
    const app = express().post('/x', breaker('cb_disable_score_writes'), (_q, r) => r.json({ ran: true }));
    const res = await request(app).post('/x');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('circuit_breaker_unknown');
  });

  describe('resolveBet', () => {
    const OLD = process.env.ORACLE_HMAC_SECRET;
    beforeAll(() => { process.env.ORACLE_HMAC_SECRET = 'test-only-oracle-secret'; });
    afterAll(() => { if (OLD === undefined) delete process.env.ORACLE_HMAC_SECRET; else process.env.ORACLE_HMAC_SECRET = OLD; });
    const openBet = () => {
      mockRows.linked_bets = { status: 'open', agent_id: 'a1', bet_amount: '100', claimed_confidence: 5000, prediction_payload: { predicted_outcome: true } };
    };

    it('tripped → error result, the score RPC is never called, the bet stays open', async () => {
      __setBreakerRead(trip('cb_disable_score_writes'));
      openBet();
      const r: any = await resolveBet('bet-1', true, signOracleOutcome('bet-1', true));
      expect(JSON.stringify(r)).toMatch(/cb_disable_score_writes/);
      expect(mockCalls).not.toContain('rpc:apply_linked_bet_resolution');
    });
    it('closed → the score RPC is called', async () => {
      openBet();
      await resolveBet('bet-1', true, signOracleOutcome('bet-1', true));
      expect(mockCalls).toContain('rpc:apply_linked_bet_resolution');
    });
  });

  describe('slashRepIDForGateFail (db is a parameter)', () => {
    beforeEach(() => clearAgentUuidCache());
    it('tripped → nothing read or written', async () => {
      __setBreakerRead(trip('cb_disable_score_writes'));
      await slashRepIDForGateFail(mockDb as any, 'agent-x', {}, 0, 'g1');
      expect(mockCalls).toEqual([]);
    });
    it('closed → proceeds to the agent lookup', async () => {
      await slashRepIDForGateFail(mockDb as any, 'agent-x', {}, 0, 'g1');
      expect(mockCalls).toContain('from:repid_agents');
    });
  });
});

// ── 2. cb_disable_zkp_proofs ────────────────────────────────────────────────────────────────
describe('cb_disable_zkp_proofs', () => {
  beforeEach(quiet);

  const drain = (pgQueryImpl: jest.Mock) =>
    createProofDrainService({
      supabase: mockDb as any,
      zkpServiceUrl: 'https://prover.test',
      pgQueryImpl: pgQueryImpl as any,
      routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'test' })) as any,
      churnMode: 'off',
    });

  it('proof drain: tripped → parks, claims nothing', async () => {
    __setBreakerRead(trip('cb_disable_zkp_proofs'));
    const pg = jest.fn(async () => []);
    expect(await drain(pg).drainOnce()).toEqual({ jobsCompleted: 0, jobsFailed: 0 });
    expect(pg).not.toHaveBeenCalled();
  });
  it('proof drain: unreadable → parks (fail closed)', async () => {
    __setBreakerRead(unreadable('cb_disable_zkp_proofs'));
    const pg = jest.fn(async () => []);
    await drain(pg).drainOnce();
    expect(pg).not.toHaveBeenCalled();
  });
  it('proof drain: closed → polls the queue', async () => {
    const pg = jest.fn(async () => []);
    await drain(pg).drainOnce();
    expect(pg).toHaveBeenCalled();
  });

  describe('generateProofReal (POST /prove-repid, /batch/prove)', () => {
    const saved = { p: process.env.PLONKY3_PROVER_URL, z: process.env.ZKP_SERVICE_URL };
    beforeEach(() => { delete process.env.PLONKY3_PROVER_URL; delete process.env.ZKP_SERVICE_URL; });
    afterAll(() => {
      if (saved.p !== undefined) process.env.PLONKY3_PROVER_URL = saved.p;
      if (saved.z !== undefined) process.env.ZKP_SERVICE_URL = saved.z;
    });
    it('tripped → ProverUnavailableError (the routes answer 503), no request, no stand-in', async () => {
      __setBreakerRead(trip('cb_disable_zkp_proofs'));
      const f = jest.spyOn(globalThis, 'fetch');
      await expect(generateProofReal('a1', 'pk', 'postcard', 't')).rejects.toBeInstanceOf(ProverUnavailableError);
      expect(f).not.toHaveBeenCalled();
    });
    it('closed → proceeds (no prover configured here, so the labelled HMAC fallback)', async () => {
      const r = await generateProofReal('a1', 'pk', 'postcard', 't');
      expect(r.is_real).toBe(false);
    });
  });

  describe('proof refresh worker', () => {
    const OLD = process.env.PROOF_REFRESH_ENABLED;
    beforeAll(() => { process.env.PROOF_REFRESH_ENABLED = 'true'; });
    afterAll(() => { if (OLD === undefined) delete process.env.PROOF_REFRESH_ENABLED; else process.env.PROOF_REFRESH_ENABLED = OLD; });
    const deps = (): RefreshDeps => ({
      query: jest.fn(async () => []),
      enqueue: jest.fn(async () => ({ error: null })),
      fetchImpl: jest.fn() as any,
      proverUrl: 'https://prover.test',
      isHalted: async () => false,
      log: () => {},
      warn: () => {},
    });
    const cfg = { maxAgeDays: 7, maxAgents: 5, intervalMs: 60_000 };
    it('tripped → tick skipped, no candidate query', async () => {
      __setBreakerRead(trip('cb_disable_zkp_proofs'));
      const d = deps();
      expect((await refreshOnce(cfg, d)).ran).toBe(false);
      expect(d.query).not.toHaveBeenCalled();
    });
    it('closed → the tick runs', async () => {
      const d = deps();
      expect((await refreshOnce(cfg, d)).ran).toBe(true);
      expect(d.query).toHaveBeenCalled();
    });
  });
});

// ── 3. cb_disable_trade_execution ───────────────────────────────────────────────────────────
describe('cb_disable_trade_execution (the mock-harness writers, the only ones in this repo)', () => {
  beforeEach(quiet);
  const trade = { decision: 'REFUSED', confidence: 0.9, reasoning: 'r', asset: 'BTC', pair: 'BTC/USD', amount_usd: 100 } as any;

  it('tripped → attemptTrade throws, nothing inserted', async () => {
    __setBreakerRead(trip('cb_disable_trade_execution'));
    await expect(new MockAgent('mock-cb', 'constitutional').attemptTrade(trade)).rejects.toThrow(/cb_disable_trade_execution/);
    expect(mockInserted).toEqual([]);
  });
  it('closed → the trade row is inserted', async () => {
    mockRows.trade_execution_log = { id: 1 };
    await new MockAgent('mock-cb', 'constitutional').attemptTrade(trade);
    expect(mockInserted.map((i) => i.table)).toEqual(['trade_execution_log']);
  });
});

// ── 4. it cannot rot ────────────────────────────────────────────────────────────────────────
const ROOT = join(__dirname, '..');
const BREAKER_FILE = 'src/middleware/circuit-breaker.ts';
const BREAKER_CLI = 'scripts/circuit-breaker-controls.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}
const rel = (f: string) => f.slice(ROOT.length + 1).replace(/\\/g, '/');
/** Comments say things; only code enforces. Approximate, and only ever errs toward flagging. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const FILES = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))]
  .map((f) => ({ path: rel(f), src: code(readFileSync(f, 'utf8')) }))
  .filter((f) => f.path !== BREAKER_FILE && f.path !== BREAKER_CLI);

const guardCall = (key: string) =>
  new RegExp(`(assertBreakerClosed|breakerAllows|breaker)\\(\\s*['"\`]${key}['"\`]\\s*\\)`);
/** The x402 settler and recovery worker read their row directly, not through the module. */
const directRead = (key: string) => new RegExp(`\\.eq\\(\\s*['"]key['"]\\s*,\\s*['"]${key}['"]\\s*\\)`);
const enforcedIn = (key: string) =>
  FILES.filter((f) => guardCall(key).test(f.src) || (f.path.startsWith('src/') && directRead(key).test(f.src))).map((f) => f.path);

describe('every BreakerKey is enforced somewhere, or says it is not', () => {
  const header = readFileSync(join(ROOT, BREAKER_FILE), 'utf8');
  const keys: string[] = [...BREAKER_KEYS];

  it('finds the keys (an empty list would pass everything below)', () => {
    expect(keys.length).toBeGreaterThanOrEqual(6);
  });

  it.each(keys)('%s', (key) => {
    const where = enforcedIn(key);
    const marked = new RegExp(`${key}\\s+NOT ENFORCED`).test(header);
    const claimed = new RegExp(`${key}\\s+ENFORCED`).test(header);
    // Exactly one of: enforced in code AND the header says ENFORCED, or no enforcement AND the
    // header says NOT ENFORCED. A marker on an enforced key is as wrong as no marker on a dead one.
    if (where.length > 0) {
      expect({ key, header: claimed ? 'ENFORCED' : marked ? 'NOT ENFORCED' : 'missing' }).toEqual({ key, header: 'ENFORCED' });
    } else {
      expect({ key, header: marked ? 'NOT ENFORCED' : claimed ? 'ENFORCED (but nothing checks it)' : 'missing' }).toEqual({
        key,
        header: 'NOT ENFORCED',
      });
    }
  });
});

describe('every src/ file that can move a score checks cb_disable_score_writes', () => {
  // Same insert shapes as tests/score-event-writer-ratchet.test.ts, plus the two other ways a
  // score moves: a direct current_repid update, and the linked-bet RPC.
  const MOVES = [
    /from\(\s*['"`]repid_score_events['"`]\s*\)[\s\S]{0,400}?\.\s*insert\s*\(/,
    /INSERT\s+INTO\s+(?:public\.)?repid_score_events/i,
    // `current_repid` as a KEY being set; `last_reputation_repid: agent.current_repid` reads it.
    /from\(\s*['"`]repid_agents['"`]\s*\)\s*\.\s*update\s*\(\s*\{[^}]{0,400}?(?<![\w.])current_repid\s*:/,
    /UPDATE\s+(?:public\.)?repid_agents\s+SET[\s\S]{0,80}current_repid/i,
    /rpc\(\s*['"`]apply_linked_bet_resolution['"`]/,
  ];
  // Each exemption says why. A stale one fails below.
  const EXEMPT: Record<string, string> = {
    'src/routes/agents.ts': 'only a zero-delta GENESIS row, which moves no score',
    'src/routes/mirror-test.ts': 'only a zero-delta MIRROR_TEST row, which moves no score',
  };
  const writers = FILES.filter((f) => f.path.startsWith('src/') && MOVES.some((re) => re.test(f.src)));

  it('finds the writers (an empty scan would pass everything)', () => {
    expect(writers.map((w) => w.path)).toEqual(expect.arrayContaining(['src/engine/repid-update.ts', 'src/scoring/pipeline.ts']));
  });
  it('none is unguarded', () => {
    const unguarded = writers
      .filter((w) => !(w.path in EXEMPT) && !guardCall('cb_disable_score_writes').test(w.src))
      .map((w) => w.path);
    expect(unguarded).toEqual([]);
  });
  it('no exemption is stale', () => {
    const found = new Set(writers.map((w) => w.path));
    expect(Object.keys(EXEMPT).filter((p) => !found.has(p))).toEqual([]);
  });
});

describe('every src/ file that calls the prover checks cb_disable_zkp_proofs', () => {
  const callers = FILES.filter((f) => f.path.startsWith('src/') && /\/zkp\/repid-proof|\/prove\/trade_auth/.test(f.src));
  it('finds the callers', () => {
    expect(callers.map((c) => c.path)).toEqual(expect.arrayContaining(['src/services/proof-drain-service.ts', 'src/zkp/plonky3-real.ts']));
  });
  it('none is unguarded', () => {
    expect(callers.filter((c) => !guardCall('cb_disable_zkp_proofs').test(c.src)).map((c) => c.path)).toEqual([]);
  });
});
