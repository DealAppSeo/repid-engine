/**
 * Arena persistence. Nothing here reads or writes RepID, stakes, escrow or any money table.
 *   supabase/migrations/20261016120000_arena.sql            five tables; applied by Sean 2026-10-16.
 *   supabase/migrations/20261017120000_arena_game_keys.sql  arena_game_keys, arena_games.events, and
 *                                                           the wider arena_signatures.action CHECK.
 *                                                           Prod DDL is Sean's.
 *
 * FAIL CLOSED. Until both are applied every arena route answers 503 `arena_tables_missing` and
 * writes nothing: `ensureTables` probes every table and the new column before the first request is
 * served, and is remembered only once it succeeds.
 */
import type { Clock, Result, StoredMove, TimeControl } from './referee';
import type { ChainEvent, KeyAct, PublicJwk } from './game-key';

export type GameStatus = 'pending' | 'live' | 'finished';
export type Speed = 'machine' | '1' | '0.5' | '0.25';

export interface GameRow {
  id: string;
  status: GameStatus;
  white: string;
  black: string;
  challenger: string;
  stake_usd: number;
  time_control: TimeControl;
  default_speed: Speed;
  owner_relation: 'distinct' | 'same' | 'unknown';
  owner_evidence: 'strong' | 'administrative' | 'none';
  owner_distinct: boolean;
  trust_evidence: boolean;
  /** = owner_distinct. An unrated game is recorded, playable and replayable, but never moves arena_ratings. */
  rated: boolean;
  fen: string;
  moves: StoredMove[];
  clock_ms: Clock;
  illegal_attempts: Clock;
  /** Resign and draw offers/acceptances, each with its game-key signature when a game key made it. */
  events: ChainEvent[];
  pre: Record<string, unknown> | null;
  result: Result | null;
  termination: string | null;
  version: number;
  created_at: string;
  started_at: string | null;
  last_move_at: string | null;
  finished_at: string | null;
}
export type NewGame = Omit<GameRow, 'id' | 'version' | 'created_at' | 'started_at' | 'last_move_at' | 'finished_at' | 'result' | 'termination' | 'pre' | 'events'> & { id?: string };
/** A wallet's grant to a game key. Published with the game: the statement and signature are the proof. */
export interface GameKeyRow {
  game_id: string;
  participant: string;
  thumbprint: string;
  public_jwk: PublicJwk;
  capabilities: KeyAct[];
  grant_statement: string;
  grant_signature: string;
  granted_at?: string;
  revoked_at: string | null;
  revoked_reason: 'replaced' | 'ended_by_wallet' | null;
}
export interface RatingRow { participant: string; rating: number; games: number }
export interface SignalRow { game_id: string; participant: string; owner_distinct: boolean; trust_evidence: boolean; signals: Record<string, unknown> }
export interface PredictionRow { game_id: string; predictor: string; is_participant: boolean; side: 'white' | 'black'; probability: number; at_ply: number }

export interface ArenaStore {
  ensureTables(): Promise<void>;
  insertGame(row: NewGame): Promise<GameRow>;
  getGame(id: string): Promise<GameRow | null>;
  /** Compare-and-set on `version`. null = somebody else changed the game first. */
  updateGame(id: string, version: number, patch: Partial<GameRow>): Promise<GameRow | null>;
  listGames(status: GameStatus, participant: string | null, limit: number): Promise<GameRow[]>;
  /** Every finished RATED game, oldest first, for the rating fold. */
  finishedGames(): Promise<Pick<GameRow, 'white' | 'black' | 'result' | 'stake_usd'>[]>;
  upsertRatings(rows: RatingRow[]): Promise<void>;
  listRatings(limit: number): Promise<RatingRow[]>;
  insertSignals(rows: SignalRow[]): Promise<void>;
  /** 'duplicate' when this predictor already predicted this game. */
  insertPrediction(row: PredictionRow): Promise<'ok' | 'duplicate'>;
  listPredictions(gameId: string): Promise<PredictionRow[]>;
  /** Single use: 'duplicate' when this signed statement was already accepted once. */
  claimSignature(row: { statement_sha256: string; wallet: string; action: string }): Promise<'ok' | 'duplicate'>;
  /** A new grant for the same game and side revokes the old key ('replaced'); old rows stay, so old signatures stay verifiable. */
  addGameKey(row: Omit<GameKeyRow, 'revoked_at' | 'revoked_reason'>): Promise<void>;
  /** Every grant for the game, active or not. */
  gameKeys(gameId: string): Promise<GameKeyRow[]>;
  /** The wallet's "end game key". */
  revokeGameKey(gameId: string, participant: string, at: string): Promise<void>;
  /** The scoresheet signature: the "accepted the result" conduct signal, merged into that player's signals row. */
  markResultAccepted(gameId: string, participant: string, scoresheet: Record<string, unknown>): Promise<boolean>;
}

export const ARENA_TABLES = ['arena_games', 'arena_ratings', 'arena_trust_signals', 'arena_predictions', 'arena_signatures', 'arena_game_keys'] as const;
export const MIGRATION_FILE = 'supabase/migrations/20261016120000_arena.sql and 20261017120000_arena_game_keys.sql';

export class ArenaTablesMissing extends Error {}

