/**
 * GAME KEYS (src/arena/game-key.ts, src/routes/arena.ts): one wallet signature per game, then a
 * browser-held P-256 key signs the moves. The controls under test:
 *   - a move is refused when signed by the wrong key, for the wrong ply, over the wrong previous
 *     hash, for another body, in another game, out of time, or after the game ended;
 *   - a new grant for the same game and side revokes the old key, and the wallet can end it;
 *   - the key can never create or accept a challenge, grant or end a key, sign a scoresheet or
 *     predict; agents cannot be given one; the wallet still does every stake action;
 *   - the grant says in plain words that resigning or a draw can lose the stake, and has no timer;
 *   - the moves form a hash chain that anyone can verify from the published record alone;
 *   - the page's own copies (payload, grant text, chain, thumbprint) equal the server's, and its
 *     chain check flags a server copy that differs.
 * The keys are made with WebCrypto (globalThis.crypto.subtle), exactly as the page makes them.
 */
import request from 'supertest';
import { Wallet } from 'ethers';

jest.mock('../src/db', () => {
  const chain: any = {
    select: () => chain, eq: () => chain, ilike: () => chain, limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: null, error: null }), insert: async () => ({ data: null, error: null }),
  };
  return { db: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});
jest.mock('../src/auth/api-keys', () => {
  const actual = jest.requireActual('../src/auth/api-keys');
  return { ...actual, validateAgentApiKey: jest.fn(async (key: string) => (key.startsWith('key-for-') ? { agent_id: key.slice(8), scopes: [] } : null)) };
});

import { arenaStatement, type ArenaAction } from '../src/routes/arena';
import { ARENA_JS } from '../src/arena/page';
import { chainGenesis, chainHead, chainNext, gameKeyPayload, grantLines, jwkThumbprint, verifyGameRecord, type KeyAct } from '../src/arena/game-key';
import { A1, A3, human, human2, memStore, appWith, agent, signedArena, challengeBy } from './helpers/arena-fixtures';
import type express from 'express';
import { Chess } from 'chess.js';

const subtle = globalThis.crypto.subtle;
type GameKey = { pair: CryptoKeyPair; jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }; thumb: string; who: string };
/** A game key held by `w`'s browser. The payload it signs names its player (`who`). */
async function newKey(w: Wallet = human): Promise<GameKey> {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const j = await subtle.exportKey('jwk', pair.publicKey);
  const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: j.x as string, y: j.y as string };
  return { pair, jwk, thumb: jwkThumbprint(jwk), who: `human:${w.address.toLowerCase()}` };
}
async function keyHeaders(k: GameKey, app: express.Express, id: string, act: KeyAct, uci?: string, o: { ply?: number; prev?: string; game?: string; time?: string; player?: string } = {}) {
  const g = (await request(app).get(`/api/v1/arena/games/${id}`)).body;
  const time = o.time ?? new Date().toISOString();
  const payload = gameKeyPayload({ game: o.game ?? id, player: o.player ?? k.who, act, ply: o.ply ?? g.moves.length + 1, prev: o.prev ?? chainHead(id, g.moves), uci }, time);
  const sig = Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.pair.privateKey, new TextEncoder().encode(payload))).toString('base64url');
  return { 'x-arena-key-signature': sig, 'x-arena-key-time': time };
}
const keyMove = async (app: express.Express, id: string, k: GameKey, uci: string, o = {}) =>
  request(app).post(`/api/v1/arena/games/${id}/move`).set(await keyHeaders(k, app, id, 'move', uci, o)).send({ uci });
const agentMove = (app: express.Express, id: string, by: string, uci: string) =>
  request(app).post(`/api/v1/arena/games/${id}/move`).set(agent(by)).send({ uci });

/** human (white) challenges an agent with a game key, in ONE wallet signature; the agent accepts. */
async function keyGame(app: express.Express, opts: { stake?: number; opponent?: string; w?: Wallet } = {}) {
  const w = opts.w ?? human, opponent = opts.opponent ?? A1, id = globalThis.crypto.randomUUID(), k = await newKey(w), stake = opts.stake ?? 1;
  const act = challengeBy(w, opponent, { game: id, stake_usd: stake, grant: k.thumb });
  const c = await request(app).post('/api/v1/arena/challenges').set(await signedArena(w, act))
    .send({ game_id: id, white: w.address, black: opponent, stake_usd: stake, game_key: k.jwk });
  expect(c.status).toBe(201);
  expect(c.body.challenge.id).toBe(id);
  expect(c.body.game_key.thumbprint).toBe(k.thumb);
  expect((await request(app).post(`/api/v1/arena/challenges/${id}/accept`).set(agent(opponent)).send()).status).toBe(200);
  return { id, k };
}

/** human (white) challenges human2 (black); both grant a game key in their one wallet signature. */
async function humanVsHuman(app: express.Express) {
  const id = globalThis.crypto.randomUUID(), k = await newKey(human), k2 = await newKey(human2);
  const c = await request(app).post('/api/v1/arena/challenges').set(await signedArena(human, { action: 'challenge', game: id, opponent: `human:${human2.address.toLowerCase()}`, colour: 'white', stake_usd: 1, time_control: 'normal', speed: '1', grant: k.thumb }))
    .send({ game_id: id, white: human.address, black: human2.address, stake_usd: 1, game_key: k.jwk });
  expect(c.status).toBe(201);
  const a = await request(app).post(`/api/v1/arena/challenges/${id}/accept`).set(await signedArena(human2, { action: 'accept', game: id, colour: 'black', stake_usd: 1, grant: k2.thumb })).send({ game_key: k2.jwk });
  expect(a.status).toBe(200);
  return { id, k, k2 };
}

