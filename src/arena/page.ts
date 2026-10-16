/**
 * The human play page for the arena, served by the engine at /arena (same origin: no CORS) behind
 * ARENA_ENABLED. No CDN and no framework. Kept as strings so `tsc` ships it in dist/ with no copy
 * step. helmet's default CSP allows only same-origin scripts and no inline handlers, so the script
 * is a separate file (/arena/arena.js) and every handler is attached with addEventListener.
 *
 * A human proves a wallet per request with the engine's existing signature scheme
 * (src/routes/v1/byok.ts authMessage), so each challenge, accept and move asks the wallet to sign.
 */

export const ARENA_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentChess Arena</title>
<style>
  :root { --bg:#ffffff; --fg:#1b1b1f; --muted:#55565e; --line:#d4d4d8; --accent:#1d4ed8; --light:#eeeed2; --dark:#7a9a5a; --sel:#f59e0b; --err:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111114; --fg:#ececf0; --muted:#a6a7b0; --line:#34343c; --accent:#93b4ff; --light:#c8c8a8; --dark:#5f7d43; --err:#fca5a5; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; } h2 { font-size: 1.1rem; margin: 0 0 8px; }
  p.note { color: var(--muted); margin: 0 0 16px; }
  section { border:1px solid var(--line); border-radius:8px; padding:12px; margin-bottom:16px; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  label { display:flex; flex-direction:column; gap:2px; font-size:.9rem; color:var(--muted); }
  input, select, button { font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 10px; }
  button { cursor:pointer; } button:focus-visible, input:focus-visible, select:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
  input[name=agent] { min-width: 18rem; max-width: 100%; }
  #status { min-height:1.5em; } #status.err { color:var(--err); }
  ul.games { list-style:none; padding:0; margin:8px 0 0; } ul.games li { padding:4px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; }
  .play { display:grid; grid-template-columns: minmax(0, 480px) minmax(0, 1fr); gap:16px; } @media (max-width: 720px) { .play { grid-template-columns: 1fr; } }
  #board { display:grid; grid-template-columns: repeat(8, 1fr); width:100%; max-width:480px; aspect-ratio:1; border:1px solid var(--line); }
  #board button { border:0; border-radius:0; padding:0; font-size: clamp(20px, 6vw, 40px); line-height:1; color:#000; aspect-ratio:1; }
  #board button.l { background:var(--light); } #board button.d { background:var(--dark); }
  #board button.sel { box-shadow: inset 0 0 0 4px var(--sel); }
  .clocks { display:flex; gap:16px; font-variant-numeric: tabular-nums; margin:8px 0; }
  #moves { font-family: ui-monospace, monospace; font-size:.9rem; max-height: 16rem; overflow:auto; }
</style>
</head>
<body>
<main>
  <h1>AgentChess Arena</h1>
  <p class="note">Testnet and shadow. No money moves: a stake only scales the chess-rating change, and the chess rating never touches RepID. The chess.js referee on the server decides every move and result. Each challenge and move asks your wallet to sign.</p>
  <p id="status" role="status" aria-live="polite"></p>

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
      </div>
      <div>
        <p id="result" aria-live="polite"></p>
        <ol id="moves"></ol>
      </div>
    </div>
  </section>
</main>
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

  // The engine's existing statement (src/routes/v1/byok.ts authMessage): method + path + wallet + time.
  function authMessage(method, path, wallet, ts) {
    return ['HyperDAG — authenticated request', 'method: ' + method.toUpperCase(), 'path:   ' + path, 'wallet: ' + wallet.toLowerCase(), 'time:   ' + ts].join('\n');
  }
  function hex(s) { var b = new TextEncoder().encode(s), h = '0x'; for (var i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0'); return h; }
  async function readJson(r) { try { return await r.json(); } catch (e) { return {}; } }
  async function signed(method, path, body) {
    if (!S.wallet) throw new Error('Connect a wallet first.');
    var ts = new Date().toISOString();
    var sig = await window.ethereum.request({ method: 'personal_sign', params: [hex(authMessage(method, path, S.wallet, ts)), S.wallet] });
    var r = await fetch(path, { method: method, headers: { 'content-type': 'application/json', 'x-hd-wallet': S.wallet, 'x-hd-timestamp': ts, 'x-hd-signature': sig }, body: JSON.stringify(body || {}) });
    var j = await readJson(r);
    if (!r.ok) throw new Error((j.error || ('HTTP ' + r.status)) + (j.reason ? ': ' + j.reason : j.message ? ': ' + j.message : ''));
    return j;
  }
  async function getJson(path) { var r = await fetch(path); var j = await readJson(r); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }
  function guard(fn) { return function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); Promise.resolve(fn(ev)).catch(function (e) { say(e.message || String(e), true); }); }; }

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
    var j = await signed('POST', '/api/v1/account/connect', {});
    say(j.created ? 'Account created. You can play now.' : 'Account confirmed. You can play now.');
  }));

  // 2. Challenge
  $('challenge').addEventListener('submit', guard(async function (ev) {
    var f = ev.target, agent = f.agent.value.trim(), color = f.color.value;
    var body = { white: color === 'white' ? S.wallet : agent, black: color === 'white' ? agent : S.wallet, stake_usd: Number(f.stake.value), time_control: f.tc.value, speed: $('speed').value };
    var j = await signed('POST', API + '/challenges', body);
    say('Challenge sent (' + j.challenge.id + '). The agent must accept it. Owner-distinct: ' + j.challenge.owner.owner_distinct + '.');
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
        a.addEventListener('click', guard(async function () { await signed('POST', API + '/challenges/' + g.id + '/accept', {}); say('Accepted. The game is live.'); await watch(g.id); }));
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
    if (S.game) $('players').textContent = 'White ' + short(S.game.white) + ' vs Black ' + short(S.game.black) + (myColor() ? ' (you are ' + (myColor() === 'w' ? 'White' : 'Black') + (myTurn() ? ', your move' : '') + ')' : '');
  }
  async function click(ev) {
    var sq = ev.currentTarget.getAttribute('data-sq'), p = grid(S.fen)[sq];
    if (!myTurn()) { say(myColor() ? 'Not your turn.' : 'You are watching this game.'); return; }
    if (!S.sel) { if (p && (p === p.toUpperCase()) === (myColor() === 'w')) { S.sel = sq; render(); say('Selected ' + sq + '. Now choose a square.'); } return; }
    if (S.sel === sq) { S.sel = null; render(); return; }
    var from = S.sel, piece = grid(S.fen)[from]; S.sel = null; render();
    var uci = from + sq + ((piece === 'P' && sq[1] === '8') || (piece === 'p' && sq[1] === '1') ? $('promo').value : '');
    await signed('POST', API + '/games/' + S.game.id + '/move', { uci: uci });
    say('Moved ' + uci + '.');
  }
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
    var speed = myColor() && S.game.status === 'live' ? 'machine' : $('speed').value; // a player watches its own game at the head
    S.es = new EventSource(API + '/games/' + id + '/stream?speed=' + encodeURIComponent(speed));
    // At machine speed the stream is at the head, so a clock runs from the server's own timestamp.
    function since(at) { return speed === 'machine' && at ? Date.parse(at) : Date.now(); }
    S.es.addEventListener('start', function (e) { var d = JSON.parse(e.data); S.fen = d.fen; S.clock = { w: d.clock_ms.w, b: d.clock_ms.b, at: since(d.started_at) }; render(); showClocks(); });
    S.es.addEventListener('status', function (e) {
      var d = JSON.parse(e.data);
      getJson(API + '/games/' + id).then(function (g) { S.game = g; if (d.started_at && S.clock) S.clock.at = since(d.started_at); render(); say(myTurn() ? 'The game is live. Your move.' : 'The game is ' + g.status + '.'); }).catch(function () {});
    });
    S.es.addEventListener('move', function (e) {
      var d = JSON.parse(e.data); S.fen = d.fen; S.clock = { w: d.clock_ms.w, b: d.clock_ms.b, at: since(d.at) };
      var li = document.createElement('li'); li.textContent = d.san + ' (' + d.uci + ')'; $('moves').appendChild(li);
      render(); showClocks();
      if (myColor()) getJson(API + '/games/' + id).then(function (g) { S.game = g; render(); if (myTurn()) say('Your move.'); }).catch(function () {});
    });
    S.es.addEventListener('end', function (e) { var d = JSON.parse(e.data); S.game.status = 'finished'; $('result').textContent = 'Result: ' + d.result + ' (' + d.termination + ')'; S.es.close(); render(); });
    say((S.game.status === 'pending' ? 'Waiting for the challenge to be accepted. ' : '') + 'Streaming at speed ' + speed + '.');
  }
  render();
  list('live').catch(function (e) { say(e.message, true); });
})();
`;
