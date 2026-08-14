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
 * THAT WAS TRUE OF ONE KEY AND ONLY ONE KEY, which was not enough. Until 2026-08-14:
 *
 *   - the child received `{ ...process.env }`, so if the operator's shell had sourced
 *     .env.master the agent's process held ALL of it, not just its own credential;
 *   - `scrub` redacted the resolved key alone, so any OTHER secret echoed back landed
 *     verbatim in `reports/`, which is committed to a repo CLAUDE.md states is PUBLIC.
 *
 * Both halves now cover every value in the reference file: the child env is PRUNED of
 * the other secrets before spawn, and the scrubber redacts all of them on the way out.
 * See buildChildEnv and makeScrubber.
 *
 *   node scripts/dispatch/run-agent.mjs --agent xc --task "…"         # inline
 *   node scripts/dispatch/run-agent.mjs --agent ga --inbox            # newest INBOX entry
 *   node scripts/dispatch/run-agent.mjs --agent xc --inbox ./IN.md    # from an explicit file
 *   node scripts/dispatch/run-agent.mjs --agent xc --inbox --dry-run  # show, don't run
 *
 * PATHS THIS READS, and how to move them off one machine:
 *   .env.master     TRUSTKEYS_ENV_MASTER   (default C:/Users/Cash4/repos/.env.master)
 *   INBOX_*.md      DISPATCH_HANDOFF_DIR   (default E:/dev/handoffs)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    // ACCEPTS BOTH NAMES, newest first. .env.master canonicalised this to
    // XAI_API_KEY (repid-engine #398); the old GROK_API_KEY is kept as a fallback.
    // A rename is the classic silent break — the same shape as the renamed
    // SUPABASE_SECRET_KEY that crash-looped zkp-postcard for days. Accepting both
    // costs one array entry; guessing wrong costs an agent that cannot be
    // dispatched and fails in a way that reads like "the agent had nothing to say".
    keyVars: ['XAI_API_KEY', 'GROK_API_KEY'],
    // FILENAME, not a full path — resolved against HANDOFF_DIR by inboxPathFor().
    inboxFile: 'INBOX_XC.md',
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
    keyVars: ['GEMINI_API_KEY', 'GEMINI_API_KEY_2'],
    inboxFile: 'INBOX_GA.md',
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
/**
 * ════════════════════════════════════════════════════════════════════════════════
 * SEAM 3 — THE CLAIM MANIFEST. A claim carries what the claimant could reach.
 * ════════════════════════════════════════════════════════════════════════════════
 * Seam 1 refuses a task the agent cannot do. Seam 2 supplies real evidence. This
 * is the third: after the fact, record what was ACTUALLY reachable, and flag any
 * claim the agent could not have earned.
 *
 * WHY IT NEEDS TEETH RATHER THAN BEING A LOG. On 2026-08-05 GA returned a review
 * asserting test results, with invented line numbers, for a file it never opened.
 * A human reading that transcript could not tell — the report was well-formed and
 * confident, and its own stderr (which nobody reads) was the only contradiction.
 * A record nobody checks reproduces exactly that.
 *
 * So this does the check. A `[V]` — "I verified this myself" — next to an
 * EXECUTION claim, from an agent that held no `shell` and was given no evidence,
 * is not possible. It is reported as UNSUPPORTED at the top of the transcript,
 * where a reviewer starts reading.
 *
 * IT DETECTS ARTIFACTS, NOT ASSERTIONS — and that is the correction that made it
 * work. My first version looked for a `[V]` tag beside "I ran the tests", and
 * MEASURED AGAINST THE REAL FABRICATED TRANSCRIPT IT MISSED COMPLETELY. GA never
 * wrote `[V]` and never said it ran anything: it tagged its section `[R]` and
 * framed invented output as "Expected Failure Output". The dishonesty was not in
 * the claim — it was in the SPECIFICS.
 *
 * What gives it away is that those specifics can only be OBSERVED:
 *
 *     AssertionError [ERR_ASSERTION]: Expected request to succeed
 *       at file:///.../tests/swarm-toolbelt.test.mjs:42:12
 *
 * A stack frame, a `file:line`, an exit code, a test count — nobody derives those
 * by reading source. Their presence in a transcript from an agent that ran
 * nothing is the contradiction, regardless of how the surrounding prose is
 * hedged. So: EXECUTION ARTIFACT + no shell + no evidence = flag.
 *
 * Still conservative — it flags, it does not fail the run. A false positive would
 * train people to ignore the banner, which is worse than not having it.
 */
