/**
 * deliver-inbox's decision logic, as pure functions.
 *
 * CJS on purpose, mirroring inbox-lib.js: the runner is an ESM .mjs, the test
 * suite is CommonJS ts-jest, and a `.mjs` cannot be imported by the latter. The
 * logic worth testing therefore lives here, where BOTH can reach it — the same
 * split, for the same reason, as inbox-lib.js next door.
 */

/**
 * to_ai -> the agent key run-agent.mjs knows.
 *
 * EXPLICIT BECAUSE THE REGISTRY HAS NO `xc2`. run-agent.mjs's AGENTS map holds
 * `xc` and `ga` only, so a row addressed to xc2 has no binary of its own; XC2 is
 * a second Grok instance, not a second CLI. Mapping it onto the same `xc` agent
 * is the honest option, and the reply discloses which runner answered so nobody
 * reads an xc2 row as having been handled by a distinct model.
 */
const AGENT_FOR = { xc: 'xc', xc2: 'xc' };

/**
 * Build the reply from what was checked AFTER the run, never from what the agent
 * said about itself.
 *
 * This is the whole point of the bridge. Two fabricated self-reports are already
 * on record here (a commit hash that did not exist, a claimed HTTP 200 against an
 * endpoint that 404'd), so the agent's output is included but fenced under a
 * CLAIM heading, and the VERIFIED section contains only the exit code, the repo's
 * git state and whether a transcript actually appeared on disk.
 */
function buildReply({ row, agentKey, run, before, after, runner }) {
  const newLines = after.status
    .split('\n')
    .filter((l) => l.trim() && !before.status.includes(l))
    .map((l) => l.trim());
  const transcripts = newLines.filter((l) => l.includes('reports/'));
  const headMoved = before.head !== after.head;

  const verified = [];
  if (run.spawnError) {
    verified.push(`FAILED to launch the agent: ${run.spawnError}`);
  } else {
    verified.push(`dispatcher exit code: ${run.code}`);
  }
  verified.push(
    `git HEAD ${
      headMoved
        ? `moved ${before.head.slice(0, 8)} -> ${after.head.slice(0, 8)}`
        : `unchanged at ${before.head.slice(0, 8)}`
    }`,
  );
  verified.push(
    transcripts.length
      ? `transcript file(s) appeared: ${transcripts.join(', ')}`
      : 'no transcript file appeared under reports/',
  );

  const notChecked = [
    "whether the agent's reasoning is correct — this runner checks that work HAPPENED, not that it is right.",
  ];

  const ok = run.code === 0 && !run.spawnError;

  const text =
    `DELIVERED by ${runner} (to_ai=${row.to_ai}, dispatched on the '${agentKey}' agent).\n` +
    (row.to_ai !== agentKey
      ? `NOTE: there is no separate '${row.to_ai}' binary — run-agent.mjs's registry holds '${agentKey}'. ` +
        `Same CLI, so do not read this as a distinct model answering.\n`
      : '') +
    `\nVERIFIED HERE (not self-reported):\n` +
    verified.map((v) => `  - ${v}`).join('\n') +
    `\n\nNOT CHECKED:\n` +
    notChecked.map((v) => `  - ${v}`).join('\n') +
    `\n\nAGENT'S OWN OUTPUT — A CLAIM, NOT A VERDICT:\n` +
    '```\n' +
    (run.stdout || run.stderr || '(no output)').slice(-2500) +
    '\n```\n' +
    (ok
      ? ''
      : '\nThis row is reported as blocked rather than done: the dispatcher did not exit 0. ' +
        'Nothing was invented to fill the gap.\n');

  return { ok, text };
}

module.exports = { AGENT_FOR, buildReply };
