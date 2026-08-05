#!/usr/bin/env node
/**
 * run-agent.mjs — execute a queued INBOX task on a named agent, headlessly.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS ACTUALLY MISSING
 * ════════════════════════════════════════════════════════════════════════════════
 * "Headless auth" was assumed to be the blocker for months. It was not.
 * [V 2026-08-05] both CLIs already work non-interactively and already read their
 * key from the environment:
 *
 *     gemini -p "..."   -> exit 0
 *     grok   -p "..."   -> exit 0
 *
 * The gap was that NOTHING INVOKED THEM. Work was queued in INBOX_XC / INBOX_GA
 * and sat there, because queuing is not dispatch. This is the missing invoker.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE SAFETY MODEL IS STRUCTURAL, NOT PROCEDURAL
 * ════════════════════════════════════════════════════════════════════════════════
 * An LLM writing code unattended is only safe if it CANNOT do the dangerous thing,
 * not if it was asked nicely. Per PARALLEL_AGENT_LANES_v1 this runner enforces:
 *
 *   - refuses to run on `main` — a branch must exist first
 *   - refuses if the working tree is dirty — no mixing agent output with yours
 *   - never merges, never pushes, never touches infra or prod SQL
 *   - hard timeout, so a runaway agent stops
 *   - writes the transcript to reports/, which is the artifact a reviewer reads
 *
 * It deliberately does NOT auto-commit. The agent's output lands in the working
 * tree for a HUMAN OR A DIFFERENT FAMILY to review before anything is recorded.
 * Auto-commit would defeat the cross-family review that makes this affordable.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * SECRETS
 * ════════════════════════════════════════════════════════════════════════════════
 * The provider key is read from .env.master and passed to the child process
 * environment only. It is never printed, never written to the transcript, and the
 * transcript is scrubbed of anything matching it before being saved.
 *
 *   node scripts/dispatch/run-agent.mjs --agent xc --task "…"        # inline
 *   node scripts/dispatch/run-agent.mjs --agent ga --inbox           # newest INBOX entry
 *   node scripts/dispatch/run-agent.mjs --agent xc --inbox --dry-run # show, don't run
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `mode` is not a style preference — it is what each CLI actually accepts,
 * measured rather than assumed [V 2026-08-05]:
 *
 *   grok   -p "<prompt>"      works. Piping to stdin opens its interactive TUI.
 *   gemini  <prompt on stdin> works. (`-p` works too, but see resolveBin below.)
 *
 * The first version of this file used `-p` for both and GA NEVER RAN ONCE — see
 * resolveBin for why, and why I did not catch it.
 */
/**
 * ════════════════════════════════════════════════════════════════════════════════
 * CAPABILITIES — MEASURED, NOT DECLARED. Absent unless proven.
 * ════════════════════════════════════════════════════════════════════════════════
 * This mirrors `canAssign()` in src/orchestration/lane-registry.ts, whose comment
 * says the thing this file exists to enforce: *"T12 lacks http — routing this here
 * yields a fabricated answer, not a failed one."*
 *
 * Duplicated rather than imported for the same reason lane-write-guard.js
 * duplicates its lease logic: this must run in a fresh worktree with no
 * `npm install` and no build, because `dist/` is stale exactly when someone is
 * mid-refactor. Anything it needs to require is a way for it to fail, and a fence
 * that fails is a fence that fails OPEN. `tests/dispatch-capability-parity.test.ts`
 * pins the two tables together.
 *
 * WHY THIS EXISTS — the failure it is built from, 2026-08-05:
 * GA was dispatched to review a PR in ANOTHER repository and returned a detailed
 * report containing fabricated test output with invented line numbers. Its own
 * stderr showed it never read the file and never ran anything:
 *
 *     Error executing tool read_file: Path not in workspace
 *     Blocked call: 'run_shell_command' is not available to this agent
 *
 * I gave it a task requiring `shell` and a cross-repo read, in a sandbox with
 * neither. The agent did not malfunction — I asked for something it had no
 * instrument to obtain, and a well-formed answer is what that always produces.
 *
 * FAIL CLOSED: a capability not listed is treated as ABSENT. Adding one requires
 * a `verified` note saying how it was measured. An unmeasured capability is a
 * guess, and a guess here re-creates the exact bug.
 */
