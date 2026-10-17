/**
 * The human play page for the arena, served by the engine at /arena (same origin: no CORS) behind
 * ARENA_ENABLED. No CDN and no framework. Kept as strings so `tsc` ships it in dist/ with no copy
 * step. helmet's default CSP allows only same-origin scripts and no inline handlers, so the script
 * is a separate file (/arena/arena.js) and every handler is attached with addEventListener.
 *
 * ONE WALLET SIGNATURE PER GAME. Challenging or accepting makes a P-256 game key with WebCrypto
 * (`extractable: false`, kept in IndexedDB; the private half never leaves the browser) and the
 * wallet signs one grant for it, after a confirm panel that says in plain words what the key may and
 * may never do. Moves, draw offers and resigning are then signed by the game key, with no popup.
 * The wallet is still asked for everything stake-bearing (challenge, accept), for a new or ended
 * game key, and for the optional scoresheet.
 *
 * The page keeps its own copy of the move chain (what this browser signed, and the hash chain it
 * recomputes from the moves) and flags a server copy that differs.
 *
 * The client copies of arenaStatement, grantLines, gameKeyPayload and the chain are pinned equal to
 * the server's by tests/arena-game-keys.test.ts. Only "Create or confirm account" signs the shared
 * authMessage of POST /api/v1/account/connect.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let chessModule: string | null | undefined;
/**
 * chess.js's own ESM build (the referee's exact dependency and version), served same-origin at
 * /arena/chess.js so the page can replay a game with the same rules as the server. Read once; null
 * when the file is not there, in which case the page says it could not check the result.
 */
