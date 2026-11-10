/**
 * Preflight: run it before writing, and on every pull request. The rules are in
 * src/orchestration/preflight.ts; this file only gathers the facts.
 *
 *   Before work (any agent, any repo checkout):
 *     npx ts-node --transpile-only scripts/preflight.ts --dir <repo checkout> [--files a,b] [--task <id> --epoch <n>] [--agent <name>]
 *   On a pull request (CI):
 *     npx ts-node --transpile-only scripts/preflight.ts --dir <checkout> --pr <n> --github owner/name --advisory
 *
 * Reads: git, the GitHub CLI (`gh`), and the task row in trinity_tasks only when --task is given and
 * DATABASE_URL is set (a SELECT; nothing is written anywhere). A source that cannot be read makes its
 * check NOT_CHECKED.
 *
 * Exit: 0 PASS or WARN · 1 FAIL · 3 NOT_CHECKED. --advisory always exits 0 and says so.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  evaluatePreflight,
  formatPreflight,
  prFromSubject,
  summaryMarkdown,
  taskFromBody,
  type MergedChange,
  type OpenPr,
  type PreflightFacts,
  type TaskClaim,
} from '../src/orchestration/preflight';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name: string): boolean => argv.includes(`--${name}`);

function run(cmd: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

const lines = (s: string | null): string[] => (s ? s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : []);
const nulSeparated = (s: string | null): string[] | null => (s === null ? null : s.split('\0').filter(Boolean));

/** git prints non-ASCII paths as octal escapes unless told not to, and then they never equal GitHub's. */
const GIT_RAW = ['-c', 'core.quotePath=false'];

