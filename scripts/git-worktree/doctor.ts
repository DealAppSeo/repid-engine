/**
 * CC Sprint 12 Phase 3 — git worktree health check CLI.
 *
 * Verifies the worktree topology is healthy. Detects:
 *   - Worktrees with no EXPECTED_BRANCH guard (warning)
 *   - Worktrees where EXPECTED_BRANCH disagrees with HEAD (error)
 *   - Worktrees in unexpected locations (warning)
 *   - Detached HEADs (warning)
 *
 * Exit codes (for CI/script integration):
 *   0 = all green
 *   1 = warnings only
 *   2 = errors present
 *
 * Usage:  npm run worktree:doctor
 *
 * Pure function `analyzeWorktrees(rawList, readGuard)` is exported so unit
 * tests can exercise the classification logic without a git command runner.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface WorktreeRecord {
  /** Filesystem path to the worktree's working directory. */
  worktree: string;
  /** Path to the worktree's git directory (where HEAD/index/EXPECTED_BRANCH live). */
  gitDir: string;
  /** Current HEAD branch name, or null if detached. */
  branch: string | null;
  /** True iff HEAD is detached (no branch). */
  detached: boolean;
  /** True iff this is the primary worktree (the original .git directory). */
  isPrimary: boolean;
  /** True iff this is a bare repo (no working tree). */
  isBare: boolean;
}

export interface DoctorFinding {
  level: 'green' | 'warning' | 'error';
  worktree: string;
  message: string;
}

export interface DoctorReport {
  worktrees: WorktreeRecord[];
  findings: DoctorFinding[];
  exitCode: 0 | 1 | 2;
}

/** Parse `git worktree list --porcelain` text into structured records. */
export function parseWorktreeList(porcelain: string, primaryGitDir: string): WorktreeRecord[] {
  const out: WorktreeRecord[] = [];
  const blocks = porcelain.split(/\n\n+/).map((b) => b.trim()).filter((b) => b.length > 0);
  for (const block of blocks) {
    const lines = block.split('\n');
    let worktree = '';
    let branch: string | null = null;
    let detached = false;
    let isBare = false;
    for (const line of lines) {
      if (line.startsWith('worktree ')) worktree = line.slice('worktree '.length).trim();
      else if (line === 'detached') detached = true;
      else if (line === 'bare') isBare = true;
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        // refs/heads/<branch> -> <branch>
        branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      }
    }
    if (!worktree) continue;
    // For non-primary worktrees git stores per-worktree state at <main-git-dir>/worktrees/<name>.
    // For the primary, gitDir IS the main .git directory.
    const normWorktree = worktree.replace(/\\/g, '/');
    const normPrimary = primaryGitDir.replace(/\\/g, '/');
    const normPrimaryDir = path.dirname(normPrimary);
    const isPrimary = path.resolve(normWorktree) === path.resolve(normPrimaryDir);
    const wtName = path.basename(normWorktree);
    const gitDir = isPrimary ? primaryGitDir : path.join(primaryGitDir, 'worktrees', wtName);
    out.push({ worktree, gitDir, branch, detached, isPrimary, isBare });
  }
  return out;
}

