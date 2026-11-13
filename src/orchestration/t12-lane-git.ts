/**
 * t12-lane-git.ts — the real adapters behind runLanes: a free-wave maker, a fresh-checkout checker
 * and an idempotent draft-PR publisher.
 *
 * MODEL USE. The maker calls `ask`, which in production is `t12Ask`: loopback, then groq, then
 * cerebras, and off unless T12_FREE_WAVE is exactly `true`. There is no paid path to reach. The
 * model returns file text only; this harness does every read, write and commit, which is why a
 * reasoning-only lane can do this at all, and it writes nothing outside the task's leased paths.
 *
 * THE CHECK SAYS NOTHING ABOUT THE MAKER'S CLAIMS. It re-derives everything from git: the commit
 * exists, the diff stays inside the lease, and the test passes in a fresh checkout. Then come the
 * negative controls: the test must FAIL when the non-test part of the change is reverted, and when
 * each of the task's deliberate breaks is applied to the code under test. Deleting the test would
 * only prove the file went missing. Controls are only as strong as the breaks a task names; the
 * draft PR's human reviewer is still the judge of whether the test is good.
 *
 * CLONES. A commit exists only in the maker's clone until publish. Roles on one machine can share a
 * clone. Roles on separate machines move it as a verified bundle (t12-lane-transfer.ts). A check that
 * cannot get the commit reports NOT_CHECKED.
 *
 * EXECUTION IS THE RISK. `check` runs model-written code, and only inside the verified container in
 * t12-sandbox.ts. Without one the answer is NOT_CHECKED: this file has no way to run it on the host.
 * `npm ci --ignore-scripts` does run on the host, because it needs the network and runs no package code.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RoutedAnswer } from './t12-lane-route';
import { PublishRefused, submissionRefProblem, type Handle, type LaneSpec, type Verdict } from './t12-lane-store';
import type { LaneAdapters, MakeOutcome } from './t12-lane-runner';
import { dockerSandbox, type SandboxRunner } from './t12-sandbox';
import { exportSubmission, importSubmission } from './t12-lane-transfer';

export interface PrClient {
  findByBranch(repo: string, branch: string): string | null;
  createDraft(input: { repo: string; branch: string; title: string; body: string }): string;
}

export interface GitAdapterConfig {
  /** `owner/name` to a local clone whose `origin` is that repo. */
  repoDirs: Record<string, string>;
  workRoot: string;
  ask: (prompt: string, h: Handle) => Promise<RoutedAnswer>;
  allowExec: boolean;
  pr: PrClient;
  timeoutMs?: number;
  /** Where model-written code runs. Defaults to the verified container. */
  sandbox?: SandboxRunner;
  /** Set when roles run on separate machines: `outDir` on the maker, `inDir` on the checker and integrator. */
  transfer?: { outDir?: string; inDir?: string };
}

const MAX_CONTEXT_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 8_000;

class SandboxRefused extends Error {}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();

/**
 * Asynchronous on purpose: lanes share one event loop, and a blocking run here would stop every
 * other lane's heartbeat until its lease expired.
 */
function run(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; shell?: boolean }) {
  return new Promise<{ code: number | null; ranOut: boolean; reason: string | null; output: string }>((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, shell: opts.shell, encoding: 'utf8' }, (err, stdout, stderr) => {
      const raw = err ? (err as { code?: unknown }).code : 0;
      const code = typeof raw === 'number' ? raw : null;
      resolve({ code, ranOut: code === null, reason: code === null && err ? err.message : null, output: `${stdout}\n${stderr}`.slice(-MAX_OUTPUT_CHARS) });
    });
  });
}

function discard(canon: string, dir: string): void {
  // A real directory tree only: nothing here is ever a junction, so removal cannot escape it.
  rmSync(dir, { recursive: true, force: true });
  try {
    git(canon, 'worktree', 'prune');
  } catch {
    // The next prune picks it up.
  }
}

function canonDir(cfg: GitAdapterConfig, spec: LaneSpec): string {
  const d = cfg.repoDirs[spec.repo];
  if (!d) throw new Error(`no local clone configured for ${spec.repo}`);
  return d;
}

export function buildMakePrompt(spec: LaneSpec, context: Record<string, string>, lastRejection?: string): string {
  return [
    `Repository: ${spec.repo}. Task: ${spec.title}.`,
    spec.prompt,
    `Write exactly these files: ${spec.paths.join(', ')}.`,
    `The task is checked by running ${spec.verify.runner} on ${spec.verify.target}, which must pass with your files and fail without them.`,
    lastRejection ? `A previous attempt was rejected: ${lastRejection}` : '',
    ...Object.entries(context).map(([p, body]) => `--- ${p} ---\n${body}`),
    'Reply with one JSON object and nothing else: {"files":[{"path":"...","content":"..."}]}',
  ].filter(Boolean).join('\n\n');
}

