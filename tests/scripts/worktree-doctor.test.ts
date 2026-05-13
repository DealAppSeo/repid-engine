/**
 * CC Sprint 12 Phase 3 — unit tests for worktree:doctor classification logic.
 *
 * Tests the pure functions parseWorktreeList + analyzeWorktrees with synthetic
 * input. The CLI driver (which shells out to git + reads filesystem) is
 * exercised by the smoke run in the sprint report.
 */

import {
  parseWorktreeList,
  analyzeWorktrees,
  type WorktreeRecord,
} from '../../scripts/git-worktree/doctor';

describe('parseWorktreeList', () => {
  it('parses a single primary worktree', () => {
    const porcelain = `worktree C:\\Users\\Cash4\\repos\\repid-engine
HEAD abc123
branch refs/heads/main
`;
    const records = parseWorktreeList(porcelain, 'C:\\Users\\Cash4\\repos\\repid-engine\\.git');
    expect(records).toHaveLength(1);
    expect(records[0]!.worktree).toBe('C:\\Users\\Cash4\\repos\\repid-engine');
    expect(records[0]!.branch).toBe('main');
    expect(records[0]!.isPrimary).toBe(true);
    expect(records[0]!.detached).toBe(false);
  });

  it('parses multiple worktrees', () => {
    const porcelain = `worktree C:\\Users\\Cash4\\repos\\repid-engine
HEAD abc123
branch refs/heads/main

worktree C:\\Users\\Cash4\\repos\\repid-engine-gemini
HEAD def456
branch refs/heads/feat/gemini-sprint-5
`;
    const records = parseWorktreeList(porcelain, 'C:\\Users\\Cash4\\repos\\repid-engine\\.git');
    expect(records).toHaveLength(2);
    expect(records[0]!.isPrimary).toBe(true);
    expect(records[1]!.isPrimary).toBe(false);
    expect(records[1]!.branch).toBe('feat/gemini-sprint-5');
    expect(records[1]!.gitDir).toContain('worktrees');
  });

  it('marks detached HEAD', () => {
    const porcelain = `worktree C:\\path
HEAD abc123
detached
`;
    const records = parseWorktreeList(porcelain, 'C:\\path\\.git');
    expect(records[0]!.detached).toBe(true);
    expect(records[0]!.branch).toBeNull();
  });

  it('marks bare repo', () => {
    const porcelain = `worktree C:\\bare
bare
`;
    const records = parseWorktreeList(porcelain, 'C:\\bare');
    expect(records[0]!.isBare).toBe(true);
  });
});

function r(opts: Partial<WorktreeRecord>): WorktreeRecord {
  return {
    worktree: 'C:\\test',
    gitDir: 'C:\\test\\.git',
    branch: 'main',
    detached: false,
    isPrimary: true,
    isBare: false,
    ...opts,
  };
}

describe('analyzeWorktrees', () => {
  it('green when single worktree, branch matches guard', () => {
    const wts = [r({ branch: 'feat/foo' })];
    const report = analyzeWorktrees(wts, () => 'feat/foo');
    expect(report.exitCode).toBe(0);
    expect(report.findings.every((f) => f.level === 'green')).toBe(true);
  });

  it('green when two worktrees on different branches, both guards match', () => {
    const wts = [
      r({ worktree: 'C:\\a', gitDir: 'C:\\a\\.git', branch: 'feat/cc' }),
      r({ worktree: 'C:\\b', gitDir: 'C:\\b\\.git', branch: 'feat/gemini', isPrimary: false }),
    ];
    const guards = new Map([
      ['C:\\a\\.git', 'feat/cc'],
      ['C:\\b\\.git', 'feat/gemini'],
    ]);
    const report = analyzeWorktrees(wts, (gd) => guards.get(gd) ?? null);
    expect(report.exitCode).toBe(0);
  });

  it('warning when EXPECTED_BRANCH missing', () => {
    const wts = [r({ branch: 'feat/foo' })];
    const report = analyzeWorktrees(wts, () => null);
    expect(report.exitCode).toBe(1);
    expect(report.findings.some((f) => f.level === 'warning' && /no EXPECTED_BRANCH/.test(f.message))).toBe(true);
  });

  it('warning when EXPECTED_BRANCH empty', () => {
    const wts = [r({ branch: 'feat/foo' })];
    const report = analyzeWorktrees(wts, () => '   ');
    expect(report.exitCode).toBe(1);
    expect(report.findings.some((f) => f.level === 'warning' && /empty/.test(f.message))).toBe(true);
  });

  it('error when guard disagrees with branch', () => {
    const wts = [r({ branch: 'feat/foo' })];
    const report = analyzeWorktrees(wts, () => 'feat/bar');
    expect(report.exitCode).toBe(2);
    expect(report.findings.some((f) => f.level === 'error' && /will block/.test(f.message))).toBe(true);
  });

  it('error when same branch in two worktrees (defensive — git refuses this)', () => {
    const wts = [
      r({ worktree: 'C:\\a', gitDir: 'C:\\a\\.git', branch: 'feat/dup' }),
      r({ worktree: 'C:\\b', gitDir: 'C:\\b\\.git', branch: 'feat/dup', isPrimary: false }),
    ];
    const report = analyzeWorktrees(wts, () => 'feat/dup');
    expect(report.exitCode).toBe(2);
    expect(report.findings.some((f) => f.level === 'error' && /should be impossible/.test(f.message))).toBe(true);
  });

  it('warning when HEAD is detached', () => {
    const wts = [r({ branch: null, detached: true })];
    const report = analyzeWorktrees(wts, () => 'feat/foo');
    expect(report.exitCode).toBe(1);
    expect(report.findings.some((f) => f.level === 'warning' && /detached HEAD/.test(f.message))).toBe(true);
  });

  it('green-bypass for bare repos', () => {
    const wts = [r({ isBare: true, branch: null })];
    const report = analyzeWorktrees(wts, () => null);
    expect(report.exitCode).toBe(0);
  });
});
