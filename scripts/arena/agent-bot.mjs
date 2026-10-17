#!/usr/bin/env node
// agent-bot.mjs — the smallest agent that can sit at an AgentChess arena board.
//
//   ARENA_AGENT_KEY=<agent api key> node scripts/arena/agent-bot.mjs --agent <agent uuid> [--base https://repid-engine-production.up.railway.app]
//
// It accepts every pending challenge addressed to its agent and, whenever it is that agent's move,
// plays a uniformly random move from the server's own `legal_uci` list. It never judges legality
// itself (the server's chess.js referee does) and holds no wallet. Testnet + shadow: nothing it
// does moves money or RepID. Stop it with Ctrl-C. The key is read from the environment so it
// never lands in shell history or a process list.
const argv = process.argv.slice(2), arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const BASE = arg('base', 'https://repid-engine-production.up.railway.app').replace(/\/$/, '') + '/api/v1/arena';
const AGENT = String(arg('agent', '')).toLowerCase(), KEY = process.env.ARENA_AGENT_KEY;
if (!/^[0-9a-f-]{36}$/.test(AGENT) || !KEY) { console.error('usage: ARENA_AGENT_KEY=<key> node scripts/arena/agent-bot.mjs --agent <uuid>'); process.exit(2); }
const ME = `agent:${AGENT}`, H = { 'content-type': 'application/json', 'x-api-key': KEY };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${j.error ?? ''} ${j.reason ?? j.message ?? ''}`.trim());
  return j;
}

for (;;) {
  try {
    for (const g of (await call('GET', `/games?status=pending&participant=${ME}`)).games)
      if (g.challenger !== ME) { await call('POST', `/challenges/${g.id}/accept`); console.log(`accepted ${g.id}: ${g.white} vs ${g.black}`); }
    for (const { id } of (await call('GET', `/games?status=live&participant=${ME}`)).games) {
      const g = await call('GET', `/games/${id}`);
      if (g.status !== 'live' || g[g.turn] !== ME || !g.legal_uci.length) continue;
      const uci = g.legal_uci[Math.floor(Math.random() * g.legal_uci.length)];
      const after = (await call('POST', `/games/${id}/move`, { uci })).game;
      console.log(`${id} ply ${after.moves.length}: ${uci}${after.result ? `  -> ${after.result} (${after.termination})` : ''}`);
    }
  } catch (e) {
    console.error(String(e.message ?? e));
  }
  await sleep(3000);
}
