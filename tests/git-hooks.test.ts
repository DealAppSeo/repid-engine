/**
 * Tests for the pre-commit branch-discipline hook (CC Sprint 7).
 *
 * Spawns the bash script with various states of .git/EXPECTED_BRANCH
 * and verifies exit code + stderr behavior. Skipped on Windows-only
 * environments without bash; passes on git-bash / WSL / macOS / Linux.
 *
 * The hook script lives at scripts/git-hooks/pre-commit.sh. Tests do
 * NOT install the hook globally — they invoke the script directly so
 * test runs don't interfere with the developer's actual hook.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOOK_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'git-hooks', 'pre-commit.sh');

// Skip on environments without bash (rare; git-bash on Windows ships with bash)
function bashAvailable(): boolean {
  const r = spawnSync('bash', ['--version'], { encoding: 'utf-8' });
  return r.status === 0;
}

const HAS_BASH = bashAvailable();
const describeIfBash = HAS_BASH ? describe : describe.skip;

describeIfBash('pre-commit hook — branch discipline', () => {
  let tmpRepo: string;

  beforeEach(() => {
    // Each test gets a fresh tmp git repo + a controlled EXPECTED_BRANCH state
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sprint7-hook-'));
    spawnSync('git', ['init', '-q', '-b', 'feat/test-current'], { cwd: tmpRepo });
    // Need at least one commit so HEAD resolves
    fs.writeFileSync(path.join(tmpRepo, 'seed.txt'), 'init');
    spawnSync('git', ['add', 'seed.txt'], { cwd: tmpRepo });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
      'commit', '-q', '--no-verify', '-m', 'init'], { cwd: tmpRepo });
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  function runHook(): { status: number | null; stderr: string; stdout: string } {
    const r = spawnSync('bash', [HOOK_SCRIPT], { cwd: tmpRepo, encoding: 'utf-8' });
    return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
  }

  it('exits 0 when EXPECTED_BRANCH matches actual', () => {
    fs.writeFileSync(path.join(tmpRepo, '.git', 'EXPECTED_BRANCH'), 'feat/test-current\n');
    const r = runHook();
    expect(r.status).toBe(0);
  });

  it('exits 1 when EXPECTED_BRANCH does NOT match actual', () => {
    fs.writeFileSync(path.join(tmpRepo, '.git', 'EXPECTED_BRANCH'), 'feat/some-other-branch\n');
    const r = runHook();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/BRANCH MISMATCH/);
    expect(r.stderr).toMatch(/Expected:\s+feat\/some-other-branch/);
    expect(r.stderr).toMatch(/Current:\s+feat\/test-current/);
  });

  it('exits 0 with WARNING when EXPECTED_BRANCH file is missing', () => {
    // Don't create the file
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING: \.git\/EXPECTED_BRANCH not set/);
  });

  it('exits 0 with WARNING when EXPECTED_BRANCH is empty', () => {
    fs.writeFileSync(path.join(tmpRepo, '.git', 'EXPECTED_BRANCH'), '');
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING: \.git\/EXPECTED_BRANCH is empty/);
  });

  it('handles trailing whitespace in EXPECTED_BRANCH (matches still)', () => {
    fs.writeFileSync(path.join(tmpRepo, '.git', 'EXPECTED_BRANCH'), '  feat/test-current  \n\n');
    const r = runHook();
    expect(r.status).toBe(0);
  });

  it('mismatch stderr includes the recovery instructions', () => {
    fs.writeFileSync(path.join(tmpRepo, '.git', 'EXPECTED_BRANCH'), 'feat/wrong\n');
    const r = runHook();
    expect(r.stderr).toMatch(/git stash push/);
    expect(r.stderr).toMatch(/git checkout feat\/wrong/);
    expect(r.stderr).toMatch(/--no-verify/);
  });
});
