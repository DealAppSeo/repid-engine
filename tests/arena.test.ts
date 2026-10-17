/**
 * AgentChess arena routes (src/routes/arena.ts). The properties under test are the controls:
 *   - flag OFF is a 404 everywhere and touches nothing;
 *   - missing tables fail closed (503, nothing written);
 *   - the referee rejects an illegal move with a reason;
 *   - only the side to move can move, and only as itself (agent key or wallet signature);
 *   - a stake is only ever on the staker's own win, and there is no field for a side bet;
 *   - a same-owner pair is allowed but marked owner_distinct=false and never trust evidence;
 *   - the SSE replay paces moves by the chosen speed.
 */
import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { Wallet } from 'ethers';

jest.mock('../src/db', () => {
  const chain: any = {
    select: () => chain, eq: () => chain, ilike: () => chain, limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: null, error: null }), insert: async () => ({ data: null, error: null }),
  };
  return { db: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});
// An agent key is valid for exactly the agent named after 'key-for-'.
jest.mock('../src/auth/api-keys', () => {
  const actual = jest.requireActual('../src/auth/api-keys');
  return { ...actual, validateAgentApiKey: jest.fn(async (key: string) => (key.startsWith('key-for-') ? { agent_id: key.slice(8), scopes: [] } : null)) };
});

import { arenaStatement, createArenaRouters, replayDelayMs, type ArenaAction } from '../src/routes/arena';
import { authMessage } from '../src/routes/v1/byok';
import { ARENA_JS } from '../src/arena/page';
import { supabaseArenaStore, type ArenaStore, type GameRow, type PredictionRow, type RatingRow, type SignalRow } from '../src/arena/store';
import type { OwnerClaim, OwnerResolution } from '../src/services/agent-owner-resolver';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const A3 = '33333333-3333-4333-8333-333333333333';
const human = Wallet.createRandom();

/** Ownership fixture: A1 and A2 share a builder; A3 has a different (signed) builder, so A3 vs A1 is distinct. */
const claim = (ownerKey: string, ownerKeyKind: OwnerClaim['ownerKeyKind'], assurance: OwnerClaim['assurance']): OwnerClaim =>
  ({ source: 'repid_agents.builder_id', assurance, ownerKey, ownerKeyKind, capUsdcPerTx: null, capUsdcTotal: null });
const OWNERS: Record<string, OwnerClaim[]> = {
  [A1]: [claim('aaaaaaaa-0000-4000-8000-000000000001', 'builder_id', 'administrative')],
  [A2]: [claim('aaaaaaaa-0000-4000-8000-000000000001', 'builder_id', 'administrative')],
  [A3]: [claim('cccccccc-0000-4000-8000-000000000003', 'builder_id', 'attested_unverified')],
};
const resolve = async ({ id }: { id?: string }): Promise<OwnerResolution> => {
  const claims = OWNERS[id ?? ''];
  if (!claims) return { status: 'unknown', agentId: null, owner: null, claims: [], conflicts: [], reason: 'agent_not_found', probes: [] };
  return { status: 'resolved', agentId: id ?? null, owner: claims[0] ?? null, claims, conflicts: [], reason: null, probes: [] };
};
const accountOf = async (wallet: string) => (wallet.toLowerCase() === human.address.toLowerCase() ? { kind: 'builder' as const, id: 'bbbbbbbb-0000-4000-8000-000000000002', wallet } : null);

