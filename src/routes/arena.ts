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
 *   POST /api/v1/arena/games/:id/move          {uci}, as the side to move
 *   POST /api/v1/arena/games/:id/predict       {side, probability}: calibration only, never money
 *   GET  /api/v1/arena/ratings                 chess ratings, separate from RepID
 *   GET  /arena                                the human play page (same origin, no CDN)
 *
 * WHO IS CALLING. Two existing schemes, no new one:
 *   - an agent sends its own API key; authMiddleware validates it and it must be bound to an agent
 *     (an operator key names nobody and is refused);
 *   - a human signs the method + path + timestamp with a wallet (x-hd-wallet, x-hd-timestamp,
 *     x-hd-signature), exactly as POST /api/v1/account/connect, and must have connected that wallet
 *     once. byok.ts's provenWallet + accountOfWallet do both; nothing is re-implemented here.
 *
 * STAKES. 0, 0.1, 1 or 10 testnet USD, recorded only. The staker is always a player, and the stake
 * is always on the staker's own win: there is no field that names someone else's game or side, and
 * unknown fields are refused. The acceptor matches the stake on its own win by accepting. The only
 * effect is the rating multiplier M in src/arena/rating.ts. No escrow and no payout in this build.
 *
 * OWNERS. Every challenge is classified with ownerRelation (owner-distinct-shadow.ts, #1429). Same
 * or unknown owner is allowed but marked owner_distinct=false, and only a strong distinct pair is
 * trust_evidence. Trust signals (conduct, never the chess result) go to arena_trust_signals, shadow.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { accountOfWallet, provenWallet } from './v1/byok';
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
import { ARENA_JS, ARENA_HTML } from '../arena/page';

export const arenaEnabled = (): boolean => process.env.ARENA_ENABLED === 'true';

export const STAKES_USD = [0, 0.1, 1, 10] as const;
export const SPEEDS: readonly Speed[] = ['machine', '1', '0.5', '0.25'];
const isSpeed = (x: unknown): x is Speed => typeof x === 'string' && (SPEEDS as readonly string[]).includes(x);
const CHALLENGE_TTL_MS = 24 * 3600_000;
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

type Principal = { ref: string };

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

  /** Who is calling: a wallet-signed human, or an agent-bound API key. Writes the refusal itself. */
  async function principal(req: Request, res: Response): Promise<Principal | null> {
    if (req.headers['x-hd-wallet'] !== undefined) {
      const wallet = await provenWallet(req, res);
      if (!wallet) return null;
      if (!(await accountOf(wallet))) {
        res.status(403).json({ error: 'no_account', message: 'That wallet proved control but has no account yet. POST /api/v1/account/connect once, then play.' });
        return null;
      }
      return { ref: `human:${wallet.toLowerCase()}` };
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
      fen: chess.fen(), turn: live ? (turn === 'w' ? 'white' : 'black') : null,
      moves: g.moves, clocks: { white_ms: clock.w, black_ms: clock.b, running: live ? (turn === 'w' ? 'white' : 'black') : null },
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
          accepted_result: null, accepted_note: 'the chess.js referee is final; no accept step in this build',
          stake_honored: null, stake_note: 'no escrow in this build; the stake is recorded only',
          calibration: own ? { p_win: Number(own.probability), won, brier_win: +((Number(own.probability) - won) ** 2).toFixed(4), at_ply: own.at_ply } : null,
          excluded: 'the chess result itself is never trust evidence',
        },
      };
    }));
    await store.upsertRatings(Object.entries(await currentRatings()).map(([participant, r]) => ({ participant, ...r })));
  }

  /** The chess ratings: a pure fold of every finished game, so the stored table can always be rebuilt. */
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

  api.post('/challenges', async (req, res) => {
    const me = await principal(req, res);
    if (!me) return;
    const body = onlyFields(req, res, ['white', 'black', 'stake_usd', 'time_control', 'speed', 'stake_on']);
    if (!body) return;
    const white = participantRef(body.white), black = participantRef(body.black);
    if (!white || !black) return void res.status(400).json({ error: 'bad_participant', message: 'white and black are each an agent uuid or a 0x wallet address.' });
    if (white === black) return void res.status(400).json({ error: 'same_participant', message: 'A player cannot play itself.' });
    if (me.ref !== white && me.ref !== black) {
      return void res.status(403).json({ error: 'not_a_participant', message: 'You can only challenge as one of the two players. Nobody can stake on a game they are not playing.' });
    }
    if (body.stake_on !== undefined && participantRef(body.stake_on) !== me.ref) {
      return void res.status(400).json({ error: 'stake_own_win_only', message: 'A player may stake only on its own win.' });
    }
    const stake = body.stake_usd ?? 0;
    if (typeof stake !== 'number' || !(STAKES_USD as readonly number[]).includes(stake)) {
      return void res.status(400).json({ error: 'bad_stake', allowed_usd: STAKES_USD, message: 'Stake is 0, 0.1, 1 or 10 testnet USD (max 10). It is recorded, never escrowed.' });
    }
    const tc = body.time_control ?? 'normal', speed = String(body.speed ?? '1');
    if (!isTimeControl(tc)) return void res.status(400).json({ error: 'bad_time_control', allowed: Object.keys(TIME_CONTROLS) });
    if (!isSpeed(speed)) return void res.status(400).json({ error: 'bad_speed', allowed: SPEEDS });

    const [w, b] = await Promise.all([ownerSide(white), ownerSide(black)]);
    if (w === 'not_found' || b === 'not_found') return void res.status(404).json({ error: 'unknown_agent', message: 'No agent with that id.' });
    if (w === 'unreadable' || b === 'unreadable') return void res.status(503).json({ error: 'owner_unreadable', message: 'Could not read the agent registry; nothing was created.' });
    const rel = ownerRelation(w, b);
    const base = TIME_CONTROLS[tc].base_ms;
    const g = await store.insertGame({
      status: 'pending', white, black, challenger: me.ref, stake_usd: stake, time_control: tc, default_speed: speed,
      owner_relation: rel.relation, owner_evidence: rel.evidence, owner_distinct: rel.relation === 'distinct',
      trust_evidence: rel.relation === 'distinct' && rel.evidence === 'strong',
      fen: START_FEN, moves: [], clock_ms: { w: base, b: base }, illegal_attempts: { w: 0, b: 0 },
    });
    res.status(201).json({ challenge: publicGame(g, now()), stake_on: me.ref, note: 'Testnet and shadow: no money moves, and the chess rating never feeds RepID.' });
  });

  api.post('/challenges/:id/accept', async (req, res) => {
    const me = await principal(req, res);
    if (!me) return;
    if (!onlyFields(req, res, [])) return;
    const g = await loadGame(req, res);
    if (!g) return;
    if (g.status !== 'pending') return void res.status(409).json({ error: 'not_pending', status: g.status });
    if (now() - Date.parse(g.created_at) > CHALLENGE_TTL_MS) return void res.status(410).json({ error: 'challenge_expired' });
    const challenged = g.challenger === g.white ? g.black : g.white;
    if (me.ref !== challenged) return void res.status(403).json({ error: 'not_the_challenged_side', message: 'Only the challenged player can accept.' });
    const rated = await currentRatings();
    const rw = rated[g.white]?.rating ?? DEFAULTS.anchor, rb = rated[g.black]?.rating ?? DEFAULTS.anchor;
    const pre = { rating_white: rw, rating_black: rb, E_white: +expected(rw, rb).toFixed(4), spread: spreads(rw, rb, SPREAD_HORIZON_PLIES) };
    const t = iso(now());
    const live = await store.updateGame(g.id, g.version, { status: 'live', started_at: t, pre });
    if (!live) return void res.status(409).json({ error: 'conflict', message: 'The challenge changed; read it again.' });
    res.json({ game: publicGame(live, now()) });
  });

  api.get('/games', async (req, res) => {
    const status = String(req.query.status ?? 'live') as GameStatus;
    if (!['pending', 'live', 'finished'].includes(status)) return void res.status(400).json({ error: 'bad_status', allowed: ['pending', 'live', 'finished'] });
    const participant = req.query.participant === undefined ? null : participantRef(req.query.participant);
    if (req.query.participant !== undefined && !participant) return void res.status(400).json({ error: 'bad_participant' });
    const t = now();
    const rows = (await store.listGames(status, participant, 50))
      .filter((g) => status !== 'pending' || t - Date.parse(g.created_at) <= CHALLENGE_TTL_MS);
    res.json({ games: rows.map((g) => ({ id: g.id, status: g.status, white: g.white, black: g.black, challenger: g.challenger, stake_usd: Number(g.stake_usd), time_control: g.time_control, owner_distinct: g.owner_distinct, fen: g.fen, plies: g.moves.length, result: g.result, created_at: g.created_at })) });
  });

  api.get('/games/:id', async (req, res) => {
    const g0 = await loadGame(req, res);
    if (!g0) return;
    const g = await settleClock(g0);
    const preds = await store.listPredictions(g.id);
    const scored = g.status === 'finished'
      ? preds.map((p) => (Number(p.probability) - (scoreWhite(g.result) === (p.side === 'white' ? 1 : 0) ? 1 : 0)) ** 2)
      : [];
    res.json({ ...publicGame(g, now()), predictions: { count: preds.length, mean_brier: scored.length ? +(scored.reduce((a, x) => a + x, 0) / scored.length).toFixed(4) : null } });
  });

  api.post('/games/:id/move', async (req, res) => {
    const me = await principal(req, res);
    if (!me) return;
    const body = onlyFields(req, res, ['uci']);
    if (!body) return;
    const g0 = await loadGame(req, res);
    if (!g0) return;
    const mine = colorOf(g0, me.ref);
    if (!mine) return void res.status(403).json({ error: 'not_a_participant' });
    const g = await settleClock(g0);
    if (g.status !== 'live') return void res.status(409).json({ error: 'game_not_live', status: g.status, result: g.result, termination: g.termination });
    const chess = replay(g.moves), turn = chess.turn();
    if (turn !== mine) return void res.status(403).json({ error: 'not_your_turn', turn: turn === 'w' ? 'white' : 'black' });
    const fenBefore = chess.fen();
    const mv = tryMove(chess, body.uci);
    if (!mv.ok) {
      // Counted for the legal-move-rate signal; a lost race here only drops one count.
      await store.updateGame(g.id, g.version, { illegal_attempts: { ...g.illegal_attempts, [mine]: (g.illegal_attempts[mine] ?? 0) + 1 } });
      return void res.status(400).json({ error: 'illegal_move', reason: mv.reason, fen: fenBefore, legal_uci: legalUci(chess) });
    }
    const t = now(), tc = TIME_CONTROLS[g.time_control];
    const clock_ms = { ...g.clock_ms, [turn]: clockAt(g.clock_ms, turn, sinceOf(g), t)[turn] + tc.increment_ms };
    const move: StoredMove = { uci: mv.uci, san: mv.san, at: iso(t), clock_ms };
    const end = outcomeOf(chess);
    const updated = await store.updateGame(g.id, g.version, {
      moves: [...g.moves, move], fen: chess.fen(), clock_ms, last_move_at: iso(t),
      ...(end ? { status: 'finished' as const, ...end, finished_at: iso(t) } : {}),
    });
    if (!updated) return void res.status(409).json({ error: 'conflict', message: 'The game changed while you moved; read it again.' });
    if (end) await afterFinish(updated);
    res.json({ game: publicGame(updated, now()) });
  });

  api.post('/games/:id/predict', async (req, res) => {
    const me = await principal(req, res);
    if (!me) return;
    const body = onlyFields(req, res, ['side', 'probability']);
    if (!body) return;
    const p = Number(body.probability);
    if (body.side !== 'white' && body.side !== 'black') return void res.status(400).json({ error: 'bad_side', allowed: ['white', 'black'] });
    if (typeof body.probability !== 'number' || !(p >= 0 && p <= 1)) return void res.status(400).json({ error: 'bad_probability', message: 'probability is a number from 0 to 1: your chance that this side wins.' });
    const g0 = await loadGame(req, res);
    if (!g0) return;
    const g = await settleClock(g0);
    if (g.status === 'finished') return void res.status(409).json({ error: 'game_over' });
    const r = await store.insertPrediction({ game_id: g.id, predictor: me.ref, is_participant: colorOf(g, me.ref) !== null, side: body.side, probability: p, at_ply: g.moves.length });
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
