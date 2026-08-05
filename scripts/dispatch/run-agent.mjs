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
const AGENTS = {
  xc: {
    cli: 'grok',
    mode: 'argv',
    args: (p) => ['-p', p],
    keyVar: 'GROK_API_KEY',
    inbox: 'E:/dev/handoffs/INBOX_XC.md',
    lane: 'L6 RED-TEAM — no write scope',
  },
  ga: {
    cli: 'gemini',
    mode: 'stdin',
    args: () => [],
    keyVar: 'GEMINI_API_KEY',
    inbox: 'E:/dev/handoffs/INBOX_GA.md',
    lane: 'L7 MEASUREMENT — no write scope',
  },
};

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

  const key = readKey(agent.keyVar);
  if (!key) {
    console.error(`${agent.keyVar} not found in ${ENV_MASTER} — cannot authenticate ${agent.cli}`);
    process.exit(2);
  }

  const branch = assertSafeRepoState();

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
