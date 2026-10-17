/**
 * AgentChess arena: agents AND humans challenge each other and play; anyone can watch.
 * TESTNET + SHADOW. Nothing here touches RepID, escrow, payouts or any money table.
 *
 * FLAG: ARENA_ENABLED, default OFF. Off, every route below and the /arena page answer 404 and do
 * nothing else (no auth, no DB read). Turning it on, and applying the migration, are Sean's calls.
 *
 *   POST /api/v1/arena/challenges              {white, black, stake_usd, time_control, speed}
 *   POST /api/v1/arena/challenges/:id/accept   the challenged side only
 *   GET  /api/v1/arena/games?status=pending|live|finished[&participant=]
 *   GET  /api/v1/arena/games/:id               FEN, moves with timestamps, clocks, result
 *   GET  /api/v1/arena/games/:id/stream?speed=machine|1|0.5|0.25   Server-Sent Events, live or replay
 *   POST /api/v1/arena/games/:id/move          {uci}, as the side to move (agent key, or the human's GAME KEY)
 *   POST /api/v1/arena/games/:id/resign        agent key or game key
 *   POST /api/v1/arena/games/:id/draw          {draw: offer|accept}, agent key or game key
 *   POST /api/v1/arena/games/:id/game-key      {game_key}: the wallet grants a (new) game key for this game
 *   POST /api/v1/arena/games/:id/game-key/revoke  the wallet's "end game key"
 *   POST /api/v1/arena/games/:id/scoresheet    {result, chain_head}: optional, "I accept the result"
 *   POST /api/v1/arena/games/:id/predict       {side, probability}: calibration only, never money
 *   GET  /api/v1/arena/ratings                 chess ratings, separate from RepID
 *   GET  /arena                                the human play page (same origin, no CDN)
 *
 * WHO IS CALLING. Two existing schemes, no new one:
 *   - an agent sends its own API key; authMiddleware validates it and it must be bound to an agent
 *     (an operator key names nobody and is refused);
 *   - a human signs with a wallet (x-hd-wallet, x-hd-timestamp, x-hd-signature), checked by
 *     `provenArenaWallet` below under the same rules as byok.ts's provenWallet (5-minute window, the
 *     shared verifyWalletMessage, the same three outcomes), and must have connected that wallet once
 *     (accountOfWallet). The statement is the
 *     arena's own (`arenaStatement` below), NOT the shared authMessage: it names the action in plain
 *     words (the move with its game and ply; the challenge's opponent, colour, stake, time control and
 *     speed; the prediction's side and probability). The server rebuilds it from the body, so a
 *     signature cannot be resent with another body, and the page shows the same text before the wallet
 *     does. Each accepted statement is SINGLE USE: its sha256 goes into arena_signatures under a
 *     primary key. (The statement, not the signature bytes, is hashed: an ECDSA signature has a
 *     second valid form, so hashing the bytes would let a replay through.)
 *
 * GAME KEYS (src/arena/game-key.ts). A human signs with the wallet ONCE per game: the challenge or
 * the accept carries a grant to a P-256 key the browser made (WebCrypto, non-extractable). After
 * that the game key signs each move, resign and draw action, with no popup. A game key is accepted
 * only on those three routes, only for its own game, and only until the game ends, the wallet ends
 * it, or a new grant replaces it. Every other route refuses it. The wallet is still required for
 * everything stake-bearing. Moves form a hash chain, and the grants (statement + signature) and
 * every key signature are published with the game, so anyone can verify the game without the server.
 * Humans no longer sign moves with the wallet: a popup per move trains people to stop reading.
 *
 * STAKES. 0, 0.1, 1 or 10 testnet USD, recorded only. The staker is always a player, and the stake
 * is always on the staker's own win: there is no field that names someone else's game or side, and
 * unknown fields are refused. The acceptor matches the stake on its own win by accepting. The only
 * effect is the rating multiplier M in src/arena/rating.ts. No escrow and no payout in this build.
 *
 * OWNERS. Every challenge is classified with ownerRelation (owner-distinct-shadow.ts, #1429). Same
 * or unknown owner is allowed but marked owner_distinct=false AND rated=false: it is recorded,
 * playable and replayable, but never moves arena_ratings and is never trust evidence. Only a strong
 * distinct pair is trust_evidence. Trust signals (conduct, never the chess result) go to
 * arena_trust_signals, shadow.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { trustedClientIp } from '../middleware/client-ip';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { accountOfWallet } from './v1/byok';
import { verifyWalletMessage } from '../services/wallet-signature';
import { resolveOwner, type AgentRef, type OwnerClaim, type OwnerResolution } from '../services/agent-owner-resolver';
import { ownerRelation } from '../services/owner-distinct-shadow';
import { peekHaltState } from '../services/emergency-halt';
import type { OwnerRef } from '../services/human-agent-binding';
import { DEFAULTS, expected, foldRatings, spreads } from '../arena/rating';
import {
  START_FEN, TIME_CONTROLS, clockAt, isTimeControl, legalUci, outcomeOf, replay, timeoutResult, tryMove,
  type Color, type StoredMove,
} from '../arena/referee';
import { ArenaTablesMissing, MIGRATION_FILE, supabaseArenaStore, type ArenaStore, type GameRow, type GameStatus, type Speed } from '../arena/store';
import type { TimeControl } from '../arena/referee';
import { ARENA_JS, ARENA_HTML } from '../arena/page';
import {
  KEY_ACTS, chainHead, chainNext, gameKeyPayload, grantLines, jwkThumbprint, parseJwk, verifyGameKey,
  type ChainEvent, type KeyAct, type PublicJwk,
} from '../arena/game-key';

export const arenaEnabled = (): boolean => process.env.ARENA_ENABLED === 'true';

export const STAKES_USD = [0, 0.1, 1, 10] as const;
export const SPEEDS: readonly Speed[] = ['machine', '1', '0.5', '0.25'];
const isSpeed = (x: unknown): x is Speed => typeof x === 'string' && (SPEEDS as readonly string[]).includes(x);
const CHALLENGE_TTL_MS = 24 * 3600_000;
const MAX_STREAMS_PER_NETWORK = 10;
/** Horizon for the survival spread locked at accept (AC's default ply cap). Not a game length limit. */
const SPREAD_HORIZON_PLIES = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

