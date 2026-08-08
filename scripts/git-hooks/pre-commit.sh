#!/usr/bin/env bash
# CC Sprint 7 + Sprint 12 — pre-commit branch-discipline hook (worktree-aware)
#
# Stops the HEAD-drift contamination pattern that bit us 5+ times in 6 days
# (see IDEAS_LOG I-15 + I-17, and Sprint 11/12 reports for fresh occurrences).
# The pattern: parallel agents in shared working trees end up with HEAD on a
# different branch than they intended, silently committing onto the wrong branch.
#
# Mechanism:
#   - At sprint start, the developer writes their intended branch name to
#     <git-dir>/EXPECTED_BRANCH (worktree-local file)
#   - This hook checks the current branch matches the expected one
#   - If mismatched: ABORT loudly. The commit does not land.
#   - If <git-dir>/EXPECTED_BRANCH is missing: WARN but allow (don't break old
#     workflows that haven't adopted the discipline yet)
#
# WORKTREE-AWARE: uses `git rev-parse --git-dir` so the EXPECTED_BRANCH file is
# read from the WORKTREE-LOCAL git directory. In the primary worktree this is
# `.git/`. In a `git worktree add`-created worktree this is
# `.git/worktrees/<name>/` — automatically resolved by git, so each agent's
# worktree gets its own EXPECTED_BRANCH guard with no collision.
#
# Bypass for emergencies: git commit --no-verify
#
# CANONICAL SOURCE: scripts/git-hooks/pre-commit.sh
# INSTALLER:        scripts/install-hooks.ts (run via `npm run install:hooks`)
# DOCUMENTATION:    docs/git-workflow/WORKTREE_HOOK.md
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# GATE 0 — production-extract fixture fence (the permanent #376 fence).
#
# Runs BEFORE the branch check so a fixture carrying a real proof / real agent
# UUID / prod table dump is refused no matter which branch you are on. The guard
# scans only the STAGED files under tests/, is pure-Node (no build step), and
# fails closed. Documented bypass: ALLOW_PROD_FIXTURE=1 git commit ...
#
# CANONICAL SOURCE: scripts/hooks/prod-fixture-guard.js
# ─────────────────────────────────────────────────────────────────────────────
REPO_ROOT="$(git rev-parse --show-toplevel)"
FIXTURE_GUARD="$REPO_ROOT/scripts/hooks/prod-fixture-guard.js"
if [ -f "$FIXTURE_GUARD" ] && command -v node >/dev/null 2>&1; then
    if ! node "$FIXTURE_GUARD" --staged; then
        echo "[pre-commit-hook] prod-fixture-guard refused the commit (see above)." >&2
        exit 1
    fi
fi

EXPECTED_FILE="$(git rev-parse --git-dir)/EXPECTED_BRANCH"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ ! -f "$EXPECTED_FILE" ]; then
    echo "[pre-commit-hook] WARNING: EXPECTED_BRANCH not set at $EXPECTED_FILE" >&2
    echo "[pre-commit-hook]   Current branch: $CURRENT_BRANCH" >&2
    echo "[pre-commit-hook]   To enable strict branch discipline:" >&2
    echo "[pre-commit-hook]     echo \"$CURRENT_BRANCH\" > \"$EXPECTED_FILE\"" >&2
    echo "[pre-commit-hook]   Allowing commit (warning-only mode)." >&2
    exit 0
fi

EXPECTED_BRANCH="$(cat "$EXPECTED_FILE" | head -n 1 | tr -d '[:space:]')"

if [ -z "$EXPECTED_BRANCH" ]; then
    echo "[pre-commit-hook] WARNING: EXPECTED_BRANCH is empty at $EXPECTED_FILE" >&2
    echo "[pre-commit-hook]   Allowing commit (warning-only mode)." >&2
    exit 0
fi

if [ "$CURRENT_BRANCH" = "$EXPECTED_BRANCH" ]; then
    # Match. Silent success — don't add noise to every commit.
    exit 0
fi

# Mismatch — ABORT loudly. This is the case the hook exists to prevent.
echo "" >&2
echo "===============================================================" >&2
echo "[pre-commit-hook] BRANCH MISMATCH — COMMIT ABORTED" >&2
echo "===============================================================" >&2
echo "  Expected:  $EXPECTED_BRANCH" >&2
echo "  Current:   $CURRENT_BRANCH" >&2
echo "  Guard at:  $EXPECTED_FILE" >&2
echo "" >&2
echo "  HEAD-drift detected. Refusing to commit on the wrong branch." >&2
echo "  This is the failure mode that caused 5+ contamination incidents" >&2
echo "  across the 2026-05 sprint window — see IDEAS_LOG I-15 + I-17 and" >&2
echo "  GIT_WORKTREE_TOPOLOGY_2026-05-12.md for the structural fix." >&2
echo "" >&2
echo "  To fix:" >&2
echo "    1. Stash your changes:    git stash push -u -m \"sprint-recovery\"" >&2
echo "    2. Switch to expected:    git checkout $EXPECTED_BRANCH" >&2
echo "    3. Pop the stash:         git stash pop" >&2
echo "    4. Re-stage and commit." >&2
echo "" >&2
echo "  To bypass (emergency only):  git commit --no-verify" >&2
echo "  To intentionally change expected branch:" >&2
echo "    echo \"$CURRENT_BRANCH\" > \"$EXPECTED_FILE\"" >&2
echo "===============================================================" >&2
exit 1