/**
 * GAME KEYS: one wallet signature per game instead of one per move.
 *
 * The pattern is Hyperliquid's approveAgent and ERC-7715 permissions, scoped to ONE game. At game
 * start the browser makes a P-256 key with WebCrypto (`extractable: false`, kept in IndexedDB), and
 * the wallet signs a grant naming: the game, your colour, the stake, the key's RFC 7638 thumbprint,
 * what it may do (move, offer or accept a draw, resign), that resigning or agreeing a draw can lose
 * the stake, and when it ends: when the game ends, when the wallet signs "end game key", or when a
 * new grant for the same game and side replaces it. There is NO timed expiry: a key that lapsed in
 * time trouble would forfeit the game (Grok red-team, 2026-10-17). After the grant, each move is
 * signed by the game key, with no wallet popup.
 *
 * WHY. A popup per move is impractical, and repeated prompts stop being read (habituation: Vance,
 * Anderson, Kirwan et al., fMRI and field studies). One prompt that says what it grants is read.
 *
 * WHAT A GAME KEY CAN NEVER DO, by construction: it is looked up only for the game in the request
 * path and only on the move, resign and draw routes. Every other route (challenge, accept, grant,
 * revoke, scoresheet, predict) refuses a game-key signature, so a key cannot move funds, change a
 * stake, create or accept a challenge, or act in another game. It CAN lose this game (resign, or
 * agree a draw), and the grant says so in plain words.
 *
 * THE MOVE CHAIN IS THE SCORESHEET. Every move carries `hash = sha256(prev + "\n" + ply + "\n" + uci)`,
 * starting from `chainGenesis(game)`. A game-key signature covers the game, the ply, the move, the
 * previous hash and the time. The game record publishes the wallet grants (statement + signature)
 * and every key signature, so `verifyGameRecord` (below) can check the whole game without trusting
 * the server, and the page keeps its own copy of the chain and flags a server copy that differs.
 *
 * node:crypto only (verify with dsaEncoding 'ieee-p1363', which is what WebCrypto ECDSA emits).
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { verifyWalletMessage } from '../services/wallet-signature';
import { arenaStatement, type ArenaAction } from './statement';
import { outcomeOf, replay, type Result, type TimeControl } from './referee';
import type { Speed } from './store';

export type KeyAct = 'move' | 'resign' | 'offer_draw' | 'accept_draw';
export const KEY_ACTS: readonly KeyAct[] = ['move', 'offer_draw', 'accept_draw', 'resign'];
const ACT_WORDS: Record<KeyAct, string> = { move: 'move', resign: 'resign', offer_draw: 'offer draw', accept_draw: 'accept draw' };

export interface PublicJwk { kty: 'EC'; crv: 'P-256'; x: string; y: string }
const B64U_32 = /^[A-Za-z0-9_-]{43}$/;

function keyObject(j: PublicJwk): KeyObject {
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y }, format: 'jwk' });
}

/** A P-256 public JWK, or null. createPublicKey rejects a point that is not on the curve. */
export function parseJwk(raw: unknown): PublicJwk | null {
  const j = raw as Partial<PublicJwk> | null;
  if (!j || typeof j !== 'object' || j.kty !== 'EC' || j.crv !== 'P-256' || !B64U_32.test(String(j.x)) || !B64U_32.test(String(j.y))) return null;
  const jwk: PublicJwk = { kty: 'EC', crv: 'P-256', x: String(j.x), y: String(j.y) };
  try { keyObject(jwk); return jwk; } catch { return null; }
}

/** RFC 7638 thumbprint: sha256 over the required members in lexicographic order, base64url. */
export function jwkThumbprint(j: PublicJwk): string {
  return createHash('sha256').update(`{"crv":"P-256","kty":"EC","x":"${j.x}","y":"${j.y}"}`).digest('base64url');
}

const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** The chain before move 1. */
export const chainGenesis = (game: string): string => sha256hex(`HyperDAG AgentChess game ${game}`);
/** The hash of move `ply` given the hash before it. */
export const chainNext = (prev: string, ply: number, uci: string): string => sha256hex(`${prev}\n${ply}\n${uci}`);
/** The head after `moves`, i.e. the `prev` the next action must sign. */
export function chainHead(game: string, moves: readonly { uci: string }[]): string {
  return moves.reduce((h, m, i) => chainNext(h, i + 1, m.uci), chainGenesis(game));
}