/** In-memory ArenaStore with the same compare-and-set contract as the Supabase one. */
function memStore() {
  const games = new Map<string, GameRow>(), ratings = new Map<string, RatingRow>();
  const signals: SignalRow[] = [], preds: PredictionRow[] = [], sigs = new Set<string>();
  let n = 0;
  const calls: string[] = [];
  const store: ArenaStore = {
    async ensureTables() { calls.push('ensureTables'); },
    async insertGame(row) {
      calls.push('insertGame');
      const g: GameRow = { ...row, id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, version: 0, created_at: new Date().toISOString(), started_at: null, last_move_at: null, finished_at: null, result: null, termination: null, pre: null };
      games.set(g.id, g); return structuredClone(g);
    },
    async getGame(id) { const g = games.get(id); return g ? structuredClone(g) : null; },
    async updateGame(id, version, patch) {
      calls.push('updateGame');
      const g = games.get(id);
      if (!g || g.version !== version) return null;
      const next = { ...g, ...structuredClone(patch), version: version + 1 } as GameRow;
      games.set(id, next); return structuredClone(next);
    },
    async listGames(status, participant) { return [...games.values()].filter((g) => g.status === status && (!participant || g.white === participant || g.black === participant)); },
    async finishedGames() { return [...games.values()].filter((g) => g.status === 'finished' && g.rated).sort((a, b) => String(a.finished_at).localeCompare(String(b.finished_at))); },
    async upsertRatings(rows) { for (const r of rows) ratings.set(r.participant, r); },
    async listRatings() { return [...ratings.values()].sort((a, b) => b.rating - a.rating); },
    async insertSignals(rows) { signals.push(...rows); },
    async insertPrediction(row) { if (preds.some((p) => p.game_id === row.game_id && p.predictor === row.predictor)) return 'duplicate'; preds.push(row); return 'ok'; },
    async listPredictions(id) { return preds.filter((p) => p.game_id === id); },
    async claimSignature(row) { if (sigs.has(row.statement_sha256)) return 'duplicate'; sigs.add(row.statement_sha256); return 'ok'; },
  };
  return { store, games, ratings, signals, preds, calls };
}

function appWith(store: ArenaStore, pollMs = 10) {
  const app = express();
  app.use(express.json());
  const { api, page } = createArenaRouters({ store, resolve, accountOf, pollMs });
  app.use('/api/v1/arena', api);
  app.use('/arena', page);
  return app;
}
const agent = (id: string) => ({ 'x-api-key': `key-for-${id}` });
/** A human's headers for one arena action: a wallet signature over the arena statement for it. */
async function signedArena(w: Wallet, action: ArenaAction) {
  const ts = new Date().toISOString();
  return { 'x-hd-wallet': w.address, 'x-hd-timestamp': ts, 'x-hd-signature': await w.signMessage(arenaStatement(action, w.address, ts)) };
}
const challengeBy = (_w: Wallet, opponent: string, extra: Partial<Extract<ArenaAction, { action: 'challenge' }>> = {}): ArenaAction =>
  ({ action: 'challenge', opponent: `agent:${opponent}`, colour: 'white', stake_usd: 0, time_control: 'normal', speed: '1', ...extra });
async function liveGame(app: express.Express, white = A3, black = A1) {
  const c = await request(app).post('/api/v1/arena/challenges').set(agent(white)).send({ white, black, stake_usd: 1, time_control: 'fast' });
  expect(c.status).toBe(201);
  const a = await request(app).post(`/api/v1/arena/challenges/${c.body.challenge.id}/accept`).set(agent(black)).send();
  expect(a.status).toBe(200);
  return a.body.game.id as string;
}
const move = (app: express.Express, id: string, by: string, uci: string) =>
  request(app).post(`/api/v1/arena/games/${id}/move`).set(agent(by)).send({ uci });

beforeEach(() => { process.env.ARENA_ENABLED = 'true'; });
afterAll(() => { delete process.env.ARENA_ENABLED; });

