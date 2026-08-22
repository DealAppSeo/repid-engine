#!/usr/bin/env node
/**
 * sprint-daemon.mjs — keep the lanes moving while nobody is watching.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE PROBLEM IT SOLVES
 * ════════════════════════════════════════════════════════════════════════════════
 * A Claude session can reach the database but not the model CLIs. A dispatcher
 * can reach the CLIs but is not always running, and the person who owns both is
 * usually doing something else. So work that existed sat unstarted, and agents
 * that had plenty to do looked idle.
 *
 * `agent_dispatch_queue` is the bus between the two halves. Claude writes a
 * brief; this daemon dispatches it whenever it happens to be up, writes the
 * handoff back, and queues the next phase itself. Neither side has to be awake at
 * the same time as the other, and neither has to hold state in its head.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * IT SELF-CHAINS, WHICH IS WHY THE GUARDS ARE NOT OPTIONAL
 * ════════════════════════════════════════════════════════════════════════════════
 * This process decides on its own to spend money on a paid model, repeatedly,
 * with nobody watching. That is a genuinely dangerous shape, and every guard here
 * exists because of a specific way it goes wrong:
 *
 *   - **Ships OFF.** `agent_dispatch_enabled` defaults to `false`. An autonomous
 *     loop that spends money should be switched on deliberately, never by the act
 *     of deploying it.
 *   - **The switch is read every cycle, from the database.** Not captured at
 *     start-up, and not a local file. The situation you build a kill switch for
 *     is the one where you cannot reach the machine — a switch that requires
 *     shell access to the runaway is not a kill switch.
 *   - **Fails closed.** A missing, unparseable or absent switch means STOP. The
 *     dangerous default is the silent yes.
 *   - **Rate ceiling**, also from live config, bounding dispatches per hour across
 *     all agents even if every other guard is somehow passed.
 *   - **A phase that does not advance halts that sprint**, so a confused agent
 *     cannot be re-dispatched with the same input all night.
 *   - **Attempts are counted and bounded**, so a row that fails to dispatch does
 *     not spin.
 *
 * It adds no capability. Dispatch still goes through `run-agent.mjs`, which keeps
 * refusing `main`, refusing a dirty tree, never committing, never pushing, and
 * enforcing its own timeout. This file decides only WHEN and WHAT.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * USAGE
 * ════════════════════════════════════════════════════════════════════════════════
 *   node scripts/dispatch/sprint-daemon.mjs                # poll forever
 *   node scripts/dispatch/sprint-daemon.mjs --once         # one cycle, then exit
 *   node scripts/dispatch/sprint-daemon.mjs --dry-run      # claim nothing, run nothing
 *   node scripts/dispatch/sprint-daemon.mjs --interval 120 # seconds between polls
 *
 * Turn it on:   update repid_config set value='true'  where key='agent_dispatch_enabled';
 * Turn it off:  update repid_config set value='false' where key='agent_dispatch_enabled';
 *
 * Requires the same environment `run-agent.mjs` needs (`.env.master` for the
 * provider key) plus `SUPABASE_URL` and a service key.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';

const require_ = createRequire(import.meta.url);
const { extractHandoff, handoffField, decideNext, buildDispatchText } = require_('./sprint-lib.js');
const { readFileSync, existsSync } = require_('node:fs');

const RUNNER = 'scripts/dispatch/run-agent.mjs';
const QUEUE = 'agent_dispatch_queue';
const MAX_PHASES = 8;
const MAX_ATTEMPTS = 2;

const flag = (n) => process.argv.includes(`--${n}`);
function arg(n, d = null) {
  const i = process.argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : d;
}

function db() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and a service key are required');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function readGuards(sb) {
  const { data } = await sb
    .from('repid_config')
    .select('key, value')
    .in('key', ['agent_dispatch_enabled', 'agent_dispatch_max_per_hour']);
  const m = new Map((data ?? []).map((r) => [r.key, r.value]));
  const sinceIso = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await sb
    .from(QUEUE)
    .select('id', { count: 'exact', head: true })
    .gte('dispatched_at', sinceIso);
  return {
    enabledRaw: m.get('agent_dispatch_enabled'),
    maxPerHourRaw: m.get('agent_dispatch_max_per_hour'),
    dispatchedLastHour: count ?? 0,
  };
}

/**
 * Claim the oldest queued row.
 *
 * The claim is a conditional UPDATE — `eq('status','QUEUED')` — so two daemons
 * racing cannot both win the same row. Selecting and then updating would let
 * both dispatch it, which is one piece of work billed twice.
 */
async function claim(sb) {
  const { data: candidates } = await sb
    .from(QUEUE)
    .select('*')
    .eq('status', 'QUEUED')
    .order('queued_at', { ascending: true })
    .limit(1);
  const row = candidates?.[0];
  if (!row) return null;

  const { data: claimed } = await sb
    .from(QUEUE)
    .update({ status: 'DISPATCHED', dispatched_at: new Date().toISOString(), attempts: row.attempts + 1 })
    .eq('id', row.id)
    .eq('status', 'QUEUED')
    .select()
    .maybeSingle();
  return claimed ?? null;
}

function dispatch(agent, text, timeoutMs) {
  const inbox = `.sprint-state/outbox/${agent}-queue.md`;
  require_('node:fs').mkdirSync('.sprint-state/outbox', { recursive: true });
  require_('node:fs').writeFileSync(inbox, text, 'utf8');
  const r = spawnSync(
    process.execPath,
    [RUNNER, '--agent', agent, '--inbox', inbox, '--requires', 'reasoning,repo_read'],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
  );
  if (r.error) return { ok: false, output: r.stdout ?? '', error: String(r.error) };
  return { ok: r.status === 0, output: r.stdout ?? '', error: r.stderr ?? '' };
}