const AGENTS = {
  xc: {
    cli: 'grok',
    mode: 'argv',
    args: (p) => ['-p', p],
    keyVar: 'GROK_API_KEY',
    inbox: 'E:/dev/handoffs/INBOX_XC.md',
    lane: 'L6 RED-TEAM — no write scope',
    // [V 2026-08-05] grok resolves to grok.exe and ran a real analysis of
    // penalty-provenance.ts, returning a finding I independently confirmed
    // (INTEGRITY_TYPES exact-match gap). Reasoning + in-repo read demonstrated.
    // `shell` is NOT listed: never observed, therefore absent.
    capabilities: ['reasoning', 'repo_read'],
  },
  ga: {
    cli: 'gemini',
    mode: 'stdin',
    args: () => [],
    keyVar: 'GEMINI_API_KEY',
    inbox: 'E:/dev/handoffs/INBOX_GA.md',
    lane: 'L7 MEASUREMENT — no write scope',
    // [V 2026-08-05] measured from its OWN stderr on the fabricated review:
    //   run_shell_command  -> "not available to this agent"      => no `shell`
    //   read_file/grep     -> "Path not in workspace"            => repo_read is
    //     scoped to the CWD workspace only, hence `repo_read` but not
    //     `cross_repo_read`.
    //   web_fetch          -> "not available to this agent"      => no `http`
    capabilities: ['reasoning', 'repo_read'],
  },
};

/** Capabilities a task may require. Unknown names are refused, not ignored. */
const KNOWN_CAPABILITIES = ['reasoning', 'repo_read', 'cross_repo_read', 'shell', 'http', 'db_read'];

/**
 * ════════════════════════════════════════════════════════════════════════════════
 * EVIDENCE COMMANDS — the harness holds `shell`, the agent does not.
 * ════════════════════════════════════════════════════════════════════════════════
 * A reviewer must RUN the tests, not read them (PARALLEL_AGENT_LANES §3.1). The
 * obvious way to enable that is to give the agent a shell. MEASURED 2026-08-05,
 * that is not safe here, and the reason is worth writing down because the flag
 * looks like it solves it:
 *
 *   grok --allow 'Bash(node:*)' -p "delete canary.txt using rm"   ->  DELETED IT
 *
 * `--allow` is an AUTO-APPROVE list, not a fence. In single-turn `-p` mode there
 * is no confirmation step to fall back on, so an unlisted command simply runs.
 * `--sandbox <invalid-profile>` was accepted silently and ran unsandboxed. So on
 * this machine a shell grant is a FULL shell grant — and a full shell reads
 * `.env.master` (44 keys, known path) and can echo the provider key we place in
 * its own environment.
 *
 * THE INVERSION: the agent does not need the capability, it needs the EVIDENCE.
 * So the harness runs the command and injects the real output into the prompt.
 * The agent gets true test results and cannot fabricate them, because they are
 * already in front of it — and it never gets arbitrary execution.
 *
 * The allowlist below is a FENCE, not a suggestion: the command is matched before
 * it runs and anything unmatched is refused. `&& || ; | > \` $( ` are rejected
 * outright so a permitted prefix cannot smuggle a second command.
 */
const EVIDENCE_ALLOWED = [
  /^npm (test|run test:[\w:-]+)$/,
  /^npx jest --config jest\.config\.js( [\w./-]+)*$/,
  /^node (-c )?[\w./-]+\.(mjs|js)$/,
  /^npx tsc --noEmit$/,
  /^git (status --porcelain|log --oneline -\d+|diff --stat [\w./~^-]+)$/,
];