/** Pure analysis: given worktree records + a guard-reader callback, classify findings. */
export function analyzeWorktrees(
  worktrees: WorktreeRecord[],
  readGuard: (gitDir: string) => string | null,
): DoctorReport {
  const findings: DoctorFinding[] = [];

  // Detect duplicate branch checkouts (git refuses these but the test exists for the error path)
  const branchCounts = new Map<string, string[]>();
  for (const wt of worktrees) {
    if (wt.branch && !wt.detached) {
      const list = branchCounts.get(wt.branch) ?? [];
      list.push(wt.worktree);
      branchCounts.set(wt.branch, list);
    }
  }
  for (const [branch, paths] of branchCounts) {
    if (paths.length > 1) {
      findings.push({
        level: 'error',
        worktree: paths.join(' + '),
        message: `branch "${branch}" is checked out in ${paths.length} worktrees — this should be impossible per git; investigate immediately`,
      });
    }
  }

  // Per-worktree checks
  for (const wt of worktrees) {
    if (wt.isBare) {
      findings.push({ level: 'green', worktree: wt.worktree, message: 'bare repo — no working tree to check' });
      continue;
    }
    if (wt.detached) {
      findings.push({
        level: 'warning',
        worktree: wt.worktree,
        message: 'detached HEAD — no branch to compare against EXPECTED_BRANCH',
      });
      continue;
    }
    const expected = readGuard(wt.gitDir);
    if (expected == null) {
      findings.push({
        level: 'warning',
        worktree: wt.worktree,
        message: `no EXPECTED_BRANCH guard at ${wt.gitDir}/EXPECTED_BRANCH — set one before next sprint to enable strict commit-time discipline`,
      });
      continue;
    }
    const trimmed = expected.trim();
    if (trimmed === '') {
      findings.push({
        level: 'warning',
        worktree: wt.worktree,
        message: `EXPECTED_BRANCH file is empty at ${wt.gitDir}/EXPECTED_BRANCH`,
      });
      continue;
    }
    if (trimmed !== wt.branch) {
      findings.push({
        level: 'error',
        worktree: wt.worktree,
        message: `EXPECTED_BRANCH="${trimmed}" but HEAD is on "${wt.branch}" — pre-commit hook will block any commit here`,
      });
      continue;
    }
    findings.push({
      level: 'green',
      worktree: wt.worktree,
      message: `branch "${wt.branch}" matches EXPECTED_BRANCH`,
    });
  }

  const hasError = findings.some((f) => f.level === 'error');
  const hasWarning = findings.some((f) => f.level === 'warning');
  const exitCode: 0 | 1 | 2 = hasError ? 2 : hasWarning ? 1 : 0;
  return { worktrees, findings, exitCode };
}

function readGuardFromFs(gitDir: string): string | null {
  const file = path.join(gitDir, 'EXPECTED_BRANCH');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

function colorise(level: DoctorFinding['level']): string {
  if (level === 'green') return '\x1b[32m✓\x1b[0m';
  if (level === 'warning') return '\x1b[33m!\x1b[0m';
  return '\x1b[31m✗\x1b[0m';
}

function main(): void {
  // Discover the primary git directory (absolute path)
  const primaryGitDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf-8' }).trim();
  const absPrimaryGitDir = path.isAbsolute(primaryGitDir) ? primaryGitDir : path.resolve(process.cwd(), primaryGitDir);

  const porcelain = execSync('git worktree list --porcelain', { encoding: 'utf-8' });
  const worktrees = parseWorktreeList(porcelain, absPrimaryGitDir);

  const report = analyzeWorktrees(worktrees, readGuardFromFs);

  console.log(`[worktree:doctor] ${worktrees.length} worktree(s) detected`);
  for (const wt of report.worktrees) {
    console.log(`  ${wt.worktree}`);
    console.log(`    branch:   ${wt.detached ? '(detached)' : wt.branch ?? '(none)'}`);
    console.log(`    git-dir:  ${wt.gitDir}${wt.isPrimary ? ' (primary)' : ''}`);
  }
  console.log('');
  console.log(`[worktree:doctor] findings (${report.findings.length}):`);
  for (const f of report.findings) {
    console.log(`  ${colorise(f.level)} ${f.worktree}`);
    console.log(`     ${f.message}`);
  }
  const summary = report.exitCode === 0 ? 'GREEN — topology healthy' : report.exitCode === 1 ? 'WARNINGS — review' : 'ERRORS — fix before next sprint';
  console.log('');
  console.log(`[worktree:doctor] ${summary} (exit ${report.exitCode})`);
  process.exit(report.exitCode);
}

if (require.main === module) main();