export function chessModuleJs(): string | null {
  if (chessModule === undefined) {
    try {
      chessModule = readFileSync(join(dirname(require.resolve('chess.js')), '..', 'esm', 'chess.js'), 'utf8').replace(/\n\/\/# sourceMappingURL=.*$/m, '\n');
    } catch {
      chessModule = null;
    }
  }
  return chessModule;
}
/** Hands the rules to the classic page script. A module, so it loads after the page and may fail alone. */
export const ARENA_RULES_JS = "import { Chess } from '/arena/chess.js';\nwindow.ArenaChess = Chess;\n";

export const ARENA_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentChess Arena</title>
<style>
  :root { --bg:#ffffff; --fg:#1b1b1f; --muted:#55565e; --line:#d4d4d8; --accent:#1d4ed8; --light:#eeeed2; --dark:#7a9a5a; --sel:#f59e0b; --err:#b91c1c; --ok:#166534; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111114; --fg:#ececf0; --muted:#a6a7b0; --line:#34343c; --accent:#93b4ff; --light:#c8c8a8; --dark:#5f7d43; --err:#fca5a5; --ok:#86efac; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; } h2 { font-size: 1.1rem; margin: 0 0 8px; }
  p.note { color: var(--muted); margin: 0 0 16px; }
  section { border:1px solid var(--line); border-radius:8px; padding:12px; margin-bottom:16px; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  label { display:flex; flex-direction:column; gap:2px; font-size:.9rem; color:var(--muted); }
  input, select, button { font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 10px; }
  button { cursor:pointer; } button:disabled { cursor:default; opacity:.5; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
  input[name=agent] { min-width: 18rem; max-width: 100%; }
  #status { min-height:1.5em; } #status.err, #chain.err { color:var(--err); } #chain.ok { color:var(--ok); }
  ul.games { list-style:none; padding:0; margin:8px 0 0; } ul.games li { padding:4px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; }
  .play { display:grid; grid-template-columns: minmax(0, 480px) minmax(0, 1fr); gap:16px; } @media (max-width: 720px) { .play { grid-template-columns: 1fr; } }
  #board { display:grid; grid-template-columns: repeat(8, 1fr); width:100%; max-width:480px; aspect-ratio:1; border:1px solid var(--line); }
  #board button { border:0; border-radius:0; padding:0; font-size: clamp(20px, 6vw, 40px); line-height:1; color:#000; aspect-ratio:1; }
  #board button.l { background:var(--light); } #board button.d { background:var(--dark); }
  #board button.sel { box-shadow: inset 0 0 0 4px var(--sel); }
  .actions { margin-top:8px; }
  .clocks { display:flex; gap:16px; font-variant-numeric: tabular-nums; margin:8px 0; }
  #moves { font-family: ui-monospace, monospace; font-size:.9rem; max-height: 16rem; overflow:auto; }
  #sign-text { white-space: pre-wrap; overflow-wrap:anywhere; font-family: ui-monospace, monospace; font-size:.9rem; margin:0; }
</style>
</head>
<body>
<main>
  <h1>AgentChess Arena</h1>
  <p class="note">Testnet and shadow. No money moves: a stake only scales the chess-rating change, and the chess rating never touches RepID. The chess.js referee on the server decides every move and result. Your wallet signs once per game; after that this browser's game key signs your moves.</p>
  <p id="status" role="status" aria-live="polite"></p>

  <section aria-labelledby="h-sign">
    <h2 id="h-sign">What your wallet will sign</h2>
    <p id="sign-why"></p>
    <pre id="sign-text" aria-live="polite">Nothing yet. Before every wallet signature this shows the exact text, and you confirm it first.</pre>
  </section>

  <section aria-labelledby="h-wallet">
    <h2 id="h-wallet">1. Wallet</h2>
    <div class="row">
      <button id="connect" type="button">Connect wallet</button>
      <button id="account" type="button" disabled>Create or confirm account</button>
      <span id="wallet" aria-live="polite">Not connected.</span>
    </div>
  </section>

  <section aria-labelledby="h-challenge">
    <h2 id="h-challenge">2. Challenge an agent</h2>
    <form id="challenge" class="row">
      <label>Agent id (uuid)<input name="agent" required pattern="[0-9a-fA-F-]{36}" autocomplete="off"></label>
      <label>Your colour<select name="color"><option value="white">White</option><option value="black">Black</option></select></label>
      <label>Stake (testnet USD, your own win)<select name="stake"><option>0</option><option>0.1</option><option selected>1</option><option>10</option></select></label>
      <label>Time control<select name="tc"><option value="fast">Fast (5 min + 5 s)</option><option value="normal" selected>Normal (15 min + 10 s)</option><option value="slow">Slow (60 min + 30 s)</option></select></label>
      <button type="submit">Send challenge</button>
    </form>
  </section>

  <section aria-labelledby="h-games">
    <h2 id="h-games">3. Games</h2>
    <div class="row" role="group" aria-label="Show games">
      <button type="button" data-list="pending">Challenges</button>
      <button type="button" data-list="live">Live</button>
      <button type="button" data-list="finished">Finished</button>
    </div>
    <ul id="games" class="games"></ul>
  </section>

  <section aria-labelledby="h-board">
    <h2 id="h-board">4. Board</h2>
    <div class="play">
      <div>
        <div class="row">
          <label>Viewer speed<select id="speed"><option value="machine">Machine (instant)</option><option value="1" selected>1x (real time)</option><option value="0.5">0.5x</option><option value="0.25">0.25x</option></select></label>
          <label>Promote to<select id="promo"><option value="q">Queen</option><option value="r">Rook</option><option value="b">Bishop</option><option value="n">Knight</option></select></label>
        </div>
        <p id="players">No game open.</p>
        <div class="clocks"><span id="cw">White --:--</span><span id="cb">Black --:--</span></div>
        <div id="board" role="group" aria-label="Chess board"></div>
        <div class="row actions" role="group" aria-label="Game actions">
          <button id="offer-draw" type="button" disabled>Offer draw</button>
          <button id="accept-draw" type="button" disabled>Accept draw</button>
          <button id="resign" type="button" disabled>Resign</button>
          <button id="grant" type="button" disabled>Grant this browser a game key</button>
          <button id="end-key" type="button" disabled>End game key</button>
          <button id="scoresheet" type="button" disabled>Sign the scoresheet (optional)</button>
        </div>
      </div>
      <div>
        <p id="result" aria-live="polite"></p>
        <p id="chain" aria-live="polite"></p>
        <ol id="moves"></ol>
      </div>
    </div>
  </section>
</main>
<script type="module" src="/arena/rules.js"></script>
<script src="/arena/arena.js"></script>
</body>
</html>
`;

export const ARENA_JS = String.raw`(function () {
  'use strict';
  var API = '/api/v1/arena';
  var S = { wallet: null, game: null, fen: null, es: null, sel: null, clock: null };
  function $(id) { return document.getElementById(id); }
  function say(msg, err) { var s = $('status'); s.textContent = msg; s.className = err ? 'err' : ''; }
  function me() { return S.wallet ? 'human:' + S.wallet.toLowerCase() : null; }
  var GRANT_WHY = 'One wallet signature for this whole game. Until this game ends, this browser may move, offer a draw, accept a draw and resign for you, in this game only. Resigning, or agreeing a draw, can lose this game\'s stake. The key can never move funds, change a stake, create or accept a challenge, or act in another game. If this browser loses the key (cleared storage or another device), you sign one new grant; the game clock keeps running while you do.';

  // The engine's existing statement (src/routes/v1/byok.ts authMessage): method + path + wallet + time.
  function authMessage(method, path, wallet, ts) {
    return ['HyperDAG — authenticated request', 'method: ' + method.toUpperCase(), 'path:   ' + path, 'wallet: ' + wallet.toLowerCase(), 'time:   ' + ts].join('\n');
  }
  // The same lines the server signs into a grant (src/arena/game-key.ts grantLines).
  function grantLines(thumbprint) {
    return ['game key: ' + thumbprint,
      'game key may: move, offer a draw, accept a draw and resign for you, in this game only',
      'resigning, or agreeing a draw, can lose this game\'s stake',
      'game key may never: move funds, change a stake, create or accept a challenge, or act in another game',
      'game key ends: when this game ends, when you sign "end game key", or when you grant a new key for this game'];
  }
  // The arena's wallet statement: the same text the server rebuilds from the request body (src/routes/arena.ts arenaStatement).
  function arenaStatement(a, wallet, ts) {
    var lines = ['HyperDAG AgentChess arena (testnet; no money moves)'];
    var stake = function (usd) { return 'stake: ' + usd + ' testnet USD, on your own win'; };
    if (a.action === 'challenge') lines.push.apply(lines, ['action: challenge'].concat(a.game ? ['game: ' + a.game] : [], ['opponent: ' + a.opponent, 'you play: ' + a.colour, stake(a.stake_usd), 'time control: ' + a.time_control, 'viewer speed: ' + a.speed], a.grant ? grantLines(a.grant) : []));
    else if (a.action === 'accept') lines.push.apply(lines, ['action: accept challenge', 'game: ' + a.game, 'you play: ' + a.colour, stake(a.stake_usd)].concat(a.grant ? grantLines(a.grant) : []));
    else if (a.action === 'grant') lines.push.apply(lines, ['action: grant a game key', 'game: ' + a.game, 'you play: ' + a.colour, stake(a.stake_usd)].concat(grantLines(a.grant)));
    else if (a.action === 'revoke') lines.push('action: end game key', 'game: ' + a.game);
    else if (a.action === 'scoresheet') lines.push('action: sign the scoresheet (I accept the result)', 'game: ' + a.game, 'result: ' + a.result, 'plies: ' + a.plies, 'move chain: ' + a.chain_head);
    else lines.push('action: predict (calibration only)', 'game: ' + a.game, 'side: ' + a.side + ' wins', 'probability: ' + a.probability);
    lines.push('wallet: ' + wallet.toLowerCase(), 'time: ' + ts);
    return lines.join('\n');
  }
  // What the game key signs (src/arena/game-key.ts gameKeyPayload).
  var ACT_WORDS = { move: 'move', resign: 'resign', offer_draw: 'offer draw', accept_draw: 'accept draw' };
  function gameKeyPayload(a, time) {
    var lines = ['HyperDAG AgentChess game key', 'game: ' + a.game, 'player: ' + a.player, 'action: ' + ACT_WORDS[a.act], 'ply: ' + a.ply, 'prev: ' + a.prev];
    if (a.act === 'move') lines.push('move: ' + (a.uci || ''));
    lines.push('time: ' + time);
    return lines.join('\n');
  }
  // The move chain (src/arena/game-key.ts chainGenesis / chainNext / chainHead), computed here, independently.
  async function sha256hex(s) { var d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), h = ''; for (var i = 0; i < d.length; i++) h += d[i].toString(16).padStart(2, '0'); return h; }
  async function chainHashes(game, moves) {
    var h = await sha256hex('HyperDAG AgentChess game ' + game), out = [h];
    for (var i = 0; i < moves.length; i++) { h = await sha256hex(h + '\n' + (i + 1) + '\n' + moves[i].uci); out.push(h); }
    return out; // out[n] = the chain after n moves
  }
  // Check a server copy of the game the same way src/arena/game-key.ts verifyGameRecord does, and FAIL
  // CLOSED: every move must carry its hash and name the seated player; a human seat's every move and
  // event must carry a game-key signature that verifies under a key whose grant names this game, this
  // colour and this key; an unsigned move is fine only for an agent seat holding no human grant. That
  // covers the OPPONENT's moves too. Then compare with what this browser signed itself. (The grants'
  // wallet signatures are checked separately, by walletGrantProblems.)
  async function chainProblems(g, signedByMe) {
    var problems = [], grants = g.grants || [], keys = {}, validEvents = [];
    if (!Array.isArray(g.moves)) problems.push('the record has no move list');
    if (!Array.isArray(g.events)) problems.push('the record has no events list');
    var moves = Array.isArray(g.moves) ? g.moves : [], hs = await chainHashes(g.id, moves);
    function colour(ref) { return ref === g.white ? 'white' : ref === g.black ? 'black' : null; }
    function human(ref) { return String(ref).indexOf('human:') === 0; }
    grants.forEach(function (x) { if (!colour(x.participant) || !human(x.participant)) problems.push('grant ' + x.thumbprint + ': ' + x.participant + ' is not a human player in this game'); });
    async function keyFor(by, thumb) {
      var id = by + '|' + thumb;
      if (!(id in keys)) {
        var x = grants.find(function (y) { return y.participant === by && y.thumbprint === thumb; });
        var ok = !!x && (await thumbprint(x.public_jwk)) === thumb && x.grant_statement.indexOf('game: ' + g.id + '\n') >= 0
          && x.grant_statement.indexOf('game key: ' + thumb + '\n') >= 0 && x.grant_statement.indexOf('you play: ' + colour(by) + '\n') >= 0;
        keys[id] = ok ? await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: x.public_jwk.x, y: x.public_jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']) : null;
      }
      return keys[id];
    }
    async function checkSigned(label, by, x, payload) {
      var before = problems.length;
      if (!human(by)) {
        if (grants.some(function (y) { return y.participant === by; })) problems.push(label + ': an agent seat holds a human grant');
        if (x.sig) problems.push(label + ': an agent seat carries a game-key signature');
        return problems.length === before;
      }
      if (!x.sig || !x.key) { problems.push(label + ': a human seat with no game-key signature'); return false; }
      var k = await keyFor(by, x.key);
      if (!k) { problems.push(label + ': no valid grant for key ' + x.key + ' of ' + by); return false; }
      var ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, b64urlBytes(x.sig), new TextEncoder().encode(payload));
      if (!ok) problems.push(label + ': game-key signature does not verify');
      return ok;
    }
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i], ply = i + 1, seat = ply % 2 === 1 ? g.white : g.black;
      if (!m.hash) problems.push('ply ' + ply + ': no hash');
      else if (m.hash !== hs[ply]) problems.push('ply ' + ply + ': the server hash does not follow from the moves');
      if (m.by !== seat) problems.push('ply ' + ply + ': made by ' + (m.by || 'nobody named') + ', but ' + seat + ' was to move');
      await checkSigned('ply ' + ply, seat, m, gameKeyPayload({ game: g.id, player: seat, act: 'move', ply: ply, prev: hs[i], uci: m.uci }, m.time || ''));
    }
    var events = Array.isArray(g.events) ? g.events : [];
    for (var j = 0; j < events.length; j++) {
      var e = events[j], label = 'event ' + (j + 1) + ' (' + e.act + ' at ply ' + e.ply + ')', before = problems.length;
      if (['resign', 'offer_draw', 'accept_draw'].indexOf(e.act) < 0) problems.push(label + ': not a resign, offer_draw or accept_draw');
      if (!Number.isInteger(e.ply) || e.ply < 1 || e.ply > moves.length + 1) problems.push(label + ': ply is off the move list (1 to ' + (moves.length + 1) + ')');
      if (typeof e.prev !== 'string') problems.push(label + ': no prev');
      else if (hs[e.ply - 1] !== e.prev) problems.push(label + ': prev is not the chain head at that ply');
      if (!colour(e.by)) problems.push(label + ': ' + e.by + ' is not a player in this game');
      if (problems.length > before) continue;
      if (await checkSigned(label, e.by, e, gameKeyPayload({ game: g.id, player: e.by, act: e.act, ply: e.ply, prev: e.prev }, e.time || ''))) validEvents.push(e);
    }
    Object.keys(signedByMe || {}).forEach(function (n) {
      var mine = signedByMe[n], theirs = moves[Number(n) - 1];
      if (!theirs || theirs.uci !== mine.uci || hs[Number(n) - 1] !== mine.prev) problems.push('ply ' + n + ': this browser signed ' + mine.uci + ', the server shows ' + (theirs ? theirs.uci : 'nothing'));
    });
    // The result must follow from what verified, as the server's verifyGameRecord requires.
    var basis = null, claimed = g.result || null, derived = null;
    if (g.status === 'finished' && !claimed) problems.push('the game is finished but carries no result');
    if (claimed || window.ArenaChess) {
      if (!window.ArenaChess) problems.push('this browser could not load the rules of chess, so it cannot check the result');
      else {
        try { derived = deriveResult(g, moves, validEvents); } catch (x) { problems.push('the moves do not replay under the rules of chess'); }
        if (claimed) {
          if (!derived) problems.push('the result ' + claimed + ' (' + (g.termination || '') + ') does not follow from the moves and the verified events');
          else if (derived.result !== claimed || derived.termination !== g.termination) problems.push('the result ' + claimed + ' (' + (g.termination || '') + ') is not what the record shows: ' + derived.result + ' (' + derived.termination + ')');
          else basis = derived.basis;
        } else if (derived) problems.push('the moves and events end the game (' + derived.result + ', ' + derived.termination + ') but no result is recorded');
      }
    }
    return { problems: problems, basis: basis };
  }
  // The result the record supports (src/arena/game-key.ts deriveResult): the board, then a valid resign or
  // agreed draw after the last move; a loss on time only as the referee's word ('referee_attested').
  function deriveResult(g, moves, validEvents) {
    var c = new window.ArenaChess();
    moves.forEach(function (m) { c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] }); });
    if (c.isCheckmate()) return { result: c.turn() === 'w' ? '0-1' : '1-0', termination: 'checkmate', basis: 'verified' };
    if (c.isStalemate()) return { result: '1/2-1/2', termination: 'stalemate', basis: 'verified' };
    if (c.isThreefoldRepetition()) return { result: '1/2-1/2', termination: 'threefold repetition', basis: 'verified' };
    if (c.isInsufficientMaterial()) return { result: '1/2-1/2', termination: 'insufficient material', basis: 'verified' };
    if (c.isDrawByFiftyMoves()) return { result: '1/2-1/2', termination: 'fifty-move rule', basis: 'verified' };
    var last = moves.length + 1, at = validEvents.filter(function (e) { return e.ply === last; });
    var resign = at.find(function (e) { return e.act === 'resign'; });
    if (resign) return resign.by === g.white ? { result: '0-1', termination: 'White resigned', basis: 'verified' } : { result: '1-0', termination: 'Black resigned', basis: 'verified' };
    var offer = at.findIndex(function (e) { return e.act === 'offer_draw'; });
    if (offer >= 0 && at.slice(offer + 1).some(function (e) { return e.by !== at[offer].by && (e.act === 'accept_draw' || e.act === 'offer_draw'); })) return { result: '1/2-1/2', termination: 'draw agreed', basis: 'verified' };
    var t = /^loss on time \((White|Black)'s clock ran out\)$/.exec(g.termination || '');
    if (t) {
      var loser = t[1] === 'White' ? 'w' : 'b', toMove = moves.length % 2 === 0 ? 'w' : 'b', result = loser === 'w' ? '0-1' : '1-0';
      if (loser === toMove && g.result === result) return { result: result, termination: g.termination, basis: 'referee_attested' };
    }
    return null;
  }
  // The grants' wallet signatures: recovered through the connected wallet (personal_ecRecover), since
  // this page carries no secp256k1 code of its own. Without a wallet that offers it, they are NOT CHECKED
  // here, and the page says so rather than counting them as good.
  async function walletGrantProblems(g) {
    if (!window.ethereum) return { notChecked: true, problems: [] };
    var problems = [];
    for (var i = 0; i < (g.grants || []).length; i++) {
      var x = g.grants[i];
      try {
        var who = await window.ethereum.request({ method: 'personal_ecRecover', params: [hex(x.grant_statement), x.grant_signature] });
        if ('human:' + String(who).toLowerCase() !== x.participant) problems.push('grant ' + x.thumbprint + ': not signed by ' + x.participant);
      } catch (e) { return { notChecked: true, problems: problems }; }
    }
    return { notChecked: false, problems: problems };
  }
  function b64urlBytes(s) { var t = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), out = new Uint8Array(t.length); for (var i = 0; i < t.length; i++) out[i] = t.charCodeAt(i); return out; }
  function b64url(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  async function thumbprint(jwk) { var d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('{"crv":"P-256","kty":"EC","x":"' + jwk.x + '","y":"' + jwk.y + '"}'))); return b64url(d); }

  // Game keys live in IndexedDB as non-extractable CryptoKeys: usable by this origin, never readable as bytes.
  function idb() { return new Promise(function (ok, no) { var r = indexedDB.open('agentchess-game-keys', 1); r.onupgradeneeded = function () { r.result.createObjectStore('keys'); }; r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; }); }
  async function idbGet(k) { var db = await idb(); return new Promise(function (ok, no) { var q = db.transaction('keys').objectStore('keys').get(k); q.onsuccess = function () { ok(q.result || null); }; q.onerror = function () { no(q.error); }; }); }
  async function idbPut(k, v) { var db = await idb(); return new Promise(function (ok, no) { var t = db.transaction('keys', 'readwrite'); t.objectStore('keys').put(v, k); t.oncomplete = function () { ok(); }; t.onerror = function () { no(t.error); }; }); }
  function keyId(game) { return game + '|' + me(); }
  async function newGameKey() {
    var pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    var j = await crypto.subtle.exportKey('jwk', pair.publicKey), jwk = { kty: 'EC', crv: 'P-256', x: j.x, y: j.y };
    return { pair: pair, jwk: jwk, thumb: await thumbprint(jwk) };
  }

  function hex(s) { var b = new TextEncoder().encode(s), h = '0x'; for (var i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0'); return h; }
  async function readJson(r) { try { return await r.json(); } catch (e) { return {}; } }
  async function send(path, body, headers) {
    var r = await fetch(path, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body || {}) });
    var j = await readJson(r);
    if (!r.ok) { var e = new Error((j.error || ('HTTP ' + r.status)) + (j.reason ? ': ' + j.reason : j.message ? ': ' + j.message : '')); e.body = j; throw e; }
    return j;
  }
  // A wallet signature, after showing the exact text (and, for a grant, what it means in plain words).
  async function signed(path, body, action, why) {
    if (!S.wallet) throw new Error('Connect a wallet first.');
    var ts = new Date().toISOString();
    var text = action ? arenaStatement(action, S.wallet, ts) : authMessage('POST', path, S.wallet, ts);
    $('sign-why').textContent = why || ''; $('sign-text').textContent = text;
    if (!window.confirm((why ? why + '\n\n' : '') + 'Your wallet will now ask you to sign exactly this:\n\n' + text)) throw new Error('Cancelled. Nothing was signed.');
    var sig = await window.ethereum.request({ method: 'personal_sign', params: [hex(text), S.wallet] });
    return send(path, body, { 'x-hd-wallet': S.wallet, 'x-hd-timestamp': ts, 'x-hd-signature': sig });
  }
  // A game-key signature: no popup. Records what this browser signed, for the chain check.
  async function keyed(path, body, act, uci) {
    var g = await getJson(API + '/games/' + S.game.id), rec = await idbGet(keyId(S.game.id));
    if (!rec) { $('grant').disabled = false; throw new Error('This browser has no game key for this game. Grant one (one wallet signature; the game clock keeps running).'); }
    var hs = await chainHashes(g.id, g.moves), ply = g.moves.length + 1, time = new Date().toISOString();
    var payload = gameKeyPayload({ game: g.id, player: me(), act: act, ply: ply, prev: hs[hs.length - 1], uci: uci }, time);
    var sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, rec.pair.privateKey, new TextEncoder().encode(payload)));
    if (act === 'move') { rec.signed = rec.signed || {}; rec.signed[ply] = { uci: uci, prev: hs[hs.length - 1] }; await idbPut(keyId(g.id), rec); }
    try { return await send(path, body, { 'x-arena-key-signature': b64url(sig), 'x-arena-key-time': time }); }
    catch (e) { if (e.body && (e.body.error === 'game_key_revoked')) $('grant').disabled = false; throw e; }
  }
  async function getJson(path) { var r = await fetch(path); var j = await readJson(r); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }
  function guard(fn) { return function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); Promise.resolve(fn(ev)).catch(function (e) { say(e.message || String(e), true); }); }; }
  function colourOf(g, ref) { return g.white === ref ? 'white' : g.black === ref ? 'black' : null; }

  // 1. Wallet
  $('connect').addEventListener('click', guard(async function () {
    if (!window.ethereum) throw new Error('No browser wallet found (window.ethereum). Install one, then reload.');
    var acc = await window.ethereum.request({ method: 'eth_requestAccounts' });
    S.wallet = acc[0];
    $('wallet').textContent = 'Connected: ' + S.wallet;
    $('account').disabled = false;
    say('Wallet connected. Create or confirm your account once, then play.');
    if (S.game) render();
  }));
  $('account').addEventListener('click', guard(async function () {
    var j = await signed('/api/v1/account/connect', {}, null, '');
    say(j.created ? 'Account created. You can play now.' : 'Account confirmed. You can play now.');
  }));

  // 2. Challenge: the challenge, its stake and the game key's grant in ONE wallet signature.
  $('challenge').addEventListener('submit', guard(async function (ev) {
    var f = ev.target, agent = f.agent.value.trim().toLowerCase(), color = f.color.value, id = crypto.randomUUID(), k = await newGameKey();
    var body = { game_id: id, white: color === 'white' ? S.wallet : agent, black: color === 'white' ? agent : S.wallet, stake_usd: Number(f.stake.value), time_control: f.tc.value, speed: $('speed').value, game_key: k.jwk };
    var act = { action: 'challenge', game: id, opponent: 'agent:' + agent, colour: color, stake_usd: body.stake_usd, time_control: body.time_control, speed: body.speed, grant: k.thumb };
    var j = await signed(API + '/challenges', body, act, GRANT_WHY);
    await idbPut(id + '|' + me(), { pair: k.pair, thumb: k.thumb, signed: {} });
    say('Challenge sent (' + j.challenge.id + '). The agent must accept it. ' + (j.challenge.rated ? 'Rated game.' : 'Unrated game: these players are not shown to have different owners.'));
    list('pending');
  }));

  // 3. Lists
  function short(ref) { return ref.length > 20 ? ref.slice(0, 12) + '…' + ref.slice(-6) : ref; }
  async function list(status) {
    var j = await getJson(API + '/games?status=' + status);
    var ul = $('games'); ul.textContent = '';
    if (!j.games.length) { var li0 = document.createElement('li'); li0.textContent = 'None.'; ul.appendChild(li0); }
    j.games.forEach(function (g) {
      var li = document.createElement('li');
      li.appendChild(document.createTextNode(short(g.white) + ' (White) vs ' + short(g.black) + ' (Black), $' + g.stake_usd + ' testnet, ' + g.time_control + (g.result ? ', ' + g.result : '') + ' '));
      var w = document.createElement('button'); w.type = 'button'; w.textContent = g.status === 'pending' ? 'Open' : 'Watch';
      w.addEventListener('click', guard(function () { return watch(g.id); })); li.appendChild(w);
      var challenged = g.challenger === g.white ? g.black : g.white;
      if (g.status === 'pending' && me() && challenged === me()) {
        var a = document.createElement('button'); a.type = 'button'; a.textContent = 'Accept';
        a.addEventListener('click', guard(async function () {
          var k = await newGameKey();
          await signed(API + '/challenges/' + g.id + '/accept', { game_key: k.jwk }, { action: 'accept', game: g.id, colour: colourOf(g, me()), stake_usd: g.stake_usd, grant: k.thumb }, GRANT_WHY);
          await idbPut(g.id + '|' + me(), { pair: k.pair, thumb: k.thumb, signed: {} });
          say('Accepted. The game is live.'); await watch(g.id);
        }));
        li.appendChild(a);
      }
      ul.appendChild(li);
    });
    say('Showing ' + status + ' games.');
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-list]'), function (b) { b.addEventListener('click', guard(function () { return list(b.getAttribute('data-list')); })); });

  // 4. Board
  var GLYPH = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙', k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  var NAME = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
  function grid(fen) { var rows = fen.split(' ')[0].split('/'), out = {}; rows.forEach(function (row, r) { var f = 0; for (var i = 0; i < row.length; i++) { var c = row[i]; if (/\d/.test(c)) f += Number(c); else { out['abcdefgh'[f] + (8 - r)] = c; f++; } } }); return out; }
  function myColor() { if (!S.game || !me()) return null; return S.game.white === me() ? 'w' : S.game.black === me() ? 'b' : null; }
  function turn() { return S.fen ? S.fen.split(' ')[1] : null; }
  function myTurn() { return S.game && S.game.status === 'live' && myColor() && turn() === myColor(); }
  function render() {
    var b = $('board'); b.textContent = '';
    var pieces = grid(S.fen || '8/8/8/8/8/8/8/8 w - - 0 1'), flip = myColor() === 'b';
    for (var i = 0; i < 64; i++) {
      var r = flip ? 1 + Math.floor(i / 8) : 8 - Math.floor(i / 8), f = flip ? 7 - (i % 8) : i % 8, sq = 'abcdefgh'[f] + r, p = pieces[sq];
      var btn = document.createElement('button'); btn.type = 'button'; btn.setAttribute('data-sq', sq);
      btn.className = ((f + r) % 2 === 1 ? 'd' : 'l') + (S.sel === sq ? ' sel' : '');
      btn.textContent = p ? GLYPH[p] : '';
      btn.setAttribute('aria-label', sq + ': ' + (p ? (p === p.toUpperCase() ? 'white ' : 'black ') + NAME[p.toLowerCase()] : 'empty') + (S.sel === sq ? ', selected' : ''));
      btn.addEventListener('click', guard(click));
      b.appendChild(btn);
    }
    showClocks();
    var live = !!(S.game && S.game.status === 'live' && myColor()), over = !!(S.game && S.game.status === 'finished' && myColor());
    $('offer-draw').disabled = !live; $('resign').disabled = !live; $('end-key').disabled = !live;
    $('accept-draw').disabled = !(live && S.game.draw_offer && S.game.draw_offer.by !== me());
    $('scoresheet').disabled = !over;
    if (S.game) $('players').textContent = 'White ' + short(S.game.white) + ' vs Black ' + short(S.game.black) + (myColor() ? ' (you are ' + (myColor() === 'w' ? 'White' : 'Black') + (myTurn() ? ', your move' : '') + ')' : '') + (S.game.draw_offer ? '. A draw is offered.' : '');
  }
  async function click(ev) {
    var sq = ev.currentTarget.getAttribute('data-sq'), p = grid(S.fen)[sq];
    if (!myTurn()) { say(myColor() ? 'Not your turn.' : 'You are watching this game.'); return; }
    if (!S.sel) { if (p && (p === p.toUpperCase()) === (myColor() === 'w')) { S.sel = sq; render(); say('Selected ' + sq + '. Now choose a square.'); } return; }
    if (S.sel === sq) { S.sel = null; render(); return; }
    var from = S.sel, piece = grid(S.fen)[from]; S.sel = null; render();
    var uci = from + sq + ((piece === 'P' && sq[1] === '8') || (piece === 'p' && sq[1] === '1') ? $('promo').value : '');
    await keyed(API + '/games/' + S.game.id + '/move', { uci: uci }, 'move', uci);
    say('Moved ' + uci + '.');
  }
  $('offer-draw').addEventListener('click', guard(async function () { await keyed(API + '/games/' + S.game.id + '/draw', { draw: 'offer' }, 'offer_draw'); say('Draw offered. It stands until a move is made.'); await refresh(); }));
  $('accept-draw').addEventListener('click', guard(async function () {
    if (!window.confirm('Accept the draw? The game ends now, and a draw can lose this game\'s stake.')) return;
    await keyed(API + '/games/' + S.game.id + '/draw', { draw: 'accept' }, 'accept_draw'); await refresh();
  }));
  $('resign').addEventListener('click', guard(async function () {
    if (!window.confirm('Resign this game? You lose it now, and with it this game\'s stake.')) return;
    await keyed(API + '/games/' + S.game.id + '/resign', {}, 'resign'); await refresh();
  }));
  $('grant').addEventListener('click', guard(async function () {
    var g = S.game, k = await newGameKey();
    await signed(API + '/games/' + g.id + '/game-key', { game_key: k.jwk }, { action: 'grant', game: g.id, colour: colourOf(g, me()), stake_usd: g.stake.usd, grant: k.thumb }, GRANT_WHY);
    var old = await idbGet(keyId(g.id));
    await idbPut(keyId(g.id), { pair: k.pair, thumb: k.thumb, signed: (old && old.signed) || {} });
    $('grant').disabled = true; say('This browser has a game key for this game. Any earlier key of yours no longer acts.');
  }));
  $('end-key').addEventListener('click', guard(async function () {
    await signed(API + '/games/' + S.game.id + '/game-key/revoke', {}, { action: 'revoke', game: S.game.id }, 'Ends your game key for this game. Until you grant a new one, this browser cannot move for you; the clock keeps running.');
    $('grant').disabled = false; say('Game key ended.');
  }));
  $('scoresheet').addEventListener('click', guard(async function () {
    var g = await getJson(API + '/games/' + S.game.id), result = g.result + ' (' + g.termination + ')';
    await signed(API + '/games/' + g.id + '/scoresheet', { result: result, chain_head: g.chain_head }, { action: 'scoresheet', game: g.id, result: result, plies: g.moves.length, chain_head: g.chain_head },
      'Optional. Signing says you accept this result and this move chain. If you do not sign, the result stands anyway.');
    say('Scoresheet signed.');
  }));

  // The page's own copy of the chain: recompute it, compare it with what this browser signed, flag any difference.
  async function checkChain(g) {
    var rec = me() ? await idbGet(keyId(g.id)) : null, checked = await chainProblems(g, rec && rec.signed), w = await walletGrantProblems(g), c = $('chain');
    var problems = checked.problems.concat(w.problems);
    c.className = problems.length ? 'err' : 'ok';
    c.textContent = problems.length
      ? 'Warning: this browser cannot verify the server copy of this game: ' + problems.join('; ')
      : 'Move chain checked in this browser: ' + g.moves.length + ' moves, every human move signed by its granted key.'
        + (checked.basis === 'verified' ? ' The result follows from the record.' : checked.basis === 'referee_attested' ? ' The result is a loss on time: the referee\'s word, which the signatures do not cover.' : '')
        + (w.notChecked ? ' The grants\' wallet signatures were not checked here (no wallet that can recover them).' : ' The grants\' wallet signatures check out.');
  }
  async function refresh() { S.game = await getJson(API + '/games/' + S.game.id); render(); await checkChain(S.game); }

  function fmt(ms) { if (ms == null) return '--:--'; var s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function showClocks() {
    if (!S.clock) return;
    var c = { w: S.clock.w, b: S.clock.b }, t = turn();
    if (S.game && S.game.status === 'live' && t) c[t] = S.clock[t] - (Date.now() - S.clock.at);
    var run = S.game && S.game.status === 'live' ? t : null; // refreshed on every event and click, not on a timer; the server clock is the one that counts
    $('cw').textContent = 'White ' + fmt(c.w) + (run === 'w' ? ' (running)' : ''); $('cb').textContent = 'Black ' + fmt(c.b) + (run === 'b' ? ' (running)' : '');
  }
  async function watch(id) {
    if (S.es) S.es.close();
    S.game = await getJson(API + '/games/' + id);
    S.sel = null; S.fen = null; $('moves').textContent = ''; $('result').textContent = '';
    if (myColor() && S.game.status !== 'finished') $('grant').disabled = !!(await idbGet(keyId(id)));
    await checkChain(S.game);
    var speed = myColor() && S.game.status === 'live' ? 'machine' : $('speed').value; // a player watches its own game at the head
    S.es = new EventSource(API + '/games/' + id + '/stream?speed=' + encodeURIComponent(speed));
    // At machine speed the stream is at the head, so a clock runs from the server's own timestamp.
    function since(at) { return speed === 'machine' && at ? Date.parse(at) : Date.now(); }
    S.es.addEventListener('start', function (e) { var d = JSON.parse(e.data); S.fen = d.fen; S.clock = { w: d.clock_ms.w, b: d.clock_ms.b, at: since(d.started_at) }; render(); });
    S.es.addEventListener('status', function () {
      refresh().then(function () { if (S.clock && S.game.started_at) S.clock.at = since(S.game.started_at); say(myTurn() ? 'The game is live. Your move.' : 'The game is ' + S.game.status + '.'); }).catch(function () {});
    });
    S.es.addEventListener('move', function (e) {
      var d = JSON.parse(e.data); S.fen = d.fen; S.clock = { w: d.clock_ms.w, b: d.clock_ms.b, at: since(d.at) };
      var li = document.createElement('li'); li.textContent = d.san + ' (' + d.uci + ')'; $('moves').appendChild(li);
      render();
      if (myColor()) refresh().then(function () { if (myTurn()) say('Your move.'); }).catch(function () {});
    });
    S.es.addEventListener('end', function (e) { var d = JSON.parse(e.data); $('result').textContent = 'Result: ' + (d.result || 'none') + ' (' + d.termination + ')'; S.es.close(); refresh().catch(function () {}); });
    say((S.game.status === 'pending' ? 'Waiting for the challenge to be accepted. ' : '') + 'Streaming at speed ' + speed + '.');
  }
  render();
  list('live').catch(function (e) { say(e.message, true); });
})();
`;