beforeEach(() => { process.env.ARENA_ENABLED = 'true'; });
afterAll(() => { delete process.env.ARENA_ENABLED; });

describe('one wallet signature per game, then the game key moves', () => {
  it('moves with no wallet popup, and each stored move carries its key, signature and chain hash', async () => {
    const m = memStore(), app = appWith(m.store), { id, k } = await keyGame(app);
    const r1 = await keyMove(app, id, k, 'e2e4');
    expect(r1.status).toBe(200);
    expect((await agentMove(app, id, A1, 'e7e5')).status).toBe(200);
    expect((await keyMove(app, id, k, 'g1f3')).status).toBe(200);
    const moves = m.games.get(id)!.moves;
    expect(moves[0]).toMatchObject({ uci: 'e2e4', by: `human:${human.address.toLowerCase()}`, key: k.thumb, hash: chainNext(chainGenesis(id), 1, 'e2e4') });
    expect(moves[0]!.sig).toEqual(expect.any(String));
    expect(moves[1]).toMatchObject({ uci: 'e7e5', by: `agent:${A1}` });
    expect(moves[1]!.sig).toBeUndefined();
    expect(m.keys).toHaveLength(1);
  });

  it('REFUSED: wrong key, wrong ply, wrong previous hash, another body, another game, stale time', async () => {
    const m = memStore(), app = appWith(m.store), { id, k } = await keyGame(app), { id: other, k: otherKey } = await keyGame(app);
    const stranger = await newKey();
    expect((await keyMove(app, id, stranger, 'e2e4')).body.error).toBe('bad_key_signature');
    expect((await keyMove(app, id, k, 'e2e4', { ply: 2 })).body.error).toBe('bad_key_signature');
    expect((await keyMove(app, id, k, 'e2e4', { prev: chainGenesis(other) })).body.error).toBe('bad_key_signature');
    // another body: signed e2e4, sent d2d4
    const signedE4 = await keyHeaders(k, app, id, 'move', 'e2e4');
    expect((await request(app).post(`/api/v1/arena/games/${id}/move`).set(signedE4).send({ uci: 'd2d4' })).body.error).toBe('bad_key_signature');
    // another game: this game's key, used on the other game (signed for it, too)
    expect((await keyMove(app, other, k, 'e2e4')).body.error).toBe('bad_key_signature');
    expect((await keyMove(app, other, k, 'e2e4', { game: id })).body.error).toBe('bad_key_signature');
    const stale = await keyHeaders(k, app, id, 'move', 'e2e4', { time: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect((await request(app).post(`/api/v1/arena/games/${id}/move`).set(stale).send({ uci: 'e2e4' })).body.error).toBe('stale_key_signature');
    expect(m.games.get(id)!.moves).toHaveLength(0);
    expect((await keyMove(app, other, otherKey, 'e2e4')).status).toBe(200); // the right key still works
  });

  it('REFUSED in another game even when a client reuses one key for two games: the signature names its game', async () => {
    const app = appWith(memStore().store), { id: a, k } = await keyGame(app), { id: b } = await keyGame(app);
    await request(app).post(`/api/v1/arena/games/${b}/game-key`).set(await signedArena(human, { action: 'grant', game: b, colour: 'white', stake_usd: 1, grant: k.thumb })).send({ game_key: k.jwk }).expect(201);
    const forA = await keyHeaders(k, app, a, 'move', 'e2e4');
    expect((await request(app).post(`/api/v1/arena/games/${b}/move`).set(forA).send({ uci: 'e2e4' })).body.error).toBe('bad_key_signature');
    expect((await keyMove(app, b, k, 'e2e4')).status).toBe(200);
  });

  it('a player cannot grant the OPPONENT\'s public key as their own, and the payload names the player anyway', async () => {
    const app = appWith(memStore().store), { id, k } = await humanVsHuman(app);
    const asMine = { ...k, who: `human:${human2.address.toLowerCase()}` };
    const r = await request(app).post(`/api/v1/arena/games/${id}/game-key`).set(await signedArena(human2, { action: 'grant', game: id, colour: 'black', stake_usd: 1, grant: k.thumb })).send({ game_key: k.jwk });
    expect(r.body.error).toBe('game_key_in_use');
    // White's own signature, claimed for black, does not verify for either seat's turn.
    expect((await keyMove(app, id, asMine, 'e2e4')).body.error).toBe('bad_key_signature');
  });

  it('re-granting the SAME key after replacing it makes it act again (the active row is found first)', async () => {
    const app = appWith(memStore().store), { id, k } = await keyGame(app), k2 = await newKey();
    const grant = async (x: GameKey) => request(app).post(`/api/v1/arena/games/${id}/game-key`).set(await signedArena(human, { action: 'grant', game: id, colour: 'white', stake_usd: 1, grant: x.thumb })).send({ game_key: x.jwk }).expect(201);
    await grant(k2);
    expect((await keyMove(app, id, k, 'e2e4')).body.error).toBe('game_key_revoked');
    await grant(k);
    expect((await keyMove(app, id, k, 'e2e4')).status).toBe(200);
    expect((await keyMove(app, id, k2, 'e7e5')).body.error).not.toBe(undefined); // k2 no longer acts (and it is not white's turn)
  });

  it('the active grant is found first, even beside a stale revoked row for the same key', async () => {
    const m = memStore(), app = appWith(m.store), { id, k } = await keyGame(app);
    m.keys.unshift({ ...structuredClone(m.keys[0]!), revoked_at: new Date().toISOString(), revoked_reason: 'replaced' });
    expect((await keyMove(app, id, k, 'e2e4')).status).toBe(200);
  });

  it('a move is credited to the player its signature names, even if a key row were shared', async () => {
    // The server refuses a shared key (game_key_in_use); this plants one anyway, ahead of the real row.
    const m = memStore(), app = appWith(m.store), { id, k } = await humanVsHuman(app);
    const white = m.keys.find((x) => x.thumbprint === k.thumb)!;
    m.keys.unshift({ ...structuredClone(white), participant: `human:${human2.address.toLowerCase()}` });
    const r = await keyMove(app, id, k, 'e2e4');
    expect(r.status).toBe(200);
    expect(r.body.game.moves[0].by).toBe(white.participant);
  });

  it('the Supabase store revokes the old key BEFORE inserting the new one (one active key per game and side)', async () => {
    const { supabaseArenaStore } = jest.requireActual('../src/arena/store');
    const calls: unknown[][] = [];
    const chain: any = new Proxy({}, { get: (_t, p) => (p === 'then' ? (r: any) => r({ data: [], error: null }) : (...args: unknown[]) => { calls.push([p, ...args]); return chain; }) });
    await supabaseArenaStore({ from: (t: string) => { calls.push(['from', t]); return chain; } }).addGameKey({ game_id: A1, participant: 'human:0x1', thumbprint: 'T', public_jwk: (await newKey()).jwk, capabilities: ['move'], grant_statement: 's', grant_signature: 'g' });
    const update = calls.findIndex((c) => c[0] === 'update'), insert = calls.findIndex((c) => c[0] === 'upsert');
    expect(update).toBeGreaterThan(-1);
    expect(calls[update]![1]).toMatchObject({ revoked_reason: 'replaced' });
    expect(calls).toContainEqual(['is', 'revoked_at', null]);
    expect(insert).toBeGreaterThan(update);
    expect(calls[insert]![2]).toEqual({ onConflict: 'game_id,participant,thumbprint' }); // re-granting the same key reactivates its row
  });

  it('REFUSED after the game ends: the key ends with its game', async () => {
    const app = appWith(memStore().store), { id, k } = await keyGame(app);
    const resign = await request(app).post(`/api/v1/arena/games/${id}/resign`).set(await keyHeaders(k, app, id, 'resign')).send();
    expect(resign.body.game).toMatchObject({ status: 'finished', result: '0-1', termination: 'White resigned' });
    expect((await keyMove(app, id, k, 'e2e4')).body.error).toBe('game_not_live');
    expect((await request(app).post(`/api/v1/arena/games/${id}/resign`).set(await keyHeaders(k, app, id, 'resign')).send()).body.error).toBe('game_not_live');
    const g = (await request(app).get(`/api/v1/arena/games/${id}`)).body;
    expect(g.grants[0].active).toBe(false);
    expect((await request(app).post(`/api/v1/arena/games/${id}/game-key`).set(await signedArena(human, { action: 'grant', game: id, colour: 'white', stake_usd: 1, grant: (await newKey()).thumb })).send({ game_key: (await newKey()).jwk })).status).toBe(401);
  });

  it('a new grant for the same game and side revokes the old key; the wallet can end it', async () => {
    const m = memStore(), app = appWith(m.store), { id, k } = await keyGame(app);
    const k2 = await newKey();
    const g = await request(app).post(`/api/v1/arena/games/${id}/game-key`).set(await signedArena(human, { action: 'grant', game: id, colour: 'white', stake_usd: 1, grant: k2.thumb })).send({ game_key: k2.jwk });
    expect(g.status).toBe(201);
    const old = await keyMove(app, id, k, 'e2e4');
    expect(old.body).toMatchObject({ error: 'game_key_revoked', reason: 'replaced' });
    expect((await keyMove(app, id, k2, 'e2e4')).status).toBe(200);
    expect((await request(app).post(`/api/v1/arena/games/${id}/game-key/revoke`).set(await signedArena(human, { action: 'revoke', game: id })).send()).body.revoked).toBe(true);
    expect((await agentMove(app, id, A1, 'e7e5')).status).toBe(200);
    expect((await keyMove(app, id, k2, 'd2d4')).body).toMatchObject({ error: 'game_key_revoked', reason: 'ended_by_wallet' });
    expect(m.keys.map((x) => x.revoked_reason)).toEqual(['replaced', 'ended_by_wallet']);
  });
});

describe('what a game key can never do', () => {
  it('cannot create or accept a challenge, grant or end a key, sign a scoresheet, or predict', async () => {
    const app = appWith(memStore().store), { id, k } = await keyGame(app);
    const h = await keyHeaders(k, app, id, 'move', 'e2e4');
    const tries: [string, object][] = [
      ['/challenges', { white: human.address, black: A3, stake_usd: 10 }],
      [`/challenges/${id}/accept`, {}],
      [`/games/${id}/game-key`, { game_key: (await newKey()).jwk }],
      [`/games/${id}/game-key/revoke`, {}],
      [`/games/${id}/scoresheet`, { result: 'x', chain_head: 'y' }],
      [`/games/${id}/predict`, { side: 'white', probability: 0.5 }],
    ];
    for (const [path, body] of tries) {
      const r = await request(app).post(`/api/v1/arena${path}`).set(h).send(body);
      expect([path, r.status, r.body.error]).toEqual([path, 403, 'key_not_allowed']);
    }
  });

  it('an agent cannot be given a game key (no agent hand-off in this build)', async () => {
    const app = appWith(memStore().store);
    const r = await request(app).post('/api/v1/arena/challenges').set(agent(A3))
      .send({ game_id: globalThis.crypto.randomUUID(), white: A3, black: A1, game_key: (await newKey()).jwk });
    expect(r.body.error).toBe('game_keys_are_for_wallets');
  });

  it('the wallet still does every stake action: a 10 USD challenge, and a human accepting one', async () => {
    const app = appWith(memStore().store);
    const { id } = await keyGame(app, { stake: 10 });
    expect((await request(app).get(`/api/v1/arena/games/${id}`)).body.stake.usd).toBe(10);
    // An agent challenges a human; the human accepts with its wallet, the grant riding on the same signature.
    const c = await request(app).post('/api/v1/arena/challenges').set(agent(A1)).send({ white: A1, black: human2.address, stake_usd: 10 });
    const k = await newKey(human2), accept: ArenaAction = { action: 'accept', game: c.body.challenge.id, colour: 'black', stake_usd: 10, grant: k.thumb };
    const a = await request(app).post(`/api/v1/arena/challenges/${c.body.challenge.id}/accept`).set(await signedArena(human2, accept)).send({ game_key: k.jwk });
    expect(a.status).toBe(200);
    // The acceptor's statement named the stake, so a different stake would not have verified.
    expect(arenaStatement(accept, human2.address, 't')).toContain('stake: 10 testnet USD, on your own win');
    expect((await agentMove(app, c.body.challenge.id, A1, 'e2e4')).status).toBe(200);
    expect((await keyMove(app, c.body.challenge.id, k, 'e7e5')).status).toBe(200);
  });

  it('the grant says plainly that resigning or a draw can lose the stake, and has no timer', () => {
    const text = arenaStatement({ action: 'grant', game: A1, colour: 'white', stake_usd: 1, grant: 'T' }, human.address, 't');
    expect(text).toContain('resigning, or agreeing a draw, can lose this game\'s stake');
    expect(text).toContain('game key may never: move funds, change a stake, create or accept a challenge, or act in another game');
    expect(text).toContain('game key ends: when this game ends, when you sign "end game key", or when you grant a new key for this game');
    expect(text).not.toMatch(/expire|hour/i);
  });
});

describe('draws and resigning', () => {
  it('a key-offered draw accepted by the agent ends the game; a move withdraws a standing offer', async () => {
    const app = appWith(memStore().store), { id, k } = await keyGame(app);
    expect((await keyMove(app, id, k, 'e2e4')).status).toBe(200);
    expect((await request(app).post(`/api/v1/arena/games/${id}/draw`).set(agent(A1)).send({ draw: 'offer' })).body.game.draw_offer).toEqual({ by: `agent:${A1}` });
    expect((await agentMove(app, id, A1, 'e7e5')).status).toBe(200); // the offerer moved: the offer is withdrawn
    expect((await request(app).post(`/api/v1/arena/games/${id}/draw`).set(await keyHeaders(k, app, id, 'accept_draw')).send({ draw: 'accept' })).body.error).toBe('no_draw_offer');
    expect((await request(app).post(`/api/v1/arena/games/${id}/draw`).set(await keyHeaders(k, app, id, 'offer_draw')).send({ draw: 'offer' })).status).toBe(200);
    const done = await request(app).post(`/api/v1/arena/games/${id}/draw`).set(agent(A1)).send({ draw: 'accept' });
    expect(done.body.game).toMatchObject({ status: 'finished', result: '1/2-1/2', termination: 'draw agreed' });
    expect(done.body.game.events.map((e: { act: string }) => e.act)).toEqual(['offer_draw', 'offer_draw', 'accept_draw']);
  });
});

describe('the move chain is the scoresheet, and anyone can verify it', () => {
  async function playedGame() {
    const m = memStore(), app = appWith(m.store), { id, k } = await keyGame(app);
    for (const step of ['f2f3', 'e7e5', 'g2g4'] as const) expect((step === 'e7e5' ? await agentMove(app, id, A1, step) : await keyMove(app, id, k, step)).status).toBe(200);
    expect((await agentMove(app, id, A1, 'd8h4')).body.game).toMatchObject({ result: '0-1', termination: 'checkmate' });
    return { m, app, id, k, g: (await request(app).get(`/api/v1/arena/games/${id}`)).body };
  }

  it('the published record verifies with no trust in the server; tampering is caught', async () => {
    const { g } = await playedGame();
    expect(g.chain_head).toBe(chainHead(g.id, g.moves));
    expect(await verifyGameRecord(g, g.grants)).toMatchObject({ ok: true, problems: [] });
    const swapped = structuredClone(g); swapped.moves[0].uci = 'f2f4';
    expect((await verifyGameRecord(swapped, g.grants)).ok).toBe(false);
    const rehashed = structuredClone(g); rehashed.moves[2].hash = '0'.repeat(64);
    expect((await verifyGameRecord(rehashed, g.grants)).problems.join()).toMatch(/ply 3: hash/);
    // A self-consistent forgery: another move with every hash recomputed, so only the signature can catch it.
    const rewritten = structuredClone(g);
    rewritten.moves[0].uci = 'f2f4';
    rewritten.moves.forEach((m: { uci: string; hash: string }, i: number) => { m.hash = chainNext(i ? rewritten.moves[i - 1].hash : chainGenesis(g.id), i + 1, m.uci); });
    // ply 3 was signed over the old chain, so it fails too: one changed move breaks every later signature.
    expect((await verifyGameRecord(rewritten, g.grants)).problems).toEqual(['ply 1: game-key signature does not verify', 'ply 3: game-key signature does not verify']);
    const forgedGrant = structuredClone(g.grants);
    forgedGrant[0].grant_signature = await Wallet.createRandom().signMessage(forgedGrant[0].grant_statement);
    expect((await verifyGameRecord(g, forgedGrant)).problems.join()).toMatch(/no valid wallet grant/);
  });

  it('FAIL CLOSED: a stripped-signature record fails, even with every hash recomputed', async () => {
    const { g } = await playedGame();
    const stripped = structuredClone(g);
    delete stripped.moves[0].sig; delete stripped.moves[0].key;
    expect((await verifyGameRecord(stripped, g.grants)).problems).toEqual(['ply 1: a human seat with no game-key signature']);
    // Strip, rewrite and rehash, as a dishonest server could: still caught at the unsigned human ply.
    const rewritten = structuredClone(stripped);
    rewritten.moves[0].uci = 'f2f4';
    rewritten.moves.forEach((m: { uci: string; hash: string }, i: number) => { m.hash = chainNext(i ? rewritten.moves[i - 1].hash : chainGenesis(g.id), i + 1, m.uci); });
    expect((await verifyGameRecord(rewritten, g.grants)).problems).toContain('ply 1: a human seat with no game-key signature');
    // An event's signature stripped is caught too.
    const { g: resigned } = await resignedGame();
    const noSig = structuredClone(resigned); delete noSig.events[0].sig;
    expect((await verifyGameRecord(noSig, resigned.grants)).problems).toEqual(['event 1 (resign at ply 1): a human seat with no game-key signature', 'the result 0-1 (White resigned) does not follow from the moves and the verified events']);
  });

  it('FAIL CLOSED: an unsigned human ply, a missing hash, or a ply relabelled as the agent\'s all fail', async () => {
    const { g } = await playedGame();
    const relabelled = structuredClone(g);
    relabelled.moves[2].by = g.black; delete relabelled.moves[2].sig; delete relabelled.moves[2].key;
    const p = (await verifyGameRecord(relabelled, g.grants)).problems;
    expect(p).toEqual([`ply 3: made by ${g.black}, but ${g.white} is to move`, 'ply 3: a human seat with no game-key signature']);
    const noHash = structuredClone(g); delete noHash.moves[1].hash;
    expect((await verifyGameRecord(noHash, g.grants)).problems).toEqual(['ply 2: no hash']);
    // An agent seat may be unsigned ONLY while it holds no human grant.
    const agentGrant = structuredClone(g.grants); agentGrant.push({ ...agentGrant[0], participant: g.black });
    expect((await verifyGameRecord(g, agentGrant)).problems.join()).toMatch(/an agent seat holds a human grant/);
  });

  it('FAIL CLOSED: two players published with one thumbprint each go through the wallet check', async () => {
    // Hand-built: the server now refuses a shared thumbprint, so only a forged record can carry one.
    const id = globalThis.crypto.randomUUID(), k = await newKey(human), white = k.who, black = `human:${human2.address.toLowerCase()}`;
    const statement = (colour: string) => arenaStatement({ action: 'grant', game: id, colour: colour as 'white', stake_usd: 0, grant: k.thumb }, colour === 'white' ? human.address : human2.address, 't');
    const grants = [
      { participant: white, thumbprint: k.thumb, public_jwk: k.jwk, grant_statement: statement('white'), grant_signature: await human.signMessage(statement('white')) },
      // black's "grant" is signed by WHITE's wallet: a forgery that only the per-participant wallet check catches.
      { participant: black, thumbprint: k.thumb, public_jwk: k.jwk, grant_statement: statement('black'), grant_signature: await human.signMessage(statement('black')) },
    ];
    const sign = async (player: string, ply: number, prev: string, uci: string) => Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.pair.privateKey, new TextEncoder().encode(gameKeyPayload({ game: id, player, act: 'move', ply, prev, uci }, 't')))).toString('base64url');
    const h0 = chainGenesis(id), h1 = chainNext(h0, 1, 'e2e4'), h2 = chainNext(h1, 2, 'e7e5');
    const record = { id, white, black, challenger: white, stake: { usd: 0 }, time_control: 'normal' as const, default_speed: '1' as const, result: null, events: [], moves: [
      { uci: 'e2e4', hash: h1, by: white, key: k.thumb, time: 't', sig: await sign(white, 1, h0, 'e2e4') },
      { uci: 'e7e5', hash: h2, by: black, key: k.thumb, time: 't', sig: await sign(black, 2, h1, 'e7e5') },
    ] };
    expect((await verifyGameRecord(record, grants)).problems).toEqual([`ply 2: no valid wallet grant for key ${k.thumb} of ${black}`]);
    // A grant genuinely signed by black's wallet, but for the WHITE seat, does not cover black's moves.
    const wrongColour = [grants[0]!, { ...grants[1]!, grant_statement: statement('white').replace(human.address.toLowerCase(), human2.address.toLowerCase()) }];
    wrongColour[1]!.grant_signature = await human2.signMessage(wrongColour[1]!.grant_statement);
    expect((await verifyGameRecord(record, wrongColour)).problems).toEqual([`ply 2: no valid wallet grant for key ${k.thumb} of ${black}`]);
    const rightColour = [grants[0]!, { ...grants[1]!, grant_statement: statement('black') }];
    rightColour[1]!.grant_signature = await human2.signMessage(statement('black'));
    expect(await verifyGameRecord(record, rightColour)).toMatchObject({ ok: true, problems: [] });
  });

  it('RESULT: a signed prefix that claims mate fails; the full game verifies as checkmate', async () => {
    const { g } = await playedGame();
    expect(await verifyGameRecord(g, g.grants)).toMatchObject({ ok: true, result_basis: 'verified', result: { result: '0-1', termination: 'checkmate' } });
    const prefix = structuredClone(g); prefix.moves = prefix.moves.slice(0, 3); // every signature still good
    const v = await verifyGameRecord(prefix, g.grants);
    expect(v).toMatchObject({ ok: false, result_basis: null, result: null });
    expect(v.problems).toEqual(['the result 0-1 (checkmate) does not follow from the moves and the verified events']);
    const wrongWinner = structuredClone(g); wrongWinner.result = '1-0';
    expect((await verifyGameRecord(wrongWinner, g.grants)).problems).toEqual(['the result 1-0 (checkmate) is not what the record shows: 0-1 (checkmate)']);
    const noMoves = structuredClone(g); delete noMoves.moves;
    expect((await verifyGameRecord(noMoves, g.grants)).problems).toContain('the record has no move list');
  });

  it('RESULT: a resign or draw needs its verified event; a missing events list is a problem, never []', async () => {
    const { g } = await resignedGame();
    expect(await verifyGameRecord(g, g.grants)).toMatchObject({ ok: true, result_basis: 'verified', result: { termination: 'White resigned' } });
    const stripped = structuredClone(g); stripped.events = [];
    expect((await verifyGameRecord(stripped, g.grants)).problems).toEqual(['the result 0-1 (White resigned) does not follow from the moves and the verified events']);
    const noEvents = structuredClone(g); delete noEvents.events;
    expect((await verifyGameRecord(noEvents, g.grants)).problems).toEqual(['the record has no events list', 'the result 0-1 (White resigned) does not follow from the moves and the verified events']);
    // A draw claimed from ONE offer (no acceptance) does not follow.
    const app = appWith(memStore().store), { id, k } = await keyGame(app);
    await request(app).post(`/api/v1/arena/games/${id}/draw`).set(await keyHeaders(k, app, id, 'offer_draw')).send({ draw: 'offer' }).expect(200);
    const done = (await request(app).post(`/api/v1/arena/games/${id}/draw`).set(agent(A1)).send({ draw: 'accept' })).body.game;
    const drawn = (await request(app).get(`/api/v1/arena/games/${id}`)).body;
    expect(done.termination).toBe('draw agreed');
    expect(await verifyGameRecord(drawn, drawn.grants)).toMatchObject({ ok: true, result_basis: 'verified' });
    const oneOffer = structuredClone(drawn); oneOffer.events = oneOffer.events.slice(0, 1);
    expect((await verifyGameRecord(oneOffer, drawn.grants)).problems).toEqual(['the result 1/2-1/2 (draw agreed) does not follow from the moves and the verified events']);
  });

  it('EVENTS: an off-list event, a missing prev, or an unknown act fails, even for an unsigned agent seat', async () => {
    const { g } = await playedGame();
    for (const [bad, why] of [
      [{ act: 'offer_draw', by: g.black, ply: 99 }, /ply is off the move list \(1 to 5\)/],
      [{ act: 'offer_draw', by: g.black, ply: 0, prev: 'x' }, /ply is off the move list/],
      [{ act: 'offer_draw', by: g.black, ply: 2 }, /no prev/],
      [{ act: 'move', by: g.black, ply: 2, prev: chainHead(g.id, g.moves.slice(0, 1)) }, /not a resign, offer_draw or accept_draw/],
    ] as const) {
      const r = structuredClone(g); r.events = [...g.events, bad];
      const v = await verifyGameRecord(r, g.grants);
      expect(v.ok).toBe(false);
      expect(v.problems.join()).toMatch(why);
    }
  });

  it('TIMEOUT: a loss on time is referee_attested, never verified, and must fall on the side to move', async () => {
    let t = Date.now();
    const m = memStore(), app = appWith(m.store, 10, { now: () => t }), { id, k } = await keyGame(app);
    expect((await keyMove(app, id, k, 'e2e4', { time: new Date(t).toISOString() })).status).toBe(200);
    t += 16 * 60_000; // black (the agent) lets a normal clock run out
    const g = (await request(app).get(`/api/v1/arena/games/${id}`)).body;
    expect(g.termination).toBe("loss on time (Black's clock ran out)");
    const v = await verifyGameRecord(g, g.grants);
    expect(v).toMatchObject({ ok: true, result_basis: 'referee_attested', result: { result: '1-0' } });
    const wrongSide = structuredClone(g); wrongSide.termination = "loss on time (White's clock ran out)"; wrongSide.result = '0-1';
    expect((await verifyGameRecord(wrongSide, g.grants)).problems).toEqual(["the result 0-1 (loss on time (White's clock ran out)) does not follow from the moves and the verified events"]);
  });

  it('GRANTS: a statement is rebuilt exactly; an extra signed line is not the grant this player could have made', async () => {
    const { g } = await playedGame();
    const padded = structuredClone(g.grants);
    padded[0].grant_statement = padded[0].grant_statement.replace(/\nwallet: /, '\nalso: this key may withdraw\nwallet: ');
    padded[0].grant_signature = await human.signMessage(padded[0].grant_statement); // a genuine signature over the longer text
    expect((await verifyGameRecord(g, padded)).problems).toEqual([
      `ply 1: no valid wallet grant for key ${g.grants[0].thumbprint} of ${g.white}`,
      `ply 3: no valid wallet grant for key ${g.grants[0].thumbprint} of ${g.white}`,
    ]);
  });

  it('SCORESHEET: checked against the replay and verified events, so a stored result the record does not support is refused', async () => {
    const { m, app, id, g } = await playedGame();
    m.games.get(id)!.result = '1-0'; // the stored row now disagrees with the moves (black mated white)
    const sheet = (result: string): ArenaAction => ({ action: 'scoresheet', game: id, result, plies: 4, chain_head: g.chain_head });
    for (const result of ['1-0 (checkmate)', '0-1 (checkmate)']) {
      const r = await request(app).post(`/api/v1/arena/games/${id}/scoresheet`).set(await signedArena(human, sheet(result))).send({ result, chain_head: g.chain_head });
      expect(r.body.error).toBe('record_unverified');
    }
    m.games.get(id)!.result = '0-1';
    const ok = await request(app).post(`/api/v1/arena/games/${id}/scoresheet`).set(await signedArena(human, sheet('0-1 (checkmate)'))).send({ result: '0-1 (checkmate)', chain_head: g.chain_head });
    expect(ok.body.accepted_result).toBe(true);
    expect(m.signals.find((x) => x.participant === g.white)!.signals.scoresheet).toMatchObject({ result_basis: 'verified' });
  });

  it('moves signed by a replaced key stay verifiable', async () => {
    const m = memStore(), app = appWith(m.store), { id, k } = await keyGame(app);
    expect((await keyMove(app, id, k, 'e2e4')).status).toBe(200);
    expect((await agentMove(app, id, A1, 'e7e5')).status).toBe(200);
    const k2 = await newKey();
    await request(app).post(`/api/v1/arena/games/${id}/game-key`).set(await signedArena(human, { action: 'grant', game: id, colour: 'white', stake_usd: 1, grant: k2.thumb })).send({ game_key: k2.jwk }).expect(201);
    expect((await keyMove(app, id, k2, 'g1f3')).status).toBe(200);
    const g = (await request(app).get(`/api/v1/arena/games/${id}`)).body;
    expect(g.moves.map((x: { key?: string }) => x.key)).toEqual([k.thumb, undefined, k2.thumb]);
    expect(await verifyGameRecord(g, g.grants)).toMatchObject({ ok: true, problems: [] });
  });

  async function resignedGame() {
    const app = appWith(memStore().store), { id, k } = await keyGame(app);
    await request(app).post(`/api/v1/arena/games/${id}/resign`).set(await keyHeaders(k, app, id, 'resign')).send().expect(200);
    const g = (await request(app).get(`/api/v1/arena/games/${id}`)).body;
    expect(await verifyGameRecord(g, g.grants)).toMatchObject({ ok: true, problems: [] });
    return { g };
  }

  it('the scoresheet signature is optional: absent until signed, and only this result and chain count', async () => {
    const { m, app, id, g } = await playedGame();
    const mine = () => m.signals.find((s) => s.participant === `human:${human.address.toLowerCase()}`)!.signals;
    expect(mine().accepted_result).toBeNull();
    const sheet = (result: string, head: string): ArenaAction => ({ action: 'scoresheet', game: id, result, plies: 4, chain_head: head });
    const wrong = await request(app).post(`/api/v1/arena/games/${id}/scoresheet`).set(await signedArena(human, sheet('0-1 (checkmate)', '0'.repeat(64)))).send({ result: '0-1 (checkmate)', chain_head: '0'.repeat(64) });
    expect(wrong.body.error).toBe('scoresheet_mismatch');
    expect(mine().accepted_result).toBeNull();
    const ok = await request(app).post(`/api/v1/arena/games/${id}/scoresheet`).set(await signedArena(human, sheet('0-1 (checkmate)', g.chain_head))).send({ result: '0-1 (checkmate)', chain_head: g.chain_head });
    expect(ok.body.accepted_result).toBe(true);
    expect(mine()).toMatchObject({ accepted_result: true, scoresheet: { chain_head: g.chain_head, by: 'wallet' } });
  });
});

