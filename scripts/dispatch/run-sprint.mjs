#!/usr/bin/env node
/**
 * run-sprint.mjs — drive a multi-phase INBOX sprint to completion, unattended.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS ACTUALLY MISSING
 * ════════════════════════════════════════════════════════════════════════════════
 * `run-agent.mjs` dispatches ONE phase. The looping briefs
 * (`INBOX_XC_TRUSTLOOP.md`, `INBOX_GA_TRUSTLOOP.md`) are four-phase sprints whose
 * only state carrier is a `=== HANDOFF ... ===` block the agent prints at the end
 * of its output — *"it is the only thing that carries state between dispatches,
 * there is no memory."*
 *
 * So between every phase a human had to: read the output, find the handoff, paste
 * it into the next dispatch, and remember which phase came next. Four phases per
 * agent, two agents, and a cross-lane requirement to hand-carry in both
 * directions. **That is the bottleneck, and it is clerical.** An agent that is
 * "idle" is almost never out of work; it is waiting for someone to paste.
 *
 * This is the loop. One command runs a sprint to its end.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE CROSS-FEED — the part that makes them collaborate rather than merely run
 * ════════════════════════════════════════════════════════════════════════════════
 * Both briefs define a lane split and ask each agent to record what it needs from
 * the other: XC emits `REQUIREMENTS_ON_GA`, GA emits `REQUIREMENTS_ON_XC`.
 * Nothing carried those. They were written into transcripts and read by nobody,
 * which is the same failure as queuing work and calling it dispatch.
 *
 * When run with both agents, each dispatch carries the counterpart's latest
 * requirements. That is the whole mechanism by which two lanes with no shared
 * memory and no write scope can converge instead of drifting.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY IT REFUSES RATHER THAN RETRIES
 * ════════════════════════════════════════════════════════════════════════════════
 * Every halt condition here exists because the alternative is a loop that burns
 * tokens producing nothing while looking busy:
 *
 *   - no handoff block            → the agent did not complete a phase. Halt.
 *   - phase did not advance       → re-running the same phase forever. Halt.
 *   - STATUS: BLOCKED             → the agent said it cannot proceed. Halt.
 *   - phase ceiling reached       → runaway guard, independent of the above.
 *
 * A run that stops with a reason is worth more than one that keeps going. The
 * failure this prevents is the overnight loop that produces forty transcripts of
 * phase 1.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IT DOES NOT DO
 * ════════════════════════════════════════════════════════════════════════════════
 * It adds no capability and relaxes no fence. It shells out to `run-agent.mjs`,
 * which keeps every guarantee it already makes — refuses `main`, refuses a dirty
 * tree, never commits, never pushes, hard timeout, scrubbed transcript. This file
 * decides only WHAT TO SEND NEXT.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * USAGE
 * ════════════════════════════════════════════════════════════════════════════════
 *   node scripts/dispatch/run-sprint.mjs \
 *     --agent xc --brief docs/dispatch/INBOX_XC_TRUSTLOOP.md
 *
 *   # both lanes, cross-feeding requirements each round:
 *   node scripts/dispatch/run-sprint.mjs \
 *     --pair xc=docs/dispatch/INBOX_XC_TRUSTLOOP.md,ga=docs/dispatch/INBOX_GA_TRUSTLOOP.md
 *
 *   --max-phases N   ceiling (default 4)
 *   --state PATH     resume file (default .sprint-state/<agent>.json)
 *   --dry-run        print what would be dispatched, run nothing
 *
 * Resume is automatic: the state file records the last completed phase and the
 * handoff, so a crashed or interrupted run continues instead of restarting.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// The pure decisions live in a CommonJS sibling so the test suite can load them;
// see the header of sprint-lib.js for why a second copy was not acceptable.
const { extractHandoff, handoffField, handoffList, decideNext, buildDispatchText, parsePair } =
  createRequire(import.meta.url)('./sprint-lib.js');

const RUNNER = 'scripts/dispatch/run-agent.mjs';
const DEFAULT_MAX_PHASES = 4;
const DEFAULT_STATE_DIR = '.sprint-state';

/* ─────────────────────────── state ─────────────────────────── */