const SHELL_METACHARS = /[;&|><`$(){}\n\r]|\|\||&&/;

function evidenceRefusal(cmd) {
  if (SHELL_METACHARS.test(cmd)) {
    return `command contains shell metacharacters — refused so a permitted prefix cannot smuggle a second command: ${cmd}`;
  }
  if (!EVIDENCE_ALLOWED.some((re) => re.test(cmd))) {
    return `command is not on the evidence allowlist: ${cmd}\n           allowed shapes: npm test · npx jest --config jest.config.js [file] · node <file> · npx tsc --noEmit · git status/log/diff`;
  }
  return null;
}

/**
 * The port of canAssign(). Returns null when assignable, or a refusal reason.
 *
 * The refusal IS the product. A dispatch that cannot be satisfied must stop here,
 * where the cause is legible — not produce a plausible transcript that someone
 * later cites as a review.
 */
function capabilityRefusal(agentKey, agent, required) {
  const unknown = required.filter((c) => !KNOWN_CAPABILITIES.includes(c));
  if (unknown.length) {
    return `unknown capability requested: ${unknown.join(', ')}. Known: ${KNOWN_CAPABILITIES.join(', ')}.`;
  }
  const missing = required.filter((c) => !agent.capabilities.includes(c));
  if (!missing.length) return null;
  return (
    `${agentKey.toUpperCase()} lacks [${missing.join(', ')}] which this task requires.\n` +
    `           It holds only [${agent.capabilities.join(', ')}].\n` +
    `           Routing this here yields a FABRICATED answer, not a failed one — on 2026-08-05\n` +
    `           exactly this produced a review with invented test output. Refusing.`
  );
}

/**
 * Resolve a CLI to something `spawnSync` can actually execute.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE BUG THIS EXISTS FOR, AND THE VERIFICATION GAP THAT LET IT SHIP
 * ════════════════════════════════════════════════════════════════════════════════
 * I verified "both CLIs work headless" by running `gemini -p "..."` in a SHELL,
 * where PATHEXT resolves `gemini` to `gemini.cmd`. This runner uses `spawnSync`
 * WITHOUT a shell, which does not apply PATHEXT — so it got **ENOENT** every time.
 *
 * `grok` happens to be `grok.exe`, so XC worked and looked like proof the runner
 * was sound. `gemini` is an npm `.cmd` shim, so GA silently produced a 0-second
 * empty transcript on every dispatch. I tested the CLI; I did not test the
 * CALL PATH — and those are different claims.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THE SHELL HERE IS NOT AN INJECTION HOLE
 * ════════════════════════════════════════════════════════════════════════════════
 * A `.cmd` shim cannot be executed without a shell on Windows. `shell: true` with
 * an LLM-authored prompt on the command line WOULD be an injection hole — the
 * prompt contains quotes, newlines and `&`, and is partly attacker-influenced
 * whenever an agent reads untrusted content.
 *
 * So the two are coupled by an assertion below: **anything needing a shell must
 * deliver its prompt over stdin**, never argv. The command line then carries only
 * a path we resolved ourselves, and the untrusted text never touches a shell
 * parser. That is why `ga` is `mode: 'stdin'` — not a preference, a requirement.
 */
function resolveBin(cli) {
  if (process.platform !== 'win32') return { cmd: cli, shell: false };
  const where = spawnSync('where', [cli], { encoding: 'utf8' });
  const paths = String(where.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const exe = paths.find((p) => /\.exe$/i.test(p));
  if (exe) return { cmd: exe, shell: false };
  const shim = paths.find((p) => /\.(cmd|bat)$/i.test(p));
  if (shim) return { cmd: shim, shell: true };
  return { cmd: cli, shell: false };
}

const ENV_MASTER = process.env.TRUSTKEYS_ENV_MASTER || 'C:/Users/Cash4/repos/.env.master';
const TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 15 * 60 * 1000);

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

/** Read one key from the reference file. Returns the value; NEVER log it. */
function readKey(varName) {
  if (!existsSync(ENV_MASTER)) return null;
  for (const line of readFileSync(ENV_MASTER, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === varName) return m[2].trim().replace(/^["']|["']$/g, '') || null;
  }
  return null;
}

/** Newest `## ` section of an INBOX (they are newest-on-top by convention). */
function newestInboxEntry(path) {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('## '));
  if (start === -1) return null;
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start, next === -1 ? undefined : next).join('\n').trim();
}

/**
 * Refuse to run unless the repo is in a state where agent output is isolable.
 * Structural, not advisory: on `main` or a dirty tree there is no way to tell the
 * agent's changes from anyone else's, which makes review impossible.
 */
function assertSafeRepoState() {
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  if (branch === 'main' || branch === 'master') {
    throw new Error(
      `refusing to run an agent on '${branch}'. Create a branch first — agent output must be isolable for review.`,
    );
  }
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) {
    throw new Error(
      'refusing to run: the working tree is dirty. Agent output would be indistinguishable from your uncommitted changes.',
    );
  }
  return branch;
}