/** Free models often leave raw newlines inside JSON strings. Escape those; touch nothing else. */
function escapeRawControls(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    out += inString && ch < ' ' ? JSON.stringify(ch).slice(1, -1) : ch;
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = inString;
    else if (ch === '"') inString = !inString;
  }
  return out;
}

type MakerFiles = Array<{ path: string; content: string }>;

/** Why a refused path is outside the lease, from the path alone. A closed set, so a record can carry it without the path. */
export type LeasePathCode = 'same_after_normalize' | 'escapes_root' | 'other_path';

/**
 * A label for a path the lease already refused; it admits nothing. Any `..` part or an absolute path is
 * escapes_root, checked first and never resolved, so `..\x` and `tests/../x` are never called the same as `x`.
 * Otherwise `./`, backslashes and repeated slashes are dropped and the result compared with the lease.
 */
export function leasePathCode(path: string, allowed: readonly string[]): LeasePathCode {
  const parts = path.split(/[\\/]/);
  if (/^([\\/]|[A-Za-z]:)/.test(path) || parts.includes('..')) return 'escapes_root';
  return allowed.includes(parts.filter((p) => p !== '' && p !== '.').join('/')) ? 'same_after_normalize' : 'other_path';
}

/**
 * The model's files or why not. Tolerates a code fence; refuses any path outside the lease by exact match, `./x`
 * included. The lane's code comes before the model's path in the reason, so a crafted path cannot forge the code.
 */
export function readMakerFiles(text: string, allowed: readonly string[]): { files: MakerFiles } | { reason: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { reason: 'no JSON object in the reply' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(escapeRawControls(text.slice(start, end + 1)));
  } catch (e) {
    return { reason: `invalid JSON: ${(e as Error).message.slice(0, 100)}` };
  }
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) return { reason: 'no files in the reply' };
  for (const f of files) {
    if (typeof f?.path !== 'string' || typeof f?.content !== 'string') return { reason: 'a file is missing its path or content' };
    if (!allowed.includes(f.path)) return { reason: `outside the lease (${leasePathCode(f.path, allowed)}): ${f.path.slice(0, 120)}` };
  }
  return { files: files as MakerFiles };
}

/** Only what a test runner needs. Every key and token in the parent environment stays behind. */
export function scrubbedEnv(home: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CI: '1', NODE_ENV: 'test', HOME: home, USERPROFILE: home, TEMP: home, TMP: home };
  for (const k of ['PATH', 'Path', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT']) {
    if (parent[k]) out[k] = parent[k];
  }
  return out;
}

/** No shell and no free-form command. passWithNoTests is forced off because a repo config can turn it on. */
export function verifyArgs(spec: LaneSpec): string[] {
  const { runner, target } = spec.verify;
  return runner === 'jest' ? ['node_modules/jest/bin/jest.js', '--ci', '--runInBand', '--passWithNoTests=false', target] : ['--test', target];
}

/** What a non-answer means to the runner. Null when the model did answer. */
export function askFailure(answer: RoutedAnswer): Extract<MakeOutcome, { ok: false }> | null {
  if (answer.outcome === 'no_capacity') return { ok: false, kind: 'no_capacity', until: answer.until, reason: answer.reason };
  if (answer.outcome === 'rate_limited') return { ok: false, kind: 'rate_limited', reason: `host ${answer.host ?? 'unknown'}` };
  if (answer.outcome === 'answered' && answer.text !== null) return null;
  // No host tried at all means configuration, which no amount of rerouting can fix.
  return answer.tried.length
    ? { ok: false, kind: 'route_failed', reason: `NOT_CHECKED: tried ${answer.tried.join(', ')}` }
    : { ok: false, kind: 'infra', reason: 'NOT_CHECKED: no free host is configured' };
}