describe('flag OFF = 404, nothing else', () => {
  it('every route and the page are 404 and the store is never touched', async () => {
    delete process.env.ARENA_ENABLED;
    const m = memStore(), app = appWith(m.store);
    for (const [method, path] of [['get', '/arena'], ['get', '/arena/arena.js'], ['get', '/api/v1/arena/games'], ['get', '/api/v1/arena/ratings'], ['post', '/api/v1/arena/challenges']] as const) {
      const r = await (request(app) as any)[method](path).set(agent(A1)).send({});
      expect(r.status).toBe(404);
    }
    expect(m.calls).toEqual([]);
  });

  it('the page builds exactly the statements the server verifies, and its script parses', async () => {
    expect(() => new Function(ARENA_JS)).not.toThrow();
    const fn = (name: string) => {
      const src = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(ARENA_JS)?.[0];
      expect(src).toBeDefined();
      return new Function(`${src}; return ${name};`)();
    };
    const ts = '2026-10-16T00:00:00.000Z';
    // account/connect keeps the shared authMessage.
    expect(fn('authMessage')('POST', '/api/v1/account/connect', human.address, ts)).toBe(authMessage('POST', '/api/v1/account/connect', human.address, ts));
    const pageStatement = fn('arenaStatement');
    for (const a of [
      challengeBy(human, A1, { colour: 'black', stake_usd: 0.1, time_control: 'slow', speed: '0.25' }),
      { action: 'accept', game: A2 },
      { action: 'move', game: A2, ply: 7, uci: 'e7e8q' },
      { action: 'predict', game: A2, side: 'black', probability: 0.35 },
    ] as ArenaAction[]) expect(pageStatement(a, human.address, ts)).toBe(arenaStatement(a, human.address, ts));
    expect(arenaStatement({ action: 'move', game: A2, ply: 7, uci: 'e7e8q' }, human.address, ts)).toContain('move: e7e8q');
  });

  it('only the exact string true turns it on', async () => {
    process.env.ARENA_ENABLED = 'TRUE';
    expect((await request(appWith(memStore().store)).get('/arena')).status).toBe(404);
    process.env.ARENA_ENABLED = 'true';
    const r = await request(appWith(memStore().store)).get('/arena');
    expect(r.status).toBe(200);
    expect(r.text).toContain('AgentChess Arena');
  });
});

describe('missing tables fail closed', () => {
  it('answers 503 arena_tables_missing on every route and writes nothing', async () => {
    const writes: string[] = [];
    const missing = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.arena_games' in the schema cache" } };
    const chain: any = new Proxy({}, {
      get: (_t, k) => (k === 'then' ? (r: any) => r(missing) : (...args: unknown[]) => { if (['insert', 'update', 'upsert'].includes(String(k))) writes.push(String(k)); void args; return chain; }),
    });
    const app = appWith(supabaseArenaStore({ from: () => chain }));
    for (const r of [
      await request(app).post('/api/v1/arena/challenges').set(agent(A3)).send({ white: A3, black: A1 }),
      await request(app).get('/api/v1/arena/games'),
      await request(app).get('/api/v1/arena/ratings'),
    ]) {
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('arena_tables_missing');
      expect(r.body.message).toMatch(/20261016120000_arena\.sql/);
    }
    expect(writes).toEqual([]);
  });
});

describe('referee', () => {
  it('rejects an illegal move with a reason and the legal list, and counts it', async () => {
    const m = memStore(), app = appWith(m.store), id = await liveGame(app);
    const r = await move(app, id, A3, 'e2e5');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('illegal_move');
    expect(r.body.reason).toMatch(/e2e5 is not legal/);
    expect(r.body.legal_uci).toContain('e2e4');
    expect((await move(app, id, A3, 'pawn to e4')).body.reason).toMatch(/not a UCI move/);
    expect(m.games.get(id)!.illegal_attempts.w).toBe(2);
  });

  it('plays legal moves, detects checkmate, finishes, rates, and writes conduct-only shadow signals', async () => {
    const m = memStore(), app = appWith(m.store), id = await liveGame(app);
    for (const [by, uci] of [[A3, 'f2f3'], [A1, 'e7e5'], [A3, 'g2g4']] as const) expect((await move(app, id, by, uci)).status).toBe(200);
    const last = await move(app, id, A1, 'd8h4');
    expect(last.status).toBe(200);
    expect(last.body.game.result).toBe('0-1');
    expect(last.body.game.termination).toBe('checkmate');
    expect(last.body.game.moves.map((x: any) => x.san)).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
    expect(last.body.game.moves[0].at).toEqual(expect.any(String));
    expect(m.ratings.get(`agent:${A1}`)!.rating).toBeGreaterThan(1500);
    expect(m.signals).toHaveLength(2);
    expect(m.signals.every((s) => s.owner_distinct === true && JSON.stringify(s.signals).includes('never trust evidence'))).toBe(true);
    expect((await move(app, id, A3, 'e2e4')).body.error).toBe('game_not_live');
  });

  it('a side whose clock runs out loses on time', async () => {
    let t = Date.now();
    const m = memStore(), app = express();
    app.use(express.json());
    const { api } = createArenaRouters({ store: m.store, resolve, accountOf, now: () => t });
    app.use('/api/v1/arena', api);
    const id = await liveGame(app as any);
    t += 5 * 60_000 + 1; // White's whole fast clock
    const r = await request(app).get(`/api/v1/arena/games/${id}`);
    expect(r.body.status).toBe('finished');
    expect(r.body.result).toBe('0-1');
    expect(r.body.termination).toMatch(/loss on time/);
  });

  it('during an emergency halt a read does not settle a flagged game (no write from a GET)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const halt = jest.spyOn(require('../src/services/emergency-halt'), 'peekHaltState').mockReturnValue({ halted: true, initialized: true, readFailing: false, mode: 'enforce' });
    try {
      let t = Date.now();
      const m = memStore(), app = express();
      app.use(express.json());
      app.use('/api/v1/arena', createArenaRouters({ store: m.store, resolve, accountOf, now: () => t }).api);
      const id = await liveGame(app as any);
      t += 5 * 60_000 + 1;
      const r = await request(app).get(`/api/v1/arena/games/${id}`);
      expect(r.body.status).toBe('live');
      expect(r.body.clocks.white_ms).toBe(0);
    } finally { halt.mockRestore(); }
  });
});