async function cycle(sb, { dryRun, timeoutMs }) {
  const guards = await readGuards(sb);
  const verdict = require_('./sprint-lib.js').shouldDispatch(guards);
  if (!verdict.ok) {
    console.log(`[daemon] idle — ${verdict.reason}`);
    return { dispatched: false };
  }

  const row = dryRun
    ? (await sb.from(QUEUE).select('*').eq('status', 'QUEUED').order('queued_at').limit(1)).data?.[0]
    : await claim(sb);

  if (!row) {
    console.log('[daemon] queue empty');
    return { dispatched: false };
  }
  if (dryRun) {
    console.log(`[daemon] DRY RUN — would dispatch ${row.agent} ${row.sprint} phase ${row.phase} (${row.dispatch_text.length} chars)`);
    return { dispatched: false };
  }
  if (row.attempts > MAX_ATTEMPTS) {
    await sb.from(QUEUE).update({ status: 'FAILED', error: `exceeded ${MAX_ATTEMPTS} attempts`, completed_at: new Date().toISOString() }).eq('id', row.id);
    console.log(`[daemon] ${row.agent} phase ${row.phase}: FAILED — too many attempts`);
    return { dispatched: false };
  }

  console.log(`[daemon] dispatching ${row.agent} ${row.sprint} phase ${row.phase} (${verdict.remaining} left this hour)`);
  const res = dispatch(row.agent, row.dispatch_text, timeoutMs);
  const handoff = extractHandoff(res.output);

  if (!handoff) {
    // Back to QUEUED for one more try if attempts remain — a transient CLI
    // failure is not the same as an agent that cannot do the work. Beyond that
    // it is FAILED, because retrying a real failure forever is the runaway.
    const status = row.attempts >= MAX_ATTEMPTS ? 'FAILED' : 'QUEUED';
    await sb.from(QUEUE).update({
      status,
      error: (res.error || 'no handoff block in output').slice(0, 2000),
      ...(status === 'FAILED' ? { completed_at: new Date().toISOString() } : {}),
    }).eq('id', row.id);
    console.log(`[daemon] ${row.agent} phase ${row.phase}: no handoff → ${status}`);
    return { dispatched: true };
  }

  const hStatus = handoffField(handoff.body, 'STATUS');
  await sb.from(QUEUE).update({
    status: hStatus === 'BLOCKED' ? 'BLOCKED' : 'COMPLETE',
    handoff_body: handoff.body,
    handoff_status: hStatus,
    next_phase_ready: Number(String(handoffField(handoff.body, 'NEXT_PHASE_READY') ?? '').match(/\d+/)?.[0]) || null,
    completed_at: new Date().toISOString(),
  }).eq('id', row.id);
  console.log(`[daemon] ${row.agent} phase ${handoff.phase}: ${hStatus ?? '?'}`);

  // Self-chain, using the SAME decision function the interactive runner uses, so
  // there is no second copy of "should this continue" to disagree with.
  const decision = decideNext(handoff, row.phase, MAX_PHASES);
  if (decision.action !== 'continue') {
    console.log(`[daemon] ${row.agent} ${row.sprint}: sprint stops — ${decision.reason}`);
    return { dispatched: true };
  }

  const brief = row.brief_path && existsSync(row.brief_path) ? readFileSync(row.brief_path, 'utf8') : '';
  // The counterpart's latest requirements, so the lanes keep converging.
  const { data: other } = await sb
    .from(QUEUE)
    .select('handoff_body, agent')
    .eq('sprint', row.sprint)
    .neq('agent', row.agent)
    .eq('status', 'COMPLETE')
    .order('completed_at', { ascending: false })
    .limit(1);
  const counterpartRequirements = other?.[0]?.handoff_body
    ? require_('./sprint-lib.js').handoffList(other[0].handoff_body, `REQUIREMENTS_ON_${row.agent.toUpperCase()}`)
    : [];

  await sb.from(QUEUE).insert({
    agent: row.agent,
    sprint: row.sprint,
    phase: decision.nextPhase,
    brief_path: row.brief_path,
    dispatch_text: buildDispatchText(brief, { handoffBody: handoff.body, counterpartRequirements }),
    status: 'QUEUED',
  });
  console.log(`[daemon] queued ${row.agent} phase ${decision.nextPhase}${counterpartRequirements.length ? ` (+${counterpartRequirements.length} cross-lane)` : ''}`);
  return { dispatched: true };
}

async function main() {
  const sb = db();
  const dryRun = flag('dry-run');
  const timeoutMs = Number(arg('timeout-ms', '900000'));
  const intervalMs = Number(arg('interval', '90')) * 1000;

  if (flag('once')) {
    await cycle(sb, { dryRun, timeoutMs });
    return;
  }
  console.log(`[daemon] polling every ${intervalMs / 1000}s — flip agent_dispatch_enabled to stop`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await cycle(sb, { dryRun, timeoutMs });
    } catch (e) {
      // A cycle that throws must not kill the daemon; the next poll re-reads the
      // kill switch, which is the thing that has to keep working.
      console.error(`[daemon] cycle error: ${e?.message ?? e}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main().catch((e) => {
  console.error(`[daemon] ${e?.message ?? e}`);
  process.exit(1);
});