interface PgError { code?: string; message?: string }
/**
 * Postgres 42P01 "relation does not exist", PostgREST PGRST205 "could not find the table" (as
 * durable-caps.ts), and for a missing column 42703 / PGRST204.
 */
const isMissingTable = (e: PgError): boolean => {
  const msg = (e.message ?? '').toLowerCase();
  return ['42P01', 'PGRST205', '42703', 'PGRST204'].includes(e.code ?? '') || msg.includes('does not exist') || msg.includes('could not find the');
};
function check<T>(r: { data: T; error: PgError | null }): T {
  if (!r.error) return r.data;
  if (isMissingTable(r.error)) throw new ArenaTablesMissing(r.error.message ?? 'arena table missing');
  throw new Error(`arena store: ${r.error.message ?? r.error.code ?? 'unknown error'}`);
}

const PAGE = 1000; // PostgREST's default max-rows: read past it in pages, never trust one call.

/** The Supabase-backed store. `db` is the engine's service-role client. */
export function supabaseArenaStore(db: any): ArenaStore {
  let ready = false;
  return {
    async ensureTables() {
      if (ready) return;
      for (const t of ARENA_TABLES) check(await db.from(t).select('*', { head: true, count: 'exact' }).limit(1));
      check(await db.from('arena_games').select('events', { head: true }).limit(1));
      ready = true;
    },
    async insertGame(row) {
      return check(await db.from('arena_games').insert(row).select('*').single()) as GameRow;
    },
    async getGame(id) {
      return check(await db.from('arena_games').select('*').eq('id', id).maybeSingle()) as GameRow | null;
    },
    async updateGame(id, version, patch) {
      const rows = check(await db.from('arena_games').update({ ...patch, version: version + 1 }).eq('id', id).eq('version', version).select('*')) as GameRow[];
      return rows?.[0] ?? null;
    },
    async listGames(status, participant, limit) {
      let q = db.from('arena_games').select('*').eq('status', status);
      if (participant) q = q.or(`white.eq.${participant},black.eq.${participant}`);
      return check(await q.order('created_at', { ascending: false }).limit(limit)) as GameRow[];
    },
    async finishedGames() {
      const out: Pick<GameRow, 'white' | 'black' | 'result' | 'stake_usd'>[] = [];
      for (let from = 0; ; from += PAGE) {
        const rows = check(await db.from('arena_games').select('white, black, result, stake_usd')
          .eq('status', 'finished').eq('rated', true).order('finished_at', { ascending: true }).order('id', { ascending: true })
          .range(from, from + PAGE - 1)) as typeof out;
        out.push(...rows);
        if (rows.length < PAGE) return out;
      }
    },
    async upsertRatings(rows) {
      if (rows.length) check(await db.from('arena_ratings').upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: 'participant' }));
    },
    async listRatings(limit) {
      return check(await db.from('arena_ratings').select('participant, rating, games').order('rating', { ascending: false }).limit(limit)) as RatingRow[];
    },
    async insertSignals(rows) {
      check(await db.from('arena_trust_signals').upsert(rows, { onConflict: 'game_id,participant', ignoreDuplicates: true }));
    },
    async insertPrediction(row) {
      const r = await db.from('arena_predictions').insert(row);
      if (r.error?.code === '23505') return 'duplicate';
      check(r);
      return 'ok';
    },
    async listPredictions(gameId) {
      return check(await db.from('arena_predictions').select('*').eq('game_id', gameId)) as PredictionRow[];
    },
    async claimSignature(row) {
      const r = await db.from('arena_signatures').insert(row);
      if (r.error?.code === '23505') return 'duplicate';
      // 23514: the action CHECK predates game keys ('grant', 'revoke', 'scoresheet'). Fail closed, and say why.
      if (r.error?.code === '23514') throw new ArenaTablesMissing(`arena_signatures.action does not allow '${row.action}' yet`);
      check(r);
      return 'ok';
    },
    async addGameKey(row) {
      const at = new Date().toISOString();
      // Revoke first, then insert: the partial unique index (one active key per game and side) then always holds.
      check(await db.from('arena_game_keys').update({ revoked_at: at, revoked_reason: 'replaced' }).eq('game_id', row.game_id).eq('participant', row.participant).is('revoked_at', null));
      // Upsert, not insert: re-granting the SAME key makes its own row active again with the new grant.
      check(await db.from('arena_game_keys').upsert({ ...row, granted_at: at, revoked_at: null, revoked_reason: null }, { onConflict: 'game_id,participant,thumbprint' }));
    },
    async gameKeys(gameId) {
      return check(await db.from('arena_game_keys').select('*').eq('game_id', gameId).order('granted_at', { ascending: true })) as GameKeyRow[];
    },
    async revokeGameKey(gameId, participant, at) {
      check(await db.from('arena_game_keys').update({ revoked_at: at, revoked_reason: 'ended_by_wallet' }).eq('game_id', gameId).eq('participant', participant).is('revoked_at', null));
    },
    async markResultAccepted(gameId, participant, scoresheet) {
      const row = check(await db.from('arena_trust_signals').select('signals').eq('game_id', gameId).eq('participant', participant).maybeSingle()) as { signals: Record<string, unknown> } | null;
      if (!row) return false;
      check(await db.from('arena_trust_signals').update({ signals: { ...row.signals, accepted_result: true, scoresheet } }).eq('game_id', gameId).eq('participant', participant));
      return true;
    },
  };
}