/** git still C-quotes a path holding a quote, a backslash or a control character. Undo that exactly. */
export function unquoteGitPath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const esc: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') bytes.push(...Buffer.from(c, 'utf8'));
    else if (/[0-7]/.test(body[i + 1] ?? '')) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      const n = body[i + 1] ?? '';
      bytes.push(esc[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Commits on `base` after `fork`, each with the PR number from its squash subject and the files it touched. */
export function mergedSince(dir: string, fork: string, base: string): MergedChange[] | null {
  const out = run('git', [...GIT_RAW, 'log', '--no-renames', '--format=@@%H%x09%s', '--name-only', `${fork}..${base}`], dir);
  if (out === null) return null;
  const changes: MergedChange[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      const [sha, ...subject] = line.slice(2).split('\t');
      changes.push({ sha: sha ?? '', pr: prFromSubject(subject.join('\t')), files: [] });
    } else if (line.trim() && changes.length) changes[changes.length - 1]!.files.push(unquoteGitPath(line.trim()));
  }
  return changes;
}

/** Every file of one PR, exactly as GitHub names it (JSON per line, so a newline in a name survives). */
function prFiles(dir: string, repo: string, n: number): string[] | null {
  const out = run('gh', ['api', '--paginate', `repos/${repo}/pulls/${n}/files`, '--jq', '.[].filename | @json'], dir);
  if (out === null) return null;
  try {
    return lines(out).map((l) => JSON.parse(l) as string);
  } catch {
    return null;
  }
}

export const OPEN_PR_LIMIT = 1000;

/**
 * Other open PRs and their files. `gh pr list` gives at most 100 files per PR and at most `limit` PRs and
 * drops the rest without saying so, so a short read is filled from the API or, failing that, is null:
 * a partial list is never "no other open PR touches these files".
 */
export function parseOpenPrs(
  out: string | null,
  exclude: (p: { number: number; headRefName: string }) => boolean,
  fetchFiles: (n: number) => string[] | null,
  limit = OPEN_PR_LIMIT,
): OpenPr[] | null {
  if (out === null) return null;
  let rows: { number: number; title: string; headRefName: string; files: { path: string }[] | null; changedFiles: number }[];
  try {
    rows = JSON.parse(out);
  } catch {
    return null;
  }
  if (rows.length >= limit) return null;
  const result: OpenPr[] = [];
  for (const p of rows.filter((r) => !exclude(r))) {
    let files = (p.files ?? []).map((x) => x.path);
    if (files.length < p.changedFiles) {
      const all = fetchFiles(p.number);
      if (all === null || all.length < p.changedFiles) return null;
      files = all;
    }
    result.push({ number: p.number, title: p.title, files });
  }
  return result;
}

function openPrs(dir: string, repo: string, exclude: (p: { number: number; headRefName: string }) => boolean): OpenPr[] | null {
  const out = run('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(OPEN_PR_LIMIT), '--json', 'number,title,headRefName,files,changedFiles'], dir);
  return parseOpenPrs(out, exclude, (n) => prFiles(dir, repo, n));
}

function repoFromRemote(dir: string): string | null {
  const url = run('git', ['remote', 'get-url', 'origin'], dir);
  const m = url ? /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url) : null;
  return m ? m[1]! : null;
}

/** The task row as the lanes keep it. Only a SELECT, and only when the caller already has DATABASE_URL. */
async function readClaim(taskId: number): Promise<{ claim?: TaskClaim; unreadable?: string }> {
  const url = process.env['DATABASE_URL'];
  if (!url) return { unreadable: 'DATABASE_URL is not set, so the queue could not be read' };
  try {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
    try {
      const { rows } = await pool.query(`SELECT claimed_by, expires_at, metadata -> 't12' AS t12 FROM trinity_tasks WHERE id = $1`, [taskId]);
      const row = rows[0] as { claimed_by: string | null; expires_at: Date | string | null; t12: { epoch?: number; spec?: { paths?: string[] } } | null } | undefined;
      if (!row) return { claim: { taskId, holder: null, leaseExpiresAt: null, epoch: null, scope: [] } };
      const expires = row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at;
      return { claim: { taskId, holder: row.claimed_by, leaseExpiresAt: expires, epoch: row.t12?.epoch ?? null, scope: row.t12?.spec?.paths ?? [] } };
    } finally {
      await pool.end();
    }
  } catch (e) {
    return { unreadable: `the queue could not be read (${e instanceof Error ? e.message.split('\n')[0] : 'error'})` };
  }
}

/**
 * Who is asking. On a PR it is the PR's author as GitHub authenticated it, never a name the PR body or a
 * flag asserts: otherwise any PR could claim to be the lane that holds the lease. Locally the caller
 * names itself, which proves nothing about identity and is only for its own early warning.
 */
export function agentIdentity(prMode: boolean, flagged: string | undefined, prAuthor: string | undefined): string {
  if (prMode) return prAuthor ?? 'unknown';
  return flagged ?? 'unknown';
}

/**
 * The target branch's tip after a fetch. A fetch that fails, or is skipped, leaves the local copy as
 * it was, which may be behind the remote: `unrefreshed` says so, and fresh_base cannot then pass.
 */
export function refreshBase(dir: string, base: string, noFetch: boolean): { baseRef: string; baseSha: string; unrefreshed?: string } {
  const baseRef = `origin/${base}`;
  let unrefreshed: string | undefined;
  if (noFetch) unrefreshed = `${baseRef} was not refreshed (--no-fetch), so it may be behind the remote`;
  else if (run('git', ['fetch', '-q', 'origin', base], dir) === null) unrefreshed = `could not refresh ${baseRef} from the remote, so it may be behind`;
  return { baseRef, baseSha: run('git', ['rev-parse', baseRef], dir) ?? '', unrefreshed };
}

async function main(): Promise<void> {
  const dir = flag('dir') ?? process.cwd();
  const base = flag('base') ?? 'main';
  const prNumber = flag('pr') ? Number(flag('pr')) : undefined;
  const repo = flag('github') ?? repoFromRemote(dir) ?? '';
  const { baseRef, baseSha, unrefreshed } = refreshBase(dir, base, has('no-fetch'));

  let head = 'HEAD';
  let files: string[] = [];
  let filesUnreadable: string | undefined;
  let body: string | null = null;
  let author: string | undefined;
  let self: (p: { number: number; headRefName: string }) => boolean;

  if (prNumber !== undefined) {
    const view = run('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body,author,changedFiles'], dir);
    let pr: { body: string; author: { login: string }; changedFiles: number } | null = null;
    try {
      pr = view ? JSON.parse(view) : null;
    } catch {
      pr = null;
    }
    head = `refs/preflight/pr-${prNumber}`;
    run('git', ['fetch', '-q', 'origin', `+refs/pull/${prNumber}/head:${head}`], dir);
    const listed = prFiles(dir, repo, prNumber);
    files = listed ?? [];
    if (!pr || listed === null) filesUnreadable = `could not read the files of PR #${prNumber}`;
    else if (listed.length !== pr.changedFiles) filesUnreadable = `read ${listed.length} of the ${pr.changedFiles} files in PR #${prNumber}`;
    body = pr?.body ?? null;
    author = pr?.author.login;
    self = (p) => p.number === prNumber;
  } else {
    const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir) ?? '';
    self = (p) => p.headRefName === branch;
  }
  const forkSha = run('git', ['merge-base', head, baseRef], dir) ?? '';
  if (prNumber === undefined) {
    const planned = flag('files');
    if (planned) files = planned.split(',').map((x) => x.trim()).filter(Boolean);
    else {
      // -z gives each path verbatim, so a newline in a name cannot split it into two.
      const changed = forkSha ? nulSeparated(run('git', [...GIT_RAW, 'diff', '--name-only', '-z', forkSha], dir)) : null;
      const untracked = nulSeparated(run('git', [...GIT_RAW, 'ls-files', '-z', '--others', '--exclude-standard'], dir));
      if (changed === null || untracked === null) filesUnreadable = `could not read the files this work touches under ${dir}`;
      files = [...new Set([...(changed ?? []), ...(untracked ?? [])])];
    }
  }

  const taskId = flag('task') ? Number(flag('task')) : taskFromBody(body);
  const facts: PreflightFacts = {
    agent: agentIdentity(prNumber !== undefined, flag('agent'), author),
    baseSha,
    baseUnrefreshed: unrefreshed,
    forkSha,
    files,
    filesUnreadable,
    mergedSince: baseSha && forkSha ? mergedSince(dir, forkSha, baseRef) : null,
    openPrs: repo ? openPrs(dir, repo, self) : null,
    taskId,
    heldEpoch: flag('epoch') !== undefined ? Number(flag('epoch')) : undefined,
    now: new Date(),
  };
  if (taskId !== undefined) {
    const read = await readClaim(taskId);
    facts.claim = read.claim;
    facts.claimUnreadable = read.unreadable;
  }

  const result = evaluatePreflight(facts);
  const advisory = has('advisory');
  const text = `${formatPreflight(result)}${advisory ? '\nADVISORY: this check reports and never blocks.' : ''}`;
  console.log(has('json') ? JSON.stringify({ ...result, advisory, repo, baseSha, forkSha, files }, null, 2) : text);
  const summary = flag('summary') ?? process.env['GITHUB_STEP_SUMMARY'];
  if (summary) appendFileSync(summary, summaryMarkdown(result, advisory));
  if (advisory) process.exit(0);
  process.exit(result.verdict === 'FAIL' ? 1 : result.verdict === 'NOT_CHECKED' ? 3 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`NOT_CHECKED: preflight crashed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(has('advisory') ? 0 : 3);
  });
}