const EXECUTION_ARTIFACT = [
  /\bAssertionError\b/,
  /\bat .*?:\d+:\d+/,                       // a stack frame with line:col
  /\b[\w./-]+\.(test|spec)\.[jt]sx?:\d+/,   // testfile.test.ts:42
  /\bexit (?:code )?[:=]? ?\d+\b/i,
  /\bTests?:\s+\d+ (passed|failed)/i,
  /\b\d+ (passing|failing|passed|failed)\b/i,
  /\bERR_[A-Z_]+\b/,
];

/**
 * THE DISARM THIS CLOSES — found 2026-08-14, by reading the predicate rather than the prose.
 *
 * The old test was `couldExecute = shell || evidenceCount > 0`, and `unsupported` required
 * `!couldExecute`. So ONE evidence command of any kind disarmed the detector for EVERY claim
 * in the transcript. Supply `git log --oneline -1` — cheap, always passes, on the allowlist —
 * and the agent could then invent jest output with stack frames and exit codes, and this
 * function stayed silent while the manifest printed a confident **[V]**.
 *
 * That is worse than having no detector. A reviewer who has been told the harness catches
 * fabrication reads [V] as "checked". The 2026-08-05 incident is precisely the class it was
 * built for, and one flag on the command line switched it off.
 *
 * WHAT REPLACES IT: an artifact is GROUNDED if the matched text also appears in the evidence
 * the harness actually injected, and UNGROUNDED otherwise. Quoting real output is exactly what
 * the agent is asked to do and never flags. Producing a stack frame that appears nowhere in
 * what it was shown is the contradiction, and it is now caught even when evidence was supplied.
 *
 * STILL CONSERVATIVE, deliberately — a false positive trains people to ignore the banner, which
 * is worse than not having it:
 *   - an agent holding real `shell` is never flagged; it could legitimately have run anything
 *   - grounding is a substring test on whitespace-normalised text, so reformatted or truncated
 *     quotes of real evidence still count as grounded
 *   - with no shell and no evidence the behaviour is IDENTICAL to before: any artifact flags
 *   - it flags, it does not fail the run
 */
function auditClaims({ output, capabilities, evidenceCount, evidenceText = '' }) {
  const hasShell = capabilities.includes('shell');
  const couldExecute = hasShell || evidenceCount > 0;

  const norm = (s) => String(s || '').replace(/\s+/g, ' ');
  const shown = norm(evidenceText);
  const said = norm(output);

  const grounded = [];
  const ungrounded = [];
  for (const re of EXECUTION_ARTIFACT) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of said.matchAll(g)) {
      (shown && shown.includes(m[0]) ? grounded : ungrounded).push(m[0]);
    }
  }

  return {
    couldExecute,
    hasArtifacts: grounded.length + ungrounded.length > 0,
    artifactCount: grounded.length + ungrounded.length,
    groundedCount: grounded.length,
    ungroundedCount: ungrounded.length,
    /** A few verbatim offenders, so the banner can show WHAT was unsupported. */
    ungroundedSamples: [...new Set(ungrounded)].slice(0, 5),
    // The contradiction: output that could only come from running something, which the
    // agent neither ran nor was shown.
    unsupported: !hasShell && ungrounded.length > 0,
    // Nothing in a transcript with no evidence and no shell can exceed [R].
    maxGrade: couldExecute ? 'V' : 'R',
  };
}

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