/**
 * What the game key signs. The page builds the same text (src/arena/page.ts, pinned equal by
 * tests/arena-game-keys.test.ts). `ply` is the next ply and `prev` the chain head when the action is
 * taken, so a move signature is good for exactly one position in exactly one game. `player` binds
 * it to one seat: a player who re-grants the OPPONENT's public key as their own still cannot have
 * the opponent's signatures counted as theirs.
 */
export function gameKeyPayload(a: { game: string; player: string; act: KeyAct; ply: number; prev: string; uci?: string }, time: string): string {
  const lines = ['HyperDAG AgentChess game key', `game: ${a.game}`, `player: ${a.player}`, `action: ${ACT_WORDS[a.act]}`, `ply: ${a.ply}`, `prev: ${a.prev}`];
  if (a.act === 'move') lines.push(`move: ${a.uci ?? ''}`);
  lines.push(`time: ${time}`);
  return lines.join('\n');
}

/** true only when `signature` (base64url, IEEE P1363 r||s) verifies `payload` under `jwk`. */
export function verifyGameKey(jwk: PublicJwk, payload: string, signature: string): boolean {
  try {
    const sig = Buffer.from(signature, 'base64url');
    if (sig.length !== 64) return false;
    return verify('sha256', Buffer.from(payload, 'utf8'), { key: keyObject(jwk), dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

export { grantLines } from './statement';

// ── independent verification ───────────────────────────────────────────────

export interface ChainMove { uci: string; hash?: string; by?: string; key?: string; sig?: string; time?: string }
export interface ChainEvent { act: KeyAct; by: string; ply: number; prev: string; key?: string; sig?: string; time?: string }
export interface PublishedGrant { participant: string; thumbprint: string; public_jwk: PublicJwk; grant_statement: string; grant_signature: string }
/** A published game record, as GET /api/v1/arena/games/:id serves it. */
export interface GameRecord {
  id: string; white: string; black: string; challenger: string;
  stake: { usd: number }; time_control: TimeControl; default_speed: Speed;
  status?: string; result?: string | null; termination?: string | null;
  moves?: readonly ChainMove[]; events?: readonly ChainEvent[];
}
/**
 * How the result is known.
 *   `verified`: it follows from the record alone AND the act that decided it is signed by a human's
 *     game key: a human's signed move that ends the game on the board (its signature commits to every
 *     move before it), a human's signed resign, a draw both sides signed.
 *   `referee_attested`: it rests on something only the server vouches for: a loss on time (the
 *     signatures do not cover the clock), or an AGENT seat's unsigned act (its resign, its draw offer
 *     or acceptance, or the agent's own last move ending the game on the board). Never `verified`.
 *   null: no result (the game is not over).
 */
export type ResultBasis = 'verified' | 'referee_attested' | null;

const EVENT_ACTS: readonly KeyAct[] = KEY_ACTS.filter((a) => a !== 'move'); // a move is never an event
const TIMEOUT = /^loss on time \((White|Black)'s clock ran out\)$/;

/**
 * The result the record itself supports, from the moves and the VALID events only (never the
 * stored result, except a loss on time, which the record cannot prove and is labelled so).
 */
export function deriveResult(game: GameRecord, validEvents: readonly ChainEvent[]): { result: Result; termination: string; basis: Exclude<ResultBasis, null> } | null {
  const moves = game.moves ?? [], board = outcomeOf(replay(moves)), last = moves.length + 1;
  /** Verified only when every act the result rests on is a human's (and so carries a verified signature). */
  const basisOf = (...by: string[]): Exclude<ResultBasis, null> => (by.every((b) => b.startsWith('human:')) ? 'verified' : 'referee_attested');
  if (board) return { ...board, basis: basisOf(moves.length % 2 === 1 ? game.white : game.black) };
  const at = validEvents.filter((e) => e.ply === last);
  const resign = at.find((e) => e.act === 'resign');
  if (resign) return { ...(resign.by === game.white ? { result: '0-1' as const, termination: 'White resigned' } : { result: '1-0' as const, termination: 'Black resigned' }), basis: basisOf(resign.by) };
  // A draw is agreed when one side offers and the OTHER side then offers or accepts, with no move between.
  const offer = at.findIndex((e) => e.act === 'offer_draw');
  const reply = offer >= 0 ? at.slice(offer + 1).find((e) => e.by !== at[offer]!.by && (e.act === 'accept_draw' || e.act === 'offer_draw')) : undefined;
  if (reply) return { result: '1/2-1/2', termination: 'draw agreed', basis: basisOf(at[offer]!.by, reply.by) };
  const t = TIMEOUT.exec(game.termination ?? '');
  if (t) {
    const loser = t[1] === 'White' ? 'w' : 'b', toMove = moves.length % 2 === 0 ? 'w' : 'b';
    const result: Result = loser === 'w' ? '0-1' : '1-0';
    if (loser === toMove && game.result === result) return { result, termination: game.termination as string, basis: 'referee_attested' };
  }
  return null;
}

/**
 * The statements a player could have signed to grant `grant.thumbprint` in this game: the grant itself,
 * and the challenge (challenger) or the accept (the other player) that can carry it. Rebuilt with
 * `arenaStatement`, using the time the statement itself names. The page has a byte-identical copy,
 * pinned by tests/arena-game-keys.test.ts. A published statement must equal one of these whole.
 */
export function expectedGrantStatements(game: GameRecord, grant: Pick<PublishedGrant, 'participant' | 'thumbprint' | 'grant_statement'>): string[] {
  const colour = grant.participant === game.white ? 'white' : grant.participant === game.black ? 'black' : null;
  const time = /\ntime: ([^\n]*)$/.exec(grant.grant_statement)?.[1];
  if (!colour || time === undefined) return [];
  const wallet = grant.participant.replace(/^human:/, ''), stake_usd = Number(game.stake?.usd);
  const opponent = grant.participant === game.white ? game.black : game.white;
  const variants: ArenaAction[] = [{ action: 'grant', game: game.id, colour, stake_usd, grant: grant.thumbprint }];
  if (grant.participant === game.challenger) variants.push({ action: 'challenge', game: game.id, opponent, colour, stake_usd, time_control: game.time_control, speed: game.default_speed, grant: grant.thumbprint });
  else variants.push({ action: 'accept', game: game.id, colour, stake_usd, grant: grant.thumbprint });
  return variants.map((a) => arenaStatement(a, wallet, time));
}

/**
 * Check a published game record WITHOUT trusting the server. FAIL CLOSED: anything the record
 * cannot prove is a problem, never a skip.
 *   - the record carries its moves and events lists;
 *   - every move carries `hash`, and it follows from the moves before it;
 *   - every move names the seated player (`by`): white on odd plies, black on even;
 *   - every event has an act from resign / offer_draw / accept_draw, a ply within 1..moves+1, a
 *     string prev equal to the chain head at that ply, and a seated player;
 *   - a HUMAN seat's every move and event carries a game-key signature that verifies, under a key
 *     whose grant this player's wallet signed for this game. A human seat can never have an unsigned ply;
 *   - an unsigned move or event is valid only for an AGENT seat that holds no human grant;
 *   - every grant is for a seated human, and its statement is EXACTLY one this player could have signed
 *     for this game (rebuilt from the record, not searched), and recovers to that player's wallet.
 *     Grants are cached per participant AND thumbprint;
 *   - the RESULT follows from the moves (chess.js replay) and the valid events; a loss on time, or a
 *     result resting on an agent seat's unsigned act, is reported as `referee_attested`, never `verified`.
 * Returns every problem found, not just the first.
 */
export async function verifyGameRecord(game: GameRecord, grants: readonly PublishedGrant[]): Promise<{ ok: boolean; problems: string[]; result_basis: ResultBasis; result: { result: Result; termination: string } | null }> {
  const problems: string[] = [];
  if (!Array.isArray(game.moves)) problems.push('the record has no move list');
  if (!Array.isArray(game.events)) problems.push('the record has no events list');
  const moves = Array.isArray(game.moves) ? game.moves : [], events = Array.isArray(game.events) ? game.events : [];
  const seatColour = (ref: string) => (ref === game.white ? 'white' : ref === game.black ? 'black' : null);
  const isHuman = (ref: string) => ref.startsWith('human:');
  for (const g of grants) {
    if (!seatColour(g.participant) || !isHuman(g.participant)) problems.push(`grant ${g.thumbprint}: ${g.participant} is not a human player in this game`);
  }
  const grantOk = new Map<string, boolean>();
  const grantFor = async (by: string, key: string | undefined): Promise<PublishedGrant | null> => {
    const g = grants.find((x) => x.participant === by && x.thumbprint === key);
    if (!g) return null;
    const id = `${g.participant}|${g.thumbprint}`;
    if (!grantOk.has(id)) {
      const exact = expectedGrantStatements(game, g).includes(g.grant_statement);
      const signed = exact && (await verifyWalletMessage(g.participant.replace(/^human:/, ''), g.grant_statement, g.grant_signature)).ok;
      grantOk.set(id, signed && jwkThumbprint(g.public_jwk) === g.thumbprint);
    }
    return grantOk.get(id) ? g : null;
  };
  /** A human seat must have signed; an agent seat holding no human grant may be unsigned. Returns true when valid. */
  const checkSigned = async (label: string, by: string, x: { key?: string; sig?: string; time?: string }, payload: (time: string) => string): Promise<boolean> => {
    const before = problems.length;
    if (!isHuman(by)) {
      if (grants.some((g) => g.participant === by)) problems.push(`${label}: an agent seat holds a human grant`);
      if (x.sig) problems.push(`${label}: an agent seat carries a game-key signature`);
      return problems.length === before;
    }
    if (!x.sig || !x.key) return void problems.push(`${label}: a human seat with no game-key signature`), false;
    const g = await grantFor(by, x.key);
    if (!g) return void problems.push(`${label}: no valid wallet grant for key ${x.key} of ${by}`), false;
    if (!verifyGameKey(g.public_jwk, payload(x.time ?? ''), x.sig)) return void problems.push(`${label}: game-key signature does not verify`), false;
    return true;
  };
  let prev = chainGenesis(game.id);
  const heads = [prev]; // heads[n] = the chain after n moves
  for (const [i, m] of moves.entries()) {
    const ply = i + 1, hash = chainNext(prev, ply, m.uci), seat = ply % 2 === 1 ? game.white : game.black;
    if (m.hash === undefined) problems.push(`ply ${ply}: no hash`);
    else if (m.hash !== hash) problems.push(`ply ${ply}: hash does not follow from the moves before it`);
    if (m.by !== seat) problems.push(`ply ${ply}: made by ${m.by ?? 'nobody named'}, but ${seat} is to move`);
    await checkSigned(`ply ${ply}`, seat, m, (time) => gameKeyPayload({ game: game.id, player: seat, act: 'move', ply, prev, uci: m.uci }, time));
    prev = hash;
    heads.push(hash);
  }
  const validEvents: ChainEvent[] = [];
  for (const [i, e] of events.entries()) {
    const label = `event ${i + 1} (${String(e.act)} at ply ${String(e.ply)})`, before = problems.length;
    if (!EVENT_ACTS.includes(e.act)) problems.push(`${label}: not a resign, offer_draw or accept_draw`);
    if (!Number.isInteger(e.ply) || e.ply < 1 || e.ply > moves.length + 1) problems.push(`${label}: ply is off the move list (1 to ${moves.length + 1})`);
    if (typeof e.prev !== 'string') problems.push(`${label}: no prev`);
    else if (heads[e.ply - 1] !== e.prev) problems.push(`${label}: prev is not the chain head at that ply`);
    if (!seatColour(e.by)) problems.push(`${label}: ${String(e.by)} is not a player in this game`);
    if (problems.length > before) continue;
    if (await checkSigned(label, e.by, e, (time) => gameKeyPayload({ game: game.id, player: e.by, act: e.act, ply: e.ply, prev: e.prev }, time))) validEvents.push(e);
  }
  // The result must follow from what verified, not from what the server says it is.
  let result_basis: ResultBasis = null;
  let derived: ReturnType<typeof deriveResult> = null;
  try { derived = deriveResult(game, validEvents); } catch { problems.push('the moves do not replay under the rules of chess'); }
  const claimed = game.result ?? null;
  if (game.status === 'finished' && !claimed) problems.push('the game is finished but carries no result');
  if (claimed) {
    if (!derived) problems.push(`the result ${claimed} (${game.termination ?? ''}) does not follow from the moves and the verified events`);
    else if (derived.result !== claimed || derived.termination !== game.termination) problems.push(`the result ${claimed} (${game.termination ?? ''}) is not what the record shows: ${derived.result} (${derived.termination})`);
    else result_basis = derived.basis;
  } else if (derived) problems.push(`the moves and events end the game (${derived.result}, ${derived.termination}) but no result is recorded`);
  return { ok: problems.length === 0, problems, result_basis, result: result_basis && derived ? { result: derived.result, termination: derived.termination } : null };
}