describe('move auth: only the side to move, only as itself', () => {
  it('refuses the wrong side, a non-player, an operator-style key with no agent, and no key at all', async () => {
    const m = memStore(), app = appWith(m.store), id = await liveGame(app);
    expect((await move(app, id, A1, 'e7e5')).body.error).toBe('not_your_turn');
    expect((await move(app, id, A2, 'e2e4')).body.error).toBe('not_a_participant');
    expect((await request(app).post(`/api/v1/arena/games/${id}/move`).send({ uci: 'e2e4' })).status).toBe(401);
    expect((await request(app).post(`/api/v1/arena/games/${id}/move`).set({ 'x-api-key': 'not-a-key' }).send({ uci: 'e2e4' })).status).toBe(403);
    process.env.REPID_API_KEYS = 'operator-key-for-tests:ops';
    try {
      expect((await request(app).post(`/api/v1/arena/games/${id}/move`).set({ 'x-api-key': 'operator-key-for-tests' }).send({ uci: 'e2e4' })).body.error).toBe('agent_key_required');
    } finally { delete process.env.REPID_API_KEYS; }
    expect(m.games.get(id)!.moves).toHaveLength(0);
  });

  /** A human (white) vs A1, accepted: returns the game id. */
  async function humanGame(app: express.Express) {
    const c = await request(app).post('/api/v1/arena/challenges').set(await signedArena(human, challengeBy(human, A1, { stake_usd: 0.1 }))).send({ white: human.address, black: A1, stake_usd: 0.1 });
    expect(c.status).toBe(201);
    expect(c.body.challenge.white).toBe(`human:${human.address.toLowerCase()}`);
    await request(app).post(`/api/v1/arena/challenges/${c.body.challenge.id}/accept`).set(agent(A1)).send().expect(200);
    return c.body.challenge.id as string;
  }

  it('a human plays by signing the arena statement for the move; a forged or other-action signature is refused', async () => {
    const app = appWith(memStore().store), id = await humanGame(app);
    const mvPath = `/api/v1/arena/games/${id}/move`, e2e4: ArenaAction = { action: 'move', game: id, ply: 1, uci: 'e2e4' };
    const forged = { ...(await signedArena(Wallet.createRandom(), e2e4)), 'x-hd-wallet': human.address };
    expect((await request(app).post(mvPath).set(forged).send({ uci: 'e2e4' })).body.error).toBe('bad_signature');
    // A signature for another action (the challenge) does not carry over.
    const other = await signedArena(human, challengeBy(human, A1, { stake_usd: 0.1 }));
    expect((await request(app).post(mvPath).set(other).send({ uci: 'e2e4' })).body.error).toBe('bad_signature');
    const ok = await request(app).post(mvPath).set(await signedArena(human, e2e4)).send({ uci: 'e2e4' });
    expect(ok.status).toBe(200);
    expect(ok.body.game.turn).toBe('black');
  });

  it('BODY SWAP: a signature over one move, challenge or prediction cannot carry another', async () => {
    const app = appWith(memStore().store), id = await humanGame(app);
    // move: signed e2e4, sent e2e3
    const mv = await signedArena(human, { action: 'move', game: id, ply: 1, uci: 'e2e4' });
    expect((await request(app).post(`/api/v1/arena/games/${id}/move`).set(mv).send({ uci: 'e2e3' })).body.error).toBe('bad_signature');
    // challenge: signed a 0.1 stake on normal against A3, as white; sent other terms
    const ch = await signedArena(human, challengeBy(human, A3, { stake_usd: 0.1 }));
    for (const body of [
      { white: human.address, black: A3, stake_usd: 10 },
      { white: human.address, black: A3, stake_usd: 0.1, time_control: 'fast' },
      { white: human.address, black: A1, stake_usd: 0.1 },
      { white: A3, black: human.address, stake_usd: 0.1 },
    ]) expect((await request(app).post('/api/v1/arena/challenges').set(ch).send(body)).body.error).toBe('bad_signature');
    // predict: signed white at 0.6, sent 0.9, then black
    const pr = await signedArena(human, { action: 'predict', game: id, side: 'white', probability: 0.6 });
    expect((await request(app).post(`/api/v1/arena/games/${id}/predict`).set(pr).send({ side: 'white', probability: 0.9 })).body.error).toBe('bad_signature');
    expect((await request(app).post(`/api/v1/arena/games/${id}/predict`).set(pr).send({ side: 'black', probability: 0.6 })).body.error).toBe('bad_signature');
  });

  it('SINGLE USE: an accepted signature is refused the second time', async () => {
    const app = appWith(memStore().store), id = await humanGame(app);
    const ch = await signedArena(human, challengeBy(human, A3, { stake_usd: 1 })), body = { white: human.address, black: A3, stake_usd: 1 };
    expect((await request(app).post('/api/v1/arena/challenges').set(ch).send(body)).status).toBe(201);
    expect((await request(app).post('/api/v1/arena/challenges').set(ch).send(body)).body.error).toBe('signature_replayed');
    // A prediction cannot be re-sent either (and a move is pinned to its ply as well).
    const pr = await signedArena(human, { action: 'predict', game: id, side: 'white', probability: 0.6 });
    expect((await request(app).post(`/api/v1/arena/games/${id}/predict`).set(pr).send({ side: 'white', probability: 0.6 })).status).toBe(201);
    expect((await request(app).post(`/api/v1/arena/games/${id}/predict`).set(pr).send({ side: 'white', probability: 0.6 })).body.error).toBe('signature_replayed');
  });

  it('a proven wallet with no account is told to connect first', async () => {
    const stranger = Wallet.createRandom(), path = '/api/v1/arena/challenges';
    const r = await request(appWith(memStore().store)).post(path).set(await signedArena(stranger, challengeBy(stranger, A1))).send({ white: stranger.address, black: A1 });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('no_account');
  });
});

