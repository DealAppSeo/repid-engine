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
 * taken, so a move signature is good for exactly one position in exactly one game.
 */
export function gameKeyPayload(a: { game: string; act: KeyAct; ply: number; prev: string; uci?: string }, time: string): string {
  const lines = ['HyperDAG AgentChess game key', `game: ${a.game}`, `action: ${ACT_WORDS[a.act]}`, `ply: ${a.ply}`, `prev: ${a.prev}`];
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
 * Check a published game record WITHOUT trusting the server: the chain links, every game-key
 * signature verifies under a key whose thumbprint the player's wallet signed for this game, and
 * every such grant recovers to that player's wallet. Returns every problem found, not just the first.
 */
export async function verifyGameRecord(game: { id: string; moves: readonly ChainMove[]; events?: readonly ChainEvent[] }, grants: readonly PublishedGrant[]): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const grantOk = new Map<string, boolean>();
  const grantFor = async (by: string | undefined, key: string | undefined): Promise<PublishedGrant | null> => {
    const g = grants.find((x) => x.participant === by && x.thumbprint === key);
    if (!g) return null;
    if (!grantOk.has(key as string)) {
      const wallet = g.participant.replace(/^human:/, '');
      const signed = await verifyWalletMessage(wallet, g.grant_statement, g.grant_signature);
      grantOk.set(key as string, signed.ok && jwkThumbprint(g.public_jwk) === g.thumbprint
        && g.grant_statement.includes(`game: ${game.id}\n`) && g.grant_statement.includes(`game key: ${g.thumbprint}\n`));
    }
    return grantOk.get(key as string) ? g : null;
  };
  let prev = chainGenesis(game.id);
  const heads = [prev]; // heads[n] = the chain after n moves
  for (const [i, m] of game.moves.entries()) {
    const ply = i + 1, hash = chainNext(prev, ply, m.uci);
    if (m.hash !== undefined && m.hash !== hash) problems.push(`ply ${ply}: hash does not follow from the moves before it`);
    if (m.sig) {
      const g = await grantFor(m.by, m.key);
      if (!g) problems.push(`ply ${ply}: no valid wallet grant for key ${m.key ?? '?'} of ${m.by ?? '?'}`);
      else if (!verifyGameKey(g.public_jwk, gameKeyPayload({ game: game.id, act: 'move', ply, prev, uci: m.uci }, m.time ?? ''), m.sig)) problems.push(`ply ${ply}: game-key signature does not verify`);
    }
    prev = hash;
    heads.push(hash);
  }
  for (const e of game.events ?? []) {
    if (!e.sig) continue;
    if (heads[e.ply - 1] !== e.prev) problems.push(`${e.act} at ply ${e.ply}: prev is not the chain head at that ply`);
    const g = await grantFor(e.by, e.key);
    if (!g) problems.push(`${e.act} at ply ${e.ply}: no valid wallet grant for key ${e.key ?? '?'}`);
    else if (!verifyGameKey(g.public_jwk, gameKeyPayload({ game: game.id, act: e.act, ply: e.ply, prev: e.prev }, e.time ?? ''), e.sig)) problems.push(`${e.act} at ply ${e.ply}: game-key signature does not verify`);
  }
  return { ok: problems.length === 0, problems };
}