/** `agent:<uuid>` or `human:<0x wallet>`, lowercase. Accepts the bare uuid / address too. */
export function participantRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^(?:(agent|human):)?(.+)$/i.exec(raw.trim());
  const kind = m?.[1]?.toLowerCase(), id = m?.[2] ?? '';
  if (UUID_RE.test(id) && kind !== 'human') return `agent:${id.toLowerCase()}`;
  if (WALLET_RE.test(id) && kind !== 'agent') return `human:${id.toLowerCase()}`;
  return null;
}

/**
 * What a human's WALLET signs. Each variant names everything the server will do with the request.
 * `grant` (a game key's RFC 7638 thumbprint) rides on a challenge or an accept, so a human signs once
 * per game. Moves are not here: a game key signs those (src/arena/game-key.ts).
 */
export type ArenaAction =
  | { action: 'challenge'; game?: string; opponent: string; colour: 'white' | 'black'; stake_usd: number; time_control: TimeControl; speed: Speed; grant?: string }
  | { action: 'accept'; game: string; colour: 'white' | 'black'; stake_usd: number; grant?: string }
  | { action: 'grant'; game: string; colour: 'white' | 'black'; stake_usd: number; grant: string }
  | { action: 'revoke'; game: string }
  | { action: 'scoresheet'; game: string; result: string; plies: number; chain_head: string }
  | { action: 'predict'; game: string; side: 'white' | 'black'; probability: number };

/**
 * The arena's signed statement, in plain words. The page builds the same text (src/arena/page.ts,
 * pinned equal by tests/arena.test.ts) and shows it before the wallet does.
 */
export function arenaStatement(a: ArenaAction, wallet: string, timestamp: string): string {
  const lines = ['HyperDAG AgentChess arena (testnet; no money moves)'];
  const stake = (usd: number) => `stake: ${usd} testnet USD, on your own win`;
  if (a.action === 'challenge') {
    lines.push('action: challenge', ...(a.game ? [`game: ${a.game}`] : []), `opponent: ${a.opponent}`, `you play: ${a.colour}`,
      stake(a.stake_usd), `time control: ${a.time_control}`, `viewer speed: ${a.speed}`, ...(a.grant ? grantLines(a.grant) : []));
  } else if (a.action === 'accept') {
    lines.push('action: accept challenge', `game: ${a.game}`, `you play: ${a.colour}`, stake(a.stake_usd), ...(a.grant ? grantLines(a.grant) : []));
  } else if (a.action === 'grant') {
    lines.push('action: grant a game key', `game: ${a.game}`, `you play: ${a.colour}`, stake(a.stake_usd), ...grantLines(a.grant));
  } else if (a.action === 'revoke') {
    lines.push('action: end game key', `game: ${a.game}`);
  } else if (a.action === 'scoresheet') {
    lines.push('action: sign the scoresheet (I accept the result)', `game: ${a.game}`, `result: ${a.result}`, `plies: ${a.plies}`, `move chain: ${a.chain_head}`);
  } else {
    lines.push('action: predict (calibration only)', `game: ${a.game}`, `side: ${a.side} wins`, `probability: ${a.probability}`);
  }
  lines.push(`wallet: ${wallet.toLowerCase()}`, `time: ${timestamp}`);
  return lines.join('\n');
}

const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Prove the caller's wallet signed `statement`. The same rules and answers as byok.ts provenWallet,
 * whose statement is the shared authMessage; it is left byte-for-byte unchanged, so /account/connect
 * and byok behave exactly as before. Returns null after writing the refusal.
 */
async function provenArenaWallet(req: Request, res: Response, statement: (wallet: string, timestamp: string) => string): Promise<string | null> {
  const wallet = String(req.headers['x-hd-wallet'] ?? '').trim();
  const signature = String(req.headers['x-hd-signature'] ?? '').trim();
  const timestamp = String(req.headers['x-hd-timestamp'] ?? '').trim();
  if (!wallet || !signature || !timestamp) {
    res.status(401).json({ error: 'signature_required', message: 'Send x-hd-wallet, x-hd-timestamp and x-hd-signature over the statement below.', sign_this: statement(wallet || '<your wallet>', '<ISO timestamp>') });
    return null;
  }
  const age = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_SKEW_MS) {
    res.status(401).json({ error: 'stale_signature', message: 'Timestamp is missing, malformed, or more than 5 minutes from now.' });
    return null;
  }
  const checked = await verifyWalletMessage(wallet, statement(wallet, timestamp), signature);
  if (!checked.ok) {
    // not_checked = we could not look (an RPC for a smart wallet); refuse, but say so truthfully.
    if (checked.reason === 'not_checked') res.status(503).json({ error: 'signature_not_checked', message: checked.detail });
    else res.status(401).json({ error: 'bad_signature', message: 'The signature does not match this exact action for this wallet.' });
    return null;
  }
  return wallet;
}

/** Replay delay before the next event. `sinceLastMs` = time already spent since the previous event went out. */
export function replayDelayMs(gapMs: number, speed: Speed, sinceLastMs = 0): number {
  return speed === 'machine' ? 0 : Math.max(0, Math.max(0, gapMs) / Number(speed) - sinceLastMs);
}

export interface ArenaDeps {
  store?: ArenaStore;
  resolve?: (ref: AgentRef) => Promise<OwnerResolution>;
  accountOf?: (wallet: string) => Promise<OwnerRef | null>;
  now?: () => number;
  /** How often a live stream re-reads the game. */
  pollMs?: number;
}

/** `statement` and `signature` are set for a wallet caller: a grant is published with them. */
type Principal = { ref: string; statement?: string; signature?: string };
/** A player proven by a game-key signature: the key, its signature and signed time are published with the move. */
type KeyPrincipal = Principal & { key: string; sig: string; time: string; prev: string; ply: number };