function main() {
  const agentKey = String(arg('agent', '')).toLowerCase();
  const agent = AGENTS[agentKey];
  if (!agent) {
    console.error(`usage: --agent <${Object.keys(AGENTS).join('|')}> [--task "..." | --inbox] [--dry-run]`);
    process.exit(64);
  }

  const task = arg('inbox') ? newestInboxEntry(agent.inbox) : arg('task');
  if (!task || task === true) {
    console.error(`no task. Pass --task "..." or --inbox (reads ${agent.inbox})`);
    process.exit(64);
  }

  // SEAM 1 — refuse before the work, not after the report.
  // Default is conservative: a task that names no requirements is assumed to need
  // only reasoning. Anything that must READ, RUN or FETCH has to say so, and
  // saying so is what makes the mismatch visible.
  const required = String(arg('requires', 'reasoning'))
    .split(',').map((s) => s.trim()).filter(Boolean);
  const refusal = capabilityRefusal(agentKey, agent, required);
  if (refusal) {
    console.error(`[dispatch] ✗ REFUSED — ${refusal}`);
    process.exit(65);
  }

  const key = readKey(agent.keyVar);
  if (!key) {
    console.error(`${agent.keyVar} not found in ${ENV_MASTER} — cannot authenticate ${agent.cli}`);
    process.exit(2);
  }

  const branch = assertSafeRepoState();

  // SEAM 2 — the harness runs it, so the agent cannot claim it ran without it.
  // Each command is fenced, executed here, and its REAL output injected below.
  // A failing command is injected too: "the suite is red and here is how" is a
  // finding, not an error, and hiding it would recreate the fabrication problem
  // from the other direction.
  const evidenceCmds = [].concat(arg('evidence') && arg('evidence') !== true ? [String(arg('evidence'))] : []);
  const evidence = [];
  for (const cmd of evidenceCmds) {
    const bad = evidenceRefusal(cmd);
    if (bad) {
      console.error(`[dispatch] ✗ REFUSED evidence command — ${bad}`);
      process.exit(66);
    }
    console.log(`[dispatch] running evidence: ${cmd}`);
    const parts = cmd.split(/\s+/);
    const r = spawnSync(parts[0], parts.slice(1), {
      encoding: 'utf8',
      timeout: 15 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === 'win32', // npm/npx are .cmd shims; argv here is fenced, not agent-authored
    });
    const tail = (s) => String(s || '').split(/\r?\n/).slice(-60).join('\n');
    evidence.push(
      `$ ${cmd}\n[exit ${r.status ?? 'null'}${r.error ? ` — ${r.error.code}` : ''}]\n${tail(r.stdout)}\n${tail(r.stderr)}`.trim(),
    );
    console.log(`[dispatch]   -> exit ${r.status}`);
  }

  // The lane and its prohibitions are prepended to EVERY dispatch. An agent that
  // has to be told once, in a doc it may not read, is an agent that will merge
  // its own PR eventually.
  const preamble = [
    `You are ${agentKey.toUpperCase()}. Your lane: ${agent.lane}.`,
    `Governing spec: E:/dev/living-docs/03_specs/PARALLEL_AGENT_LANES_v1.md`,
    '',
    'HARD PROHIBITIONS — these are enforced elsewhere too, but do not attempt them:',
    '  - do NOT commit to main, do NOT merge any PR, do NOT push',
    '  - do NOT apply prod SQL or DDL',
    '  - do NOT change Railway/Vercel/DNS settings or any secret',
    '  - do NOT flip any flag to `enforce`',
    '  - if you write code that changes behaviour, it MUST be behind a default-OFF flag',
    '',
    'Report findings as [V] (you verified it yourself) or [R] (reported/assumed).',
    'If you could not check something, say so — an unbounded "looks fine" is refused.',
    '',
    ...(evidence.length
      ? [
          '════ EVIDENCE — REAL OUTPUT, RUN BY THE HARNESS ════',
          'These commands were executed for you just now. This is literal captured',
          'stdout/stderr, not a summary. Cite these numbers; do NOT restate them from',
          'memory and do NOT invent additional runs. If you need output this does not',
          'contain, say which command would produce it — do not infer it.',
          '',
          ...evidence,
          '════ END EVIDENCE ════',
          '',
        ]
      : [
          'You have NO shell and cannot run anything. If this task requires running',
          'tests or a build, say so and name the command — do not report results you',
          'did not observe. On 2026-08-05 a review fabricated test output with invented',
          'line numbers this way; that transcript is kept as the example of what not to do.',
          '',
        ]),
    `Current branch: ${branch}`,
    '---',
    task,
  ].join('\n');

  if (arg('dry-run')) {
    console.log(`[dry-run] would run: ${agent.cli} -p <prompt>  (${preamble.length} chars)`);
    console.log(`[dry-run] branch=${branch} timeout=${TIMEOUT_MS}ms`);
    console.log('---\n' + preamble.slice(0, 600) + (preamble.length > 600 ? '\n…' : ''));
    return;
  }

  const bin = resolveBin(agent.cli);
  // The coupling that keeps `shell: true` safe. If this ever fires, the fix is to
  // give that agent `mode: 'stdin'` — NOT to relax the assertion.
  if (bin.shell && agent.mode !== 'stdin') {
    throw new Error(
      `${agent.cli} resolves to a shell shim (${bin.cmd}) but is configured mode='${agent.mode}'. ` +
        `Putting an LLM-authored prompt on a shell command line is an injection hole. Use mode:'stdin'.`,
    );
  }

  console.log(`[dispatch] ${agentKey} via ${bin.cmd}${bin.shell ? ' (shim, prompt on stdin)' : ''} on branch ${branch} (timeout ${TIMEOUT_MS / 1000}s)`);
  const started = Date.now();
  const res = spawnSync(bin.cmd, agent.args(preamble), {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: { ...process.env, [agent.keyVar]: key },
    maxBuffer: 32 * 1024 * 1024,
    shell: bin.shell,
    ...(agent.mode === 'stdin' ? { input: preamble } : {}),
  });

  const secs = Math.round((Date.now() - started) / 1000);
  // Scrub before anything is written or printed. The key was in the child env, so
  // a provider echoing it back must not reach the transcript.
  const scrub = (s) => (s || '').split(key).join('<redacted>');
  const out = scrub(res.stdout);
  const err = scrub(res.stderr);

  const dir = join('reports', new Date().toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `DISPATCH_${agentKey.toUpperCase()}_${Date.now()}.md`);
  writeFileSync(
    file,
    `# Dispatch — ${agentKey.toUpperCase()}\n\n` +
      `- agent: ${agent.cli}\n- lane: ${agent.lane}\n- branch: ${branch}\n` +
      `- duration: ${secs}s\n- exit: ${res.status}\n\n` +
      `## Task\n\n${task}\n\n## Output\n\n${out}\n` +
      (err.trim() ? `\n## stderr\n\n${err}\n` : ''),
    'utf8',
  );

  console.log(out);
  if (err.trim()) console.error(err);
  console.log(`\n[dispatch] ${secs}s · exit ${res.status} · transcript: ${file}`);

  // A dispatch that produced NOTHING must not read like a review that found
  // nothing. GA failed this way silently: exit null, 0 seconds, empty output, and
  // a transcript file that existed and therefore looked like a result. An absent
  // review is far more dangerous than a negative one, because the PR then carries
  // a cross-family signature it never earned.
  if (res.error || res.status !== 0 || !out.trim()) {
    console.error(
      `\n[dispatch] ✗ NO REVIEW WAS PRODUCED — do not treat this as a pass.\n` +
        `           reason: ${res.error ? `${res.error.code} (${agent.cli} could not be executed)` : res.status === null ? 'process did not exit normally (killed or timed out)' : `exit ${res.status}`}` +
        (out.trim() ? '' : '\n           the agent returned no output at all'),
    );
    process.exit(1);
  }

  const changed = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (changed) {
    console.log(`[dispatch] the agent modified ${changed.split('\n').length} file(s).`);
    console.log('[dispatch] NOT committed on purpose — a different model family reviews before anything lands.');
  }
  process.exit(res.status === 0 ? 0 : 1);
}

try {
  main();
} catch (e) {
  console.error(`[dispatch] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(3);
}
