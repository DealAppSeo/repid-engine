#!/usr/bin/env bash
# CC Sprint 7 — pre-commit branch-discipline hook
#
# Stops the HEAD-drift contamination pattern that bit us 5 times in 6 days
# (see IDEAS_LOG I-15 + I-17). The pattern: parallel agents in shared
# working trees end up with HEAD on a different branch than they intended,
# silently committing onto the wrong branch.
#
# Mechanism:
#   - At sprint start, the developer writes their intended branch name to
#     .git/EXPECTED_BRANCH (a file gitignored by .git/ being out-of-tree)
#   - This hook checks the current branch matches the expected one
#   - If mismatched: ABORT loudly. The commit does not land.
#   - If .git/EXPECTED_BRANCH is missing: WARN but allow (don't break old
#     workflows that haven't adopted the discipline yet)
#
# Bypass for emergencies: git commit --no-verify
#
# This file is the canonical hook source. scripts/git-hooks/install.sh
# copies it to .git/hooks/pre-commit and chmods +x.

set -euo pipefail

EXPECTED_FILE="$(git rev-parse --git-dir)/EXPECTED_BRANCH"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ ! -f "$EXPECTED_FILE" ]; then
    echo "[pre-commit-hook] WARNING: .git/EXPECTED_BRANCH not set." >&2
    echo "[pre-commit-hook]   Current branch: $CURRENT_BRANCH" >&2
    echo "[pre-commit-hook]   To enable strict branch discipline:" >&2
    echo "[pre-commit-hook]     echo \"$CURRENT_BRANCH\" > .git/EXPECTED_BRANCH" >&2
    echo "[pre-commit-hook]   Allowing commit (warning-only mode)." >&2
    exit 0
fi

EXPECTED_BRANCH="$(cat "$EXPECTED_FILE" | head -n 1 | tr -d '[:space:]')"

if [ -z "$EXPECTED_BRANCH" ]; then
    echo "[pre-commit-hook] WARNING: .git/EXPECTED_BRANCH is empty." >&2
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
echo "[pre-commit-hook] ❌ BRANCH MISMATCH — COMMIT ABORTED" >&2
echo "===============================================================" >&2
echo "  Expected:  $EXPECTED_BRANCH" >&2
echo "  Current:   $CURRENT_BRANCH" >&2
echo "" >&2
echo "  HEAD-drift detected. Refusing to commit on the wrong branch." >&2
echo "  This is the failure mode that caused 5 contamination incidents" >&2
echo "  in 6 days — see IDEAS_LOG I-15 + I-17." >&2
echo "" >&2
echo "  To fix:" >&2
echo "    1. Stash your changes:    git stash push -m \"sprint-recovery\"" >&2
echo "    2. Switch to expected:    git checkout $EXPECTED_BRANCH" >&2
echo "    3. Pop the stash:         git stash pop" >&2
echo "    4. Re-stage and commit." >&2
echo "" >&2
echo "  To bypass (emergency only):  git commit --no-verify" >&2
echo "  To intentionally change expected branch:" >&2
echo "    echo \"$CURRENT_BRANCH\" > .git/EXPECTED_BRANCH" >&2
echo "===============================================================" >&2
exit 1