/**
 * The one file every agent on this system reads. See the injection site in main().
 *
 * Resolved from THIS FILE's location, not `process.cwd()`.
 *
 * [V 2026-08-14] It was `join(process.cwd(), 'LESSONS.md')` under a comment claiming it
 * came "from the repo root so the dispatcher works from any cwd". It did not: cwd is
 * wherever the caller happened to be. Measured by dispatching from `src/` — the preamble
 * collapsed from 7537 to 1001 characters and the entire shared-lessons block was gone.
 *
 * That is this file's own failure mode aimed at itself. CLAUDE.md calls the dispatch
 * preamble "the ONLY channel that reaches XC and GA", and the lessons block opens with
 * "each one is here because it already cost us something real". Losing it to a cwd
 * turns a governed dispatch into an ungoverned one, and the only trace is one warning
 * line in a log nobody reads after the fact. `import.meta.url` cannot drift this way.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LESSONS_PATH = join(REPO_ROOT, 'LESSONS.md');
const LESSONS_MAX = 6000;

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

/**
 * EVERY occurrence of a repeatable flag, in order.
 *
 * `arg()` uses indexOf, so it returns the FIRST match and discards the rest. For a
 * repeatable flag that is a silent truncation, and `--evidence` is repeatable in every
 * way that matters: it is collected into an array, the manifest renders it with
 * `.map()`, and the prompt injects the entries as a list.
 *
 * [V 2026-08-14] Measured: `--evidence "git log --oneline -1" --evidence "npx tsc
 * --noEmit"` ran ONLY the git command. No warning. The manifest then truthfully listed
 * one command, so the transcript looked correct while the reviewer's actual request —
 * "run the tests AND the typecheck" — had been halved on the way in.
 *
 * This matters more than a dropped flag usually would, because evidence is what licenses
 * an execution claim. Silently supplying less evidence than was asked for produces a
 * report graded against evidence nobody knows is missing.
 */
function argAll(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== `--${name}`) continue;
    const v = process.argv[i + 1];
    if (v && !v.startsWith('--')) out.push(v);
  }
  return out;
}

/** Read one key from the reference file. Returns the value; NEVER log it. */
/**
 * Read the first key present from a list of accepted names. NEVER log the value.
 *
 * Returns `{ name, value }` so the caller can report WHICH name resolved. A key
 * rename must be visible, not silently absorbed — that is the failure mode this
 * whole function was rewritten for.
 */
function readKey(varNames) {
  if (!existsSync(ENV_MASTER)) return null;
  const found = new Map();
  for (const line of readFileSync(ENV_MASTER, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && varNames.includes(m[1])) {
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      // First occurrence wins. dotenv is last-wins, but a duplicated key has
      // already shadowed a good value here once (the GROQ dupe), so preferring
      // the first and reporting the name is the safer read for a lookup tool.
      if (v && !found.has(m[1])) found.set(m[1], v);
    }
  }
  for (const n of varNames) if (found.has(n)) return { name: n, value: found.get(n) };
  return null;
}

/**
 * EVERY name/value in the reference file. NEVER logged, never written, never returned
 * to a caller that prints. Used for two things only: pruning the child environment and
 * building the scrubber.
 *
 * Same first-occurrence-wins parse as readKey, for the same reason (the GROQ dupe).
 */
function readAllSecrets(path = ENV_MASTER) {
  const out = new Map();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    if (v && !out.has(m[1])) out.set(m[1], v);
  }
  return out;
}