export function createGitAdapters(cfg: GitAdapterConfig): LaneAdapters {
  const timeoutMs = cfg.timeoutMs ?? 5 * 60 * 1000;
  const sandbox = cfg.sandbox ?? dockerSandbox();

  /** A refusal is thrown so every call site reports NOT_CHECKED the same way. */
  async function runVerify(dir: string, spec: LaneSpec) {
    const args = verifyArgs(spec);
    const r = await sandbox({ dir, command: ['node', ...args], timeoutMs });
    if (r.kind === 'refused') throw new SandboxRefused(r.reason);
    return { cmd: `node ${args.join(' ')}`, code: r.code, ranOut: r.ranOut, reason: r.reason, output: r.output };
  }

  async function make(h: Handle, signal: AbortSignal): Promise<MakeOutcome> {
    const canon = canonDir(cfg, h.spec);
    const dir = join(cfg.workRoot, `make-${h.taskId}-e${h.epoch}`);
    const branch = `t12/${h.spec.id}-e${h.epoch}`;
    mkdirSync(cfg.workRoot, { recursive: true });
    git(canon, 'fetch', 'origin', 'main');
    const base = git(canon, 'rev-parse', 'origin/main');
    git(canon, 'worktree', 'add', '-q', '-b', branch, dir, base);
    let committed = false;
    try {
      const context: Record<string, string> = {};
      for (const p of h.spec.context ?? []) {
        const f = join(dir, p);
        if (existsSync(f)) context[p] = readFileSync(f, 'utf8').slice(0, MAX_CONTEXT_CHARS);
      }
      const answer = await cfg.ask(buildMakePrompt(h.spec, context, h.lastRejection), h);
      if (signal.aborted) return { ok: false, kind: 'infra', reason: 'lease lost while the model was answering' };
      const failure = askFailure(answer);
      if (failure) return failure;

      const read = readMakerFiles(answer.text!, h.spec.paths);
      if ('reason' in read) return { ok: false, kind: 'maker_failed', reason: `model output was not a valid file set inside the lease: ${read.reason}` };
      const { files } = read;

      for (const f of files) {
        const target = join(dir, f.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.content, 'utf8');
      }
      git(dir, 'add', '--', ...files.map((f) => f.path));
      if (!git(dir, 'diff', '--cached', '--name-only')) return { ok: false, kind: 'maker_failed', reason: 'the model produced no change' };
      git(dir, '-c', 'user.name=t12-lane', '-c', 'user.email=t12-lane@users.noreply.github.com',
        'commit', '-q', '-m', `t12(${h.spec.id}): ${h.spec.title}`);
      committed = true;
      const commit = git(dir, 'rev-parse', 'HEAD');
      const bundle = cfg.transfer?.outDir ? { bundle_sha256: exportSubmission(canon, cfg.transfer.outDir, h.spec, branch, base, commit) } : {};
      return { ok: true, submission: { branch, commit, base, files: files.map((f) => f.path), host: answer.host, ...bundle } };
    } finally {
      discard(canon, dir);
      if (!committed) git(canon, 'branch', '-q', '-D', branch);
    }
  }

  async function check(h: Handle): Promise<Verdict> {
    const sub = h.submission;
    if (!sub) return { outcome: 'not_checked', reason: 'no submission on the row' };
    const refProblem = submissionRefProblem(h.spec, sub);
    if (refProblem) return { outcome: 'rejected', reason: refProblem };
    const canon = canonDir(cfg, h.spec);
    if (cfg.transfer?.inDir) {
      const got = importSubmission(canon, cfg.transfer.inDir, h.spec, sub);
      if (!got.ok) return { outcome: got.outcome, reason: got.reason };
    }
    try {
      git(canon, 'cat-file', '-e', `${sub.commit}^{commit}`);
    } catch {
      return { outcome: 'not_checked', reason: `commit ${sub.commit} is not available on this host` };
    }
    const statuses = git(canon, 'diff', '--name-status', '--no-renames', sub.base, sub.commit).split('\n').filter(Boolean).map((l) => l.split('\t'));
    const changed = statuses.map(([, f]) => f!);
    const outside = changed.filter((f) => !h.spec.paths.includes(f));
    if (outside.length) return { outcome: 'rejected', reason: `wrote outside its lease: ${outside.join(', ')}` };
    // A green test proves nothing about what a replaced file used to cover.
    const replaced = statuses.filter(([st, f]) => st !== 'A' && !(h.spec.overwrites ?? []).includes(f!)).map(([, f]) => f);
    if (replaced.length) return { outcome: 'rejected', reason: `replaced existing work the task did not name: ${replaced.join(', ')}` };
    if (!changed.includes(h.spec.verify.target)) return { outcome: 'rejected', reason: `verify target ${h.spec.verify.target} is not in the diff` };
    if (!cfg.allowExec) return { outcome: 'not_checked', reason: 'execution of model-written code is not allowed on this host' };

    const dir = join(cfg.workRoot, `check-${h.taskId}-e${h.epoch}`);
    const home = join(cfg.workRoot, `home-${h.taskId}-e${h.epoch}`);
    mkdirSync(home, { recursive: true });
    git(canon, 'worktree', 'add', '-q', '--detach', dir, sub.commit);
    try {
      const env = scrubbedEnv(home);
      if (existsSync(join(dir, 'package-lock.json'))) {
        const npm = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
          { cwd: dir, env, timeoutMs, shell: process.platform === 'win32' });
        if (npm.code !== 0) return { outcome: 'not_checked', reason: `npm ci failed: ${npm.output.slice(-300)}` };
      }
      const pass = await runVerify(dir, h.spec);
      if (pass.ranOut) return { outcome: 'not_checked', reason: `verify did not finish: ${pass.reason ?? 'timed out'}` };
      if (pass.code !== 0) return { outcome: 'rejected', reason: `verify failed with exit ${pass.code}: ${pass.output.slice(-600)}` };

      // Negative controls: each must turn the same test red.
      const controls: Array<{ control: string; exit: number | null }> = [];
      const expectRed = async (label: string): Promise<Verdict | null> => {
        const c = await runVerify(dir, h.spec);
        if (c.ranOut) return { outcome: 'not_checked', reason: `control "${label}" did not finish: ${c.reason ?? 'timed out'}` };
        if (c.code === 0) return { outcome: 'rejected', reason: `vacuous: the test still passes with ${label}` };
        controls.push({ control: label, exit: c.code });
        return null;
      };

      const code = sub.files.filter((f) => f !== h.spec.verify.target);
      if (code.length > 0) {
        for (const f of code) {
          if (git(dir, 'ls-tree', '--name-only', sub.base, '--', f)) git(dir, 'checkout', '-q', sub.base, '--', f);
          else rmSync(join(dir, f), { force: true });
        }
        const failed = await expectRed('the code change reverted');
        if (failed) return failed;
        git(dir, 'checkout', '-q', sub.commit, '--', ...code);
      }
      for (const c of h.spec.verify.controls ?? []) {
        const f = join(dir, c.file);
        const original = existsSync(f) ? readFileSync(f, 'utf8') : '';
        if (!original.includes(c.find)) return { outcome: 'not_checked', reason: `control on ${c.file} no longer applies` };
        writeFileSync(f, original.split(c.find).join(c.replace), 'utf8');
        const failed = await expectRed(`${c.file} deliberately broken`);
        if (failed) return failed;
        writeFileSync(f, original, 'utf8');
      }
      if (controls.length === 0) return { outcome: 'not_checked', reason: 'no negative control ran' };

      const transcript = `${pass.cmd} at ${sub.commit} exited 0. Controls: ${controls.map((c) => `${c.control} exited ${c.exit}`).join('; ')}.\n${pass.output}`;
      return { outcome: 'approved', commit: sub.commit, transcript, evidence: { commit: sub.commit, cmd: pass.cmd, exit: pass.code, controls } };
    } catch (e) {
      if (e instanceof SandboxRefused) return { outcome: 'not_checked', reason: `no sandbox, so the code was not run: ${e.message}` };
      throw e;
    } finally {
      discard(canon, dir);
      rmSync(home, { recursive: true, force: true });
    }
  }

  async function publish(h: Handle): Promise<{ url: string }> {
    const sub = h.submission!;
    const refProblem = submissionRefProblem(h.spec, sub);
    if (refProblem) throw new PublishRefused(refProblem);
    const existing = cfg.pr.findByBranch(h.spec.repo, sub.branch);
    if (existing) return { url: existing };
    if (cfg.transfer?.inDir) {
      const got = importSubmission(canonDir(cfg, h.spec), cfg.transfer.inDir, h.spec, sub);
      if (!got.ok) throw new PublishRefused(got.reason);
    }
    git(canonDir(cfg, h.spec), 'push', 'origin', `${sub.commit}:refs/heads/${sub.branch}`);
    const body = `T12 lane deliverable for ${h.spec.id}. Checked by a fresh-checkout re-run at ${sub.commit}, with a negative control. That proves the test passes with this change and fails without it, not that the test is good. Review before merging.`;
    return { url: cfg.pr.createDraft({ repo: h.spec.repo, branch: sub.branch, title: `t12(${h.spec.id}): ${h.spec.title}`, body }) };
  }

  return { make, check, publish };
}

/** The real PR client. Separate so a test never reaches GitHub. */
export const ghPrClient: PrClient = {
  findByBranch(repo, branch) {
    const out = execFileSync('gh', ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'url', '--jq', '.[0].url // ""'], { encoding: 'utf8' }).trim();
    return out || null;
  },
  createDraft({ repo, branch, title, body }) {
    return execFileSync('gh', ['pr', 'create', '--draft', '--repo', repo, '--head', branch, '--base', 'main', '--title', title, '--body', body], { encoding: 'utf8' }).trim();
  },
};