export function loadState(path) {
  if (!existsSync(path)) return { completedPhase: 0, handoffBody: null, history: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A corrupt state file must not silently restart the sprint at phase 1 and
    // spend a full run rediscovering what is already known.
    throw new Error(`state file ${path} is unreadable — inspect or delete it deliberately`);
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
}

/* ─────────────────────────── the loop ─────────────────────────── */

function dispatch(agent, text, { dryRun, timeoutMs }) {
  const tmpDir = join(DEFAULT_STATE_DIR, 'outbox');
  mkdirSync(tmpDir, { recursive: true });
  const inbox = join(tmpDir, `${agent}-dispatch.md`);
  writeFileSync(inbox, text, 'utf8');

  if (dryRun) {
    console.log(`[sprint] DRY RUN — would dispatch ${agent} with ${text.length} chars (${inbox})`);
    return { ok: true, output: '' };
  }

  const r = spawnSync(
    process.execPath,
    [RUNNER, '--agent', agent, '--inbox', inbox, '--requires', 'reasoning,repo_read'],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
  );
  // A non-zero exit is reported, not swallowed. The output is still returned:
  // an agent that produced a handoff and then exited badly has still done the work.
  if (r.error) return { ok: false, output: r.stdout ?? '', error: String(r.error) };
  return { ok: r.status === 0, output: r.stdout ?? '', error: r.stderr ?? '' };
}

async function runSprint({ agents, maxPhases, dryRun, stateDir, timeoutMs }) {
  const state = {};
  for (const a of agents) {
    state[a.key] = loadState(a.statePath ?? join(stateDir, `${a.key}.json`));
  }

  let round = 0;
  const active = new Set(agents.map((a) => a.key));

  while (active.size && round < maxPhases + 1) {
    round++;
    for (const a of agents) {
      if (!active.has(a.key)) continue;
      const st = state[a.key];
      const phase = st.completedPhase + 1;
      if (phase > maxPhases) {
        console.log(`[sprint] ${a.key}: phase ceiling reached (${maxPhases}) — done`);
        active.delete(a.key);
        continue;
      }

      // The counterpart's requirements, as of its most recent completed phase.
      const other = agents.find((x) => x.key !== a.key);
      const counterpartRequirements =
        other && state[other.key].handoffBody
          ? handoffList(state[other.key].handoffBody, `REQUIREMENTS_ON_${a.key.toUpperCase()}`)
          : [];

      const text = buildDispatchText(readFileSync(a.brief, 'utf8'), {
        handoffBody: st.handoffBody,
        counterpartRequirements,
      });

      console.log(`[sprint] ${a.key}: dispatching phase ${phase}${counterpartRequirements.length ? ` (+${counterpartRequirements.length} cross-lane)` : ''}`);
      const res = dispatch(a.key, text, { dryRun, timeoutMs });
      if (dryRun) {
        active.delete(a.key);
        continue;
      }

      const handoff = extractHandoff(res.output);
      const decision = decideNext(handoff, phase, maxPhases);

      if (handoff) {
        st.completedPhase = handoff.phase;
        st.handoffBody = handoff.body;
        st.history.push({ phase: handoff.phase, status: handoffField(handoff.body, 'STATUS') });
        saveState(a.statePath ?? join(stateDir, `${a.key}.json`), st);
        console.log(`[sprint] ${a.key}: phase ${handoff.phase} ${handoffField(handoff.body, 'STATUS') ?? '?'}`);
      }

      if (decision.action === 'halt') {
        console.log(`[sprint] ${a.key}: STOP — ${decision.reason}`);
        if (!res.ok && res.error) console.error(`[sprint] ${a.key}: runner stderr: ${String(res.error).slice(0, 400)}`);
        active.delete(a.key);
      }
    }
  }
  console.log('[sprint] all lanes finished');
}

/* ─────────────────────────── cli ─────────────────────────── */

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);


async function main() {
  const pair = arg('pair');
  const agents = pair
    ? parsePair(pair)
    : [{ key: arg('agent'), brief: arg('brief') }];

  for (const a of agents) {
    if (!a.key || !a.brief) {
      console.error('usage: --agent <key> --brief <path>   |   --pair xc=<path>,ga=<path>');
      process.exit(2);
    }
    if (!existsSync(a.brief)) {
      console.error(`brief not found: ${a.brief}`);
      process.exit(2);
    }
  }

  const stateDir = arg('state-dir', DEFAULT_STATE_DIR);
  const maxPhases = Number(arg('max-phases', String(DEFAULT_MAX_PHASES)));
  const timeoutMs = Number(arg('timeout-ms', '900000'));

  await runSprint({ agents, maxPhases, dryRun: flag('dry-run'), stateDir, timeoutMs });
}

// Only run when invoked directly, so the pure helpers above stay importable.
if (process.argv[1] && process.argv[1].endsWith('run-sprint.mjs')) {
  main().catch((e) => {
    console.error(`[sprint] ${e?.message ?? e}`);
    process.exit(1);
  });
}
