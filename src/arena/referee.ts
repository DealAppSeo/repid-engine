/**
 * The AgentChess referee. chess.js decides every move and every result; no model and no caller
 * does. The server replays the stored move list on each request, so threefold repetition and the
 * fifty-move rule see the whole game, and a stored game can always be re-checked from its moves.
 */
import { Chess } from 'chess.js';

/** Per-side clock. A side whose clock reaches zero loses on time. */
export const TIME_CONTROLS = {
  fast: { base_ms: 5 * 60_000, increment_ms: 5_000 },
  normal: { base_ms: 15 * 60_000, increment_ms: 10_000 },
  slow: { base_ms: 60 * 60_000, increment_ms: 30_000 },
} as const;
export type TimeControl = keyof typeof TIME_CONTROLS;
export const isTimeControl = (x: unknown): x is TimeControl => typeof x === 'string' && Object.hasOwn(TIME_CONTROLS, x);

export const START_FEN = new Chess().fen();
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export type Color = 'w' | 'b';
export type Result = '1-0' | '0-1' | '1/2-1/2';
export interface Clock { w: number; b: number }
export interface StoredMove { uci: string; san: string; at: string; clock_ms: Clock }

const parts = (uci: string) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) });

/** Rebuild the position from the stored moves. Throws only if the stored history is corrupt. */
export function replay(moves: readonly { uci: string }[]): Chess {
  const c = new Chess();
  for (const m of moves) c.move(parts(m.uci));
  return c;
}

export const legalUci = (c: Chess): string[] => c.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ''));

/** Try one move. Never throws: an illegal move is an answer with a reason, not an exception. */
export function tryMove(c: Chess, raw: unknown): { ok: true; uci: string; san: string } | { ok: false; reason: string } {
  const uci = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!UCI_RE.test(uci)) return { ok: false, reason: 'not a UCI move: send from-square, to-square and an optional promotion piece, e.g. e2e4 or e7e8q' };
  try {
    const mv = c.move(parts(uci));
    return { ok: true, uci, san: mv.san };
  } catch {
    const toMove = c.turn() === 'w' ? 'White' : 'Black';
    return { ok: false, reason: `${uci} is not legal in this position (${toMove} to move${c.inCheck() ? ', in check' : ''})` };
  }
}

/** The result, if the position ends the game. Same order and words as AC's game.mjs. */
export function outcomeOf(c: Chess): { result: Result; termination: string } | null {
  if (c.isCheckmate()) return { result: c.turn() === 'w' ? '0-1' : '1-0', termination: 'checkmate' };
  if (c.isStalemate()) return { result: '1/2-1/2', termination: 'stalemate' };
  if (c.isThreefoldRepetition()) return { result: '1/2-1/2', termination: 'threefold repetition' };
  if (c.isInsufficientMaterial()) return { result: '1/2-1/2', termination: 'insufficient material' };
  if (c.isDrawByFiftyMoves()) return { result: '1/2-1/2', termination: 'fifty-move rule' };
  return null;
}

/** Remaining time for each side at `now`; only the side to move is running. */
export function clockAt(stored: Clock, turn: Color, sinceMs: number, nowMs: number): Clock {
  const live = { ...stored };
  live[turn] = Math.max(0, stored[turn] - Math.max(0, nowMs - sinceMs));
  return live;
}

/** Loss on time: the side to move with no time left loses. (ponytail: no "opponent cannot mate" draw rule.) */
export const timeoutResult = (loser: Color): { result: Result; termination: string } => ({
  result: loser === 'w' ? '0-1' : '1-0',
  termination: `loss on time (${loser === 'w' ? 'White' : 'Black'}'s clock ran out)`,
});