/**
 * The environment the agent's process actually gets.
 *
 * `{ ...process.env }` was the whole of it before. That is the maximum possible blast
 * radius for no benefit: the CLI needs its OWN provider key, PATH, HOME and the usual
 * platform variables — it has no use for the other 43 credentials, and handing them over
 * means a prompt-injected or merely chatty agent can surface one.
 *
 * So every name present in the reference file is removed, and only this agent's key is
 * put back (under each accepted alias, as before). Note what is NOT done: this is a
 * targeted prune, not an allow-list. An allow-list of "variables a CLI needs" is a guess,
 * and a wrong guess breaks dispatch on a machine I cannot test — HOME, APPDATA,
 * USERPROFILE, TEMP, SystemRoot, LANG, NODE_OPTIONS and PATHEXT are all load-bearing
 * somewhere. Pruning known-secret NAMES cannot break a CLI that only needs its own key,
 * and it is the part that carries the risk.
 */
function buildChildEnv(parentEnv, secretNames, keyVars, key) {
  const env = { ...parentEnv };
  for (const name of secretNames) delete env[name];
  for (const name of keyVars) env[name] = key;
  return env;
}

/**
 * A scrubber over every known secret value, applied to stdout and stderr before either
 * is printed or written to `reports/`.
 *
 * LONGEST FIRST: two secrets can share a prefix, and redacting the short one first would
 * leave the tail of the long one exposed in the transcript.
 *
 * MINIMUM LENGTH 8: a short or dictionary-word value would redact ordinary prose and
 * make the transcript unreadable. An unreadable transcript is not reviewed, and a review
 * nobody reads is the failure this whole file exists to prevent — so the floor is a
 * legibility guard, not laziness. Values that short are not credentials worth the trade.
 */
const SCRUB_MIN_LEN = 8;
function makeScrubber(values) {
  const targets = [...new Set(values)]
    .filter((v) => typeof v === 'string' && v.length >= SCRUB_MIN_LEN)
    .sort((a, b) => b.length - a.length);
  return (s) => targets.reduce((acc, v) => acc.split(v).join('<redacted>'), String(s || ''));
}

/**
 * Where an INBOX actually lives, most specific first:
 *
 *   1. an explicit `--inbox <path>`
 *   2. DISPATCH_HANDOFF_DIR + the agent's filename
 *   3. the historical default directory
 *
 * TWO DEFECTS THIS CLOSES, both measured 2026-08-14.
 *
 * (a) `--inbox <path>` PARSED THE PATH AND THREW IT AWAY. `arg()` returns the value when
 *     one follows the flag, but the call site read `agent.inbox` regardless, so
 *     `--inbox ./MY_TASK.md` silently dispatched from a completely different file — or,
 *     off Windows, from nothing at all. The only clue was the hardcoded path echoed back
 *     in the "no task" message. Silently substituting the input is the same shape as the
 *     `--evidence` truncation: the flag looks honoured, the work is done on other data.
 *
 * (b) THE DIRECTORY WAS HARDCODED to one machine's `E:/dev/handoffs`, with no override —
 *     unlike `.env.master`, which has had `TRUSTKEYS_ENV_MASTER` all along. So `--inbox`
 *     worked for exactly one operator on exactly one OS, and everywhere else exited 64
 *     "no task", which reads like an empty queue rather than an unreachable path.
 *
 * The default is deliberately kept, so nothing changes for the machine it was written for.
 */
const HANDOFF_DIR = process.env.DISPATCH_HANDOFF_DIR || 'E:/dev/handoffs';

