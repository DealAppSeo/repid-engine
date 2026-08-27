#!/usr/bin/env node
/**
 * SessionStart hook — put the fleet's CURRENT state in front of the session,
 * or say plainly that it could not be read.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * On 2026-08-27 a session spent most of its budget answering "are the agents
 * awake?" and got it wrong twice, in both directions:
 *
 *   - It repeated an index entry reading "the Trinity fleet is DOWN on Railway,
 *     manual redeploy required." That entry had stood for twelve days. The
 *     fleet was up the whole time; a redeploy would have fixed nothing and
 *     would have looked like a fix.
 *   - It then nearly asked the operator for an UptimeRobot API key to check,
 *     when the probe data was already in Supabase and fresh to the second.
 *
 * Both failures are the same shape: **a fact that could be measured was
 * instead remembered.** Prose went stale; nobody re-read the table.
 *
 * A bigger memory would not have helped — it would have recalled "fleet is
 * DOWN" faster and more reliably. The fix is not more memory. It is removing
 * the need to remember: the number arrives before a belief can form.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE OUTCOMES, NEVER TWO
 * ─────────────────────────────────────────────────────────────────────────────
 * MEASURED     — the live rows, with their timestamp.
 * NOT_CHECKED  — no credential, or the host is unreachable from this sandbox.
 *                The exact query is injected anyway, so the session knows what
 *                to run and through which tool.
 * FAILED       — the query ran and errored. Reported, never swallowed.
 *
 * A hook that silently injected nothing when it could not reach the database
 * would recreate the original defect: absence read as "fine". It must always
 * say which of the three happened.
 *
 * FAIL-OPEN on any unexpected error: a SessionStart hook that aborts the
 * session would be worse than the gap it closes. Same posture as
 * inject-lessons.mjs, deliberately.
 */

const QUERY = 'select agent_name, state, evidence, minutes_since_probe,\n' +
              '       minutes_since_iteration, loop_count, current_task_id\n' +
              '  from v_agent_state order by state, agent_name;';

/** Never block session start, and never take longer than a person would wait. */
const TIMEOUT_MS = 4000;

function emit(body) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: body,
      },
    }),
  );
  process.exit(0);
}

const PREAMBLE =
  'FLEET STATE — injected at session start so it is a reading, not a memory.\n\n' +
  'v_agent_state is the ONE canonical answer to "what is each agent doing":\n' +
  '  working | idle | wedged | down | unknown, each with the evidence column\n' +
  '  that produced it. Do NOT use v_fleet_truth (its is_live never consults the\n' +
  '  probe and reported 0/12 live while 12/12 answered HTTP 200), do NOT use a\n' +
  '  status column (a dead agent cannot write status=offline), and do NOT fetch\n' +
  '  UptimeRobot (the probe data is already in agent_health_probes).\n' +
  '  "unknown" is a real outcome and must never be reported as "down".\n\n';

const HOW_TO_RUN =
  '\nRead it yourself before claiming anything about the fleet — the Supabase MCP\n' +
  'tools reach the database from any session:\n\n' +
  QUERY + '\n';

async function main() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    emit(
      PREAMBLE +
        'NOT_CHECKED — no Supabase credential in this session, so the hook could\n' +
        'not read the live rows. This is the normal case in a cloud session and\n' +
        'says nothing about the fleet. It is NOT evidence the agents are down.' +
        HOW_TO_RUN,
    );
  }

  const endpoint =
    url.replace(/\/+$/, '') +
    '/rest/v1/v_agent_state?select=agent_name,state,evidence,minutes_since_probe,' +
    'minutes_since_iteration,loop_count,current_task_id&order=state,agent_name';

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  let rows;
  try {
    const res = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: ac.signal,
    });
    if (!res.ok) {
      emit(
        PREAMBLE +
          `FAILED — the query ran and returned HTTP ${res.status}. Treat the fleet\n` +
          'state as UNKNOWN and read it yourself before claiming anything.' +
          HOW_TO_RUN,
      );
    }
    rows = await res.json();
  } catch (err) {
    // Unreachable host, DNS, proxy denial, or the timeout above. All are
    // "we did not look", which is not "it is down".
    emit(
      PREAMBLE +
        'NOT_CHECKED — the database was unreachable from this session ' +
        `(${err && err.name === 'AbortError' ? `no answer in ${TIMEOUT_MS}ms` : 'connection refused or proxy-denied'}).\n` +
        'That is a statement about THIS SESSION\'S NETWORK, not about the fleet.\n' +
        'Whether *.supabase.co is reachable from a sandbox has changed before — it\n' +
        'was proxy-denied on 2026-08-15 and answering on 2026-08-27 — so do not\n' +
        'infer either way from a doc; the Supabase MCP path works regardless.' +
        HOW_TO_RUN,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    emit(
      PREAMBLE +
        'NOT_CHECKED — v_agent_state returned no rows. That means no probe landed\n' +
        'inside the freshness window, which is "we cannot see them", NOT "they are\n' +
        'down". Check whether the prober itself is running before concluding.' +
        HOW_TO_RUN,
    );
  }

  const tally = rows.reduce((acc, r) => {
    acc[r.state] = (acc[r.state] || 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${s}`)
    .join(' · ');

  // A null age is "not reported", which must not render as the string "null".
  // A display that prints "loop nullm (#null)" trains the reader to skim past
  // the row, and the rows worth reading are exactly the ones with nulls in them.
  const age = (m) => (m === null || m === undefined ? 'n/a' : `${m}m`);
  const lines = rows.map((r) => {
    const task = r.current_task_id ? `task=${r.current_task_id}` : 'no task';
    const loop =
      r.loop_count === null || r.loop_count === undefined
        ? 'loop not reported'
        : `loop ${age(r.minutes_since_iteration)} (#${r.loop_count})`;
    return (
      `  ${String(r.agent_name).padEnd(18)} ${String(r.state).padEnd(8)} ` +
      `${task.padEnd(16)} probe ${age(r.minutes_since_probe)} · ${loop} — ${r.evidence}`
    );
  });

  emit(
    PREAMBLE +
      `MEASURED at ${new Date().toISOString()} — ${rows.length} agents: ${summary}\n\n` +
      lines.join('\n') +
      '\n\nThis is a dated snapshot. It was true when the hook ran; re-query before\n' +
      'quoting it later in a long session.',
  );
}

main().catch(() => process.exit(0)); // fail-open: never block session start
