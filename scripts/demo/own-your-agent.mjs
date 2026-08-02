#!/usr/bin/env node
/**
 * own-your-agent.mjs — the how-to video walkthrough, as a script that actually runs.
 *
 * The point is that the video is a REAL terminal recording, not a slide deck. So
 * this walks the owner journey against a live deployment and reports, per step,
 * whether it is filmable today:
 *
 *   LIVE       works right now, put it on camera
 *   FLAG OFF   built and inert, one env var away
 *   BLOCKED    a real gap; filming this step would mean faking it
 *
 * It never fakes a step to make the run look complete. A demo that quietly
 * simulates the hard part is exactly what this whole project argues against, and
 * on camera it becomes a claim.
 *
 *   npm run demo:own-agent
 *   API=http://localhost:3000 npm run demo:own-agent
 *   WALLET_KEY=0x… npm run demo:own-agent      # use a real account's wallet
 *
 * Read-only apart from the steps you explicitly enable. It signs messages (free,
 * moves nothing) and never sends a transaction.
 */
import { Wallet } from 'ethers';

const API = process.env.API ?? 'https://repid-engine-production.up.railway.app';
const BASE = `${API}/api/v1`;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

const steps = [];
function record(n, title, state, detail) {
  const badge = { LIVE: c.green('LIVE    '), 'FLAG OFF': c.yellow('FLAG OFF'), BLOCKED: c.red('BLOCKED ') }[state];
  console.log(`  ${badge}  ${c.bold(`${n}. ${title}`)}`);
  if (detail) console.log(`            ${c.dim(detail)}`);
  steps.push({ n, title, state, detail });
}

const authMessage = (method, path, wallet, timestamp) =>
  [
    'HyperDAG — authenticated request',
    `method: ${method.toUpperCase()}`,
    `path:   ${path}`,
    `wallet: ${wallet.toLowerCase()}`,
    `time:   ${timestamp}`,
  ].join('\n');

async function signedGet(wallet, path) {
  const ts = new Date().toISOString();
  const signature = await wallet.signMessage(authMessage('GET', `/api/v1${path}`, wallet.address, ts));
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-hd-wallet': wallet.address, 'x-hd-timestamp': ts, 'x-hd-signature': signature },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function main() {
  console.log(`\n${c.bold('Own your agent — the walkthrough, run for real')}`);
  console.log(c.dim(`against ${API}\n`));

  const wallet = process.env.WALLET_KEY ? new Wallet(process.env.WALLET_KEY) : Wallet.createRandom();
  console.log(c.dim(`  wallet ${wallet.address}${process.env.WALLET_KEY ? '' : '  (fresh — set WALLET_KEY to use a real account)'}\n`));

  // 0 — get an account at all. A walkthrough that opens with "first, email me"
  // is not a walkthrough.
  const ts0 = new Date().toISOString();
  const sig0 = await wallet.signMessage(authMessage('POST', '/api/v1/account/connect', wallet.address, ts0));
  const connect = await fetch(`${BASE}/account/connect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hd-wallet': wallet.address, 'x-hd-timestamp': ts0, 'x-hd-signature': sig0,
    },
    body: JSON.stringify({}),
  });
  record(
    0, 'Connect a wallet and get an account',
    connect.status === 503 ? 'FLAG OFF' : connect.ok ? 'LIVE' : 'BLOCKED',
    connect.status === 503
      ? 'SELF_SERVE_ACCOUNTS_ENABLED is off. Idempotent, and grants NO reputation — signing up cannot mint RepID or it would measure wallet creation instead of behaviour.'
      : connect.ok ? 'Account created from a wallet signature. No password, no email.' : `unexpected ${connect.status}`,
  );

  // 1 — identity. A signature, not a password and not a header.
  const probe = await signedGet(wallet, '/byok/keys');
  if (probe.status === 401) {
    record(1, 'Prove who you are', 'BLOCKED', `signature rejected: ${probe.body.error}`);
  } else if (probe.status === 403) {
    record(
      1, 'Prove who you are', 'FLAG OFF',
      'Signature VERIFIED — the wallet simply has no account yet, because step 0 is switched off. Enable it, or set WALLET_KEY to an existing account.',
    );
  } else {
    record(1, 'Prove who you are', 'LIVE', 'Signed a statement naming the method, path and time. No password, and no header anyone could copy.');
  }

  // 2 — bring your own keys.
  const providers = await get('/byok/providers');
  record(
    2, 'Bring your own keys',
    providers.body?.enabled ? 'LIVE' : 'FLAG OFF',
    `${providers.body?.providers?.length ?? 0} providers supported. Keys are verified against the provider before storage and never returned. ${
      providers.body?.enabled ? '' : 'BYOK_CUSTODY_ENABLED is off.'
    }`,
  );

  // 3 — how many INDEPENDENT opinions your keys buy. The number that decides
  // whether verification can actually overrule a confident wrong answer.
  if (probe.status === 200) {
    record(3, 'See how many independent opinions you can afford', 'LIVE', probe.body.note);
  } else {
    record(3, 'See how many independent opinions you can afford', 'FLAG OFF', 'Needs an account; the endpoint is live.');
  }

  // 4 — claim the agent. The signed statement is public and proves nothing on
  // its own, which is why it can be shown on camera.
  const msg = await get('/human/bind/message?wallet=0xYourWallet&agent_id=YOUR-AGENT-ID');
  record(
    4, 'Claim your agent',
    msg.status === 200 ? 'FLAG OFF' : 'BLOCKED',
    msg.status === 200
      ? 'The exact text to sign is public. The agent id is inside it, so a signature for one agent cannot claim another. HUMAN_AGENT_BIND_ENABLED is off.'
      : `unexpected ${msg.status}`,
  );

  // 5 — ownership is checkable by a stranger. No key, no account.
  const anyAgent = await get('/agents/00000000-0000-0000-0000-000000000000/owner');
  record(
    5, 'Anyone can check that it is yours',
    anyAgent.status === 200 ? 'LIVE' : 'BLOCKED',
    'Public, no API key. Distinguishes a PROVEN binding from a merely linked account — linked is not owned.',
  );

  // 6 — the exchange itself, already real.
  const stats = await get('/stats');
  record(
    6, 'Your agent hires another, and pays only after delivery is verified',
    stats.status === 200 ? 'LIVE' : 'BLOCKED',
    `${stats.body?.full_harness_loops ?? '?'} complete loops on record — settled contract AND real money, not just a settlement row.`,
  );

  // 7 — the receipt. The thing a viewer can paste to a sceptic.
  const receipt = await get('/receipt/latest.json');
  record(
    7, 'Share a receipt a sceptic can check',
    receipt.status === 200 ? 'LIVE' : 'BLOCKED',
    receipt.status === 200
      ? `contract ${String(receipt.body.contract_id).slice(0, 8)} · paid_before_delivery=${receipt.body.paid_before_delivery} · ${receipt.body.caveats?.length ?? 0} stated caveats`
      : `unexpected ${receipt.status}`,
  );

  const live = steps.filter((s) => s.state === 'LIVE').length;
  const off = steps.filter((s) => s.state === 'FLAG OFF').length;
  const blocked = steps.filter((s) => s.state === 'BLOCKED');

  console.log(`\n  ${c.bold('Filmable today')}: ${live} live, ${off} one flag away, ${blocked.length} blocked.`);
  if (blocked.length) {
    console.log(`  ${c.dim('Blocked steps would have to be faked to film, so they are named instead:')}`);
    for (const b of blocked) console.log(`    ${c.red('•')} ${b.title}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('walkthrough failed:', e?.message ?? String(e));
  process.exit(1);
});