function inboxPathFor(agent, explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return join(HANDOFF_DIR, agent.inboxFile);
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
    console.error(`usage: --agent <${Object.keys(AGENTS).join('|')}> [--task "..." | --inbox [path]] [--dry-run]`);
    process.exit(64);
  }

  // `arg('inbox')` is `true` for a bare flag and the path string when one follows.
  const inboxArg = arg('inbox');
  const inboxPath = inboxArg ? inboxPathFor(agent, typeof inboxArg === 'string' ? inboxArg : undefined) : null;
  const task = inboxPath ? newestInboxEntry(inboxPath) : arg('task');
  if (!task || task === true) {
    // Name the path that was ACTUALLY read. When the file is missing this message is the
    // only diagnosis available, and it used to print the hardcoded default even when a
    // different path had been passed — sending the reader to the wrong file.
    console.error(
      inboxPath
        ? `no task: ${existsSync(inboxPath) ? 'no "## " entry found in' : 'no such file'} ${inboxPath}`
        : `no task. Pass --task "..." or --inbox (reads ${inboxPathFor(agent)})`,
    );
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

  // Read once: the same map prunes the child env and builds the scrubber. Values are
  // never logged — the COUNT is reported so a surprising 0 (a moved or unreadable
  // reference file) is visible rather than silently disabling both protections.
  const secrets = readAllSecrets();

  const resolved = readKey(agent.keyVars);
  if (!resolved) {
    console.error(
      `none of [${agent.keyVars.join(', ')}] found in ${ENV_MASTER} — cannot authenticate ${agent.cli}.
` +
        '           A key RENAME is the usual cause and it fails silently: add the new name to keyVars.',
    );
    process.exit(2);
  }
  const key = resolved.value;
  if (resolved.name !== agent.keyVars[0]) {
    console.warn(`[dispatch] note: authenticating via fallback ${resolved.name} (preferred ${agent.keyVars[0]} absent)`);
  }

  const branch = assertSafeRepoState();

  // SEAM 2 — the harness runs it, so the agent cannot claim it ran without it.
  // Each command is fenced, executed here, and its REAL output injected below.
  // A failing command is injected too: "the suite is red and here is how" is a
  // finding, not an error, and hiding it would recreate the fabrication problem
  // from the other direction.
  const evidenceCmds = argAll('evidence');
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
  // ════════════════════════════════════════════════════════════════════════════
  // SHARED LESSONS — injected, because filing them demonstrably does not work.
  // ════════════════════════════════════════════════════════════════════════════
  // This repo holds 116 dated report files and CLAUDE.md referenced none of them.
  // reports/2026-07-31/SCHOOL_OF_HARD_KNOCKS_proof_drain.md logs "unverified
  // inference — again, THIRD occurrence"; it then recurred twice more on
  // 2026-08-05, once by me. A lesson a worker never reads is not a lesson.
  //
  // XC and GA cannot read living-docs, ~/.claude memory, or claude-mem — the
  // dispatch preamble is the ONLY channel that reaches them. So LESSONS.md ships
  // in the repo (git resolves conflicts, so two truths cannot diverge silently)
  // and is injected verbatim here. One file, many readers, never copied.
  //
  // Absent or oversized is reported LOUDLY rather than skipped: silently
  // dropping the rules would be this file's own lesson #4 turned on itself.
  const lessons = (() => {
    if (!existsSync(LESSONS_PATH)) {
      console.error(`[dispatch] ⚠ ${LESSONS_PATH} MISSING — dispatching without shared lessons.`);
      return null;
    }
    const text = readFileSync(LESSONS_PATH, 'utf8');
    if (text.length > LESSONS_MAX) {
      console.error(
        `[dispatch] ⚠ LESSONS.md is ${text.length} chars, over the ${LESSONS_MAX} cap. ` +
          'Injecting anyway, but it needs consolidating — an un-injectable lessons file is the 117th report.',
      );
    }
    return text;
  })();

  const preamble = [
    `You are ${agentKey.toUpperCase()}. Your lane: ${agent.lane}.`,
    `Governing spec: E:/dev/living-docs/03_specs/PARALLEL_AGENT_LANES_v1.md`,
    '',
    ...(lessons
      ? [
          '════ SHARED LESSONS — read before you work ════',
          'These are hard-won operating rules, shared by every agent on this system',
          '(CC, XC, GA and the T12 swarm). They are not style advice: each one is here',
          'because it already cost us something real, usually more than once.',
          '',
          lessons,
          '',
          'If your work teaches a NEW lesson of this kind, say so explicitly at the end',
          'of your report under "LESSON:" — it will be reviewed for inclusion. Do not',
          'edit LESSONS.md yourself; it is shared state and changes go through review.',
          '════ END SHARED LESSONS ════',
          '',
        ]
      : []),
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

  // Containment posture, stated BEFORE the dry-run branch so `--dry-run` previews it too —
  // "what would this dispatch expose?" is exactly what a dry run is for.
  //
  // Counts only, never values. There is no zero-count branch on purpose: `readKey` reads
  // the same file and has already exited if it was missing or held nothing, so reaching
  // here with an empty inventory is not a state this can be in. A defensive branch for it
  // would be unreachable code implying a check that never runs.
  console.log(
    `[dispatch] child env pruned of ${secrets.size} inventory secret(s); transcript scrubbed against all of them`,
  );

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
    env: buildChildEnv(process.env, secrets.keys(), agent.keyVars, key),
    maxBuffer: 32 * 1024 * 1024,
    shell: bin.shell,
    ...(agent.mode === 'stdin' ? { input: preamble } : {}),
  });

  const secs = Math.round((Date.now() - started) / 1000);
  // Scrub before anything is written or printed. The key was in the child env, so
  // a provider echoing it back must not reach the transcript.
  // Every known secret, not just the one this agent authenticates with. The child was
  // pruned of the others, but the operator's shell, a setup script or the agent's own
  // repo reads can still surface one — and `reports/` is committed to a public repo.
  const scrub = makeScrubber([key, ...secrets.values()]);
  const out = scrub(res.stdout);
  const err = scrub(res.stderr);

  // SEAM 3 — the manifest goes FIRST in the file, before the agent's prose.
  // A reviewer must meet "this agent could not run anything" before meeting its
  // confident paragraph about test results, not after.
  const audit = auditClaims({
    output: out,
    capabilities: agent.capabilities,
    evidenceCount: evidence.length,
    // The literal text the agent was shown. Grounding is checked against this, so an
    // artifact it could only have invented is caught even when evidence WAS supplied.
    evidenceText: evidence.join('\n'),
  });
  const headSha = (() => {
    try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
    catch { return 'unknown'; }
  })();

  const manifest = [
    '## Claim manifest — what this agent could actually reach',
    '',
    '| | |',
    '|---|---|',
    `| agent / cli | ${agentKey.toUpperCase()} · ${agent.cli} |`,
    `| lane | ${agent.lane} |`,
    `| capabilities held | ${agent.capabilities.join(', ')} |`,
    `| capabilities required by task | ${required.join(', ')} |`,
    `| shell | **no** — the harness holds it, the agent never does |`,
    `| evidence commands run FOR it | ${evidence.length === 0 ? '**none**' : evidenceCmds.map((c) => `\`${c}\``).join(', ')} |`,
    `| repo / branch / HEAD | ${branch} @ ${headSha} |`,
    `| duration · exit | ${secs}s · ${res.status} |`,
    `| **highest grade any claim here can carry** | **[${audit.maxGrade}]** |`,
    '',
    audit.unsupported
      ? '> ### ⚠ EXECUTION ARTIFACTS WITH NO EXECUTION\n' +
        '>\n' +
        `> This transcript contains ${audit.ungroundedCount} pattern(s) that can only be OBSERVED by\n` +
        '> running something — a stack frame, a `file:line`, an exit code, a test\n' +
        `> count — which appear NOWHERE in what this agent was shown${evidence.length ? ` (${audit.groundedCount} other(s) do match the evidence and are fine)` : ''}.\n` +
        `> **This agent held no \`shell\`${evidence.length ? '; the evidence it was given does not contain these' : ' and was given no evidence'}.** Nobody derives those by reading source.\n` +
        '>\n' +
        (audit.ungroundedSamples.length
          ? `> Unsupported specifics: ${audit.ungroundedSamples.map((s) => `\`${s}\``).join(' · ')}\n>\n`
          : '') +
        '> Note this fires regardless of how the prose is hedged. The 2026-08-05\n' +
        '> fabricated review tagged itself `[R]` and called its invented output\n' +
        '> "Expected Failure Output" — the dishonesty was in the SPECIFICS, not the\n' +
        '> claim. Re-run anything here before citing it.'
      : evidence.length > 0
        ? '> Execution claims below are backed by harness-run evidence, quoted verbatim in the prompt.\n' +
          `> The agent did not run these itself — it was shown the real output, and all ${audit.artifactCount}\n` +
          '> execution artifact(s) in this transcript trace back to it.'
        : '> No execution capability and none claimed. Reasoning-only report; grade [R].',
    '',
  ].join('\n');

  const dir = join('reports', new Date().toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `DISPATCH_${agentKey.toUpperCase()}_${Date.now()}.md`);
  writeFileSync(
    file,
    `# Dispatch — ${agentKey.toUpperCase()}\n\n` +
      `${manifest}\n` +
      `## Task\n\n${task}\n\n` +
      (evidence.length ? `## Evidence supplied (run by the harness)\n\n\`\`\`\n${evidence.join('\n\n')}\n\`\`\`\n\n` : '') +
      `## Output\n\n${out}\n` +
      (err.trim() ? `\n## stderr\n\n${err}\n` : ''),
    'utf8',
  );

  console.log(out);
  if (err.trim()) console.error(err);
  console.log(`\n[dispatch] ${secs}s · exit ${res.status} · transcript: ${file}`);
  console.log(`[dispatch] max claim grade: [${audit.maxGrade}] · evidence runs: ${evidence.length}`);
  if (audit.unsupported) {
    console.error(
      `[dispatch] ⚠ UNSUPPORTED EXECUTION CLAIM — ${audit.ungroundedCount} specific(s) in the output\n` +
        '           could only come from running something, and appear nowhere in what this\n' +
        `           agent was shown${evidence.length ? ` (${audit.groundedCount} other(s) do match the evidence).` : ' — it held no shell and got no evidence.'}\n` +
        (audit.ungroundedSamples.length ? `           e.g. ${audit.ungroundedSamples.join(' · ')}\n` : '') +
        '           Do not accept the execution claims without re-running them yourself.',
    );
  }

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

