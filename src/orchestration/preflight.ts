/**
 * The start-of-work contract every coding agent passes: Claude sessions, Codex and T12 lanes alike.
 *
 * WHY: on 2026-11-09 Codex built a change three hours after trustshell #692 had merged, from the commit
 * before it, and 5 of its 12 files conflicted with work already on main. Nothing it ran asked "has main
 * moved under these files?" or "is someone else on these files?". This module asks, and nothing else.
 *
 * It is a pure decision over facts. Gathering the facts (git, GitHub, the queue) is scripts/preflight.ts,
 * so the same rules run in a PR check, on a laptop and inside a lane. A fact that could not be read is
 * NOT_CHECKED, which is never a pass. The claim, lease, fencing and scope legs reuse what the lanes already
 * store on the task row (`trinity_tasks.claimed_by`, `expires_at`, `metadata.t12`); no second queue.
 */
import { matchesAny, normalisePath } from './write-lease';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'NOT_CHECKED';
export type CheckName = 'fresh_base' | 'duplicate_work' | 'claim' | 'lease' | 'fencing' | 'scope' | 'permission';

export interface Check {
  name: CheckName;
  status: CheckStatus;
  reason: string;
}

/** One commit that landed on the target branch after this work started. */
export interface MergedChange {
  sha: string;
  pr: number | null;
  files: string[];
}

export interface OpenPr {
  number: number;
  title: string;
  files: string[];
}

/** The queue's record of a task, as the lanes store it. */
export interface TaskClaim {
  taskId: number;
  holder: string | null;
  leaseExpiresAt: string | null;
  epoch: number | null;
  /** Files or globs the task may touch. Empty means the task row names no scope. */
  scope: string[];
}

export interface PreflightFacts {
  agent: string;
  /** Tip of the target branch, freshly fetched. */
  baseSha: string;
  /** Where this work started: the merge base of the work and the target branch. */
  forkSha: string;
  /** Files touched so far, or planned, repo-relative. */
  files: string[];
  /** Commits on the target branch since `forkSha`. null = could not be read. */
  mergedSince: MergedChange[] | null;
  /** Other open PRs on the same repo. null = could not be read. */
  openPrs: OpenPr[] | null;
  /** The task this work claims. undefined = no task named. */
  taskId?: number;
  /** The task row. undefined = a task was named but the queue could not be read. */
  claim?: TaskClaim;
  /** Why the queue could not be read, when it could not. */
  claimUnreadable?: string;
  /** The fencing epoch the agent believes it holds. */
  heldEpoch?: number;
  now: Date;
}

export interface PreflightResult {
  verdict: CheckStatus;
  checks: Check[];
}

/**
 * Paths whose changes are owner decisions under CLAUDE_RULES r31 (MAJOR): production schema, deploy and
 * environment config, RepID weights and on-chain contracts. Drafting them is allowed; merging needs the
 * owner, so this leg can only WARN.
 * ponytail: a path heuristic; a change that is MAJOR by content (a new public claim, a price) is not caught here.
 */
export const OWNER_ONLY_PATHS: readonly string[] = [
  'migrations/**',
  '**/*.sql',
  'supabase/**',
  '**/.env*',
  'railway.toml',
  '**/railway*.json',
  'vercel.json',
  'nixpacks.toml',
  'fly.toml',
  'src/config/scoring-params*',
  'src/scoring/**',
  'contracts/**',
  'packages/contracts/**',
];

const ORDER: readonly CheckStatus[] = ['FAIL', 'NOT_CHECKED', 'WARN', 'PASS'];

