#!/usr/bin/env node
/**
 * trust-chain-probe — read-only instrument for the MVP sentence.
 *
 *   "A human stakes testnet USDC. That stake is a hard limit on the total spend of every agent
 *    bound to that human. Two agents cannot both spend it. Every transaction moves the RepID of
 *    the human, the agent, and HAL."
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * IT WRITES NOTHING. ON PURPOSE.
 *
 * Every leg is a SELECT or an unauthenticated GET. It creates no binding, posts no deposit and
 * requests no payment — so it is safe to run against production on any branch, by anyone, at
 * any time, which is the only way an instrument gets run often enough to be worth having.
 *
 * Making the first real binding and the first real deposit are separate, signed, human-gated
 * acts. This tells you whether they have happened and what the system does about it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * IT IS BUILT TO REPORT RED ON THE THING THAT MATTERS MOST
 *
 * The concurrency leg cannot pass today and the probe says so in its own state. `daily_used` is
 * summed from `x402_payment_gates WHERE authorized = true`, and the insert creating that row is
 * fire-and-forget (`void db...insert(...)`, never awaited) so the gate can answer "authorized"
 * before the row is durable. Two in-flight calls read the same total and both pass.
 *
 * That is not fixable by awaiting the insert. Two transactions can still both decide before
 * either row lands. It needs a reservation whose write IS the authorisation. Until that exists
 * this leg is EXPECTED_FAIL — which does not fail the run, and which flips to a loud
 * EXPECTED_FAIL_NOW_PASSING if it ever starts working, because then this file is the stale one.
 *
 * Usage:
 *   node scripts/e2e/trust-chain-probe.mjs [--builder <uuid>] [--agent <name>] [--json]
 *
 * Exit: 0 VERIFIED · 2 NOT_CHECKED (incl. blocked legs) · 1 FAILED.
 */
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;
const ENGINE = (process.env.REPID_ENGINE_URL || 'https://repid-engine-production.up.railway.app').replace(/\/+$/, '');

const JSON_OUT = process.argv.includes('--json');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v && !v.startsWith('--') ? v : d;
};

