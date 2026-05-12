#!/usr/bin/env bash
# CC Sprint 7 — install the pre-commit branch-discipline hook
#
# Idempotent: safe to re-run. Backs up any existing hook to
# .git/hooks/pre-commit.bak before overwriting.
#
# Usage:
#   bash scripts/git-hooks/install.sh
# Or via npm:
#   npm run install:hooks

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SOURCE_HOOK="$REPO_ROOT/scripts/git-hooks/pre-commit.sh"
HOOKS_DIR="$(git rev-parse --git-dir)/hooks"
TARGET_HOOK="$HOOKS_DIR/pre-commit"

if [ ! -f "$SOURCE_HOOK" ]; then
    echo "[install-hooks] ERROR: source hook not found at $SOURCE_HOOK" >&2
    exit 1
fi

mkdir -p "$HOOKS_DIR"

# Back up any existing hook (only if it differs from what we're about to install)
if [ -f "$TARGET_HOOK" ]; then
    if cmp -s "$TARGET_HOOK" "$SOURCE_HOOK"; then
        echo "[install-hooks] pre-commit hook already up to date — no changes."
        exit 0
    fi
    BACKUP="$TARGET_HOOK.bak.$(date +%s)"
    cp "$TARGET_HOOK" "$BACKUP"
    echo "[install-hooks] Backed up existing hook to $BACKUP"
fi

cp "$SOURCE_HOOK" "$TARGET_HOOK"
chmod +x "$TARGET_HOOK"

echo "[install-hooks] ✅ Installed pre-commit hook at $TARGET_HOOK"
echo "[install-hooks]"
echo "[install-hooks] Next step — set your expected branch when starting a sprint:"
echo "[install-hooks]   echo \"feat/your-branch-name\" > .git/EXPECTED_BRANCH"
echo "[install-hooks]"
echo "[install-hooks] To bypass for emergencies:  git commit --no-verify"