const list = (xs: readonly string[], max = 4): string =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`;

function freshBase(f: PreflightFacts, mine: Set<string>): Check {
  if (f.forkSha === f.baseSha) return { name: 'fresh_base', status: 'PASS', reason: `starts from the current tip ${f.baseSha.slice(0, 8)}` };
  if (f.mergedSince === null) return { name: 'fresh_base', status: 'NOT_CHECKED', reason: 'could not read what landed on the target branch since this work started' };
  const hits = f.mergedSince
    .map((c) => ({ c, shared: c.files.map((x) => normalisePath(x)).filter((x) => mine.has(x)) }))
    .filter((h) => h.shared.length > 0);
  if (hits.length === 0) {
    return { name: 'fresh_base', status: 'WARN', reason: `${f.mergedSince.length} commit(s) landed since ${f.forkSha.slice(0, 8)}; none touch these files. Rebase before review.` };
  }
  const named = hits.map((h) => `${h.c.pr ? `#${h.c.pr}` : h.c.sha.slice(0, 8)} (${list(h.shared, 3)})`);
  return { name: 'fresh_base', status: 'FAIL', reason: `started at ${f.forkSha.slice(0, 8)}; since then these changed the same files: ${list(named, 3)}` };
}

function duplicateWork(f: PreflightFacts, mine: Set<string>): Check {
  if (f.openPrs === null) return { name: 'duplicate_work', status: 'NOT_CHECKED', reason: 'could not read the open pull requests' };
  const hits = f.openPrs
    .map((p) => ({ p, shared: p.files.map((x) => normalisePath(x)).filter((x) => mine.has(x)) }))
    .filter((h) => h.shared.length > 0);
  if (hits.length === 0) return { name: 'duplicate_work', status: 'PASS', reason: `no other open PR touches these files (${f.openPrs.length} checked)` };
  return { name: 'duplicate_work', status: 'FAIL', reason: `open PRs already touch these files: ${list(hits.map((h) => `#${h.p.number} (${list(h.shared, 3)})`), 3)}` };
}

function taskChecks(f: PreflightFacts, files: string[]): Check[] {
  const all = (status: CheckStatus, reason: string): Check[] =>
    (['claim', 'lease', 'fencing', 'scope'] as const).map((name) => ({ name, status, reason }));
  if (f.taskId === undefined) return all('FAIL', 'no task claimed: name the trinity_tasks row this work belongs to');
  if (!f.claim) return all('NOT_CHECKED', `task ${f.taskId}: ${f.claimUnreadable ?? 'the queue could not be read'}`);

  const c = f.claim;
  const out: Check[] = [];
  out.push(
    c.holder === f.agent
      ? { name: 'claim', status: 'PASS', reason: `task ${c.taskId} is claimed by ${f.agent}` }
      : { name: 'claim', status: 'FAIL', reason: c.holder ? `task ${c.taskId} is claimed by ${c.holder}, not ${f.agent}` : `task ${c.taskId} is not claimed` },
  );
  const expires = c.leaseExpiresAt ? Date.parse(c.leaseExpiresAt) : NaN;
  out.push(
    Number.isFinite(expires) && expires > f.now.getTime()
      ? { name: 'lease', status: 'PASS', reason: `lease runs until ${c.leaseExpiresAt}` }
      : { name: 'lease', status: 'FAIL', reason: c.leaseExpiresAt ? `lease expired at ${c.leaseExpiresAt}` : 'the task row holds no lease' },
  );
  if (c.epoch === null) out.push({ name: 'fencing', status: 'NOT_CHECKED', reason: 'the task row carries no epoch' });
  else if (f.heldEpoch === undefined) out.push({ name: 'fencing', status: 'NOT_CHECKED', reason: `the agent did not state the epoch it holds (row is at ${c.epoch})` });
  else if (f.heldEpoch !== c.epoch) out.push({ name: 'fencing', status: 'FAIL', reason: `fenced: the agent holds epoch ${f.heldEpoch}, the row is at ${c.epoch}` });
  else out.push({ name: 'fencing', status: 'PASS', reason: `epoch ${c.epoch} matches` });
  if (c.scope.length === 0) out.push({ name: 'scope', status: 'NOT_CHECKED', reason: `task ${c.taskId} names no file scope` });
  else {
    const outside = files.filter((x) => !matchesAny(x, c.scope));
    out.push(
      outside.length === 0
        ? { name: 'scope', status: 'PASS', reason: `all ${files.length} file(s) are inside the task's scope` }
        : { name: 'scope', status: 'FAIL', reason: `outside the task's scope: ${list(outside)}` },
    );
  }
  return out;
}

function permission(files: string[]): Check {
  const owner = files.filter((x) => matchesAny(x, OWNER_ONLY_PATHS));
  return owner.length === 0
    ? { name: 'permission', status: 'PASS', reason: 'no owner-only paths' }
    : { name: 'permission', status: 'WARN', reason: `owner decision needed before merge (r31 MAJOR): ${list(owner)}` };
}

export function evaluatePreflight(f: PreflightFacts): PreflightResult {
  const files = [...new Set(f.files.map((x) => normalisePath(x)).filter(Boolean))];
  const mine = new Set(files);
  const checks = [freshBase(f, mine), duplicateWork(f, mine), ...taskChecks(f, files), permission(files)];
  const verdict = ORDER.find((s) => checks.some((c) => c.status === s)) ?? 'PASS';
  return { verdict, checks };
}

export function formatPreflight(r: PreflightResult): string {
  return [`Preflight: ${r.verdict}`, ...r.checks.map((c) => `${c.status.padEnd(11)} ${c.name.padEnd(14)} ${c.reason}`)].join('\n');
}

/** PR numbers squash-merged by GitHub end their subject with "(#123)". */
export function prFromSubject(subject: string): number | null {
  const m = /\(#(\d+)\)\s*$/.exec(subject.trim());
  return m ? Number(m[1]) : null;
}

/** A PR body names its task with a line "Task: 123" (or "Task: #123"). */
export function taskFromBody(body: string | null | undefined): number | undefined {
  const m = /^\s*task:\s*#?(\d+)\s*$/im.exec(body ?? '');
  return m ? Number(m[1]) : undefined;
}
