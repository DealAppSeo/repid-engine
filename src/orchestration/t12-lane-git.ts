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
 * exists, the diff stays inside the lease, the test passes in a fresh checkout, and the same test
 * FAILS without the deliverable, so a test that passes on nothing cannot approve itself. It does
 * not prove the test is good; that is what the draft PR's human reviewer is for.
 *
 * EXECUTION IS THE RISK. `check` runs model-written code. It is refused unless `allowExec` is set,
 * runs with a stripped environment and never runs install scripts, but that is not a sandbox: arm
 * it only on an ephemeral runner holding no secrets.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { T12AskResult } from './t12-attempt';
import type { Handle, LaneSpec, Verdict } from './t12-lane-store';
import type { LaneAdapters, MakeOutcome } from './t12-lane-runner';

export interface PrClient {
  findByBranch(repo: string, branch: string): string | null;
  createDraft(input: { repo: string; branch: string; title: string; body: string }): string;
}

export interface GitAdapterConfig {
  /** `owner/name` to a local clone whose `origin` is that repo. */
  repoDirs: Record<string, string>;
  workRoot: string;
  ask: (prompt: string) => Promise<T12AskResult>;
  allowExec: boolean;
  pr: PrClient;
  timeoutMs?: number;
}

const MAX_CONTEXT_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 8_000;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

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

/** The model's files, or null. Tolerates a code fence; refuses any path outside the lease. */
export function parseMakerFiles(text: string, allowed: readonly string[]): Array<{ path: string; content: string }> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) return null;
  for (const f of files) {
    if (typeof f?.path !== 'string' || typeof f?.content !== 'string' || !allowed.includes(f.path)) return null;
  }
  return files as Array<{ path: string; content: string }>;
}

/** Only what a test runner needs. Every key and token in the parent environment stays behind. */
export function scrubbedEnv(home: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CI: '1', NODE_ENV: 'test', HOME: home, USERPROFILE: home, TEMP: home, TMP: home };
  for (const k of ['PATH', 'Path', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT']) {
    if (parent[k]) out[k] = parent[k];
  }
  return out;
}

function runVerify(dir: string, spec: LaneSpec, env: NodeJS.ProcessEnv, timeoutMs: number) {
  const { runner, target } = spec.verify;
  const args = runner === 'jest' ? ['node_modules/jest/bin/jest.js', '--ci', '--runInBand', target] : ['--test', target];
  const r = spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.slice(-MAX_OUTPUT_CHARS);
  return { cmd: `node ${args.join(' ')}`, code: r.status, ranOut: !!r.error || r.status === null, reason: r.error?.message ?? null, output };
}

