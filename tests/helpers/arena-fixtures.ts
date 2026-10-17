/**
 * Shared fixtures for the arena suites (tests/arena.test.ts, tests/arena-game-keys.test.ts).
 * A test file using these must still declare its own jest.mock('../src/db') and
 * jest.mock('../src/auth/api-keys'): jest hoists mocks per file.
 */
import express from 'express';
import request from 'supertest';
import { Wallet } from 'ethers';
import { arenaStatement, createArenaRouters, type ArenaAction, type ArenaDeps } from '../../src/routes/arena';
import type { ArenaStore, GameKeyRow, GameRow, PredictionRow, RatingRow, SignalRow } from '../../src/arena/store';
import type { OwnerClaim, OwnerResolution } from '../../src/services/agent-owner-resolver';

export const A1 = '11111111-1111-4111-8111-111111111111';
export const A2 = '22222222-2222-4222-8222-222222222222';
export const A3 = '33333333-3333-4333-8333-333333333333';
export const human = Wallet.createRandom();
export const human2 = Wallet.createRandom();

/** Ownership fixture: A1 and A2 share a builder; A3 has a different (signed) builder, so A3 vs A1 is distinct. */
export const claim = (ownerKey: string, ownerKeyKind: OwnerClaim['ownerKeyKind'], assurance: OwnerClaim['assurance']): OwnerClaim =>
  ({ source: 'repid_agents.builder_id', assurance, ownerKey, ownerKeyKind, capUsdcPerTx: null, capUsdcTotal: null });
export const OWNERS: Record<string, OwnerClaim[]> = {
  [A1]: [claim('aaaaaaaa-0000-4000-8000-000000000001', 'builder_id', 'administrative')],
  [A2]: [claim('aaaaaaaa-0000-4000-8000-000000000001', 'builder_id', 'administrative')],
  [A3]: [claim('cccccccc-0000-4000-8000-000000000003', 'builder_id', 'attested_unverified')],
};
export const resolve = async ({ id }: { id?: string }): Promise<OwnerResolution> => {
  const claims = OWNERS[id ?? ''];
  if (!claims) return { status: 'unknown', agentId: null, owner: null, claims: [], conflicts: [], reason: 'agent_not_found', probes: [] };
  return { status: 'resolved', agentId: id ?? null, owner: claims[0] ?? null, claims, conflicts: [], reason: null, probes: [] };
};
const ACCOUNTS: Record<string, string> = {
  [human.address.toLowerCase()]: 'bbbbbbbb-0000-4000-8000-000000000002',
  [human2.address.toLowerCase()]: 'bbbbbbbb-0000-4000-8000-000000000004',
};
export const accountOf = async (wallet: string) => (ACCOUNTS[wallet.toLowerCase()] ? { kind: 'builder' as const, id: ACCOUNTS[wallet.toLowerCase()] as string, wallet } : null);

/** In-memory ArenaStore with the same compare-and-set and single-active-key contract as the Supabase one. */
export function memStore() {
  const games = new Map<string, GameRow>(), ratings = new Map<string, RatingRow>();
  const signals: SignalRow[] = [], preds: PredictionRow[] = [], sigs = new Set<string>(), keys: GameKeyRow[] = [];
  let n = 0;
  const calls: string[] = [];
  const store: ArenaStore = {
    async ensureTables() { calls.push('ensureTables'); },
    async insertGame(row) {
      calls.push('insertGame');
      const g: GameRow = { ...row, id: row.id ?? `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, version: 0, created_at: new Date().toISOString(), started_at: null, last_move_at: null, finished_at: null, result: null, termination: null, pre: null, events: [] };
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
    async insertSignals(rows) { signals.push(...structuredClone(rows)); },
    async insertPrediction(row) { if (preds.some((p) => p.game_id === row.game_id && p.predictor === row.predictor)) return 'duplicate'; preds.push(row); return 'ok'; },
    async listPredictions(id) { return preds.filter((p) => p.game_id === id); },
    async claimSignature(row) { if (sigs.has(row.statement_sha256)) return 'duplicate'; sigs.add(row.statement_sha256); return 'ok'; },
    async addGameKey(row) {
      const at = new Date().toISOString();
      for (const k of keys) if (k.game_id === row.game_id && k.participant === row.participant && !k.revoked_at) { k.revoked_at = at; k.revoked_reason = 'replaced'; }
      const same = keys.findIndex((k) => k.game_id === row.game_id && k.participant === row.participant && k.thumbprint === row.thumbprint);
      const next = { ...structuredClone(row), granted_at: at, revoked_at: null, revoked_reason: null };
      if (same >= 0) keys[same] = next; else keys.push(next);
    },
    async gameKeys(id) { return structuredClone(keys.filter((k) => k.game_id === id)); },
    async revokeGameKey(id, participant, at) { for (const k of keys) if (k.game_id === id && k.participant === participant && !k.revoked_at) { k.revoked_at = at; k.revoked_reason = 'ended_by_wallet'; } },
    async markResultAccepted(id, participant, scoresheet) {
      const row = signals.find((x) => x.game_id === id && x.participant === participant);
      if (!row) return false;
      row.signals = { ...row.signals, accepted_result: true, scoresheet };
      return true;
    },
  };
  return { store, games, ratings, signals, preds, calls, keys };
}

export function appWith(store: ArenaStore, pollMs = 10, deps: Partial<ArenaDeps> = {}) {
  const app = express();
  app.use(express.json());
  const { api, page } = createArenaRouters({ store, resolve, accountOf, pollMs, ...deps });
  app.use('/api/v1/arena', api);
  app.use('/arena', page);
  return app;
}
export const agent = (id: string) => ({ 'x-api-key': `key-for-${id}` });
/** A human's headers for one arena action: a wallet signature over the arena statement for it. */
export async function signedArena(w: Wallet, action: ArenaAction) {
  const ts = new Date().toISOString();
  return { 'x-hd-wallet': w.address, 'x-hd-timestamp': ts, 'x-hd-signature': await w.signMessage(arenaStatement(action, w.address, ts)) };
}
export const challengeBy = (_w: Wallet, opponent: string, extra: Partial<Extract<ArenaAction, { action: 'challenge' }>> = {}): ArenaAction =>
  ({ action: 'challenge', opponent: `agent:${opponent}`, colour: 'white', stake_usd: 0, time_control: 'normal', speed: '1', ...extra });
export async function liveGame(app: express.Express, white = A3, black = A1) {
  const c = await request(app).post('/api/v1/arena/challenges').set(agent(white)).send({ white, black, stake_usd: 1, time_control: 'fast' });
  expect(c.status).toBe(201);
  const a = await request(app).post(`/api/v1/arena/challenges/${c.body.challenge.id}/accept`).set(agent(black)).send();
  expect(a.status).toBe(200);
  return a.body.game.id as string;
}
export const move = (app: express.Express, id: string, by: string, uci: string) =>
  request(app).post(`/api/v1/arena/games/${id}/move`).set(agent(by)).send({ uci });
