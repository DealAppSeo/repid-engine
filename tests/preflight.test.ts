/**
 * The shared start-of-work contract (src/orchestration/preflight.ts). Each case is a way work has gone
 * wrong or could: the first one replays the 2026-11-09 Codex run, which started from the commit before
 * trustshell #692 and rewrote five files #692 had already changed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePreflight, formatPreflight, prFromSubject, summaryMarkdown, taskFromBody, type PreflightFacts } from '../src/orchestration/preflight';
import { mergedSince, parseOpenPrs, unquoteGitPath } from '../scripts/preflight';

const NOW = new Date('2026-11-09T20:00:00Z');
const FORK = '41503778a769117c3a6b6a1622e9779b5bd6e427';
const TIP = 'd930f20281a0dcbd15c7f92b7c2d593362331164';

const facts = (over: Partial<PreflightFacts> = {}): PreflightFacts => ({
  agent: 'claude',
  baseSha: TIP,
  forkSha: TIP,
  files: ['app/page.tsx'],
  mergedSince: [],
  openPrs: [],
  taskId: 7,
  claim: { taskId: 7, holder: 'claude', leaseExpiresAt: '2026-11-09T21:00:00Z', epoch: 3, scope: ['app/**'] },
  heldEpoch: 3,
  now: NOW,
  ...over,
});
const status = (f: PreflightFacts, name: string) => evaluatePreflight(f).checks.find((c) => c.name === name)!;

describe('preflight: fresh base', () => {
  it('replays the Codex run: work started before #692 and touches files #692 changed, so it fails and names #692', () => {
    const codexFiles = [
      'README.md', 'app/build/page.tsx', 'app/inspect/page.tsx', 'app/page.tsx', 'app/vision/page.tsx', 'components/build/charts.tsx',
      'docs/challenge.md', 'docs/recipes/mcp-clients/README.md', 'lib/first-run.ts', 'lib/npm-latest.ts', 'tests/inspect-demo-copy.test.ts', 'tests/site-npm-badge.test.ts',
    ];
    const merged = [{ sha: TIP, pr: 692, files: ['app/build/page.tsx', 'app/page.tsx', 'app/vision/page.tsx', 'lib/npm-latest.ts', 'tests/site-npm-badge.test.ts', '.mcp.json'] }];
    const r = evaluatePreflight(facts({ forkSha: FORK, files: codexFiles, mergedSince: merged }));
    const c = r.checks.find((x) => x.name === 'fresh_base')!;
    expect(c.status).toBe('FAIL');
    expect(c.reason).toContain('#692');
    expect(c.reason).toContain('app/page.tsx');
    expect(r.verdict).toBe('FAIL');
  });

  it('passes when the work starts from the current tip', () => {
    expect(status(facts(), 'fresh_base').status).toBe('PASS');
  });

  it('warns, and does not fail, when main moved but touched none of these files', () => {
    const c = status(facts({ forkSha: FORK, mergedSince: [{ sha: TIP, pr: 9, files: ['docs/other.md'] }] }), 'fresh_base');
    expect(c.status).toBe('WARN');
  });

  it('is NOT_CHECKED, never a pass, when the history could not be read', () => {
    const r = evaluatePreflight(facts({ forkSha: FORK, mergedSince: null }));
    expect(r.checks.find((x) => x.name === 'fresh_base')!.status).toBe('NOT_CHECKED');
    expect(r.verdict).toBe('NOT_CHECKED');
  });

  it('is NOT_CHECKED, not PASS, when neither SHA could be resolved (two empty strings are equal)', () => {
    const c = status(facts({ baseSha: '', forkSha: '' }), 'fresh_base');
    expect(c.status).toBe('NOT_CHECKED');
  });

  it('matches a Windows path against a merged POSIX path', () => {
    const c = status(facts({ forkSha: FORK, files: ['app\\page.tsx'], mergedSince: [{ sha: TIP, pr: 692, files: ['app/page.tsx'] }] }), 'fresh_base');
    expect(c.status).toBe('FAIL');
  });
});

describe('preflight: duplicate work', () => {
  it('fails when another open PR touches the same file, and names it', () => {
    const c = status(facts({ openPrs: [{ number: 693, title: 'x', files: ['app/page.tsx'] }] }), 'duplicate_work');
    expect(c.status).toBe('FAIL');
    expect(c.reason).toContain('#693');
  });
  it('passes when open PRs touch other files', () => {
    expect(status(facts({ openPrs: [{ number: 693, title: 'x', files: ['lib/x.ts'] }] }), 'duplicate_work').status).toBe('PASS');
  });
  it('is NOT_CHECKED when the PR list could not be read', () => {
    expect(status(facts({ openPrs: null }), 'duplicate_work').status).toBe('NOT_CHECKED');
  });
});

describe('preflight: claim, lease, fencing and scope', () => {
  it('passes for the claim holder inside an unexpired lease, at its own epoch, inside scope', () => {
    const r = evaluatePreflight(facts());
    expect(r.checks.map((c) => c.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
    expect(r.verdict).toBe('PASS');
  });
  it('fails every task leg when no task is named: work without a claim', () => {
    const r = evaluatePreflight(facts({ taskId: undefined, claim: undefined }));
    for (const name of ['claim', 'lease', 'fencing', 'scope']) expect(r.checks.find((c) => c.name === name)!.status).toBe('FAIL');
  });
  it('is NOT_CHECKED when a task is named but the queue cannot be read', () => {
    const r = evaluatePreflight(facts({ claim: undefined, claimUnreadable: 'DATABASE_URL is not set' }));
    expect(r.checks.find((c) => c.name === 'claim')!.status).toBe('NOT_CHECKED');
    expect(r.checks.find((c) => c.name === 'claim')!.reason).toContain('DATABASE_URL');
  });
  it('fails when someone else holds the claim', () => {
    const c = facts().claim!;
    expect(status(facts({ claim: { ...c, holder: 'trinity-lane-2' } }), 'claim').status).toBe('FAIL');
  });
  it('fails on an expired lease', () => {
    const c = facts().claim!;
    expect(status(facts({ claim: { ...c, leaseExpiresAt: '2026-11-09T19:59:59Z' } }), 'lease').status).toBe('FAIL');
  });
  it('fails when the row moved to a newer epoch: the agent was fenced out', () => {
    expect(status(facts({ heldEpoch: 2 }), 'fencing').status).toBe('FAIL');
  });
  it('is NOT_CHECKED when the agent does not say which epoch it holds', () => {
    expect(status(facts({ heldEpoch: undefined }), 'fencing').status).toBe('NOT_CHECKED');
  });
  it('fails a file outside the task scope and names it', () => {
    const c = status(facts({ files: ['app/page.tsx', 'lib/npm-latest.ts'] }), 'scope');
    expect(c.status).toBe('FAIL');
    expect(c.reason).toContain('lib/npm-latest.ts');
  });
  it('is NOT_CHECKED when the task names no scope', () => {
    const c = facts().claim!;
    expect(status(facts({ claim: { ...c, scope: [] } }), 'scope').status).toBe('NOT_CHECKED');
  });
});

describe('preflight: permission', () => {
  it('warns on owner-only paths such as a migration', () => {
    const c = status(facts({ files: ['migrations/2026-11-09_x.sql'], claim: { ...facts().claim!, scope: ['migrations/**'] } }), 'permission');
    expect(c.status).toBe('WARN');
  });
});

describe('preflight: nothing to check', () => {
  it('reports the file legs NOT_CHECKED, never PASS, when there are no files', () => {
    const r = evaluatePreflight(facts({ files: [] }));
    for (const name of ['duplicate_work', 'scope', 'permission']) expect(r.checks.find((c) => c.name === name)!.status).toBe('NOT_CHECKED');
    expect(r.verdict).toBe('NOT_CHECKED');
  });
});

describe('preflight: the job summary', () => {
  it('keeps a hostile file name inside its cell: no new row, heading or link', () => {
    const name = 'x\n| PASS | claim | forged |\n## Preflight: PASS\n[click](https://evil.example)\\.sql';
    // Scope app/** puts the name in the scope leg's reason, so it really reaches the summary.
    const md = summaryMarkdown(evaluatePreflight(facts({ files: [name], claim: { ...facts().claim!, scope: ['app/**'] } })), true);
    expect(md).toContain('forged');
    const rows = md.split('\n').filter((l) => l.startsWith('|'));
    expect(rows).toHaveLength(2 + 7); // header, separator, one row per check
    expect(md.match(/^## /gm)).toHaveLength(1);
    expect(md).not.toMatch(/(?<!\\)\[click(?<!\\)\]/);
    expect(md).not.toContain('](https');
  });
});

describe('preflight: hostile and incomplete inputs', () => {
  const hostile = 'migrations/foo\n::error::forged\nbar.ts';

  it('never lets a path start a new log line, so it cannot forge a workflow command', () => {
    const out = formatPreflight(evaluatePreflight(facts({ files: [hostile], claim: { ...facts().claim!, scope: ['app/**'] } })));
    expect(out).toContain('forged');
    expect(out.split('\n')).toHaveLength(1 + 7);
    expect(out.split('\n').some((l) => l.startsWith('::'))).toBe(false);
  });

  it('sends a path with a control character to the owner instead of passing it', () => {
    const c = status(facts({ files: [hostile], claim: { ...facts().claim!, scope: ['**'] } }), 'permission');
    expect(c.status).toBe('WARN');
  });

  it('reports the file legs NOT_CHECKED when the file list is known to be incomplete', () => {
    const r = evaluatePreflight(facts({ forkSha: FORK, mergedSince: [{ sha: TIP, pr: 9, files: ['docs/other.md'] }], filesUnreadable: 'read 100 of the 250 files in PR #1' }));
    for (const name of ['fresh_base', 'duplicate_work', 'scope', 'permission']) expect(r.checks.find((c) => c.name === name)!.status).toBe('NOT_CHECKED');
  });

  it('keeps a real overlap as FAIL even when the list is incomplete', () => {
    const r = evaluatePreflight(facts({ openPrs: [{ number: 5, title: 'x', files: ['app/page.tsx'] }], filesUnreadable: 'partial' }));
    expect(r.checks.find((c) => c.name === 'duplicate_work')!.status).toBe('FAIL');
  });

  it('decodes paths git C-quotes, so they equal the literal paths GitHub reports', () => {
    expect(unquoteGitPath('"\\303\\251.sql"')).toBe('é.sql');
    expect(unquoteGitPath('"a\\nb.ts"')).toBe('a\nb.ts');
    expect(unquoteGitPath('plain/path.ts')).toBe('plain/path.ts');
  });

  const row = (number: number, paths: string[], changedFiles: number) => ({ number, title: 't', headRefName: `b${number}`, files: paths.map((path) => ({ path })), changedFiles });
  const none = () => false;

  it('fills a PR whose file list gh truncated, from the full listing', () => {
    const out = JSON.stringify([row(1, ['a.ts'], 2)]);
    expect(parseOpenPrs(out, none, () => ['a.ts', 'b.ts'])).toEqual([{ number: 1, title: 't', files: ['a.ts', 'b.ts'] }]);
  });

  it('returns null, never a partial list, when a truncated PR cannot be filled or the PR list hit its limit', () => {
    expect(parseOpenPrs(JSON.stringify([row(1, ['a.ts'], 2)]), none, () => null)).toBeNull();
    expect(parseOpenPrs(JSON.stringify([row(1, ['a.ts'], 1), row(2, ['b.ts'], 1)]), none, () => [], 2)).toBeNull();
  });
});

describe('preflight: parsing', () => {
  it('reads the PR number from a squash subject, and nothing else', () => {
    expect(prFromSubject('fix(site): move every install to 1.9.1 (#692)')).toBe(692);
    expect(prFromSubject('fix #692 in the middle')).toBeNull();
  });
  it('reads a task id from a PR body line', () => {
    expect(taskFromBody('Summary\n\nTask: #412\n')).toBe(412);
    expect(taskFromBody('no task here')).toBeUndefined();
  });
});

describe('preflight: reading real git history', () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'preflight-'));
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), '1');
    writeFileSync(join(dir, 'b.txt'), '1');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the merged PR that changed a file this work also changes', () => {
    const fork = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'a.txt'), '2');
    git('commit', '-q', '-am', 'change a (#5)');
    writeFileSync(join(dir, 'b.txt'), '2');
    git('commit', '-q', '-am', 'change b');
    const merged = mergedSince(dir, fork, 'main');
    expect(merged).toHaveLength(2);
    const r = evaluatePreflight(facts({ forkSha: fork, baseSha: git('rev-parse', 'HEAD'), files: ['a.txt'], mergedSince: merged, claim: { ...facts().claim!, scope: ['**'] } }));
    const c = r.checks.find((x) => x.name === 'fresh_base')!;
    expect(c.status).toBe('FAIL');
    expect(c.reason).toContain('#5');
  });

  it('reads a non-ASCII path literally, as GitHub does', () => {
    const fork = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'é.sql'), '1');
    git('add', '.');
    git('commit', '-q', '-m', 'add é (#6)');
    const merged = mergedSince(dir, fork, 'main');
    expect(merged!.flatMap((c) => c.files)).toContain('é.sql');
  });

  it('returns null, not an empty list, when the history cannot be read', () => {
    expect(mergedSince(dir, 'not-a-commit', 'main')).toBeNull();
  });
});