describe('the page uses the same texts and keeps its own chain', () => {
  const src = (re: RegExp) => { const x = re.exec(ARENA_JS)?.[0]; expect(x).toBeDefined(); return x as string; };
  const fn = (name: string) => src(new RegExp(`(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
  // The page runs with chess.js as window.ArenaChess, served same-origin from the referee's own dependency.
  const client = new Function('ArenaChess', `var window = { ArenaChess: ArenaChess };\n${src(/var ACT_WORDS = \{[^\n]*\};/)}\n${['grantLines', 'arenaStatement', 'gameKeyPayload', 'sha256hex', 'chainHashes', 'chainProblems', 'deriveResult', 'b64url', 'b64urlBytes', 'thumbprint'].map(fn).join('\n')}
    return { grantLines, arenaStatement, gameKeyPayload, chainHashes, chainProblems, thumbprint };`)(Chess);

  it('the grant text, every wallet statement and the key payload are identical to the server\'s', () => {
    expect(client.grantLines('T')).toEqual(grantLines('T'));
    for (const a of [
      challengeBy(human, A1, { game: A3, stake_usd: 0.1, grant: 'T', colour: 'black' }),
      { action: 'accept', game: A3, colour: 'white', stake_usd: 10, grant: 'T' },
      { action: 'grant', game: A3, colour: 'black', stake_usd: 0, grant: 'T' },
      { action: 'revoke', game: A3 },
      { action: 'scoresheet', game: A3, result: '1-0 (checkmate)', plies: 37, chain_head: 'h' },
    ] as ArenaAction[]) expect(client.arenaStatement(a, human.address, 't')).toBe(arenaStatement(a, human.address, 't'));
    for (const act of ['move', 'resign', 'offer_draw', 'accept_draw'] as const) {
      const a = { game: A3, player: `human:${human.address.toLowerCase()}`, act, ply: 9, prev: 'p', uci: act === 'move' ? 'e7e8q' : undefined };
      expect(client.gameKeyPayload(a, 't')).toBe(gameKeyPayload(a, 't'));
    }
  });

  it('the page loads the referee\'s own rules (chess.js) from this origin, behind the arena flag', async () => {
    const app = appWith(memStore().store);
    const js = await request(app).get('/arena/chess.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.text).toMatch(/export \{[^}]*\bChess\b/);
    expect(js.text).not.toMatch(/sourceMappingURL/);
    expect((await request(app).get('/arena/rules.js')).text).toContain("import { Chess } from '/arena/chess.js'");
    expect((await request(app).get('/arena')).text).toContain('<script type="module" src="/arena/rules.js"></script>');
    delete process.env.ARENA_ENABLED;
    expect((await request(app).get('/arena/chess.js')).status).toBe(404);
  });

  it('the chain and the thumbprint match the server\'s', async () => {
    const moves = [{ uci: 'e2e4' }, { uci: 'e7e5' }, { uci: 'g1f3' }];
    const hs = await client.chainHashes(A3, moves);
    expect(hs[0]).toBe(chainGenesis(A3));
    expect(hs[3]).toBe(chainHead(A3, moves));
    const k = await newKey();
    expect(await client.thumbprint(k.jwk)).toBe(k.thumb);
  });

  /** A finished human-vs-human game, played through the server, as white's browser sees it. */
  async function hvhRecord() {
    const app = appWith(memStore().store), { id, k, k2 } = await humanVsHuman(app), mine: Record<number, { uci: string; prev: string }> = {};
    for (const [key, uci] of [[k, 'f2f3'], [k2, 'e7e5'], [k, 'g2g4'], [k2, 'd8h4']] as const) {
      const before = (await request(app).get(`/api/v1/arena/games/${id}`)).body;
      if (key === k) mine[before.moves.length + 1] = { uci, prev: chainHead(id, before.moves) };
      expect((await keyMove(app, id, key, uci)).status).toBe(200);
    }
    return { g: (await request(app).get(`/api/v1/arena/games/${id}`)).body, mine };
  }

  it('the page passes an honest record, and fails closed on stripped signatures and missing hashes', async () => {
    const { g, mine } = await hvhRecord();
    expect(g.result).toBe('0-1');
    expect(await client.chainProblems(g, mine)).toEqual({ problems: [], basis: 'verified' });
    expect(await verifyGameRecord(g, g.grants)).toMatchObject({ ok: true, problems: [] });
    const stripped = structuredClone(g); delete stripped.moves[1].sig;
    expect((await client.chainProblems(stripped, mine)).problems).toEqual(['ply 2: a human seat with no game-key signature']);
    const noHash = structuredClone(g); delete noHash.moves[3].hash;
    expect((await client.chainProblems(noHash, mine)).problems).toEqual(['ply 4: no hash']);
  });

  it('the page checks the result too: a signed prefix claiming mate fails, a stripped resign fails', async () => {
    const { g, mine } = await hvhRecord();
    const prefix = structuredClone(g); prefix.moves = prefix.moves.slice(0, 3);
    const prefixMine = Object.fromEntries(Object.entries(mine).filter(([n]) => Number(n) <= 3));
    expect((await client.chainProblems(prefix, prefixMine)).problems).toEqual(['the result 0-1 (checkmate) does not follow from the moves and the verified events']);
    const app = appWith(memStore().store), { id, k } = await keyGame(app);
    await request(app).post(`/api/v1/arena/games/${id}/resign`).set(await keyHeaders(k, app, id, 'resign')).send().expect(200);
    const resigned = (await request(app).get(`/api/v1/arena/games/${id}`)).body;
    expect(await client.chainProblems(resigned, {})).toEqual({ problems: [], basis: 'verified' });
    const noEvent = structuredClone(resigned); noEvent.events = [];
    expect((await client.chainProblems(noEvent, {})).problems).toEqual(['the result 0-1 (White resigned) does not follow from the moves and the verified events']);
    const unsigned = structuredClone(resigned); delete unsigned.events[0].sig;
    expect((await client.chainProblems(unsigned, {})).problems).toEqual(['event 1 (resign at ply 1): a human seat with no game-key signature', 'the result 0-1 (White resigned) does not follow from the moves and the verified events']);
    const offList = structuredClone(resigned); offList.events.push({ act: 'offer_draw', by: resigned.black, ply: 40 });
    expect((await client.chainProblems(offList, {})).problems.join()).toMatch(/ply is off the move list.*no prev/);
  });

  it('the page labels a loss on time referee_attested, never verified', async () => {
    let t = Date.now();
    const app = appWith(memStore().store, 10, { now: () => t }), { id, k } = await keyGame(app);
    expect((await keyMove(app, id, k, 'e2e4', { time: new Date(t).toISOString() })).status).toBe(200);
    t += 16 * 60_000;
    const g = (await request(app).get(`/api/v1/arena/games/${id}`)).body;
    expect(await client.chainProblems(g, {})).toEqual({ problems: [], basis: 'referee_attested' });
  });

  it('the page flags a rewrite of the OPPONENT\'s move, which this browser never signed', async () => {
    const { g, mine } = await hvhRecord();
    // Black's last move rewritten and every hash recomputed: nothing this browser signed changed.
    const rewritten = structuredClone(g);
    rewritten.moves[3].uci = 'd8g5';
    const hs = await client.chainHashes(g.id, rewritten.moves);
    rewritten.moves.forEach((m: { hash: string }, i: number) => { m.hash = hs[i + 1]; });
    expect((await client.chainProblems(rewritten, mine)).problems).toEqual(['ply 4: game-key signature does not verify', 'the result 0-1 (checkmate) does not follow from the moves and the verified events']);
    // And a rewrite of a move this browser DID sign is flagged twice: bad signature, and not what I signed.
    const mineChanged = structuredClone(g); mineChanged.moves[2].uci = 'h2h4';
    const hs2 = await client.chainHashes(g.id, mineChanged.moves);
    mineChanged.moves.forEach((m: { hash: string }, i: number) => { m.hash = hs2[i + 1]; });
    expect((await client.chainProblems(mineChanged, mine)).problems.join()).toMatch(/ply 3: this browser signed g2g4, the server shows h2h4/);
  });
});