export function createGitAdapters(cfg: GitAdapterConfig): LaneAdapters {
  const timeoutMs = cfg.timeoutMs ?? 10 * 60 * 1000;

  async function make(h: Handle, signal: AbortSignal): Promise<MakeOutcome> {
    const canon = canonDir(cfg, h.spec);
    const dir = join(cfg.workRoot, `make-${h.taskId}-e${h.epoch}`);
    const branch = `t12/${h.spec.id}-e${h.epoch}`;
    mkdirSync(cfg.workRoot, { recursive: true });
    git(canon, 'fetch', 'origin', 'main');
    const base = git(canon, 'rev-parse', 'origin/main');
    git(canon, 'worktree', 'add', '-q', '-b', branch, dir, base);
    try {
      const context: Record<string, string> = {};
      for (const p of h.spec.context ?? []) {
        const f = join(dir, p);
        if (existsSync(f)) context[p] = readFileSync(f, 'utf8').slice(0, MAX_CONTEXT_CHARS);
      }
      const answer = await cfg.ask(buildMakePrompt(h.spec, context, h.lastRejection));
      if (signal.aborted) return { ok: false, kind: 'infra', reason: 'lease lost while the model was answering' };
      if (answer.outcome === 'rate_limited') return { ok: false, kind: 'rate_limited', reason: `host ${answer.host ?? 'unknown'}` };
      if (answer.outcome !== 'answered' || answer.text === null) return { ok: false, kind: 'infra', reason: 'NOT_CHECKED: no free host answered' };

      const files = parseMakerFiles(answer.text, h.spec.paths);
      if (!files) return { ok: false, kind: 'maker_failed', reason: 'model output was not a valid file set inside the lease' };

      for (const f of files) {
        const target = join(dir, f.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.content, 'utf8');
      }
      git(dir, 'add', '--', ...files.map((f) => f.path));
      git(dir, '-c', 'user.name=t12-lane', '-c', 'user.email=t12-lane@users.noreply.github.com',
        'commit', '-q', '-m', `t12(${h.spec.id}): ${h.spec.title}`);
      return { ok: true, submission: { branch, commit: git(dir, 'rev-parse', 'HEAD'), base, files: files.map((f) => f.path), host: answer.host } };
    } finally {
      discard(canon, dir);
    }
  }

  async function check(h: Handle): Promise<Verdict> {
    const sub = h.submission;
    if (!sub) return { outcome: 'not_checked', reason: 'no submission on the row' };
    const canon = canonDir(cfg, h.spec);
    try {
      git(canon, 'cat-file', '-e', `${sub.commit}^{commit}`);
    } catch {
      return { outcome: 'rejected', reason: `commit ${sub.commit} does not exist` };
    }
    const changed = git(canon, 'diff', '--name-only', sub.base, sub.commit).split('\n').filter(Boolean);
    const outside = changed.filter((f) => !h.spec.paths.includes(f));
    if (outside.length) return { outcome: 'rejected', reason: `wrote outside its lease: ${outside.join(', ')}` };
    if (!changed.includes(h.spec.verify.target)) return { outcome: 'rejected', reason: `verify target ${h.spec.verify.target} is not in the diff` };
    if (!cfg.allowExec) return { outcome: 'not_checked', reason: 'execution of model-written code is not allowed on this host' };

    const dir = join(cfg.workRoot, `check-${h.taskId}-e${h.epoch}`);
    const home = join(cfg.workRoot, `home-${h.taskId}-e${h.epoch}`);
    mkdirSync(home, { recursive: true });
    git(canon, 'worktree', 'add', '-q', '--detach', dir, sub.commit);
    try {
      const env = scrubbedEnv(home);
      if (existsSync(join(dir, 'package-lock.json'))) {
        const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
          { cwd: dir, env, encoding: 'utf8', timeout: timeoutMs, shell: process.platform === 'win32' });
        if (npm.status !== 0) return { outcome: 'not_checked', reason: `npm ci failed: ${String(npm.stderr).slice(-300)}` };
      }
      const pass = runVerify(dir, h.spec, env, timeoutMs);
      if (pass.ranOut) return { outcome: 'not_checked', reason: `verify did not finish: ${pass.reason ?? 'timed out'}` };
      if (pass.code !== 0) return { outcome: 'rejected', reason: `verify failed with exit ${pass.code}: ${pass.output.slice(-600)}` };

      // Negative control: the same check, with the deliverable removed.
      for (const f of sub.files) {
        if (git(dir, 'ls-tree', '--name-only', sub.base, '--', f)) git(dir, 'checkout', '-q', sub.base, '--', f);
        else rmSync(join(dir, f), { force: true });
      }
      const control = runVerify(dir, h.spec, env, timeoutMs);
      if (control.ranOut) return { outcome: 'not_checked', reason: `negative control did not finish: ${control.reason ?? 'timed out'}` };
      if (control.code === 0) return { outcome: 'rejected', reason: 'vacuous: verify also passes without the deliverable' };

      const transcript = `${pass.cmd} at ${sub.commit} exited 0; without the deliverable it exited ${control.code}.\n${pass.output}`;
      return { outcome: 'approved', commit: sub.commit, transcript, evidence: { commit: sub.commit, cmd: pass.cmd, exit: pass.code, control_exit: control.code } };
    } finally {
      discard(canon, dir);
      rmSync(home, { recursive: true, force: true });
    }
  }

  async function publish(h: Handle): Promise<{ url: string }> {
    const sub = h.submission!;
    const existing = cfg.pr.findByBranch(h.spec.repo, sub.branch);
    if (existing) return { url: existing };
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