export function createArenaRouters(deps: ArenaDeps = {}): { api: Router; page: Router } {
  const store = deps.store ?? supabaseArenaStore(db);
  const resolve = deps.resolve ?? resolveOwner;
  const accountOf = deps.accountOf ?? accountOfWallet;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 1000;
  const iso = (ms: number) => new Date(ms).toISOString();

  // ── gates ──────────────────────────────────────────────────────────────────
  const flagGate = (_req: Request, res: Response, next: NextFunction) => {
    if (!arenaEnabled()) return void res.status(404).json({ error: 'not_found', message: 'The arena is not enabled on this deployment.' });
    next();
  };
  const tablesGate = async (_req: Request, _res: Response, next: NextFunction) => {
    await store.ensureTables();
    next();
  };

  /**
   * Who is calling: a wallet-signed human, or an agent-bound API key. Writes the refusal itself.
   * `action` builds, from the request body, the statement a human must have signed; null means the
   * caller is not someone who can take this action (e.g. not a player in the challenge).
   */
  async function principal(req: Request, res: Response, action: (me: string) => ArenaAction | null): Promise<Principal | null> {
    if (req.headers['x-arena-key-signature'] !== undefined) {
      res.status(403).json({ error: 'key_not_allowed', message: 'A game key can only move, offer or accept a draw, or resign, in its own game. This action needs the wallet.' });
      return null;
    }
    if (req.headers['x-hd-wallet'] !== undefined) {
      const claimed = `human:${String(req.headers['x-hd-wallet']).trim().toLowerCase()}`;
      const act = action(claimed);
      if (!act) {
        res.status(403).json({ error: 'not_a_participant', message: 'You can only take this action as one of the players.' });
        return null;
      }
      let signed = '';
      const wallet = await provenArenaWallet(req, res, (w, ts) => (signed = arenaStatement(act, w, ts)));
      if (!wallet) return null;
      if (!(await accountOf(wallet))) {
        res.status(403).json({ error: 'no_account', message: 'That wallet proved control but has no account yet. POST /api/v1/account/connect once, then play.' });
        return null;
      }
      const sha = createHash('sha256').update(signed).digest('hex');
      if ((await store.claimSignature({ statement_sha256: sha, wallet: wallet.toLowerCase(), action: act.action })) === 'duplicate') {
        res.status(401).json({ error: 'signature_replayed', message: 'That signature was already used once. Sign the action again.' });
        return null;
      }
      return { ref: `human:${wallet.toLowerCase()}`, statement: signed, signature: String(req.headers['x-hd-signature']).trim() };
    }
    let passed = false;
    await authMiddleware(req, res, () => { passed = true; });
    if (!passed) return null; // authMiddleware already answered 401/403
    const agentId = (req as any).agent_id;
    if (!agentId) {
      res.status(403).json({ error: 'agent_key_required', message: 'This key names no agent. Play with an agent-bound API key, or sign with a wallet.' });
      return null;
    }
    return { ref: `agent:${String(agentId).toLowerCase()}` };
  }

  /** Only these body fields exist. Anything else (a side bet, a stake on someone else) is refused. */
  function onlyFields(req: Request, res: Response, allowed: readonly string[]): Record<string, unknown> | null {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const extra = Object.keys(body).filter((k) => !allowed.includes(k));
    if (extra.length) {
      res.status(400).json({ error: 'unknown_field', fields: extra, message: `Only ${allowed.join(', ') || 'an empty body'} may be sent. There are no side bets in this API.` });
      return null;
    }
    return body;
  }

  // ── game keys ──────────────────────────────────────────────────────────────
  /** The `game_key` body field: a P-256 public JWK. Writes a 400 and returns null when it is not one. */
  function parseGameKey(raw: unknown, res: Response): { jwk: PublicJwk; thumbprint: string } | null {
    const jwk = parseJwk((raw as { jwk?: unknown } | null)?.jwk ?? raw);
    if (!jwk) {
      res.status(400).json({ error: 'bad_game_key', message: 'game_key is a P-256 public key as a JWK: {"kty":"EC","crv":"P-256","x":"...","y":"..."}.' });
      return null;
    }
    return { jwk, thumbprint: jwkThumbprint(jwk) };
  }
  /** A thumbprint belongs to one player per game: granting the opponent's public key is refused. */
  async function keyTaken(g: GameRow, me: string, thumbprint: string, res: Response): Promise<boolean> {
    if (!(await store.gameKeys(g.id)).some((k) => k.thumbprint === thumbprint && k.participant !== me)) return false;
    res.status(409).json({ error: 'game_key_in_use', message: 'That key is already granted to the other player in this game. Make a new key.' });
    return true;
  }
  const grantRow = (g: GameRow, me: Principal, k: { jwk: PublicJwk; thumbprint: string }) => ({
    game_id: g.id, participant: me.ref, thumbprint: k.thumbprint, public_jwk: k.jwk, capabilities: [...KEY_ACTS],
    grant_statement: me.statement ?? '', grant_signature: me.signature ?? '',
  });

  /**
   * A game-key signature (x-arena-key-signature over gameKeyPayload, x-arena-key-time). Only the keys
   * granted for THIS game are tried, so a key cannot act anywhere else. Returns the player, and the
   * key's thumbprint so the move or event can be published with it.
   */
  async function keyPrincipal(req: Request, res: Response, g: GameRow, a: { act: KeyAct; uci?: string }): Promise<KeyPrincipal | null> {
    const sig = String(req.headers['x-arena-key-signature'] ?? '').trim(), time = String(req.headers['x-arena-key-time'] ?? '').trim();
    const age = now() - Date.parse(time);
    if (!sig || !Number.isFinite(age) || Math.abs(age) > MAX_SKEW_MS) {
      res.status(401).json({ error: 'stale_key_signature', message: 'Send x-arena-key-signature and x-arena-key-time (within 5 minutes of now).' });
      return null;
    }
    const ply = g.moves.length + 1, prev = chainHead(g.id, g.moves);
    // Each grant is tried with ITS player in the payload, active grants first: a re-granted key
    // resolves to its live row, not an older revoked one.
    const rows = (await store.gameKeys(g.id)).sort((x, y) => Number(!!x.revoked_at) - Number(!!y.revoked_at));
    const row = rows.find((k) => verifyGameKey(k.public_jwk, gameKeyPayload({ game: g.id, player: k.participant, act: a.act, ply, prev, uci: a.uci }, time), sig));
    if (!row) {
      // The expected ply and prev let an honest client resync; they reveal nothing that GET does not.
      res.status(401).json({ error: 'bad_key_signature', message: 'No game key granted for this game verifies this exact action (game, ply, previous move hash, move, time).', ply, prev });
      return null;
    }
    if (row.revoked_at) {
      res.status(401).json({ error: 'game_key_revoked', reason: row.revoked_reason, message: 'This game key no longer acts for you. Sign a new grant with your wallet.' });
      return null;
    }
    if (!row.capabilities.includes(a.act)) return void res.status(403).json({ error: 'not_granted', act: a.act }), null;
    return { ref: row.participant, key: row.thumbprint, sig, time, prev, ply };
  }

  /** Who may move, resign or draw: a game key for this game, or an agent's API key. Never a wallet popup. */
  async function player(req: Request, res: Response, g: GameRow, a: { act: KeyAct; uci?: string }): Promise<KeyPrincipal | Principal | null> {
    if (req.headers['x-arena-key-signature'] !== undefined) return keyPrincipal(req, res, g, a);
    if (req.headers['x-hd-wallet'] !== undefined) {
      res.status(400).json({ error: 'use_game_key', message: 'Humans move, resign and offer draws with this game\'s game key, not a wallet popup. If this browser has no key for the game, POST /games/:id/game-key once with the wallet.' });
      return null;
    }
    return principal(req, res, () => null);
  }

  const isKey = (p: Principal): p is KeyPrincipal => typeof (p as KeyPrincipal).key === 'string';

  /** The one standing draw offer: the latest offer, by `by`, with no move made since. */
  const standingOffer = (g: GameRow): ChainEvent | null => {
    const last = [...(g.events ?? [])].reverse().find((e) => e.act === 'offer_draw' || e.act === 'accept_draw' || e.act === 'resign');
    return last && last.act === 'offer_draw' && last.ply === g.moves.length + 1 ? last : null;
  };

  // ── owners ─────────────────────────────────────────────────────────────────
  type Side = { agentId: string | null; claims: OwnerClaim[] };
  async function ownerSide(ref: string): Promise<Side | 'not_found' | 'unreadable'> {
    if (ref.startsWith('agent:')) {
      const r = await resolve({ id: ref.slice(6) });
      if (r.agentId === null) return r.reason === 'agent_not_found' ? 'not_found' : 'unreadable';
      return r;
    }
    const wallet = ref.slice(6);
    const claim = (ownerKey: string, ownerKeyKind: OwnerClaim['ownerKeyKind'], assurance: OwnerClaim['assurance']): OwnerClaim =>
      ({ source: 'wallet_signature', assurance, ownerKey, ownerKeyKind, capUsdcPerTx: null, capUsdcTotal: null });
    const claims = [claim(wallet, 'wallet', 'proven_wallet')];
    const acct = await accountOf(wallet);
    if (acct?.kind === 'human_sbt') claims.unshift(claim(acct.id, 'human_sbt_token', 'proven_human'));
    else if (acct) claims.unshift(claim(acct.id, 'builder_id', 'proven_wallet'));
    return { agentId: null, claims };
  }

  // ── game helpers ───────────────────────────────────────────────────────────
  const colorOf = (g: GameRow, ref: string): Color | null => (g.white === ref ? 'w' : g.black === ref ? 'b' : null);
  const sinceOf = (g: GameRow) => Date.parse(g.last_move_at ?? g.started_at ?? g.created_at);
  const scoreWhite = (r: GameRow['result']) => (r === '1-0' ? 1 : r === '0-1' ? 0 : 0.5);

  function publicGame(g: GameRow, nowMs: number) {
    const chess = replay(g.moves);
    const turn: Color = chess.turn();
    const live = g.status === 'live';
    const clock = live ? clockAt(g.clock_ms, turn, sinceOf(g), nowMs) : g.clock_ms;
    return {
      id: g.id, status: g.status, white: g.white, black: g.black, challenger: g.challenger,
      stake: { usd: Number(g.stake_usd), each_player_on_own_win: true, testnet: true, escrow: false, effect: 'chess-rating multiplier only' },
      time_control: g.time_control, clock_rules: TIME_CONTROLS[g.time_control], default_speed: g.default_speed,
      owner: { relation: g.owner_relation, evidence: g.owner_evidence, owner_distinct: g.owner_distinct, trust_evidence: g.trust_evidence },
      rated: g.rated,
      fen: chess.fen(), turn: live ? (turn === 'w' ? 'white' : 'black') : null,
      moves: g.moves, chain_head: chainHead(g.id, g.moves), events: g.events ?? [],
      draw_offer: live && standingOffer(g) ? { by: standingOffer(g)!.by } : null,
      clocks: { white_ms: clock.w, black_ms: clock.b, running: live ? (turn === 'w' ? 'white' : 'black') : null },
      legal_uci: live ? legalUci(chess) : [],
      result: g.result, termination: g.termination, pre: g.pre,
      created_at: g.created_at, started_at: g.started_at, finished_at: g.finished_at,
      expires_at: g.status === 'pending' ? iso(Date.parse(g.created_at) + CHALLENGE_TTL_MS) : null,
      shadow: true, money: false,
    };
  }

  /** After a game ends: shadow trust signals (conduct only) and the rating fold. */
  async function afterFinish(g: GameRow): Promise<void> {
    const preds = await store.listPredictions(g.id);
    const flaggedSide = g.termination?.startsWith('loss on time') ? (g.result === '0-1' ? 'w' : 'b') : null;
    await store.insertSignals((['w', 'b'] as const).map((c) => {
      const ref = c === 'w' ? g.white : g.black, sideName = c === 'w' ? 'white' : 'black';
      const mine = g.moves.filter((_, i) => (i % 2 === 0) === (c === 'w')).length;
      const illegal = g.illegal_attempts[c] ?? 0;
      const own = preds.find((p) => p.predictor === ref && p.side === sideName);
      const won = scoreWhite(g.result) === (c === 'w' ? 1 : 0) ? 1 : 0;
      return {
        game_id: g.id, participant: ref, owner_distinct: g.owner_distinct, trust_evidence: g.trust_evidence,
        signals: {
          completed: flaggedSide !== c, abandoned_or_timeout: flaggedSide === c,
          moves: mine, illegal_attempts: illegal, legal_answer_rate: mine + illegal ? mine / (mine + illegal) : null,
          accepted_result: null, accepted_note: 'absent until the player signs the scoresheet (optional); absent is not negative, and the referee result stands either way',
          stake_honored: null, stake_note: 'no escrow in this build; the stake is recorded only',
          calibration: own ? { p_win: Number(own.probability), won, brier_win: +((Number(own.probability) - won) ** 2).toFixed(4), at_ply: own.at_ply } : null,
          excluded: 'the chess result itself is never trust evidence',
        },
      };
    }));
    // An unrated game (owner_distinct=false) never moves the ladder: not even a re-write of it.
    if (g.rated) await store.upsertRatings(Object.entries(await currentRatings()).map(([participant, r]) => ({ participant, ...r })));
  }

  /** The chess ratings: a pure fold of every finished RATED game, so the stored table can always be rebuilt. */
  async function currentRatings() {
    const games = await store.finishedGames();
    return foldRatings(games.map((x) => ({ white: x.white, black: x.black, score_white: scoreWhite(x.result), stake_usd: Number(x.stake_usd) })));
  }

  /**
   * A live game whose side to move has no time left is lost on time. Returns the current row.
   * Reads (GET, the stream) call this too, so it is the one write a GET can make. It stands down
   * during an emergency halt, like every write: the game is settled by the first read after.
   */
  async function settleClock(g: GameRow): Promise<GameRow> {
    if (g.status !== 'live' || peekHaltState().halted) return g;
    const turn = replay(g.moves).turn(), t = now();
    if (clockAt(g.clock_ms, turn, sinceOf(g), t)[turn] > 0) return g;
    const clock_ms = { ...g.clock_ms, [turn]: 0 };
    const done = await store.updateGame(g.id, g.version, { status: 'finished', ...timeoutResult(turn), clock_ms, finished_at: iso(t) });
    if (!done) return (await store.getGame(g.id)) ?? g; // someone else settled or moved first
    await afterFinish(done);
    return done;
  }

  async function loadGame(req: Request, res: Response): Promise<GameRow | null> {
    const id = String(req.params.id ?? '');
    const g = UUID_RE.test(id) ? await store.getGame(id) : null;
    if (!g) res.status(404).json({ error: 'no_such_game' });
    return g;
  }

  // ── the API ────────────────────────────────────────────────────────────────
  const api = Router();
  api.use(flagGate, tablesGate);
  // Every write authenticates (a signature check or a key lookup), so each one is braked per network
  // on top of the global /api/v1 limiter. 120 a minute is far above a person or a bot playing chess.
  const openStreams = new Map<string, number>(); // ponytail: per-process count; share it (Redis) if the engine runs more than one replica
  const writeLimiter = rateLimit({
    windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req): string => ipKeyGenerator(trustedClientIp(req)),
    message: { error: 'too_many_requests', message: 'Too many arena writes from this network. Try again in a minute.' },
  });

  api.post('/challenges', writeLimiter, async (req, res) => {
    // The body is checked before the caller, because a human's signature is checked against a
    // statement rebuilt FROM this body: a signature over other terms then fails as bad_signature.
    const body = onlyFields(req, res, ['white', 'black', 'stake_usd', 'time_control', 'speed', 'stake_on', 'game_id', 'game_key']);
    if (!body) return;
    const white = participantRef(body.white), black = participantRef(body.black);
    const gameId = body.game_id === undefined ? undefined : String(body.game_id).toLowerCase();
    if (gameId !== undefined && !UUID_RE.test(gameId)) return void res.status(400).json({ error: 'bad_game_id', message: 'game_id is a uuid you choose, so the grant can name the game before it exists.' });
    const key = body.game_key === undefined ? null : parseGameKey(body.game_key, res);
    if (body.game_key !== undefined && !key) return;
    if (key && !gameId) return void res.status(400).json({ error: 'game_id_required', message: 'A game key is granted for one game: send the game_id it is for.' });
    if (key && req.headers['x-hd-wallet'] === undefined) return void res.status(400).json({ error: 'game_keys_are_for_wallets', message: 'Agents play with their API key; a game key is granted by a human wallet.' });
    if (!white || !black) return void res.status(400).json({ error: 'bad_participant', message: 'white and black are each an agent uuid or a 0x wallet address.' });
    if (white === black) return void res.status(400).json({ error: 'same_participant', message: 'A player cannot play itself.' });
    const stake = body.stake_usd ?? 0;
    if (typeof stake !== 'number' || !(STAKES_USD as readonly number[]).includes(stake)) {
      return void res.status(400).json({ error: 'bad_stake', allowed_usd: STAKES_USD, message: 'Stake is 0, 0.1, 1 or 10 testnet USD (max 10). It is recorded, never escrowed.' });
    }
    const tc = body.time_control ?? 'normal', speed = String(body.speed ?? '1');
    if (!isTimeControl(tc)) return void res.status(400).json({ error: 'bad_time_control', allowed: Object.keys(TIME_CONTROLS) });
    if (!isSpeed(speed)) return void res.status(400).json({ error: 'bad_speed', allowed: SPEEDS });

    const me = await principal(req, res, (ref) => (ref === white || ref === black
      ? { action: 'challenge', ...(gameId ? { game: gameId } : {}), opponent: ref === white ? black : white, colour: ref === white ? 'white' : 'black', stake_usd: stake, time_control: tc, speed, ...(key ? { grant: key.thumbprint } : {}) }
      : null));
    if (!me) return;
    if (me.ref !== white && me.ref !== black) {
      return void res.status(403).json({ error: 'not_a_participant', message: 'You can only challenge as one of the two players. Nobody can stake on a game they are not playing.' });
    }
    if (body.stake_on !== undefined && participantRef(body.stake_on) !== me.ref) {
      return void res.status(400).json({ error: 'stake_own_win_only', message: 'A player may stake only on its own win.' });
    }

    const [w, b] = await Promise.all([ownerSide(white), ownerSide(black)]);
    if (w === 'not_found' || b === 'not_found') return void res.status(404).json({ error: 'unknown_agent', message: 'No agent with that id.' });
    if (w === 'unreadable' || b === 'unreadable') return void res.status(503).json({ error: 'owner_unreadable', message: 'Could not read the agent registry; nothing was created.' });
    const rel = ownerRelation(w, b), distinct = rel.relation === 'distinct';
    const base = TIME_CONTROLS[tc].base_ms;
    if (gameId && (await store.getGame(gameId))) return void res.status(409).json({ error: 'game_id_taken' });
    const g = await store.insertGame({
      ...(gameId ? { id: gameId } : {}),
      status: 'pending', white, black, challenger: me.ref, stake_usd: stake, time_control: tc, default_speed: speed,
      owner_relation: rel.relation, owner_evidence: rel.evidence, owner_distinct: distinct,
      trust_evidence: distinct && rel.evidence === 'strong', rated: distinct,
      fen: START_FEN, moves: [], clock_ms: { w: base, b: base }, illegal_attempts: { w: 0, b: 0 },
    });
    if (key) await store.addGameKey(grantRow(g, me, key));
    res.status(201).json({
      challenge: publicGame(g, now()), stake_on: me.ref, game_key: key ? { thumbprint: key.thumbprint } : null,
      note: distinct
        ? 'Testnet and shadow: no money moves, and the chess rating never feeds RepID.'
        : 'Testnet and shadow. These players are not shown to have different owners, so this game is UNRATED: it is recorded and replayable but never moves the chess ratings.',
    });
  });

  api.post('/challenges/:id/accept', writeLimiter, async (req, res) => {
    const body = onlyFields(req, res, ['game_key']);
    if (!body) return;
    const g = await loadGame(req, res);
    if (!g) return;
    const key = body.game_key === undefined ? null : parseGameKey(body.game_key, res);
    if (body.game_key !== undefined && !key) return;
    if (key && req.headers['x-hd-wallet'] === undefined) return void res.status(400).json({ error: 'game_keys_are_for_wallets', message: 'Agents play with their API key; a game key is granted by a human wallet.' });
    const me = await principal(req, res, (ref) => (colorOf(g, ref)
      ? { action: 'accept', game: g.id, colour: colorOf(g, ref) === 'w' ? 'white' : 'black', stake_usd: Number(g.stake_usd), ...(key ? { grant: key.thumbprint } : {}) }
      : null));
    if (!me) return;
    if (g.status !== 'pending') return void res.status(409).json({ error: 'not_pending', status: g.status });
    if (now() - Date.parse(g.created_at) > CHALLENGE_TTL_MS) return void res.status(410).json({ error: 'challenge_expired' });
    const challenged = g.challenger === g.white ? g.black : g.white;
    if (me.ref !== challenged) return void res.status(403).json({ error: 'not_the_challenged_side', message: 'Only the challenged player can accept.' });
    if (key && (await keyTaken(g, me.ref, key.thumbprint, res))) return;
    const rated = await currentRatings();
    const rw = rated[g.white]?.rating ?? DEFAULTS.anchor, rb = rated[g.black]?.rating ?? DEFAULTS.anchor;
    const pre = { rating_white: rw, rating_black: rb, E_white: +expected(rw, rb).toFixed(4), spread: spreads(rw, rb, SPREAD_HORIZON_PLIES) };
    const t = iso(now());
    const live = await store.updateGame(g.id, g.version, { status: 'live', started_at: t, pre });
    if (!live) return void res.status(409).json({ error: 'conflict', message: 'The challenge changed; read it again.' });
    if (key) await store.addGameKey(grantRow(live, me, key));
    res.json({ game: publicGame(live, now()), game_key: key ? { thumbprint: key.thumbprint } : null });
  });

  api.get('/games', async (req, res) => {
    const status = String(req.query.status ?? 'live') as GameStatus;
    if (!['pending', 'live', 'finished'].includes(status)) return void res.status(400).json({ error: 'bad_status', allowed: ['pending', 'live', 'finished'] });
    const participant = req.query.participant === undefined ? null : participantRef(req.query.participant);
    if (req.query.participant !== undefined && !participant) return void res.status(400).json({ error: 'bad_participant' });
    const t = now();
    const rows = (await store.listGames(status, participant, 50))
      .filter((g) => status !== 'pending' || t - Date.parse(g.created_at) <= CHALLENGE_TTL_MS);
    res.json({ games: rows.map((g) => ({ id: g.id, status: g.status, white: g.white, black: g.black, challenger: g.challenger, stake_usd: Number(g.stake_usd), time_control: g.time_control, owner_distinct: g.owner_distinct, rated: g.rated, fen: g.fen, plies: g.moves.length, result: g.result, created_at: g.created_at })) });
  });

  api.get('/games/:id', async (req, res) => {
    const g0 = await loadGame(req, res);
    if (!g0) return;
    const g = await settleClock(g0);
    const preds = await store.listPredictions(g.id);
    const scored = g.status === 'finished'
      ? preds.map((p) => (Number(p.probability) - (scoreWhite(g.result) === (p.side === 'white' ? 1 : 0) ? 1 : 0)) ** 2)
      : [];
    // The wallet grants are published with the game: with them, anyone can verify every game-key
    // signature in the record (src/arena/game-key.ts verifyGameRecord) without trusting this server.
    const grants = (await store.gameKeys(g.id)).map((k) => ({ participant: k.participant, thumbprint: k.thumbprint, public_jwk: k.public_jwk, capabilities: k.capabilities,
      grant_statement: k.grant_statement, grant_signature: k.grant_signature, granted_at: k.granted_at, revoked_at: k.revoked_at, revoked_reason: k.revoked_reason,
      active: !k.revoked_at && g.status !== 'finished' }));
    res.json({ ...publicGame(g, now()), grants, predictions: { count: preds.length, mean_brier: scored.length ? +(scored.reduce((a, x) => a + x, 0) / scored.length).toFixed(4) : null } });
  });

  api.post('/games/:id/move', writeLimiter, async (req, res) => {
    const body = onlyFields(req, res, ['uci']);
    if (!body) return;
    const g0 = await loadGame(req, res);
    if (!g0) return;
    const uci = typeof body.uci === 'string' ? body.uci.trim().toLowerCase() : '';
    const me = await player(req, res, g0, { act: 'move', uci });
    if (!me) return;
    const mine = colorOf(g0, me.ref);
    if (!mine) return void res.status(403).json({ error: 'not_a_participant' });
    const g = await settleClock(g0);
    if (g.status !== 'live') return void res.status(409).json({ error: 'game_not_live', status: g.status, result: g.result, termination: g.termination });
    const chess = replay(g.moves), turn = chess.turn();
    if (turn !== mine) return void res.status(403).json({ error: 'not_your_turn', turn: turn === 'w' ? 'white' : 'black' });
    if (isKey(me) && me.ply !== g.moves.length + 1) return void res.status(409).json({ error: 'conflict', message: 'The game changed while you moved; read it again.' });
    const fenBefore = chess.fen();
    const mv = tryMove(chess, uci);
    if (!mv.ok) {
      // Counted for the legal-move-rate signal; a lost race here only drops one count.
      await store.updateGame(g.id, g.version, { illegal_attempts: { ...g.illegal_attempts, [mine]: (g.illegal_attempts[mine] ?? 0) + 1 } });
      return void res.status(400).json({ error: 'illegal_move', reason: mv.reason, fen: fenBefore, legal_uci: legalUci(chess) });
    }
    const t = now(), tc = TIME_CONTROLS[g.time_control];
    const clock_ms = { ...g.clock_ms, [turn]: clockAt(g.clock_ms, turn, sinceOf(g), t)[turn] + tc.increment_ms };
    const move: StoredMove = {
      uci: mv.uci, san: mv.san, at: iso(t), clock_ms, by: me.ref, hash: chainNext(chainHead(g.id, g.moves), g.moves.length + 1, mv.uci),
      ...(isKey(me) ? { key: me.key, sig: me.sig, time: me.time } : {}),
    };
    const end = outcomeOf(chess);
    const updated = await store.updateGame(g.id, g.version, {
      moves: [...g.moves, move], fen: chess.fen(), clock_ms, last_move_at: iso(t),
      ...(end ? { status: 'finished' as const, ...end, finished_at: iso(t) } : {}),
    });
    if (!updated) return void res.status(409).json({ error: 'conflict', message: 'The game changed while you moved; read it again.' });
    if (end) await afterFinish(updated);
    res.json({ game: publicGame(updated, now()) });
  });

  /** Resign, offer a draw, or accept one. A game key's signature is published with the event. */
  async function keyEvent(req: Request, res: Response, act: Exclude<KeyAct, 'move'>) {
    const g0 = await loadGame(req, res);
    if (!g0) return;
    const me = await player(req, res, g0, { act });
    if (!me) return;
    const mine = colorOf(g0, me.ref);
    if (!mine) return void res.status(403).json({ error: 'not_a_participant' });
    const g = await settleClock(g0);
    if (g.status !== 'live') return void res.status(409).json({ error: 'game_not_live', status: g.status, result: g.result, termination: g.termination });
    if (isKey(me) && me.ply !== g.moves.length + 1) return void res.status(409).json({ error: 'conflict', message: 'The game changed; read it again.' });
    const t = iso(now()), offer = standingOffer(g), theirs = offer && offer.by !== me.ref ? offer : null;
    const event: ChainEvent = { act, by: me.ref, ply: g.moves.length + 1, prev: chainHead(g.id, g.moves), ...(isKey(me) ? { key: me.key, sig: me.sig, time: me.time } : {}) };
    const name = mine === 'w' ? 'White' : 'Black';
    let end: { result: '1-0' | '0-1' | '1/2-1/2'; termination: string } | null = null;
    if (act === 'resign') end = { result: mine === 'w' ? '0-1' : '1-0', termination: `${name} resigned` };
    else if (act === 'accept_draw' || theirs) {
      if (!theirs) return void res.status(409).json({ error: 'no_draw_offer', message: 'There is no standing draw offer from your opponent (a move made since an offer withdraws it).' });
      end = { result: '1/2-1/2', termination: 'draw agreed' };
    }
    const updated = await store.updateGame(g.id, g.version, { events: [...(g.events ?? []), event], ...(end ? { status: 'finished' as const, ...end, finished_at: t } : {}) });
    if (!updated) return void res.status(409).json({ error: 'conflict', message: 'The game changed; read it again.' });
    if (end) await afterFinish(updated);
    res.json({ game: publicGame(updated, now()) });
  }
  api.post('/games/:id/resign', writeLimiter, async (req, res) => {
    if (!onlyFields(req, res, [])) return;
    await keyEvent(req, res, 'resign');
  });
  api.post('/games/:id/draw', writeLimiter, async (req, res) => {
    const body = onlyFields(req, res, ['draw']);
    if (!body) return;
    if (body.draw !== 'offer' && body.draw !== 'accept') return void res.status(400).json({ error: 'bad_draw', allowed: ['offer', 'accept'] });
    await keyEvent(req, res, body.draw === 'offer' ? 'offer_draw' : 'accept_draw');
  });

  /** The wallet grants a game key for this game (a lost key, another device). The new key revokes the old one. */
  api.post('/games/:id/game-key', writeLimiter, async (req, res) => {
    const body = onlyFields(req, res, ['game_key']);
    if (!body) return;
    const g = await loadGame(req, res);
    if (!g) return;
    const key = parseGameKey(body.game_key, res);
    if (!key) return;
    if (req.headers['x-hd-wallet'] === undefined && req.headers['x-arena-key-signature'] === undefined) {
      return void res.status(400).json({ error: 'game_keys_are_for_wallets', message: 'A game key is granted by a human wallet.' });
    }
    const me = await principal(req, res, (ref) => (colorOf(g, ref)
      ? { action: 'grant', game: g.id, colour: colorOf(g, ref) === 'w' ? 'white' : 'black', stake_usd: Number(g.stake_usd), grant: key.thumbprint }
      : null));
    if (!me) return;
    if (g.status === 'finished') return void res.status(409).json({ error: 'game_over', message: 'A game key ends with its game.' });
    if (await keyTaken(g, me.ref, key.thumbprint, res)) return;
    await store.addGameKey(grantRow(g, me, key));
    res.status(201).json({ game_key: { thumbprint: key.thumbprint }, note: 'Any earlier key of yours for this game no longer acts. The game clock did not pause.' });
  });

  api.post('/games/:id/game-key/revoke', writeLimiter, async (req, res) => {
    if (!onlyFields(req, res, [])) return;
    const g = await loadGame(req, res);
    if (!g) return;
    if (req.headers['x-hd-wallet'] === undefined && req.headers['x-arena-key-signature'] === undefined) {
      return void res.status(400).json({ error: 'game_keys_are_for_wallets', message: 'A game key is ended by the wallet that granted it.' });
    }
    const me = await principal(req, res, (ref) => (colorOf(g, ref) ? { action: 'revoke', game: g.id } : null));
    if (!me) return;
    await store.revokeGameKey(g.id, me.ref, iso(now()));
    res.json({ revoked: true });
  });

  /**
   * The optional scoresheet (FIDE Article 8.7): the player signs the result and the head of the move
   * chain. That is the "accepted the result" conduct signal. Not signing changes nothing: the
   * referee's result stands, and the signal is recorded as absent, not negative.
   */
  api.post('/games/:id/scoresheet', writeLimiter, async (req, res) => {
    const body = onlyFields(req, res, ['result', 'chain_head']);
    if (!body) return;
    const g = await loadGame(req, res);
    if (!g) return;
    const result = String(body.result ?? ''), head = String(body.chain_head ?? '');
    const me = await principal(req, res, (ref) => (colorOf(g, ref) ? { action: 'scoresheet', game: g.id, result, plies: g.moves.length, chain_head: head } : null));
    if (!me) return;
    if (!colorOf(g, me.ref)) return void res.status(403).json({ error: 'not_a_participant' });
    if (g.status !== 'finished') return void res.status(409).json({ error: 'game_not_finished' });
    const actual = { result: `${g.result} (${g.termination})`, chain_head: chainHead(g.id, g.moves) };
    if (result !== actual.result || head !== actual.chain_head) return void res.status(409).json({ error: 'scoresheet_mismatch', message: 'That is not this game\'s result and move chain, so it was not recorded as accepted.', actual });
    const ok = await store.markResultAccepted(g.id, me.ref, { result, chain_head: head, plies: g.moves.length, signed_at: iso(now()), by: me.statement ? 'wallet' : 'agent_key', ...(me.statement ? { statement: me.statement, signature: me.signature } : {}) });
    if (!ok) return void res.status(409).json({ error: 'no_signals_row' });
    res.json({ accepted_result: true });
  });

  api.post('/games/:id/predict', writeLimiter, async (req, res) => {
    const body = onlyFields(req, res, ['side', 'probability']);
    if (!body) return;
    const p = Number(body.probability), side = body.side;
    if (side !== 'white' && side !== 'black') return void res.status(400).json({ error: 'bad_side', allowed: ['white', 'black'] });
    if (typeof body.probability !== 'number' || !(p >= 0 && p <= 1)) return void res.status(400).json({ error: 'bad_probability', message: 'probability is a number from 0 to 1: your chance that this side wins.' });
    const g0 = await loadGame(req, res);
    if (!g0) return;
    const me = await principal(req, res, () => ({ action: 'predict', game: g0.id, side, probability: p }));
    if (!me) return;
    const g = await settleClock(g0);
    if (g.status === 'finished') return void res.status(409).json({ error: 'game_over' });
    const r = await store.insertPrediction({ game_id: g.id, predictor: me.ref, is_participant: colorOf(g, me.ref) !== null, side, probability: p, at_ply: g.moves.length });
    if (r === 'duplicate') return void res.status(409).json({ error: 'already_predicted', message: 'One prediction per game.' });
    res.status(201).json({ recorded: true, money: false, note: 'Calibration only: scored with a Brier score when the game ends. Nothing is staked or paid.' });
  });

  api.get('/ratings', async (_req, res) => {
    res.json({
      ratings: (await store.listRatings(100)).map((r) => ({ participant: r.participant, rating: Number(r.rating), games: r.games })),
      params: DEFAULTS, ruler: 'src/arena/rating.ts (port of lane AC ratings.mjs); result only, no engine performance term',
      note: 'Chess only. Separate from RepID, and never feeds it.',
    });
  });

  api.get('/games/:id/stream', async (req, res) => {
    const g0 = await loadGame(req, res);
    if (!g0) return;
    const speed = req.query.speed === undefined ? g0.default_speed : String(req.query.speed);
    if (!isSpeed(speed)) return void res.status(400).json({ error: 'bad_speed', allowed: SPEEDS });
    // Strix (LOW, CWE-400): a public stream is a held socket plus a DB read a second, so one network gets a
    // bounded number at once. A live game ends on its own clock; a pending one ends at its TTL (below).
    const ip = trustedClientIp(req), open = openStreams.get(ip) ?? 0;
    if (open >= MAX_STREAMS_PER_NETWORK) return void res.status(429).json({ error: 'too_many_streams', message: `At most ${MAX_STREAMS_PER_NETWORK} open arena streams per network.` });
    openStreams.set(ip, open + 1);
    res.on('close', () => { const n = (openStreams.get(ip) ?? 1) - 1; if (n > 0) openStreams.set(ip, n); else openStreams.delete(ip); });

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let closed = false;
    res.on('close', () => { closed = true; }); // not req: a GET's request side can close as soon as it is read
    const send = (event: string, data: unknown, id?: number) => { if (!closed) res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    /** A long replay gap (0.25x of a slow human move) still sends a comment every 15 s, so no proxy drops it as idle. */
    const pause = async (ms: number) => {
      for (let left = ms; left > 0 && !closed; left -= 15_000) {
        await sleep(Math.min(left, 15_000));
        if (left > 15_000 && !closed) res.write(': keep-alive\n\n');
      }
    };
    // EventSource reconnects on its own and sends the last ply it saw: resume after it, never from move 1 again.
    const resume = Math.max(0, Math.floor(Number(req.headers['last-event-id']) || 0));

    let g = g0, i = 0, prevAt = 0, lastSent = now(), lastBeat = now();
    const chess = replay([]), base = TIME_CONTROLS[g.time_control].base_ms;
    if (!resume) send('start', { id: g.id, white: g.white, black: g.black, status: g.status, started_at: g.started_at, fen: START_FEN, speed, time_control: g.time_control, clock_ms: { w: base, b: base } });
    while (!closed) {
      const m = g.moves[i];
      if (m) {
        const at = Date.parse(m.at);
        if (i === 0) prevAt = Date.parse(g.started_at ?? m.at); // the first gap is from the start of play, not from the challenge
        const wait = i < resume ? 0 : replayDelayMs(at - prevAt, speed, now() - lastSent);
        if (wait) await pause(wait);
        chess.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), ...(m.uci[4] ? { promotion: m.uci[4] } : {}) });
        if (i >= resume) send('move', { ply: i + 1, uci: m.uci, san: m.san, at: m.at, clock_ms: m.clock_ms, fen: chess.fen() }, i + 1);
        prevAt = at; lastSent = now(); i++;
        continue;
      }
      if (g.status === 'finished') { send('end', { result: g.result, termination: g.termination, finished_at: g.finished_at }); break; }
      if (g.status === 'pending' && now() - Date.parse(g.created_at) > CHALLENGE_TTL_MS) { send('end', { result: null, termination: 'challenge expired', finished_at: null }); break; }
      await sleep(pollMs);
      if (now() - lastBeat > 15_000) { if (!closed) res.write(': keep-alive\n\n'); lastBeat = now(); }
      const was = g.status;
      g = await settleClock((await store.getGame(g.id)) ?? g);
      if (g.status !== was) send('status', { status: g.status, started_at: g.started_at }); // e.g. the challenge was accepted
    }
    res.end();
  });

  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return void res.end();
    if (err instanceof ArenaTablesMissing) {
      return void res.status(503).json({ error: 'arena_tables_missing', message: `The arena tables are not migrated on this deployment. Apply ${MIGRATION_FILE} (Sean-gated prod DDL); until then nothing is read or written.` });
    }
    console.error('[arena]', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'arena_error' });
  });

  // ── the page ───────────────────────────────────────────────────────────────
  const page = Router();
  page.use(flagGate);
  page.get('/', (_req, res) => { res.type('html').send(ARENA_HTML); });
  page.get('/arena.js', (_req, res) => { res.type('application/javascript; charset=utf-8').send(ARENA_JS); });

  return { api, page };
}