/**
 * ════════════════════════════════════════════════════════════════════════════════
 * TESTABILITY — why there is an entry guard and a set of exports
 * ════════════════════════════════════════════════════════════════════════════════
 * The safety of this file rests on four pure functions — `auditClaims` (the fabrication
 * detector), `evidenceRefusal` (the command fence), `readKey` (the rename-tolerant
 * lookup) and `resolveBin` (the call-path resolver). Until 2026-08-14 not one of them
 * had a direct test. The two suites that name this file read it as TEXT and check the
 * capability table; they cannot execute a predicate.
 *
 * That gap is not theoretical here. `auditClaims`'s first version was written, reviewed,
 * shipped, and then MEASURED AGAINST THE REAL FABRICATED TRANSCRIPT IT MISSED COMPLETELY
 * — see the comment on EXECUTION_ARTIFACT. Nothing has pinned it since, and the disarm
 * fixed today survived in it for exactly that reason: reading the prose around the
 * predicate is not the same as running the predicate.
 *
 * `main()` runs only when this file is the process entry point, so a test can import the
 * functions without dispatching an agent. `tests/dispatch-runner-seams.test.ts` executes
 * them in a real Node process — the same idiom as `demo-leaf-bin.test.ts`, and the same
 * lesson as `resolveBin` itself: test the CALL PATH, not the thing beside it.
 */
export { auditClaims, evidenceRefusal, readKey, readAllSecrets, buildChildEnv, makeScrubber, resolveBin, argAll, capabilityRefusal, inboxPathFor, newestInboxEntry, EXECUTION_ARTIFACT, EVIDENCE_ALLOWED, LESSONS_PATH, HANDOFF_DIR, AGENTS };

const INVOKED_DIRECTLY =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (INVOKED_DIRECTLY) {
  try {
    main();
  } catch (e) {
    console.error(`[dispatch] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(3);
  }
}
