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

/** Commits on `base` after `fork`, each with the PR number from its squash subject and the files it touched. */
export function mergedSince(dir: string, fork: string, base: string): MergedChange[] | null {
  const out = run('git', ['log', '--no-renames', '--format=@@%H%x09%s', '--name-only', `${fork}..${base}`], dir);
  if (out === null) return null;
  const changes: MergedChange[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      const [sha, ...subject] = line.slice(2).split('\t');
      changes.push({ sha: sha ?? '', pr: prFromSubject(subject.join('\t')), files: [] });
    } else if (line.trim() && changes.length) changes[changes.length - 1]!.files.push(line.trim());
  }
  return changes;
}

function openPrs(dir: string, repo: string, exclude: (p: { number: number; headRefName: string }) => boolean): OpenPr[] | null {
  const out = run('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,headRefName,files'], dir);
  if (out === null) return null;
  try {
    const rows = JSON.parse(out) as { number: number; title: string; headRefName: string; files: { path: string }[] | null }[];
    return rows.filter((p) => !exclude(p)).map((p) => ({ number: p.number, title: p.title, files: (p.files ?? []).map((x) => x.path) }));
  } catch {
    return null;
  }
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

async function main(): Promise<void> {
  const dir = flag('dir') ?? process.cwd();
  const base = flag('base') ?? 'main';
  const prNumber = flag('pr') ? Number(flag('pr')) : undefined;
  const repo = flag('github') ?? repoFromRemote(dir) ?? '';
  if (!has('no-fetch')) run('git', ['fetch', '-q', 'origin', base], dir);
  const baseRef = `origin/${base}`;
  const baseSha = run('git', ['rev-parse', baseRef], dir) ?? '';

  let head = 'HEAD';
  let files: string[];
  let body: string | null = null;
  let author: string | undefined;
  let self: (p: { number: number; headRefName: string }) => boolean;

  if (prNumber !== undefined) {
    const view = run('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body,files,author'], dir);
    const pr = view ? (JSON.parse(view) as { body: string; files: { path: string }[]; author: { login: string } }) : null;
    head = `refs/preflight/pr-${prNumber}`;
    run('git', ['fetch', '-q', 'origin', `+refs/pull/${prNumber}/head:${head}`], dir);
    files = (pr?.files ?? []).map((f) => f.path);
    body = pr?.body ?? null;
    author = pr?.author.login;
    self = (p) => p.number === prNumber;
  } else {
    const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir) ?? '';
    self = (p) => p.headRefName === branch;
    files = [];
  }
  const forkSha = run('git', ['merge-base', head, baseRef], dir) ?? '';
  if (prNumber === undefined) {
    const planned = flag('files');
    files = planned
      ? planned.split(',').map((x) => x.trim()).filter(Boolean)
      : [...new Set([...lines(run('git', ['diff', '--name-only', forkSha], dir)), ...lines(run('git', ['ls-files', '--others', '--exclude-standard'], dir))])];
  }

  const taskId = flag('task') ? Number(flag('task')) : taskFromBody(body);
  const facts: PreflightFacts = {
    agent: flag('agent') ?? /^\s*agent:\s*(\S+)\s*$/im.exec(body ?? '')?.[1] ?? author ?? 'unknown',
    baseSha,
    forkSha,
    files,
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
  if (summary) {
    // Backslashes first, or a reason ending in "\" would escape the cell's closing pipe.
    const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    const rows = result.checks.map((c) => `| ${c.status} | ${c.name} | ${cell(c.reason)} |`).join('\n');
    appendFileSync(summary, `## Preflight: ${result.verdict}${advisory ? ' (advisory)' : ''}\n\n| Status | Check | Why |\n|---|---|---|\n${rows}\n`);
  }
  if (advisory) process.exit(0);
  process.exit(result.verdict === 'FAIL' ? 1 : result.verdict === 'NOT_CHECKED' ? 3 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`NOT_CHECKED: preflight crashed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(has('advisory') ? 0 : 3);
  });
}
