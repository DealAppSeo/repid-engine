/**
 * CC Sprint 12 Phase 2 — install git hooks into the worktree-local git dir.
 *
 * Copies `scripts/git-hooks/pre-commit.sh` to the active worktree's
 * `<git-dir>/hooks/pre-commit` and marks it executable.
 *
 * WORKTREE-AWARE: uses `git rev-parse --git-dir` to find the destination, so:
 * - In the primary worktree this writes to `.git/hooks/pre-commit`.
 * - In a `git worktree add`-created worktree this writes to
 *   `.git/worktrees/<name>/hooks/pre-commit`.
 *
 * Each worktree must run this once after creation to install its own hook.
 *
 * Usage:  npm run install:hooks
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function main(): void {
  const repoRoot = path.resolve(__dirname, '..');
  const sourceHook = path.join(repoRoot, 'scripts', 'git-hooks', 'pre-commit.sh');

  if (!fs.existsSync(sourceHook)) {
    console.error(`[install-hooks] missing source: ${sourceHook}`);
    process.exit(1);
  }

  const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf-8', cwd: repoRoot }).trim();
  const hooksDir = path.isAbsolute(gitDir) ? path.join(gitDir, 'hooks') : path.resolve(repoRoot, gitDir, 'hooks');
  const destHook = path.join(hooksDir, 'pre-commit');

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(sourceHook, destHook);

  // chmod +x — on Windows this is a no-op effectively but git-bash respects it
  try { fs.chmodSync(destHook, 0o755); } catch { /* best-effort */ }

  console.log(`[install-hooks] installed pre-commit hook`);
  console.log(`  source:  ${sourceHook}`);
  console.log(`  dest:    ${destHook}`);
  console.log(`  git-dir: ${gitDir} (worktree-local)`);
}

main();
