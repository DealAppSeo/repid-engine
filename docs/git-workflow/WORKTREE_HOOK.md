# Worktree-Aware Pre-Commit Hook

**Authored:** CC Sprint 7 (initial), CC Sprint 12 (worktree-aware refinement + canonical source)
**Source-of-truth:** `scripts/git-hooks/pre-commit.sh`
**Installer:** `scripts/install-hooks.ts` (run via `npm run install:hooks`)

---

## Why this hook exists

The HyperDAG repo has multiple agents (CC1, Gemini, Sean) and historically a single shared working tree. Without a guard, parallel sessions can:
- Switch HEAD to another agent's branch unintentionally (`git checkout` from a different terminal mutates the shared `.git/HEAD`)
- Commit work onto the wrong branch
- Push contamination cross-branch

This pattern has bitten the project 5+ times (logged in `IDEAS_LOG.md` items I-15 + I-17, plus fresh occurrences during Sprints 10/11/12 of 2026-05-12).

The hook prevents the second-half of the failure mode: it refuses to commit when `HEAD` doesn't match an explicitly-declared `EXPECTED_BRANCH`.

---

## How it works

### Sprint setup

At the start of every sprint, write the intended branch name to the worktree-local guard file:

```bash
echo "feat/your-sprint-branch" > "$(git rev-parse --git-dir)/EXPECTED_BRANCH"
```

In the primary worktree, that resolves to `.git/EXPECTED_BRANCH`.
In a `git worktree add`-created worktree, it resolves to `.git/worktrees/<name>/EXPECTED_BRANCH`.

### Per commit

The hook reads `<git-dir>/EXPECTED_BRANCH` (worktree-local), compares to current `HEAD`, and either:
- **Match**: silent success, commit proceeds
- **Mismatch**: ABORT with a loud error message + recovery steps
- **Missing file**: WARN-and-allow (so old branches without the discipline still work)

### Bypass

Emergency only:
```bash
git commit --no-verify
```

If you need to intentionally change the expected branch (e.g., after a deliberate re-branch):
```bash
echo "feat/new-branch" > "$(git rev-parse --git-dir)/EXPECTED_BRANCH"
```

---

## Worktree awareness

The hook uses `git rev-parse --git-dir` rather than a hardcoded `.git/` path. This makes it work identically in:
- The primary worktree (`<repo>/.git/EXPECTED_BRANCH`)
- A `git worktree add`-created worktree (`<repo>/.git/worktrees/<name>/EXPECTED_BRANCH`)

Each worktree maintains its own guard, so CC1 working in `repo/` and Gemini working in `repo-gemini/` can declare different EXPECTED_BRANCH values without conflict.

See `E:\dev\living-docs\GIT_WORKTREE_TOPOLOGY_2026-05-12.md` for the broader topology design.

---

## Installation

After cloning the repo OR after `git worktree add`:

```bash
npm run install:hooks
```

This copies `scripts/git-hooks/pre-commit.sh` to `<git-dir>/hooks/pre-commit` and marks it executable. Run it once per worktree.

---

## Lifecycle

- **Source-of-truth lives in `scripts/git-hooks/pre-commit.sh`** — this file IS tracked by git.
- The installed copy at `<git-dir>/hooks/pre-commit` is NOT tracked (git's hooks dir is by definition out-of-tree).
- If the canonical source changes (e.g., new behavior), re-run `npm run install:hooks` to refresh installed copies.
- Each worktree must be installed independently.

---

## Common failure modes (and what the hook prints)

### "BRANCH MISMATCH — COMMIT ABORTED"

You're on a different branch than declared. Cause: another session checked out a different branch, OR you intentionally switched without updating the guard. Fix per the hook's output (stash → checkout → pop → commit).

### "EXPECTED_BRANCH not set"

This worktree never had the guard set. The hook allows commits but warns. Recommended: set the guard at sprint start.

### "EXPECTED_BRANCH is empty"

File exists but is empty. Same as missing — warn-and-allow. Set a value to enable strict mode.

---

*Built by CC Sprint 7 and CC Sprint 12. Maintained by CC1 + Sean.*