describe('stakes: own win only, no side bets', () => {
  it('a player can stake only on its own win; a third party cannot create a game; unknown fields are refused', async () => {
    const m = memStore(), app = appWith(m.store);
    const post = (by: string, body: object) => request(app).post('/api/v1/arena/challenges').set(agent(by)).send(body);
    expect((await post(A3, { white: A3, black: A1, stake_usd: 1, stake_on: A1 })).body.error).toBe('stake_own_win_only');
    expect((await post(A2, { white: A3, black: A1, stake_usd: 1 })).body.error).toBe('not_a_participant');
    const side = await post(A3, { white: A3, black: A1, stake_usd: 1, side_bet: { on: A1, usd: 10 } });
    expect(side.status).toBe(400);
    expect(side.body).toMatchObject({ error: 'unknown_field', fields: ['side_bet'] });
    expect((await post(A3, { white: A3, black: A1, stake_usd: 100 })).body.error).toBe('bad_stake');
    expect((await post(A3, { white: A3, black: A1, stake_usd: 5 })).body.error).toBe('bad_stake');
    const ok = await post(A3, { white: A3, black: A1, stake_usd: 10, stake_on: A3 });
    expect(ok.status).toBe(201);
    expect(ok.body.stake_on).toBe(`agent:${A3}`);
    expect(ok.body.challenge.stake).toMatchObject({ usd: 10, each_player_on_own_win: true, escrow: false });
    expect(m.calls.filter((c) => c === 'insertGame')).toHaveLength(1);
  });

  it('a prediction is calibration only: no money fields, one per predictor', async () => {
    const m = memStore(), app = appWith(m.store), id = await liveGame(app);
    const p = (body: object) => request(app).post(`/api/v1/arena/games/${id}/predict`).set(agent(A2)).send(body);
    expect((await p({ side: 'white', probability: 0.6, stake_usd: 1 })).body.error).toBe('unknown_field');
    expect((await p({ side: 'white', probability: 1.5 })).body.error).toBe('bad_probability');
    const ok = await p({ side: 'white', probability: 0.6 });
    expect(ok.status).toBe(201);
    expect(ok.body.money).toBe(false);
    expect((await p({ side: 'black', probability: 0.4 })).status).toBe(409);
  });

  it('only the challenged side can accept', async () => {
    const m = memStore(), app = appWith(m.store);
    const c = await request(app).post('/api/v1/arena/challenges').set(agent(A3)).send({ white: A3, black: A1 });
    const url = `/api/v1/arena/challenges/${c.body.challenge.id}/accept`;
    expect((await request(app).post(url).set(agent(A3)).send()).body.error).toBe('not_the_challenged_side');
    expect((await request(app).post(url).set(agent(A2)).send()).body.error).toBe('not_the_challenged_side');
    expect((await request(app).post(url).set(agent(A1)).send()).status).toBe(200);
  });
});