async function rest(path) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`PostgREST ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function engine(path) {
  const res = await fetch(`${ENGINE}${path}`);
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  const { scoreChain, blocked, expectedFail, tierBypassesStake } = require_('../../dist/e2e/trust-chain.js');
  const legs = [];
  const add = (l) => { legs.push(l); return l; };
  const passed = (id) => legs.find((l) => l.id === id)?.status === 'PASS';

  // ── 0. Can we look at all? ───────────────────────────────────────────────────────────────
  if (!URL_BASE || !KEY) {
    add({ id: 'db', says: 'this probe can read the database', status: 'NOT_CHECKED',
          detail: 'no Supabase credential in this environment — nothing below was observed. ' +
                  'This says nothing about whether the product works.' });
    return report(scoreChain(legs));
  }
  add({ id: 'db', says: 'this probe can read the database', status: 'PASS', detail: 'PostgREST reachable.' });

  // ── 1. A human account exists ────────────────────────────────────────────────────────────
  const humans = await rest('repid_agents?select=id,agent_name,builder_id,tier,current_repid&is_human=is.true&limit=5');
  add(humans.length
    ? { id: 'human', says: 'a human RepID account exists', status: 'PASS',
        detail: `${humans.length} is_human agent(s); e.g. ${humans[0].agent_name} tier=${humans[0].tier} repid=${humans[0].current_repid}` }
    : { id: 'human', says: 'a human RepID account exists', status: 'FAILED', detail: 'no repid_agents row has is_human = true.' });

  // ── 2. A human is BOUND to an agent (signed ownership, not the admin builder_id link) ────
  const binds = await rest('human_agent_bindings?select=builder_id,owner_kind,bound_at&limit=5');
  add(binds.length
    ? { id: 'bind', says: 'a human is bound to an agent by signature', status: 'PASS',
        detail: `${binds.length} binding row(s); newest owner_kind=${binds[0].owner_kind}` }
    : { id: 'bind', says: 'a human is bound to an agent by signature', status: 'FAILED',
        detail: 'human_agent_bindings is EMPTY. The flag reads on and the route exists — nothing ' +
                'has ever called it. An empty table under a live flag is not a working feature.' });

  // ── 3. Real, non-simulated collateral is posted ─────────────────────────────────────────
  const deps = await rest('stake_deposits?select=builder_id,amount,status,is_simulated');
  const real = deps.filter((d) => d.is_simulated !== true && d.status === 'active');
  const sim = deps.filter((d) => d.is_simulated === true);
  add(real.length
    ? { id: 'deposit', says: 'real testnet USDC is staked', status: 'PASS',
        detail: `${real.length} real active deposit(s), ${sim.length} simulated excluded` }
    : { id: 'deposit', says: 'real testnet USDC is staked', status: 'FAILED',
        detail: `0 real active deposits (${sim.length} simulated, which must never back authority). ` +
                'A simulated deposit leaving the gate at insufficient_stake is CORRECT, not a bug.' });

  // ── 4. The chain closes: one builder both OWNS an agent and HOLDS real collateral ────────
  // Grok's sharpest point: a binding with no matching real deposit still denies. This is the
  // leg that distinguishes "bound" from "funded", and it is the one the demo actually needs.
  if (!passed('bind') || !passed('deposit')) {
    add(blocked('chain', 'the staking human owns the spending agent', !passed('bind') ? 'bind' : 'deposit'));
  } else {
    const owners = await rest('repid_agents?select=agent_name,builder_id&builder_id=not.is.null');
    const realBuilders = new Set(real.map((d) => d.builder_id));
    const closed = owners.filter((a) => realBuilders.has(a.builder_id));
    add(closed.length
      ? { id: 'chain', says: 'the staking human owns the spending agent', status: 'PASS',
          detail: `${closed.length} agent(s) whose builder holds REAL collateral` }
      : { id: 'chain', says: 'the staking human owns the spending agent', status: 'FAILED',
          detail: 'no agent’s builder_id matches a builder with a real deposit. Binding and staking ' +
                  'both exist but not on the same human, so the cap can never bind.' });
  }

  // ── 5. What the gate is actually deciding ───────────────────────────────────────────────
  const gates = await rest('x402_payment_gates?select=agent_name,amount_usdc,stake_available,authorized,denial_reason,requested_at&order=requested_at.desc&limit=20');
  const denied = gates.filter((g) => !g.authorized);
  add(gates.length
    ? { id: 'gate', says: 'the spend gate is live and deciding', status: 'PASS',
        detail: `${gates.length} recent decision(s); ${denied.length} denied; newest ` +
                `${gates[0].denial_reason ?? 'AUTHORIZED'} at ${gates[0].requested_at}` }
    : { id: 'gate', says: 'the spend gate is live and deciding', status: 'NOT_CHECKED',
        detail: 'no rows in x402_payment_gates — the gate may be fine and simply unused.' });

  // ── 6. THE CONCURRENCY INVARIANT — cannot pass today, and says so in its own state ───────
  add(expectedFail({
    id: 'concurrency',
    says: 'two bound agents cannot both spend the same stake',
    ref: 'x402-gate.ts — daily_used sums a fire-and-forget audit insert',
    stillBroken: true,
    detail:
      'NOT ENFORCEABLE as built: daily_used is summed from x402_payment_gates WHERE authorized, ' +
      'and that row is inserted with `void db...insert(...)` — never awaited. The gate answers ' +
      'before the row is durable, so two in-flight calls read the same total and both authorise. ' +
      'Awaiting the insert does NOT fix it: two transactions can still both decide first. It needs ' +
      'a reservation whose write IS the authorisation.',
  }));

  // ── 7. The latent tier bypass — green today, and green is the finding ────────────────────
  const tiers = await rest('repid_agents?select=tier');
  const bypassing = tiers.filter((t) => tierBypassesStake(t.tier));
  add(bypassing.length === 0
    ? { id: 'tier-bypass', says: 'no agent sits in a tier that ignores stake', status: 'PASS',
        detail: 'AUTONOMOUS and VETERAN carry requires_stake:false (their stake_available becomes ' +
                'the RepID score, not money). 0 agents occupy them — the counterparty gate demotes ' +
                'anything without 2 counterparties. Unreachable TODAY; opens with no announcement ' +
                'the moment one agent earns a second counterparty.' }
    : { id: 'tier-bypass', says: 'no agent sits in a tier that ignores stake', status: 'FAILED',
        detail: `${bypassing.length} agent(s) in AUTONOMOUS/VETERAN can now spend on reputation ` +
                'alone, with no collateral. The stake ceiling no longer binds for them.' });

  // ── 8. RepID moves for BOTH sides ────────────────────────────────────────────────────────
  const ev = await rest('repid_score_events?select=id,created_at&order=created_at.desc&limit=1');

  // The human-side read is kept SEPARABLE from its verdict on purpose.
  //
  // This leg first shipped as `.catch(() => [])` feeding `humanEv.length ? PASS : APPROXIMATE`,
  // so a query that FAILED produced an empty array and was then reported as "no human-side
  // events" — a failed read scored as a measured negative, in the harness whose entire job is
  // to stop exactly that. `null` here means NOT_CHECKED and can never be counted as zero.
  //
  // It also joined on the wrong column. `repid_score_events.agent_id` is `repid_agents.id`;
  // the first version filtered on `builder_id ?? agent_name`, which matches nothing, so it
  // would have reported "no human events" against a table that has them.
  let humanEv = null;
  try {
    const ids = humans.map((h) => h.id).filter(Boolean).map((v) => encodeURIComponent(v));
    if (ids.length) humanEv = await rest(`repid_score_events?select=id&agent_id=in.(${ids.join(',')})&limit=1`);
  } catch {
    humanEv = null; // read failed — NOT the same as "none found"
  }

  if (!ev.length) {
    add({ id: 'repid', says: 'transactions move RepID', status: 'FAILED', detail: 'no score events at all.' });
  } else if (humanEv === null) {
    add({ id: 'repid', says: 'transactions move RepID', status: 'NOT_CHECKED',
          detail: `newest score event ${ev[0].created_at}, but the human-side read did not complete. ` +
                  'This says nothing about whether human RepID moves — it is an absence, not a negative.' });
  } else {
    add({ id: 'repid', says: 'transactions move RepID', status: humanEv.length ? 'PASS' : 'APPROXIMATE',
          detail: humanEv.length
            ? `newest score event ${ev[0].created_at}; human-side events present`
            : `newest score event ${ev[0].created_at}, but none attributable to a human account — ` +
              'agent-side only, so "moves the human\'s RepID" is unproven.' });
  }

  // ── 9. HAL answers with named providers ──────────────────────────────────────────────────
  const health = await engine('/health');
  add(health.ok
    ? { id: 'hal', says: 'HAL is reachable inside the harness', status: 'PASS',
        detail: `engine /health 200, commit ${health.body?.deployed_commit_short ?? '?'}` }
    : { id: 'hal', says: 'HAL is reachable inside the harness', status: 'NOT_CHECKED',
        detail: `engine /health unreachable from here (status ${health.status}) — says nothing about the service.` });

  return report(scoreChain(legs));
}

const GLYPH = {
  PASS: '✓', FAILED: '✗', NOT_CHECKED: '·', APPROXIMATE: '~',
  EXPECTED_FAIL: '▲', EXPECTED_FAIL_NOW_PASSING: '!', BLOCKED: '–',
};

function report(v) {
  if (JSON_OUT) { console.log(JSON.stringify(v, null, 2)); return v.exitCode; }
  console.log('\nTRUST CHAIN — a human stakes, their agents spend within it, RepID moves.\n');
  for (const l of v.legs) {
    console.log(`  ${GLYPH[l.status] ?? '?'} ${l.status.padEnd(26)} ${l.says}`);
    console.log(`      ${l.detail}`);
    if (l.ref) console.log(`      ref: ${l.ref}`);
    console.log('');
  }
  console.log(`  ${v.summary}`);
  console.log(`  exit ${v.exitCode} (0 VERIFIED · 2 NOT_CHECKED · 1 FAILED)\n`);
  return v.exitCode;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error(`trust-chain-probe — FAILED: ${e.message}`);
  process.exit(1);
});
