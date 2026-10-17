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

/** The grant lines a wallet signs, in plain words. */
export function grantLines(thumbprint: string): string[] {
  return [
    `game key: ${thumbprint}`,
    'game key may: move, offer a draw, accept a draw and resign for you, in this game only',
    'resigning, or agreeing a draw, can lose this game\'s stake',
    'game key may never: move funds, change a stake, create or accept a challenge, or act in another game',
    'game key ends: when this game ends, when you sign "end game key", or when you grant a new key for this game',
  ];
}

// ── independent verification ───────────────────────────────────────────────

export interface ChainMove { uci: string; hash?: string; by?: string; key?: string; sig?: string; time?: string }
export interface ChainEvent { act: KeyAct; by: string; ply: number; prev: string; key?: string; sig?: string; time?: string }
export interface PublishedGrant { participant: string; thumbprint: string; public_jwk: PublicJwk; grant_statement: string; grant_signature: string }

/**
 * Check a published game record WITHOUT trusting the server. FAIL CLOSED: anything the record
 * cannot prove is a problem, never a skip.
 *   - every move carries `hash`, and it follows from the moves before it;
 *   - every move names the seated player (`by`): white on odd plies, black on even;
 *   - a HUMAN seat's every move and event carries a game-key signature that verifies, under a key
 *     whose thumbprint that player's wallet signed for this game and this colour. A human seat can
 *     never have an unsigned ply, so stripping signatures and recomputing hashes is caught;
 *   - an unsigned move is valid only for an AGENT seat (an `agent:` ref) that holds no human grant;
 *   - every grant is for a seated human, names this game, this colour and this key, and recovers
 *     to that player's wallet. Grants are cached per participant AND thumbprint, so two players
 *     published with the same thumbprint each go through the wallet check.
 * Returns every problem found, not just the first.
 */
export async function verifyGameRecord(
  game: { id: string; white: string; black: string; moves: readonly ChainMove[]; events?: readonly ChainEvent[] },
  grants: readonly PublishedGrant[],
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
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
      const signed = await verifyWalletMessage(g.participant.replace(/^human:/, ''), g.grant_statement, g.grant_signature);
      grantOk.set(id, signed.ok && jwkThumbprint(g.public_jwk) === g.thumbprint
        && g.grant_statement.includes(`game: ${game.id}\n`) && g.grant_statement.includes(`game key: ${g.thumbprint}\n`)
        && g.grant_statement.includes(`you play: ${seatColour(g.participant)}\n`));
    }
    return grantOk.get(id) ? g : null;
  };
  /** A human seat must have signed; an agent seat holding no human grant may be unsigned. */
  const checkSigned = async (label: string, by: string, x: { key?: string; sig?: string; time?: string }, payload: (time: string) => string) => {
    if (!isHuman(by)) {
      if (grants.some((g) => g.participant === by)) problems.push(`${label}: an agent seat holds a human grant`);
      if (x.sig) problems.push(`${label}: an agent seat carries a game-key signature`);
      return;
    }
    if (!x.sig || !x.key) return void problems.push(`${label}: a human seat with no game-key signature`);
    const g = await grantFor(by, x.key);
    if (!g) return void problems.push(`${label}: no valid wallet grant for key ${x.key} of ${by}`);
    if (!verifyGameKey(g.public_jwk, payload(x.time ?? ''), x.sig)) problems.push(`${label}: game-key signature does not verify`);
  };
  let prev = chainGenesis(game.id);
  const heads = [prev]; // heads[n] = the chain after n moves
  for (const [i, m] of game.moves.entries()) {
    const ply = i + 1, hash = chainNext(prev, ply, m.uci), seat = ply % 2 === 1 ? game.white : game.black;
    if (m.hash === undefined) problems.push(`ply ${ply}: no hash`);
    else if (m.hash !== hash) problems.push(`ply ${ply}: hash does not follow from the moves before it`);
    if (m.by !== seat) problems.push(`ply ${ply}: made by ${m.by ?? 'nobody named'}, but ${seat} is to move`);
    await checkSigned(`ply ${ply}`, seat, m, (time) => gameKeyPayload({ game: game.id, player: seat, act: 'move', ply, prev, uci: m.uci }, time));
    prev = hash;
    heads.push(hash);
  }
  for (const e of game.events ?? []) {
    const label = `${e.act} at ply ${e.ply}`;
    if (!seatColour(e.by)) { problems.push(`${label}: ${e.by} is not a player in this game`); continue; }
    if (heads[e.ply - 1] !== e.prev) problems.push(`${label}: prev is not the chain head at that ply`);
    await checkSigned(label, e.by, e, (time) => gameKeyPayload({ game: game.id, player: e.by, act: e.act, ply: e.ply, prev: e.prev }, time));
  }
  return { ok: problems.length === 0, problems };
}