describe('write brake', () => {
  it('a network gets 120 arena writes a minute, then 429', async () => {
    const app = appWith(memStore().store);
    for (let i = 0; i < 120; i++) expect((await request(app).post('/api/v1/arena/challenges').send({})).status).toBe(400);
    expect((await request(app).post('/api/v1/arena/challenges').send({})).status).toBe(429);
  });
});

describe('owner_distinct', () => {
  it('a same-owner pair is allowed but marked owner_distinct=false and never trust evidence', async () => {
    const app = appWith(memStore().store);
    const r = await request(app).post('/api/v1/arena/challenges').set(agent(A1)).send({ white: A1, black: A2 });
    expect(r.status).toBe(201);
    expect(r.body.challenge.owner).toEqual({ relation: 'same', evidence: 'administrative', owner_distinct: false, trust_evidence: false });
    expect(r.body.challenge.rated).toBe(false);
  });

  it('UNRATED: a same-owner game is played and recorded but leaves the ratings unchanged', async () => {
    const m = memStore(), app = appWith(m.store);
    const before = (await request(app).get('/api/v1/arena/ratings')).body.ratings;
    const id = await liveGame(app, A1, A2);
    for (const [by, uci] of [[A1, 'f2f3'], [A2, 'e7e5'], [A1, 'g2g4'], [A2, 'd8h4']] as const) expect((await move(app, id, by, uci)).status).toBe(200);
    const g = (await request(app).get(`/api/v1/arena/games/${id}`)).body;
    expect(g).toMatchObject({ status: 'finished', result: '0-1', rated: false });
    expect(m.ratings.size).toBe(0);
    expect((await request(app).get('/api/v1/arena/ratings')).body.ratings).toEqual(before);
    expect(m.signals).toHaveLength(2); // still recorded as shadow conduct, never trust evidence
  });

  it('UNRATED: the Supabase store folds only rated games into the ladder', async () => {
    const calls: unknown[][] = [];
    const chain: any = new Proxy({}, {
      get: (_t, k) => (k === 'then' ? (r: any) => r({ data: [], error: null }) : (...args: unknown[]) => { calls.push([k, ...args]); return chain; }),
    });
    await supabaseArenaStore({ from: () => chain }).finishedGames();
    expect(calls).toContainEqual(['eq', 'status', 'finished']);
    expect(calls).toContainEqual(['eq', 'rated', true]);
  });

  it('a pair the resolver cannot separate is unknown, which is never distinct', async () => {
    OWNERS['44444444-4444-4444-8444-444444444444'] = [claim('qualified_investor', 'opaque', 'declared')];
    const app = appWith(memStore().store);
    const r = await request(app).post('/api/v1/arena/challenges').set(agent(A1)).send({ white: A1, black: '44444444-4444-4444-8444-444444444444' });
    expect(r.body.challenge.owner).toMatchObject({ relation: 'unknown', owner_distinct: false, trust_evidence: false });
  });

  it('a human whose own wallet is bound to the agent is the same owner', async () => {
    OWNERS[A3] = [claim(human.address.toLowerCase(), 'wallet', 'proven_wallet')];
    try {
      const app = appWith(memStore().store), path = '/api/v1/arena/challenges';
      const r = await request(app).post(path).set(await signedArena(human, challengeBy(human, A3))).send({ white: human.address, black: A3 });
      expect(r.body.challenge.owner).toMatchObject({ relation: 'same', owner_distinct: false, trust_evidence: false });
    } finally {
      OWNERS[A3] = [claim('cccccccc-0000-4000-8000-000000000003', 'builder_id', 'attested_unverified')];
    }
  });

  it('an unknown agent is a 404, not a game', async () => {
    const r = await request(appWith(memStore().store)).post('/api/v1/arena/challenges').set(agent(A1)).send({ white: A1, black: '55555555-5555-4555-8555-555555555555' });
    expect(r.status).toBe(404);
  });
});

describe('SSE stream and replay speed', () => {
  it('replay delay: machine is instant, 1x is the real gap, 0.5x doubles it, 0.25x quadruples it', () => {
    expect(replayDelayMs(1000, 'machine')).toBe(0);
    expect(replayDelayMs(1000, '1')).toBe(1000);
    expect(replayDelayMs(1000, '0.5')).toBe(2000);
    expect(replayDelayMs(1000, '0.25')).toBe(4000);
    expect(replayDelayMs(1000, '1', 400)).toBe(600); // time already spent waiting counts
    expect(replayDelayMs(-5, '1')).toBe(0);
  });

  function sse(app: express.Express, url: string) {
    const t0 = Date.now();
    return request(app).get(url).buffer(true).parse((res, cb) => { let s = ''; res.on('data', (c: Buffer) => { s += c; }); res.on('end', () => cb(null, s)); })
      .then((r) => ({ status: r.status, type: r.headers['content-type'], text: r.body as string, ms: Date.now() - t0 }));
  }
  /** A finished fool's mate whose four moves were 60 ms apart. */
  async function finishedGame() {
    const m = memStore(), app = appWith(m.store), id = await liveGame(app);
    for (const [by, uci] of [[A3, 'f2f3'], [A1, 'e7e5'], [A3, 'g2g4'], [A1, 'd8h4']] as const) await move(app, id, by, uci);
    const g = m.games.get(id)!, start = Date.parse('2026-10-16T00:00:00.000Z');
    g.started_at = new Date(start).toISOString();
    g.moves.forEach((mv, i) => { mv.at = new Date(start + 60 * (i + 1)).toISOString(); });
    return { app, id };
  }

  it('replays a finished game: start, every move with its FEN, then end', async () => {
    const { app, id } = await finishedGame();
    const r = await sse(app, `/api/v1/arena/games/${id}/stream?speed=machine`);
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/text\/event-stream/);
    expect(r.text.match(/^event: move$/gm)).toHaveLength(4);
    expect(r.text).toMatch(/^event: start$/m);
    expect(r.text).toMatch(/"san":"Qh4#"/);
    expect(r.text).toMatch(/event: end\ndata: \{"result":"0-1","termination":"checkmate"/);
  });

  it('an EventSource reconnect (Last-Event-ID) resumes after the last ply it saw', async () => {
    const { app, id } = await finishedGame();
    const r = await request(app).get(`/api/v1/arena/games/${id}/stream?speed=machine`).set('Last-Event-ID', '2').buffer(true)
      .parse((res, cb) => { let s = ''; res.on('data', (c: Buffer) => { s += c; }); res.on('end', () => cb(null, s)); });
    const text = r.body as string;
    expect(text).not.toMatch(/^event: start$/m);
    expect(text.match(/^id: (\d+)$/gm)).toEqual(['id: 3', 'id: 4']);
    expect(text).toMatch(/event: end/);
  });

  it('a stream on a challenge past its TTL ends instead of polling forever', async () => {
    const m = memStore(), app = appWith(m.store);
    const c = await request(app).post('/api/v1/arena/challenges').set(agent(A3)).send({ white: A3, black: A1 });
    m.games.get(c.body.challenge.id)!.created_at = new Date(Date.now() - 25 * 3600_000).toISOString();
    const r = await sse(app, `/api/v1/arena/games/${c.body.challenge.id}/stream?speed=machine`);
    expect(r.text).toMatch(/event: end\ndata: \{"result":null,"termination":"challenge expired"/);
  });

  it('one network may hold at most 10 open streams; a closed one frees its slot', async () => {
    const m = memStore(), app = appWith(m.store, 50), id = await liveGame(app);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const open = (): Promise<{ status: number; req: http.ClientRequest }> => new Promise((resolve) => {
      const req = http.get({ port, path: `/api/v1/arena/games/${id}/stream?speed=machine` }, (res) => { resolve({ status: res.statusCode ?? 0, req }); res.resume(); });
    });
    try {
      const held = [];
      for (let i = 0; i < 10; i++) held.push(await open());
      expect(held.every((h) => h.status === 200)).toBe(true);
      const eleventh = await open();
      expect(eleventh.status).toBe(429);
      held[0]!.req.destroy();
      await new Promise((r) => setTimeout(r, 100));
      const again = await open();
      expect(again.status).toBe(200);
      for (const h of [...held, eleventh, again]) h.req.destroy();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('paces the replay by the chosen speed', async () => {
    const { app, id } = await finishedGame();
    const fast = await sse(app, `/api/v1/arena/games/${id}/stream?speed=machine`);
    const slow = await sse(app, `/api/v1/arena/games/${id}/stream?speed=0.25`);
    // 4 gaps of 60 ms at 0.25x = 960 ms of pacing; machine has none.
    expect(slow.ms - fast.ms).toBeGreaterThan(800);
    expect((await request(app).get(`/api/v1/arena/games/${id}/stream?speed=2`)).status).toBe(400);
  });

  it('a live stream pushes a move made after the viewer connected', async () => {
    const m = memStore(), app = appWith(m.store, 10), id = await liveGame(app);
    const watching = sse(app, `/api/v1/arena/games/${id}/stream?speed=machine`);
    await new Promise((r) => setTimeout(r, 50));
    for (const [by, uci] of [[A3, 'f2f3'], [A1, 'e7e5'], [A3, 'g2g4'], [A1, 'd8h4']] as const) await move(app, id, by, uci);
    const r = await watching;
    expect(r.text.match(/^event: move$/gm)).toHaveLength(4);
    expect(r.text).toMatch(/event: end/);
  });
});

describe('ratings', () => {
  it('lists chess ratings, labelled as separate from RepID', async () => {
    const m = memStore(), app = appWith(m.store), id = await liveGame(app);
    for (const [by, uci] of [[A3, 'f2f3'], [A1, 'e7e5'], [A3, 'g2g4'], [A1, 'd8h4']] as const) await move(app, id, by, uci);
    const r = await request(app).get('/api/v1/arena/ratings');
    expect(r.body.ratings[0]).toMatchObject({ participant: `agent:${A1}`, games: 1 });
    expect(r.body.note).toMatch(/never feeds it/);
    const list = await request(app).get('/api/v1/arena/games?status=finished');
    expect(list.body.games).toHaveLength(1);
  });
});
